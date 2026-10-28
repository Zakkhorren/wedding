/** Temporary admin-only handlers. Omitted entirely by the production build switch. */
export const TEST_ADMIN_HELP =
  "/delete ID — удалить тестовую анкету с подтверждением\n/clear_test — очистить тестовые анкеты с подтверждением\n";
export async function handleTestAdmin({
  command,
  argument,
  callback,
  env,
  adminId,
  chatId,
  send,
  telegramApi,
  unix,
  digest,
  UUID,
}) {
  const relevant =
    ["/delete", "/clear_test"].includes(command) ||
    /^[dn]:/.test(String(callback?.data || ""));
  if (!relevant) return false;
  const answer = async (value) => {
    if (callback)
      await telegramApi(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: value.slice(0, 180),
      });
    await send(env, chatId, value);
  };
  if (env.ENABLE_TEST_DELETIONS !== "true") {
    await answer("Тестовое удаление отключено на сервере.");
    return true;
  }
  if (callback) {
    const match = String(callback.data).match(/^([dn]):([a-f0-9]{32})$/);
    if (!match) {
      await answer("Некорректное подтверждение.");
      return true;
    }
    const tokenHash = await digest(match[2]);
    const entry = await env.DB.prepare(
      "SELECT * FROM rsvp_admin_confirmations WHERE token_hash=? AND admin_id=? AND chat_id=?",
    )
      .bind(tokenHash, adminId, String(chatId))
      .first();
    const meta = await env.DB.prepare(
      "SELECT epoch FROM rsvp_control WHERE singleton=1",
    ).first();
    if (!entry || entry.expires_at <= unix() || entry.epoch !== meta.epoch) {
      await answer(
        "Подтверждение истекло или уже использовано. Повторите команду.",
      );
      return true;
    }
    if (match[1] === "n") {
      await env.DB.prepare(
        "DELETE FROM rsvp_admin_confirmations WHERE token_hash=? AND admin_id=? AND chat_id=?",
      )
        .bind(tokenHash, adminId, String(chatId))
        .run();
      await answer("Удаление отменено.");
      return true;
    }
    const guard = `EXISTS(SELECT 1 FROM rsvp_admin_confirmations c JOIN rsvp_control s ON s.singleton=1 AND s.epoch=c.epoch WHERE c.token_hash=? AND c.admin_id=? AND c.chat_id=? AND c.expires_at>?)`;
    const args = [tokenHash, adminId, String(chatId), unix()];
    const target =
      entry.action === "one" ? "id=? AND revision=?" : "last_write_seq<=?";
    const targets =
      entry.action === "one"
        ? [entry.response_id, entry.revision]
        : [entry.cutoff_seq];
    const result = await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM rsvp_responses WHERE ${target} AND ${guard} RETURNING id`,
      ).bind(...targets, ...args),
      env.DB.prepare(
        `UPDATE rsvp_control SET epoch=lower(hex(randomblob(16))),write_seq=write_seq+1 WHERE singleton=1 AND ${guard} AND (?='all' OR changes()>0)`,
      ).bind(...args, entry.action),
      env.DB.prepare(
        "DELETE FROM rsvp_admin_confirmations WHERE token_hash=? AND admin_id=? AND chat_id=?",
      ).bind(tokenHash, adminId, String(chatId)),
      env.DB.prepare(
        "DELETE FROM rsvp_admin_confirmations WHERE response_id IS NOT NULL AND response_id NOT IN (SELECT id FROM rsvp_responses)",
      ),
    ]);
    const deleted = result[0].results?.length ?? result[0].meta.changes;
    await answer(
      `Удалено анкет: ${deleted}. Записи, появившиеся или изменённые после запроса очистки, сохранены. Статистика пересчитывается по текущей базе.`,
    );
    return true;
  }
  const meta = await env.DB.prepare(
    "SELECT epoch,write_seq FROM rsvp_control WHERE singleton=1",
  ).first();
  let record = null,
    amount = 0;
  if (command === "/delete") {
    if (!UUID.test(argument)) {
      await answer("Использование: /delete ID (ID указан в /guests).");
      return true;
    }
    record = await env.DB.prepare(
      "SELECT id,name,revision FROM rsvp_responses WHERE id=?",
    )
      .bind(argument)
      .first();
    if (!record) {
      await answer("Анкета не найдена.");
      return true;
    }
    amount = 1;
  } else {
    amount = (
      await env.DB.prepare(
        "SELECT COUNT(*) n FROM rsvp_responses WHERE last_write_seq<=?",
      )
        .bind(meta.write_seq)
        .first()
    ).n;
  }
  const token = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  await env.DB.prepare(
    "INSERT INTO rsvp_admin_confirmations(token_hash,admin_id,chat_id,action,response_id,revision,cutoff_seq,epoch,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      await digest(token),
      adminId,
      String(chatId),
      record ? "one" : "all",
      record?.id ?? null,
      record?.revision ?? null,
      meta.write_seq,
      meta.epoch,
      unix() + 300,
    )
    .run();
  const text = record
    ? `Удалить тестовую анкету «${record.name}» (${record.id})? Данные и заявки будут удалены из базы.`
    : `ВНИМАНИЕ: удалить все текущие тестовые анкеты (${amount})? Это необратимое действие. Будут удалены ответы, их квитанции и очередь уведомлений. Новые или изменённые после этого запроса записи сохранятся.`;
  await send(env, chatId, text + "\nПодтверждение действует 5 минут.", [
    [
      {
        text: record ? "Удалить анкету" : "Очистить тестовые анкеты",
        callback_data: `d:${token}`,
      },
      { text: "Отмена", callback_data: `n:${token}` },
    ],
  ]);
  return true;
}
