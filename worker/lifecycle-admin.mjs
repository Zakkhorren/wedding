/** Permanent private-admin lifecycle commands; available in BOTH builds. No bulk erase. */
export const LIFECYCLE_HELP =
  "/archive ID — архивировать с подтверждением\n/archived — архивные анкеты\n/restore ID — вернуть из архива\n/erase ID — удалить одну анкету безвозвратно\n";
export async function handleLifecycleAdmin({
  command,
  argument,
  callback,
  env,
  adminId,
  chatId,
  send,
  sendLines,
  telegramApi,
  unix,
  digest,
  UUID,
}) {
  const callbackData = String(callback?.data || "");
  if (
    !["/archive", "/archived", "/restore", "/erase"].includes(command) &&
    !/^[lx]:/.test(callbackData)
  )
    return false;
  const answer = async (text) => {
    if (callback)
      await telegramApi(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: text.slice(0, 180),
      });
    await send(env, chatId, text);
  };
  if (command === "/archived") {
    const { results } = await env.DB.prepare(
      "SELECT id,name,attending,guest_count,parking_status,archived_at,revision FROM rsvp_responses WHERE archived_at IS NOT NULL ORDER BY archived_at,id",
    ).all();
    await sendLines(
      env,
      chatId,
      "🗂 Архив анкет",
      (results || []).length
        ? results.map(
            (r) =>
              `${r.name} — ${r.attending}; людей: ${r.guest_count ?? "не указано"}\nВ архиве: ${r.archived_at}; версия ${r.revision}\nID: ${r.id}`,
          )
        : ["Архив пока пуст."],
    );
    return true;
  }
  if (callback) {
    const match = callbackData.match(/^([lx]):([a-f0-9]{32})$/);
    if (!match) {
      await answer("Некорректное подтверждение.");
      return true;
    }
    const hash = await digest(match[2]);
    const item = await env.DB.prepare(
      "SELECT c.* FROM rsvp_lifecycle_confirmations c JOIN rsvp_control s ON s.singleton=1 AND s.epoch=c.epoch WHERE c.token_hash=? AND c.admin_id=? AND c.chat_id=? AND c.expires_at>? AND c.applied=0",
    )
      .bind(hash, adminId, String(chatId), unix())
      .first();
    if (!item) {
      await answer(
        "Подтверждение истекло или уже использовано. Повторите команду.",
      );
      return true;
    }
    if (match[1] === "x") {
      await env.DB.prepare(
        "DELETE FROM rsvp_lifecycle_confirmations WHERE token_hash=? AND admin_id=? AND chat_id=?",
      )
        .bind(hash, adminId, String(chatId))
        .run();
      await answer("Действие отменено.");
      return true;
    }
    const guard = `EXISTS(SELECT 1 FROM rsvp_lifecycle_confirmations c JOIN rsvp_control s ON s.singleton=1 AND s.epoch=c.epoch WHERE c.token_hash=? AND c.admin_id=? AND c.chat_id=? AND c.expires_at>? AND c.applied=0)`;
    const args = [hash, adminId, String(chatId), unix()];
    const queries = [
      env.DB.prepare(
        "UPDATE rsvp_control SET write_seq=write_seq+1 WHERE singleton=1",
      ),
    ];
    if (item.action === "erase")
      queries.push(
        env.DB.prepare(
          `DELETE FROM rsvp_responses WHERE id=? AND revision=? AND ${guard} RETURNING id`,
        ).bind(item.response_id, item.revision, ...args),
      );
    else {
      const set =
        item.action === "archive"
          ? "archived_at=CURRENT_TIMESTAMP"
          : "archived_at=NULL,parking_status=CASE WHEN attending='Да, конечно!' AND parking_choice='yes' THEN 'pending' ELSE 'not_requested' END";
      const expected =
        item.action === "archive"
          ? "archived_at IS NULL"
          : "archived_at IS NOT NULL";
      queries.push(
        env.DB.prepare(
          `UPDATE rsvp_responses SET ${set},revision=revision+1,updated_at=CURRENT_TIMESTAMP,last_write_seq=(SELECT write_seq FROM rsvp_control WHERE singleton=1) WHERE id=? AND revision=? AND ${expected} AND ${guard}`,
        ).bind(item.response_id, item.revision, ...args),
      );
    }
    // Capture the guarded mutation's result inside the SAME transaction.
    queries.push(
      env.DB.prepare(
        "UPDATE rsvp_lifecycle_confirmations SET applied=CASE WHEN changes()>0 THEN 1 ELSE 0 END WHERE token_hash=? AND admin_id=? AND chat_id=?",
      ).bind(hash, adminId, String(chatId)),
    );
    const applied =
      "EXISTS(SELECT 1 FROM rsvp_lifecycle_confirmations WHERE token_hash=? AND applied=1)";
    if (item.action === "archive")
      queries.push(
        env.DB.prepare(
          `UPDATE rsvp_outbox SET state='cancelled',payload_json='{}',lease_until=0 WHERE response_id=? AND state!='sent' AND ${applied}`,
        ).bind(item.response_id, hash),
      );
    if (item.action === "erase") {
      queries.push(
        env.DB.prepare(
          `UPDATE rsvp_control SET epoch=lower(hex(randomblob(16))) WHERE singleton=1 AND ${applied}`,
        ).bind(hash),
      );
      queries.push(
        env.DB.prepare(
          `DELETE FROM rsvp_admin_confirmations WHERE response_id=? AND ${applied}`,
        ).bind(item.response_id, hash),
      );
      queries.push(
        env.DB.prepare(
          `DELETE FROM rsvp_lifecycle_confirmations WHERE response_id=? AND token_hash!=? AND ${applied}`,
        ).bind(item.response_id, hash, hash),
      );
    }
    queries.push(
      env.DB.prepare(
        "DELETE FROM rsvp_lifecycle_confirmations WHERE token_hash=? AND admin_id=? AND chat_id=?",
      ).bind(hash, adminId, String(chatId)),
    );
    const result = await env.DB.batch(queries),
      changed =
        item.action === "erase"
          ? (result[1].results?.length ?? result[1].meta.changes)
          : result[1].meta.changes;
    if (!changed) {
      await answer(
        "Анкета уже изменена. Подтверждение устарело; повторите команду.",
      );
      return true;
    }
    await answer(
      item.action === "archive"
        ? "Анкета архивирована. Она исключена из активных списков; парковочные места освобождены."
        : item.action === "restore"
          ? "Анкета восстановлена с тем же ID. Парковка требует нового решения, если запрашивались машины."
          : "Анкета безвозвратно удалена вместе с квитанциями и очередью уведомлений. Восстановление невозможно.",
    );
    return true;
  }
  if (!UUID.test(argument)) {
    await answer(`Использование: ${command} ID (ID указан в списке анкет).`);
    return true;
  }
  const row = await env.DB.prepare(
    "SELECT id,name,revision,archived_at FROM rsvp_responses WHERE id=?",
  )
    .bind(argument)
    .first();
  if (!row) {
    await answer("Анкета не найдена.");
    return true;
  }
  const action = command.slice(1);
  if (action === "archive" && row.archived_at !== null) {
    await answer("Анкета уже в архиве.");
    return true;
  }
  if (action === "restore" && row.archived_at === null) {
    await answer("Анкета уже активна.");
    return true;
  }
  const { epoch } = await env.DB.prepare(
    "SELECT epoch FROM rsvp_control WHERE singleton=1",
  ).first();
  const token = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  await env.DB.prepare(
    "INSERT INTO rsvp_lifecycle_confirmations(token_hash,admin_id,chat_id,action,response_id,revision,epoch,expires_at) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      await digest(token),
      adminId,
      String(chatId),
      action,
      row.id,
      row.revision,
      epoch,
      unix() + 300,
    )
    .run();
  const verb =
    action === "archive"
      ? "Архивировать"
      : action === "restore"
        ? "Вернуть из архива"
        : "Удалить безвозвратно";
  const warning =
    action === "archive"
      ? "Ответы сохранятся. Анкета выйдет из активной статистики, её парковочные места освободятся."
      : action === "restore"
        ? "ID и ответы сохранятся. Парковка вернётся на рассмотрение, без автоматической брони."
        : "Это необратимо: персональные данные, квитанции и очередь будут удалены. Восстановить анкету будет нельзя.";
  await send(
    env,
    chatId,
    `${verb} анкету «${row.name}»?\nID: ${row.id}\n${warning}\nПодтверждение действует 5 минут.`,
    [
      [
        { text: verb, callback_data: `l:${token}` },
        { text: "Отмена", callback_data: `x:${token}` },
      ],
    ],
  );
  return true;
}
