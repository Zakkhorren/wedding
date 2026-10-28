import { handleLifecycleAdmin, LIFECYCLE_HELP } from "./lifecycle-admin.mjs";
import {
  YES,
  NO,
  LATER,
  DRINKS,
  CAPACITY,
  ValidationError,
  normalizeAnswer,
  nextParkingStatus,
  editKeyHash,
  verifyEditKey,
  describeChanges,
  exportCsv,
} from "./rsvp-policy.mjs";
import { verifyTurnstile, TurnstileError } from "./turnstile-verifier.mjs";
import { handleTestAdmin, TEST_ADMIN_HELP } from "./test-admin.mjs";

const UUID =
  /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const PUBLIC_COLUMNS =
  "id,name,attending,additional_guests,guest_count,drinks_json,custom_drink,parking_choice,cars_requested,parking_status,message,extra_answers_json,created_at,updated_at,revision";
const unix = () => Math.floor(Date.now() / 1000);
const plain = (value, status = 200) =>
  new Response(value, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
const admins = (env) => [
  ...new Set(
    String(env.ADMIN_IDS || "")
      .split(/[\s,;]+/)
      .filter((x) => /^\d{4,16}$/.test(x)),
  ),
];
const same = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
async function digest(value) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
async function readJson(request, limit) {
  if (Number(request.headers.get("Content-Length") || 0) > limit)
    throw new HttpError(413, "BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_JSON");
  let size = 0,
    chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}
function rowAnswer(row) {
  let drinks = [];
  try {
    drinks = JSON.parse(row.drinks_json || "[]");
  } catch {}
  return {
    name: row.name,
    attending: row.attending,
    guestCount: row.guest_count,
    additionalGuests: row.additional_guests || "",
    drinks: Array.isArray(drinks) ? drinks : [],
    otherDrink: row.custom_drink || "",
    parking: row.parking_choice || null,
    carCount: row.parking_choice === "yes" ? row.cars_requested : null,
    message: row.message || "",
    consent: true,
  };
}
function recordResult(row, epoch) {
  return {
    ok: true,
    saved: true,
    submissionId: row.id,
    revision: row.revision,
    epoch,
    answer: rowAnswer(row),
    parkingStatus: row.parking_status,
  };
}
async function control(env) {
  const row = await env.DB.prepare(
    "SELECT epoch,write_seq FROM rsvp_control WHERE singleton=1",
  ).first();
  if (!row) throw new HttpError(503, "MIGRATION_REQUIRED");
  return row;
}
async function telegramApi(env, method, payload, multipart = false) {
  if (!env.BOT_TOKEN) throw new Error("TELEGRAM_NOT_CONFIGURED");
  const response = await fetch(
    `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,
    {
      method: "POST",
      ...(multipart
        ? { body: payload }
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }),
      signal: AbortSignal.timeout(8000),
    },
  );
  const result = await response.json();
  if (!response.ok || result.ok !== true)
    throw new Error("TELEGRAM_UNAVAILABLE");
  return result.result;
}
const send = (env, chatId, value, keyboard) =>
  telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: value.slice(0, 4000),
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
async function sendLines(env, chatId, title, lines) {
  let chunk = title;
  for (let line of lines) {
    while (line.length > 3400) {
      if (chunk !== title) {
        await send(env, chatId, chunk);
        chunk = title;
      }
      await send(env, chatId, title + "\n" + line.slice(0, 3400));
      line = line.slice(3400);
    }
    if (chunk.length + line.length + 1 > 3800) {
      await send(env, chatId, chunk);
      chunk = title + " (продолжение)";
    }
    chunk += "\n" + line;
  }
  await send(env, chatId, chunk);
}
function parkingButtons(row) {
  if (row.attending !== YES || row.parking_choice !== "yes") return [];
  if (row.archived_at) return [];
  if (row.parking_status === "approved")
    return [
      [
        {
          text: "Отменить подтверждение",
          callback_data: `p:c:${row.id}:${row.revision}`,
        },
      ],
    ];
  if (row.parking_status === "rejected")
    return [
      [
        {
          text: "Отменить отказ",
          callback_data: `p:u:${row.id}:${row.revision}`,
        },
      ],
    ];
  return [
    [
      { text: "Подтвердить", callback_data: `p:a:${row.id}:${row.revision}` },
      { text: "Отклонить", callback_data: `p:r:${row.id}:${row.revision}` },
    ],
  ];
}
async function drainOutbox(env) {
  if (!env.DB || !env.BOT_TOKEN) return;
  const now = unix(),
    deadline = Date.now() + 18000;
  const { results } = await env.DB.prepare(
    "SELECT id,payload_json FROM rsvp_outbox WHERE state IN ('pending','sending') AND EXISTS(SELECT 1 FROM rsvp_responses r WHERE r.id=rsvp_outbox.response_id AND r.archived_at IS NULL) AND next_attempt<=? AND lease_until<=? ORDER BY created_at,id LIMIT 10",
  )
    .bind(now, now)
    .all();
  for (const row of results || []) {
    if (Date.now() > deadline) break;
    const lease = unix() + 60;
    const claim = await env.DB.prepare(
      "UPDATE rsvp_outbox SET state='sending',lease_until=?,attempts=attempts+1 WHERE id=? AND state IN ('pending','sending') AND EXISTS(SELECT 1 FROM rsvp_responses r WHERE r.id=rsvp_outbox.response_id AND r.archived_at IS NULL) AND next_attempt<=? AND lease_until<=?",
    )
      .bind(lease, row.id, unix(), unix())
      .run();
    if (!claim.meta.changes) continue;
    try {
      const payload = JSON.parse(row.payload_json);
      await telegramApi(env, "sendMessage", payload);
      await env.DB.prepare(
        "UPDATE rsvp_outbox SET state='sent',payload_json='{}',lease_until=0 WHERE id=? AND lease_until=?",
      )
        .bind(row.id, lease)
        .run();
    } catch {
      await env.DB.prepare(
        "UPDATE rsvp_outbox SET state='pending',lease_until=0,next_attempt=?+MIN(3600,30*(1 << MIN(attempts,6))) WHERE id=? AND lease_until=?",
      )
        .bind(unix(), row.id, lease)
        .run();
    }
  }
}
function notice(before, answer, id, revision) {
  let lines;
  if (before) {
    lines = [
      "✏️ Анкета изменена",
      `Компания: ${answer.name}`,
      `ID: ${id} · версия ${revision}`,
      ...describeChanges(rowAnswer(before), answer),
    ];
    if (lines.length === 3) lines.push("Ответы не изменились.");
  } else
    lines = [
      "💌 Новая анкета",
      `Компания: ${answer.name}`,
      `ID: ${id} · версия ${revision}`,
      `Присутствие: ${answer.attending}`,
      `Количество гостей: ${answer.guestCount}`,
      answer.additionalGuests && `Другие гости: ${answer.additionalGuests}`,
      answer.drinks.length && `Напитки компании: ${answer.drinks.join(", ")}`,
      answer.otherDrink && `Свой напиток: ${answer.otherDrink}`,
      answer.parking &&
        `Парковка: ${answer.parking}${answer.carCount ? ` (${answer.carCount} авто)` : ""}`,
      answer.message && `Сообщение: ${answer.message.slice(0, 400)}`,
    ];
  return lines.filter(Boolean).join("\n").slice(0, 3600);
}
async function publicApi(request, env, url, ctx) {
  const origin = request.headers.get("Origin") || "",
    allowed = String(env.ALLOWED_ORIGIN || "");
  if (!allowed || origin !== allowed) return plain("Forbidden", 403);
  const headers = {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers });
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers });
  try {
    if (url.search) throw new HttpError(400, "QUERY_NOT_ALLOWED");
    if (!env.DB) throw new HttpError(503, "DATABASE_NOT_CONFIGURED");
    const meta = await control(env);
    if (url.pathname === "/rsvp/bootstrap" && request.method === "GET")
      return json({ ok: true, protocol: 2, epoch: meta.epoch });
    if (!["GET", "POST"].includes(request.method))
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const key = (request.headers.get("Authorization") || "").match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    )?.[1];
    if (!key) throw new HttpError(401, "EDIT_KEY_REQUIRED");
    if (request.method === "GET") {
      const id = url.pathname.slice("/rsvp/".length).toLowerCase();
      if (!UUID.test(id)) throw new HttpError(404, "NOT_FOUND");
      const row = await env.DB.prepare(
        "SELECT * FROM rsvp_responses WHERE id=?",
      )
        .bind(id)
        .first();
      if (!row) throw new HttpError(404, "RESPONSE_NOT_FOUND");
      if (!(await verifyEditKey(id, key, row.edit_token_hash)))
        throw new HttpError(403, "EDIT_KEY_INVALID");
      if (row.archived_at) throw new HttpError(409, "RESPONSE_ARCHIVED");
      return json(recordResult(row, meta.epoch));
    }
    if (url.pathname !== "/rsvp")
      throw new HttpError(405, "METHOD_NOT_ALLOWED");
    if (!env.TURNSTILE_SECRET || !env.BOT_TOKEN || !admins(env).length)
      throw new HttpError(503, "SERVICE_NOT_CONFIGURED");
    if (
      !(request.headers.get("Content-Type") || "")
        .toLowerCase()
        .startsWith("application/json")
    )
      throw new HttpError(415, "JSON_REQUIRED");
    const raw = await readJson(request, 12000);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new HttpError(400, "INVALID_ANSWER");
    const id =
      typeof raw.submissionId === "string"
        ? raw.submissionId.toLowerCase()
        : "";
    const requestId =
      typeof raw.requestId === "string" ? raw.requestId.toLowerCase() : "";
    if (
      !UUID.test(id) ||
      !UUID.test(requestId) ||
      !Number.isSafeInteger(raw.revision) ||
      raw.revision < 0
    )
      throw new HttpError(400, "INVALID_ID_OR_REVISION");
    const answer = normalizeAnswer(raw);
    const before = await env.DB.prepare(
      "SELECT * FROM rsvp_responses WHERE id=?",
    )
      .bind(id)
      .first();
    if (before && !(await verifyEditKey(id, key, before.edit_token_hash)))
      throw new HttpError(403, "EDIT_KEY_INVALID");
    if (before?.archived_at) throw new HttpError(409, "RESPONSE_ARCHIVED");
    const payloadHash = await digest(
      JSON.stringify({ id, revision: raw.revision, epoch: raw.epoch, answer }),
    );
    const receipt = await env.DB.prepare(
      "SELECT * FROM rsvp_requests WHERE request_id=?",
    )
      .bind(requestId)
      .first();
    if (receipt) {
      if (
        !before ||
        receipt.response_id !== id ||
        !same(receipt.payload_hash, payloadHash)
      )
        throw new HttpError(409, "REQUEST_ID_REUSED");
      return json(JSON.parse(receipt.result_json));
    }
    if (raw.epoch !== meta.epoch)
      throw new HttpError(
        before ? 409 : 410,
        before ? "EPOCH_CHANGED" : "STALE_IDENTITY",
      );
    if (!before && raw.revision !== 0)
      throw new HttpError(410, "RESPONSE_DELETED");
    if (before && before.revision !== raw.revision)
      throw new HttpError(409, "REVISION_CONFLICT");
    await verifyTurnstile({
      token: raw.turnstileToken,
      secret: env.TURNSTILE_SECRET,
      hostname: new URL(allowed).hostname,
      action: "rsvp",
      remoteIp: request.headers.get("CF-Connecting-IP") || undefined,
      verificationId: requestId,
    });
    const hash = await editKeyHash(id, key),
      revision = raw.revision + 1;
    const parkingStatus = nextParkingStatus(
      before
        ? { answer: rowAnswer(before), parkingStatus: before.parking_status }
        : null,
      answer,
    );
    const savedResult = {
      ok: true,
      saved: true,
      submissionId: id,
      revision,
      epoch: meta.epoch,
      answer,
      parkingStatus,
    };
    const statements = [
      env.DB.prepare(
        "UPDATE rsvp_control SET write_seq=write_seq+1 WHERE singleton=1",
      ),
      env.DB.prepare(
        `INSERT INTO rsvp_responses
      (id,name,attending,additional_guests,guest_count,drinks_json,custom_drink,parking_choice,cars_requested,parking_status,message,extra_answers_json,edit_token_hash,revision,last_request_id,last_write_seq)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,'{}',?,?,?,write_seq FROM rsvp_control WHERE singleton=1 AND epoch=?
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,attending=excluded.attending,additional_guests=excluded.additional_guests,
      guest_count=excluded.guest_count,drinks_json=excluded.drinks_json,custom_drink=excluded.custom_drink,parking_choice=excluded.parking_choice,
      cars_requested=excluded.cars_requested,parking_status=excluded.parking_status,message=excluded.message,revision=excluded.revision,
      last_request_id=excluded.last_request_id,last_write_seq=excluded.last_write_seq,updated_at=CURRENT_TIMESTAMP
      WHERE rsvp_responses.edit_token_hash=? AND rsvp_responses.revision=? AND rsvp_responses.archived_at IS NULL AND ?>0`,
      ).bind(
        id,
        answer.name,
        answer.attending,
        answer.additionalGuests,
        answer.guestCount,
        JSON.stringify(answer.drinks),
        answer.otherDrink,
        answer.parking || "",
        answer.carCount || 0,
        parkingStatus,
        answer.message,
        hash,
        revision,
        requestId,
        meta.epoch,
        hash,
        raw.revision,
        raw.revision,
      ),
      env.DB.prepare(
        `INSERT INTO rsvp_requests(request_id,response_id,payload_hash,result_json,created_at)
      SELECT ?,id,?,?,? FROM rsvp_responses WHERE id=? AND last_request_id=? AND edit_token_hash=? AND archived_at IS NULL ON CONFLICT(request_id) DO NOTHING`,
      ).bind(
        requestId,
        payloadHash,
        JSON.stringify(savedResult),
        unix(),
        id,
        requestId,
        hash,
      ),
    ];
    const notification = notice(before, answer, id, revision);
    const keyboard = parkingButtons({
      id,
      revision,
      attending: answer.attending,
      parking_choice: answer.parking,
      parking_status: parkingStatus,
    });
    for (const admin of admins(env))
      statements.push(
        env.DB.prepare(
          `INSERT INTO rsvp_outbox(id,response_id,payload_json,created_at)
      SELECT ?,id,?,? FROM rsvp_responses WHERE id=? AND last_request_id=? AND edit_token_hash=? AND archived_at IS NULL ON CONFLICT(id) DO NOTHING`,
        ).bind(
          `${requestId}:${admin}`,
          JSON.stringify({
            chat_id: admin,
            text: notification,
            ...(keyboard.length
              ? { reply_markup: { inline_keyboard: keyboard } }
              : {}),
          }),
          unix(),
          id,
          requestId,
          hash,
        ),
      );
    await env.DB.batch(statements);
    const owner = await env.DB.prepare(
      "SELECT edit_token_hash,archived_at FROM rsvp_responses WHERE id=?",
    )
      .bind(id)
      .first();
    if (owner && !(await verifyEditKey(id, key, owner.edit_token_hash)))
      throw new HttpError(403, "EDIT_KEY_INVALID");
    if (owner?.archived_at) throw new HttpError(409, "RESPONSE_ARCHIVED");
    const committed = await env.DB.prepare(
      "SELECT * FROM rsvp_requests WHERE request_id=?",
    )
      .bind(requestId)
      .first();
    if (!committed) {
      const current = await env.DB.prepare(
        "SELECT edit_token_hash,archived_at FROM rsvp_responses WHERE id=?",
      )
        .bind(id)
        .first();
      if (current && !(await verifyEditKey(id, key, current.edit_token_hash)))
        throw new HttpError(403, "EDIT_KEY_INVALID");
      throw new HttpError(409, "REVISION_OR_EPOCH_CONFLICT");
    }
    if (
      committed.response_id !== id ||
      !same(committed.payload_hash, payloadHash)
    )
      throw new HttpError(409, "REQUEST_ID_REUSED");
    if (ctx?.waitUntil) ctx.waitUntil(drainOutbox(env).catch(() => {}));
    return json(JSON.parse(committed.result_json));
  } catch (error) {
    if (error instanceof ValidationError)
      return json({ ok: false, error: "INVALID_ANSWER" }, 400);
    if (error instanceof TurnstileError)
      return json(
        { ok: false, error: error.code },
        error.code === "TURNSTILE_RETRY" ? 400 : 503,
      );
    if (error instanceof HttpError)
      return json({ ok: false, error: error.code }, error.status);
    return json({ ok: false, error: "TEMPORARY_FAILURE" }, 503);
  }
}
async function readAll(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${PUBLIC_COLUMNS} FROM rsvp_responses WHERE archived_at IS NULL ORDER BY created_at,id`,
  ).all();
  return results || [];
}
function statistics(rows) {
  const yes = rows.filter((r) => r.attending === YES),
    known = yes.filter(
      (r) => Number.isSafeInteger(r.guest_count) && r.guest_count >= 1,
    ),
    unknown = yes.length - known.length;
  return `📊 Статистика\n\nВсего анкет: ${rows.length}\nКомпаний: ${rows.length}\n✅ Подтвердили: ${yes.length} компаний\n👥 Подтверждено гостей: ${known.reduce((n, r) => n + r.guest_count, 0)}${unknown ? ` (ещё у ${unknown} старых анкет количество не указано)` : ""}\n⏳ Ожидают ответа: ${rows.filter((r) => r.attending === LATER).length} компаний\n❌ Отказались: ${rows.filter((r) => r.attending === NO).length} компаний`;
}
function drinkStatistics(rows) {
  const standard = new Map(),
    custom = new Map();
  for (const row of rows.filter((r) => r.attending === YES)) {
    for (const value of new Set(rowAnswer(row).drinks))
      standard.set(value, (standard.get(value) || 0) + 1);
    const own = (row.custom_drink || "").trim();
    if (own) custom.set(own, (custom.get(own) || 0) + 1);
  }
  return [
    "🥂 Напитки — количество компаний",
    [...standard].map(([name, n]) => `${name}: ${n}`).join("\n") ||
      "Стандартные варианты не выбраны.",
    custom.size
      ? "Свои варианты:\n" +
        [...custom].map(([name, n]) => `${name}: ${n}`).join("\n")
      : "",
    "Одна компания может выбрать несколько напитков.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
async function parkingList(env, chatId, rows) {
  const requested = rows.filter(
    (r) => r.attending === YES && r.parking_choice === "yes",
  );
  const approved = requested
    .filter((r) => r.parking_status === "approved")
    .reduce((n, r) => n + r.cars_requested, 0);
  await send(
    env,
    chatId,
    `🚗 Парковка: ${approved}/8 подтверждено\nСвободно: ${Math.max(0, CAPACITY - approved)}\nЗапрошено: ${requested.reduce((n, r) => n + (r.cars_requested || 0), 0)} машин\nОжидают решения: ${requested.filter((r) => !["approved", "rejected"].includes(r.parking_status)).length}\nПока не знают: ${rows.filter((r) => r.attending === YES && r.parking_choice === "unknown").length}`,
  );
  for (const row of requested)
    await send(
      env,
      chatId,
      `${row.name} — ${row.cars_requested} авто\nID: ${row.id}\n${row.parking_status === "approved" ? "✅ Подтверждено" : row.parking_status === "rejected" ? "❌ Отклонено" : "⏳ Ожидает решения"}`,
      parkingButtons(row),
    );
}
async function parkingAction(env, callback, chatId) {
  const match = String(callback.data || "").match(
    /^p:([arcu]):([a-f0-9-]{36}):(\d{1,15})$/i,
  );
  if (!match || !UUID.test(match[2])) return "Некорректная кнопка.";
  const [, rawAction, id, rev] = match,
    action = rawAction.toLowerCase(),
    revision = Number(rev),
    status =
      action === "a" ? "approved" : action === "r" ? "rejected" : "pending";
  if (!Number.isSafeInteger(revision)) return "Некорректная версия.";
  const expected =
    action === "c"
      ? "parking_status='approved'"
      : action === "u"
        ? "parking_status='rejected'"
        : "parking_status='pending'";
  let result;
  try {
    const changes = await env.DB.batch([
      env.DB.prepare(
        "UPDATE rsvp_control SET write_seq=write_seq+1 WHERE singleton=1",
      ),
      env.DB.prepare(
        `UPDATE rsvp_responses SET parking_status=?,revision=revision+1,last_write_seq=(SELECT write_seq FROM rsvp_control WHERE singleton=1),updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND revision=? AND attending=? AND parking_choice='yes' AND archived_at IS NULL AND ${expected}`,
      ).bind(status, id, revision, YES),
    ]);
    result = changes[1];
  } catch (error) {
    if (String(error.message).includes("parking_capacity"))
      return "Недостаточно свободных мест: лимит 8 машин.";
    throw error;
  }
  if (!result.meta.changes)
    return "Заявка уже изменена. Обновите список: /parking";
  if (callback.message?.message_id)
    try {
      await telegramApi(env, "editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {}
  return action === "a"
    ? "Парковка подтверждена."
    : action === "r"
      ? "Заявка отклонена."
      : action === "u"
        ? "Отказ отменён; заявка снова ожидает решения."
        : "Подтверждение отменено; заявка снова ожидает решения.";
}
async function telegramWebhook(request, env) {
  if (
    !env.WEBHOOK_SECRET ||
    !same(
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "",
      env.WEBHOOK_SECRET,
    )
  )
    return plain("Forbidden", 403);
  let update;
  try {
    update = await readJson(request, 64000);
  } catch {
    return plain("Bad update", 400);
  }
  const callback = update?.callback_query,
    message = update?.message,
    actor = callback?.from || message?.from,
    chat = callback?.message?.chat || message?.chat;
  if (!actor || !chat || chat.type !== "private") return plain("OK");
  const chatId = chat.id,
    adminId = String(actor.id);
  if (!admins(env).includes(adminId)) {
    try {
      if (callback)
        await telegramApi(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "Доступ только для организаторов.",
        });
      else await send(env, chatId, "⛔ Доступ только для организаторов.");
    } catch {}
    return plain("OK");
  }
  if (!Number.isSafeInteger(update.update_id) || update.update_id < 0)
    return plain("Bad update", 400);
  const now = unix();
  try {
    const claim = await env.DB.prepare(
      `INSERT INTO telegram_updates(update_id,state,lease_until,created_at) VALUES(?,'processing',?,?)
      ON CONFLICT(update_id) DO UPDATE SET lease_until=excluded.lease_until WHERE state='processing' AND lease_until<=?`,
    )
      .bind(update.update_id, now + 60, now, now)
      .run();
    if (!claim.meta.changes) {
      const existing = await env.DB.prepare(
        "SELECT state FROM telegram_updates WHERE update_id=?",
      )
        .bind(update.update_id)
        .first();
      return plain(
        existing?.state === "done" ? "OK" : "Retry",
        existing?.state === "done" ? 200 : 503,
      );
    }
    const input = String(message?.text || "").trim(),
      [fullCommand, ...args] = input.split(/\s+/),
      command = (fullCommand || "").split("@")[0].toLowerCase();
    const argument = args.join(" ");
    let handled = await handleLifecycleAdmin({
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
    });
    /* TEST_ADMIN_BEGIN */
    if (!handled)
      handled = await handleTestAdmin({
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
      });
    /* TEST_ADMIN_END */
    if (!handled && callback) {
      const answer = await parkingAction(env, callback, chatId);
      await telegramApi(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text: answer,
      });
      await send(env, chatId, answer);
    } else if (!handled && (command === "/start" || command === "/help"))
      await send(
        env,
        chatId,
        "💌 Свадьба Сони и Леши — админка\n\n/stats — сводка\n/guests — компании и гости\n/drinks — напитки компаний\n/parking — заявки и подтверждение\n/export — CSV\n" +
          LIFECYCLE_HELP +
          (env.ENABLE_TEST_DELETIONS === "true" ? TEST_ADMIN_HELP : "") +
          "\nСайт подключается отдельно после проверки сервера.",
      );
    else if (
      !handled &&
      ["/stats", "/guests", "/drinks", "/parking", "/export"].includes(command)
    ) {
      const rows = await readAll(env);
      if (command === "/stats") await send(env, chatId, statistics(rows));
      if (command === "/guests")
        await sendLines(
          env,
          chatId,
          "👥 Компании",
          rows.length
            ? rows.map(
                (r, i) =>
                  `${i + 1}. ${r.name} — ${r.attending}\nЛюдей: ${r.attending === YES ? (r.guest_count ?? "не указано") : "0"}${r.additional_guests ? " · " + r.additional_guests : ""}\nID: ${r.id}`,
              )
            : ["Пока нет анкет."],
        );
      if (command === "/drinks")
        await sendLines(
          env,
          chatId,
          "🥂 Предпочтения",
          drinkStatistics(rows).split("\n"),
        );
      if (command === "/parking") await parkingList(env, chatId, rows);
      if (command === "/export") {
        const data = exportCsv(
            rows.map((row) => ({
              id: row.id,
              parkingStatus: row.parking_status,
              answer: rowAnswer(row),
              extraAnswers: row.extra_answers_json || "{}",
              createdAt: row.created_at,
              updatedAt: row.updated_at,
              revision: row.revision,
            })),
          ),
          form = new FormData();
        form.append("chat_id", String(chatId));
        form.append(
          "document",
          new Blob([data], { type: "text/csv;charset=utf-8" }),
          "wedding-rsvp.csv",
        );
        form.append(
          "caption",
          `Актуальные анкеты: ${rows.length}. Только для организаторов.`,
        );
        await telegramApi(env, "sendDocument", form, true);
      }
    } else if (!handled && command.startsWith("/"))
      await send(env, chatId, "Неизвестная команда. Список команд: /help");
    await env.DB.prepare(
      "UPDATE telegram_updates SET state='done',lease_until=0 WHERE update_id=?",
    )
      .bind(update.update_id)
      .run();
    return plain("OK");
  } catch {
    try {
      await env.DB.prepare(
        "UPDATE telegram_updates SET lease_until=0 WHERE update_id=? AND state='processing'",
      )
        .bind(update.update_id)
        .run();
    } catch {}
    return plain("Temporary error", 503);
  }
}
export default {
  async fetch(request, bindings, ctx) {
    const env = {
      ...bindings,
      DB: bindings.DB?.withSession
        ? bindings.DB.withSession("first-primary")
        : bindings.DB,
    };
    const url = new URL(request.url);
    if (url.pathname === "/rsvp" || url.pathname.startsWith("/rsvp/"))
      return publicApi(request, env, url, ctx);
    if (request.method === "GET" && url.pathname === "/")
      return plain("Wedding RSVP API v2. Site connection is a separate step.");
    if (request.method === "POST" && url.pathname === "/telegram")
      return telegramWebhook(request, env);
    return plain("Not found", 404);
  },
  async scheduled(controller, bindings, ctx) {
    const env = {
      ...bindings,
      DB: bindings.DB?.withSession
        ? bindings.DB.withSession("first-primary")
        : bindings.DB,
    };
    ctx.waitUntil(drainOutbox(env));
  },
};
