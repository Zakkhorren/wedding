import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker as Thread } from "node:worker_threads";
import worker from "../worker/wedding-rsvp-api.js";
import production from "../worker/wedding-rsvp-api.production.js";
import { openRsvpSession } from "../rsvp-session.mjs";
import { database, D1Local, legacySql } from "./d1-local.mjs";
const YES = "Да, конечно!",
  NO = "К сожалению, нет",
  LATER = "Отвечу чуть позже";
const origin = "https://zakkhorren.github.io";
async function lifecycle(env, action, id, implementation = worker) {
  await telegramUpdate(
    env,
    {
      update_id: updateNumber++,
      message: {
        text: "/" + action + " " + id,
        chat: { id: 11111, type: "private" },
        from: { id: 11111 },
      },
    },
    implementation,
  );
  return telegram.at(-1).data.reply_markup.inline_keyboard[0][0].callback_data;
}
const uuid = () => crypto.randomUUID();
const key = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
let telegram = [],
  captchaCalls = 0,
  captchaFailure = false,
  telegramFailure = false,
  updateNumber = 100;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://challenges.cloudflare.com/")) {
    captchaCalls++;
    if (captchaFailure) throw Error("private internal failure");
    return Response.json({
      success: options.body.get("response") !== "expired",
      hostname: new URL(origin).hostname,
      action: "rsvp",
    });
  }
  if (String(url).startsWith("https://api.telegram.org/")) {
    if (telegramFailure) throw Error("ambiguous Telegram delivery");
    const data =
      options.body instanceof FormData
        ? {
            chat_id: options.body.get("chat_id"),
            document: Buffer.from(
              await options.body.get("document").arrayBuffer(),
            ).toString("utf8"),
          }
        : JSON.parse(options.body);
    telegram.push({ method: String(url).split("/").at(-1), data });
    return Response.json({ ok: true, result: { message_id: 1000 } });
  }
  throw Error("Unexpected external fetch");
};
process.on("exit", () => {
  globalThis.fetch = originalFetch;
});
const envFor = (db) => ({
  DB: db,
  ALLOWED_ORIGIN: origin,
  ADMIN_IDS: "11111,22222",
  BOT_TOKEN: "TEST_ONLY_TOKEN",
  WEBHOOK_SECRET: "TEST_ONLY_WEBHOOK",
  TURNSTILE_SECRET: "TEST_ONLY_TURNSTILE",
  ENABLE_TEST_DELETIONS: "true",
});
async function call(
  env,
  route,
  method = "GET",
  body,
  secret,
  implementation = worker,
) {
  return implementation.fetch(
    new Request("https://worker.test" + route, {
      method,
      headers: {
        Origin: origin,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(secret ? { Authorization: "Bearer " + secret } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    env,
  );
}
async function identity(env, fields = {}) {
  return {
    secret: key(),
    body: {
      submissionId: uuid(),
      requestId: uuid(),
      revision: 0,
      epoch: (await (await call(env, "/rsvp/bootstrap")).json()).epoch,
      name: "Компания",
      attending: YES,
      guestCount: 3,
      additionalGuests: "Имена, не, количество",
      drinks: ["Виски", "Ром"],
      otherDrink: "Сидр",
      parking: "yes",
      carCount: 2,
      message: "До встречи",
      consent: true,
      turnstileToken: "valid",
      ...fields,
    },
  };
}
async function save(env, identity) {
  const r = await call(env, "/rsvp", "POST", identity.body, identity.secret);
  return { status: r.status, data: await r.json() };
}
async function telegramUpdate(env, update, implementation = worker) {
  return implementation.fetch(
    new Request("https://worker.test/telegram", {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(update),
    }),
    env,
  );
}
async function command(env, text, user = 11111) {
  return telegramUpdate(env, {
    update_id: updateNumber++,
    message: { text, chat: { id: user, type: "private" }, from: { id: user } },
  });
}
async function callback(
  env,
  data,
  user = 11111,
  updateId = updateNumber++,
  implementation = worker,
) {
  return telegramUpdate(
    env,
    {
      update_id: updateId,
      callback_query: {
        id: "callback-" + updateId,
        data,
        from: { id: user },
        message: { message_id: 10, chat: { id: user, type: "private" } },
      },
    },
    implementation,
  );
}
function edit(identity, revision, fields = {}) {
  identity.body = {
    ...identity.body,
    revision,
    requestId: uuid(),
    turnstileToken: "new-token",
    ...fields,
  };
  return identity;
}
const rows = (db) => db.sqlite.prepare("SELECT * FROM rsvp_responses").all();

test("Migration preserves supplied schema rows and refuses an invalid legacy allocation atomically", () => {
  const db = new D1Local();
  db.sqlite.exec(legacySql);
  db.sqlite
    .prepare("INSERT INTO rsvp_responses(id,name,attending) VALUES(?,?,?)")
    .run(uuid(), "Legacy", YES);
  const before = rows(db)[0];
  db.migrate();
  const after = rows(db)[0];
  for (const [field, value] of Object.entries(before))
    assert.equal(after[field], value);
  assert.equal(after.revision, 1);
  db.close();
  const bad = new D1Local();
  bad.sqlite.exec(legacySql);
  bad.sqlite
    .prepare(
      "INSERT INTO rsvp_responses(id,name,attending,parking_choice,cars_requested,parking_status) VALUES(?,?,?,'yes',9,'approved')",
    )
    .run(uuid(), "Legacy", YES);
  assert.throws(() => bad.migrate());
  assert.equal(rows(bad).length, 1);
  assert.ok(
    !bad.sqlite
      .prepare("PRAGMA table_info(rsvp_responses)")
      .all()
      .some((c) => c.name === "revision"),
  );
  bad.close();
});
test("Create, restore on another device, retry, wrong owner and payload conflicts", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  const first = await save(env, id);
  assert.equal(first.status, 200);
  assert.equal(first.data.saved, true);
  assert.equal(rows(db).length, 1);
  assert.match(rows(db)[0].edit_token_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(rows(db)[0].edit_token_hash, id.secret);
  assert.ok(!JSON.stringify(first.data).includes(id.secret));
  const initialCalls = captchaCalls;
  id.body.turnstileToken = "expired";
  assert.deepEqual(await save(env, id), first);
  assert.equal(captchaCalls, initialCalls);
  assert.equal(rows(db).length, 1);
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) n FROM rsvp_outbox").get().n,
    2,
  );
  const read = await call(
    env,
    "/rsvp/" + id.body.submissionId,
    "GET",
    undefined,
    id.secret,
  );
  assert.equal((await read.json()).answer.guestCount, 3);
  assert.equal(
    (await call(env, "/rsvp/" + id.body.submissionId, "GET", undefined, key()))
      .status,
    403,
  );
  assert.equal((await call(env, "/rsvp/" + id.body.submissionId)).status, 401);
  id.body.message = "changed";
  assert.equal((await save(env, id)).status, 409);
  const wrong = { body: { ...id.body, requestId: uuid() }, secret: key() };
  assert.equal((await save(env, wrong)).status, 403);
  assert.equal(rows(db)[0].message, "До встречи");
  const serialized =
    JSON.stringify(db.sqlite.prepare("SELECT * FROM rsvp_requests").all()) +
    JSON.stringify(db.sqlite.prepare("SELECT * FROM rsvp_outbox").all());
  assert.ok(
    !serialized.includes(id.secret) && !serialized.includes("turnstileToken"),
  );
  db.close();
});
test("No acknowledgement on D1 failure; captcha errors never write; retry is safe", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  db.failNextBatch = true;
  assert.equal((await save(env, id)).status, 503);
  assert.equal(rows(db).length, 0);
  assert.equal((await save(env, id)).status, 200);
  assert.equal(rows(db).length, 1);
  const expired = await identity(env, { turnstileToken: "expired" });
  assert.equal((await save(env, expired)).status, 400);
  captchaFailure = true;
  assert.equal((await save(env, await identity(env))).status, 503);
  captchaFailure = false;
  assert.equal(rows(db).length, 1);
  db.close();
});
test("Concurrent same-ID saves produce one company/receipt and cannot overwrite another key", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  const replies = await Promise.all([
    save(env, id),
    save(env, id),
    save(env, { ...id, secret: key() }),
  ]);
  assert.equal(rows(db).length, 1);
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) n FROM rsvp_requests").get().n,
    1,
  );
  assert.ok(replies.some((r) => r.status === 200));
  assert.ok(replies.some((r) => r.status === 403));
  db.close();
});
test("Parking approvals enforce 8 total, stale buttons and unauthorized admins cannot mutate", async () => {
  const db = database(),
    env = envFor(db);
  const a = await identity(env, { carCount: 5 }),
    b = await identity(env, { carCount: 4 });
  await save(env, a);
  await save(env, b);
  await callback(env, `p:a:${a.body.submissionId}:1`);
  await callback(env, `p:a:${b.body.submissionId}:1`);
  assert.equal(
    rows(db)
      .filter((r) => r.parking_status === "approved")
      .reduce((n, r) => n + r.cars_requested, 0),
    5,
  );
  assert.equal(
    rows(db).find((r) => r.id === b.body.submissionId).parking_status,
    "pending",
  );
  await callback(env, `p:c:${a.body.submissionId}:2`, 99999);
  assert.equal(
    rows(db).find((r) => r.id === a.body.submissionId).parking_status,
    "approved",
  );
  await callback(env, `p:c:${a.body.submissionId}:1`);
  assert.equal(
    rows(db).find((r) => r.id === a.body.submissionId).parking_status,
    "approved",
  );
  await callback(env, `p:c:${a.body.submissionId}:2`);
  assert.equal(
    rows(db).find((r) => r.id === a.body.submissionId).parking_status,
    "pending",
  );
  await callback(env, `p:a:${b.body.submissionId}:1`);
  assert.equal(
    rows(db).find((r) => r.id === b.body.submissionId).parking_status,
    "approved",
  );
  db.close();
});
test("Rejected parking can be reopened by admin, but stale callbacks stay invalid", async () => {
  const db = database(),
    env = envFor(db),
    identityA = await identity(env, { carCount: 1 });
  await save(env, identityA);
  const id = identityA.body.submissionId;
  await callback(env, `p:r:${id}:1`);
  assert.equal(rows(db)[0].parking_status, "rejected");
  await command(env, "/parking");
  const last = telegram.filter((r) => r.method === "sendMessage").at(-1).data;
  assert.equal(last.reply_markup.inline_keyboard[0][0].text, "Отменить отказ");
  await callback(env, `p:u:${id}:1`);
  assert.equal(rows(db)[0].parking_status, "rejected");
  await callback(env, `p:u:${id}:2`);
  assert.equal(rows(db)[0].parking_status, "pending");
  await callback(env, `p:a:${id}:3`);
  assert.equal(rows(db)[0].parking_status, "approved");
  assert.equal(rows(db)[0].revision, 4);
  db.close();
});
test("Guest edits preserve approval for drinks/message and reset approval for car count/attendance", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  await save(env, id);
  await callback(env, `p:a:${id.body.submissionId}:1`);
  const saved = await save(
    env,
    edit(id, 2, { message: "Новое", drinks: ["Ром"] }),
  );
  assert.equal(saved.data.parkingStatus, "approved");
  assert.equal(saved.data.revision, 3);
  const changed = await save(env, edit(id, 3, { carCount: 3 }));
  assert.equal(changed.data.parkingStatus, "pending");
  const no = await save(env, edit(id, 4, { attending: NO }));
  assert.equal(no.data.answer.guestCount, 0);
  assert.equal(no.data.answer.carCount, null);
  assert.equal(no.data.parkingStatus, "not_requested");
  await command(env, "/stats");
  assert.ok(telegram.at(-1).data.text.includes("Подтверждено гостей: 0"));
  db.close();
});
test("Existing commands, exact guest sums, companies per drink and CSV continue working", async () => {
  const db = database(),
    env = envFor(db);
  await save(env, await identity(env, { guestCount: 3 }));
  await save(env, await identity(env, { guestCount: 2 }));
  await save(env, await identity(env, { attending: LATER }));
  for (const cmd of [
    "/start",
    "/help",
    "/stats",
    "/guests",
    "/drinks",
    "/parking",
    "/export",
  ])
    assert.equal((await command(env, cmd)).status, 200);
  const messages = telegram
    .filter((r) => r.method === "sendMessage")
    .map((r) => r.data.text)
    .join("\n");
  assert.ok(messages.includes("Подтверждено гостей: 5"));
  assert.ok(messages.includes("Виски: 2"));
  assert.ok(messages.includes("Ожидают ответа: 1 компаний"));
  const csv = telegram.filter((r) => r.method === "sendDocument").at(-1)
    .data.document;
  assert.ok(csv.startsWith("\ufeffsep=;\r\n"));
  assert.ok(
    csv.includes("Количество гостей") && csv.includes("Статус парковки"),
  );
  assert.ok(!csv.includes("edit_token_hash"));
  db.close();
});
test("Webhook secret/private-admin checks and update-ID replay", async () => {
  const db = database(),
    env = envFor(db);
  const bad = await worker.fetch(
    new Request("https://worker.test/telegram", { method: "POST", body: "{}" }),
    env,
  );
  assert.equal(bad.status, 403);
  const id = await identity(env);
  await save(env, id);
  const updateId = updateNumber++;
  await callback(env, `p:a:${id.body.submissionId}:1`, 11111, updateId);
  const revision = rows(db)[0].revision;
  await callback(env, `p:a:${id.body.submissionId}:1`, 11111, updateId);
  assert.equal(rows(db)[0].revision, revision);
  db.close();
});
test("Outbox failure leaves DB acknowledgement intact and cron recovers delivery", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  telegramFailure = true;
  assert.equal((await save(env, id)).status, 200);
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  assert.equal(rows(db).length, 1);
  assert.equal(
    db.sqlite
      .prepare("SELECT COUNT(*) n FROM rsvp_outbox WHERE state='sent'")
      .get().n,
    0,
  );
  telegramFailure = false;
  db.sqlite.exec("UPDATE rsvp_outbox SET next_attempt=0");
  const retried = [];
  await worker.scheduled({}, env, { waitUntil: (p) => retried.push(p) });
  await Promise.all(retried);
  assert.equal(
    db.sqlite
      .prepare("SELECT COUNT(*) n FROM rsvp_outbox WHERE state='sent'")
      .get().n,
    2,
  );
  db.close();
});
test("Test deletion requires same-admin confirmation and deletes answer/receipts/outbox; stale IDs fail", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  await save(env, id);
  await command(env, "/delete " + id.body.submissionId);
  assert.equal(rows(db).length, 1);
  const token = telegram
    .filter((r) => r.method === "sendMessage" && r.data.reply_markup)
    .at(-1).data.reply_markup.inline_keyboard[0][0].callback_data;
  await callback(env, token, 22222);
  assert.equal(rows(db).length, 1);
  await callback(env, token);
  assert.equal(rows(db).length, 0);
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) n FROM rsvp_requests").get().n,
    0,
  );
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) n FROM rsvp_outbox").get().n,
    0,
  );
  assert.equal(
    (
      await call(
        env,
        "/rsvp/" + id.body.submissionId,
        "GET",
        undefined,
        id.secret,
      )
    ).status,
    404,
  );
  assert.equal((await save(env, id)).status, 410);
  await callback(env, token);
  assert.equal(rows(db).length, 0);
  db.close();
});
test("Clear snapshot does not erase newly created/edited answers; explicit cancel/expiry/disable work", async () => {
  const db = database(),
    env = envFor(db),
    a = await identity(env),
    b = await identity(env);
  await save(env, a);
  await save(env, b);
  await command(env, "/clear_test");
  const token = telegram.filter((r) => r.data.reply_markup).at(-1).data
    .reply_markup.inline_keyboard[0][0].callback_data;
  await save(env, edit(a, 1, { message: "Изменено после предупреждения" }));
  const fresh = await identity(env);
  await save(env, fresh);
  await callback(env, token);
  assert.deepEqual(
    new Set(rows(db).map((r) => r.id)),
    new Set([a.body.submissionId, fresh.body.submissionId]),
  );
  env.ENABLE_TEST_DELETIONS = "false";
  await command(env, "/clear_test");
  assert.equal(rows(db).length, 2);
  env.ENABLE_TEST_DELETIONS = "true";
  await command(env, "/clear_test");
  let current = telegram.filter((r) => r.data.reply_markup).at(-1).data
    .reply_markup.inline_keyboard[0];
  await callback(env, current[1].callback_data);
  await callback(env, current[0].callback_data);
  assert.equal(rows(db).length, 2);
  await command(env, "/clear_test");
  current = telegram.filter((r) => r.data.reply_markup).at(-1).data.reply_markup
    .inline_keyboard[0];
  db.sqlite.exec("UPDATE rsvp_admin_confirmations SET expires_at=0");
  await callback(env, current[0].callback_data);
  assert.equal(rows(db).length, 2);
  db.close();
});
test("Production excludes temporary deletion handlers; public DELETE is never available", async () => {
  const source = fs.readFileSync(
    new URL("../worker/wedding-rsvp-api.production.js", import.meta.url),
    "utf8",
  );
  assert.ok(
    !source.includes("DELETE FROM rsvp_responses WHERE 1") &&
      !source.includes("handleTestAdmin") &&
      !source.includes("/clear_test"),
  );
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  await save(env, id);
  await command(env, "/clear_test");
  const token = telegram.filter((r) => r.data.reply_markup).at(-1).data
    .reply_markup.inline_keyboard[0][0].callback_data;
  await callback(env, token, 11111, updateNumber++, production);
  assert.equal(rows(db).length, 1);
  assert.equal((await call(env, "/rsvp", "DELETE")).status, 405);
  db.close();
});
test("SQLite itself serializes two independent writers and rejects capacity overflow", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wedding-d1-")),
    file = path.join(directory, "db.sqlite"),
    db = new D1Local(file);
  db.sqlite.exec("PRAGMA journal_mode=WAL");
  db.sqlite.exec(legacySql);
  db.migrate();
  const ids = [uuid(), uuid()];
  for (let i = 0; i < 2; i++)
    db.sqlite
      .prepare(
        "INSERT INTO rsvp_responses(id,name,attending,parking_choice,cars_requested,parking_status) VALUES(?,?,?,'yes',?,'pending')",
      )
      .run(ids[i], "Компания", YES, i ? 4 : 5);
  const run = (id) =>
    new Promise((resolve, reject) => {
      const thread = new Thread(
        `const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(workerData.file);d.exec('PRAGMA busy_timeout=5000');try{d.prepare("UPDATE rsvp_responses SET parking_status='approved' WHERE id=?").run(workerData.id);parentPort.postMessage(true)}catch{parentPort.postMessage(false)}finally{d.close()}`,
        { eval: true, workerData: { file, id } },
      );
      thread.on("message", resolve);
      thread.on("error", reject);
    });
  const results = await Promise.all(ids.map(run));
  assert.equal(results.filter(Boolean).length, 1);
  assert.ok(
    db.sqlite
      .prepare(
        "SELECT SUM(cars_requested) n FROM rsvp_responses WHERE parking_status='approved'",
      )
      .get().n <= 8,
  );
  db.close();
  assert.ok(
    path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) &&
      path.basename(directory).startsWith("wedding-d1-"),
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("Legacy records cannot be claimed by guessing IDs and statistics are not truncated to 500", async () => {
  const db = database(),
    env = envFor(db);
  const legacyId = uuid();
  db.sqlite
    .prepare(
      "INSERT INTO rsvp_responses(id,name,attending,guest_count) VALUES(?,?,?,NULL)",
    )
    .run(legacyId, "Legacy", YES);
  const attack = await identity(env, { submissionId: legacyId, revision: 1 });
  assert.equal((await save(env, attack)).status, 403);
  for (let i = 0; i < 501; i++)
    db.sqlite
      .prepare(
        "INSERT INTO rsvp_responses(id,name,attending,guest_count) VALUES(?,?,?,1)",
      )
      .run(uuid(), "Компания", YES);
  await command(env, "/stats");
  assert.ok(telegram.at(-1).data.text.includes("Всего анкет: 502"));
  assert.ok(telegram.at(-1).data.text.includes("количество не указано"));
  db.close();
});
test("Changed single-record delete confirmation cannot erase a newer revision", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  await save(env, id);
  await command(env, "/delete " + id.body.submissionId);
  const token = telegram.filter((r) => r.data.reply_markup).at(-1).data
    .reply_markup.inline_keyboard[0][0].callback_data;
  const oldEpoch = id.body.epoch;
  await save(env, edit(id, 1, { message: "Новое" }));
  await callback(env, token);
  assert.equal(rows(db).length, 1);
  assert.equal(
    (await (await call(env, "/rsvp/bootstrap")).json()).epoch,
    oldEpoch,
  );
  db.close();
});
test("Outbox includes before/after changes, never editing secrets or Turnstile token", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  await save(env, id);
  await save(env, edit(id, 1, { guestCount: 2, message: "Другой текст" }));
  const text = db.sqlite
    .prepare("SELECT payload_json FROM rsvp_outbox ORDER BY id")
    .all()
    .map((r) => r.payload_json)
    .join("\n");
  assert.ok(text.includes("Количество гостей: было 3 → стало 2"));
  assert.ok(!text.includes(id.secret) && !text.includes("turnstileToken"));
  db.close();
});
test("CORS/query-secret rejection and no-cache responses do not expose data", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  await save(env, id);
  const read = await call(
    env,
    "/rsvp/" + id.body.submissionId,
    "GET",
    undefined,
    id.secret,
  );
  assert.equal(read.headers.get("Cache-Control"), "no-store");
  assert.equal(read.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(
    (
      await call(
        env,
        "/rsvp/" + id.body.submissionId + "?edit_key=secret",
        "GET",
        undefined,
        id.secret,
      )
    ).status,
    400,
  );
  const foreign = await worker.fetch(
    new Request("https://worker.test/rsvp/bootstrap", {
      headers: { Origin: "https://evil.test" },
    }),
    env,
  );
  assert.equal(foreign.status, 403);
  db.close();
});

test("Client adapter end-to-end against delivered Worker: stable ID, retry and another-device link", async () => {
  const db = database(),
    env = envFor(db),
    memory = new Map(),
    storage = {
      getItem: (k) => memory.get(k) ?? null,
      setItem: (k, v) => memory.set(k, v),
    };
  let lose = true;
  const fetcher = async (url, options) => {
    const response = await worker.fetch(
      new Request(url, {
        ...options,
        headers: { ...options.headers, Origin: origin },
      }),
      env,
    );
    if (options.method === "POST" && lose) {
      lose = false;
      throw Error("lost acknowledgement");
    }
    return response;
  };
  const pageUrl = "https://zakkhorren.github.io/wedding/";
  const session = await openRsvpSession({
    endpoint: "https://worker.test/rsvp",
    storage,
    pageUrl,
    fetcher,
  });
  const raw = {
    name: "Компания",
    attending: YES,
    guestCount: 3,
    additionalGuests: "Имена",
    drinks: ["Виски"],
    parking: "yes",
    carCount: 2,
    message: "До встречи",
    consent: true,
  };
  await assert.rejects(
    session.save(raw, async () => "valid"),
    { code: "NETWORK_RETRY" },
  );
  await session.save(raw, async () => "expired");
  assert.equal(rows(db).length, 1);
  let clean = false;
  const freshMemory = new Map();
  const other = await openRsvpSession({
    endpoint: "https://worker.test/rsvp",
    storage: {
      getItem: (k) => freshMemory.get(k) ?? null,
      setItem: (k, v) => freshMemory.set(k, v),
    },
    pageUrl: session.editLink(),
    history: {
      replaceState(a, b, url) {
        assert.equal(new URL(url).hash, "");
        clean = true;
      },
    },
    fetcher,
  });
  assert.ok(clean);
  await other.save({ ...raw, guestCount: 2 }, async () => "new-token");
  assert.equal(rows(db)[0].guest_count, 2);
  assert.equal(rows(db).length, 1);
  assert.equal((await session.restore()).answer.guestCount, 2);
  db.close();
});
test("Fully allocated parking still permits ordinary guest edits without false capacity errors", async () => {
  const db = database(),
    env = envFor(db),
    a = await identity(env, { carCount: 5 }),
    b = await identity(env, { carCount: 3 });
  await save(env, a);
  await save(env, b);
  await callback(env, `p:a:${a.body.submissionId}:1`);
  await callback(env, `p:a:${b.body.submissionId}:1`);
  const updated = await save(
    env,
    edit(a, 2, { message: "Сообщение при заполненной парковке" }),
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.data.parkingStatus, "approved");
  assert.equal(
    db.sqlite
      .prepare(
        "SELECT SUM(cars_requested) n FROM rsvp_responses WHERE parking_status='approved'",
      )
      .get().n,
    8,
  );
  db.close();
});

test("Missing bot/admin configuration cannot silently accept records without notification targets", async () => {
  const db = database(),
    env = envFor(db),
    id = await identity(env);
  for (const broken of [
    { ...env, BOT_TOKEN: "" },
    { ...env, ADMIN_IDS: "" },
    { ...env, TURNSTILE_SECRET: "" },
  ])
    assert.equal((await save(broken, id)).status, 503);
  assert.equal(rows(db).length, 0);
  db.close();
});

test("Archive releases capacity; restore preserves identity but requires fresh parking review", async () => {
  const db = database(),
    env = envFor(db),
    a = await identity(env, { carCount: 8 }),
    b = await identity(env, { carCount: 1 });
  await save(env, a);
  await save(env, b);
  await callback(env, `p:a:${a.body.submissionId}:1`);
  const original = rows(db).find((r) => r.id === a.body.submissionId);
  const archive = await lifecycle(env, "archive", a.body.submissionId);
  await callback(env, archive, 22222);
  assert.equal(rows(db)[0].archived_at, null);
  await callback(env, archive);
  let row = rows(db).find((r) => r.id === a.body.submissionId);
  assert.ok(row.archived_at);
  assert.equal(row.edit_token_hash, original.edit_token_hash);
  assert.equal((await save(env, a)).data.error, "RESPONSE_ARCHIVED");
  assert.equal(
    (
      await (
        await call(env, "/rsvp/" + row.id, "GET", undefined, a.secret)
      ).json()
    ).error,
    "RESPONSE_ARCHIVED",
  );
  await callback(env, `p:a:${b.body.submissionId}:1`);
  assert.throws(() =>
    db.sqlite
      .prepare("UPDATE rsvp_responses SET archived_at=NULL WHERE id=?")
      .run(row.id),
  );
  await callback(env, await lifecycle(env, "restore", row.id));
  row = rows(db).find((r) => r.id === row.id);
  assert.equal(row.archived_at, null);
  assert.equal(row.parking_status, "pending");
  await callback(env, `p:a:${row.id}:2`);
  assert.equal(rows(db).find((r) => r.id === row.id).parking_status, "pending");
  await callback(env, `p:a:${row.id}:${row.revision}`);
  assert.equal(rows(db).find((r) => r.id === row.id).parking_status, "pending");
  await callback(env, archive);
  assert.equal(rows(db).find((r) => r.id === row.id).archived_at, null);
  db.close();
});

test("Archived records leave active reports/export/outbox; revision-bound confirmations reject edits and expiry", async () => {
  const db = database(),
    env = envFor(db),
    a = await identity(env, { name: "UNIQUE_ARCHIVE_PERSON" });
  await save(env, a);
  const stale = await lifecycle(env, "archive", a.body.submissionId);
  await save(env, edit(a, 1, { message: "changed" }));
  await callback(env, stale);
  assert.equal(rows(db)[0].archived_at, null);
  const expired = await lifecycle(env, "archive", a.body.submissionId);
  db.sqlite.exec("UPDATE rsvp_lifecycle_confirmations SET expires_at=0");
  await callback(env, expired);
  assert.equal(rows(db)[0].archived_at, null);
  const cancel = await lifecycle(env, "archive", a.body.submissionId);
  await callback(env, cancel.replace("l:", "x:"));
  await callback(env, cancel);
  assert.equal(rows(db)[0].archived_at, null);
  await callback(env, await lifecycle(env, "archive", a.body.submissionId));
  for (const cmd of ["/guests", "/drinks", "/parking", "/export"]) {
    telegram = [];
    await command(env, cmd);
    assert.ok(!JSON.stringify(telegram).includes("UNIQUE_ARCHIVE_PERSON"));
  }
  assert.equal(
    db.sqlite
      .prepare(
        "SELECT count(*) n FROM rsvp_outbox WHERE state IN ('pending','sending')",
      )
      .get().n,
    0,
  );
  telegram = [];
  await command(env, "/archived");
  assert.ok(JSON.stringify(telegram).includes("UNIQUE_ARCHIVE_PERSON"));
  db.close();
});

test("Final build supports confirmed individual erase, cascades receipts, invalidates old identity, excludes bulk handlers", async () => {
  const db = database(),
    env = envFor(db),
    a = await identity(env);
  await save(env, a);
  const token = await lifecycle(env, "erase", a.body.submissionId, production);
  await callback(env, token, 22222, updateNumber++, production);
  assert.equal(rows(db).length, 1);
  await callback(env, token, 11111, updateNumber++, production);
  assert.equal(rows(db).length, 0);
  assert.equal(
    db.sqlite.prepare("SELECT count(*) n FROM rsvp_requests").get().n,
    0,
  );
  assert.equal(
    db.sqlite.prepare("SELECT count(*) n FROM rsvp_outbox").get().n,
    0,
  );
  assert.equal((await save(env, a)).status, 410);
  const source = fs.readFileSync(
    new URL("../worker/wedding-rsvp-api.production.js", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("/clear_test"));
  assert.ok(!source.includes("handleTestAdmin"));
  db.close();
});

test("0002 preserves existing v2 answers, receipts, identity and revision", async () => {
  const db = new D1Local();
  db.sqlite.exec(legacySql);
  db.migrate();
  db.sqlite
    .prepare(
      "INSERT INTO rsvp_responses(id,name,attending,edit_token_hash,revision) VALUES(?,?,?,?,?)",
    )
    .run(uuid(), "Legacy", NO, "HASH", 9);
  const before = rows(db)[0];
  db.migrateArchive();
  const after = rows(db)[0];
  assert.equal(after.archived_at, null);
  delete after.archived_at;
  assert.deepEqual(after, before);
  db.close();
});

test("Reopened rejection at full capacity consumes no space and approval remains blocked", async () => {
  const db = database(),
    env = envFor(db),
    a = await identity(env, { carCount: 8 }),
    b = await identity(env, { carCount: 1 });
  await save(env, a);
  await save(env, b);
  await callback(env, `p:r:${b.body.submissionId}:1`);
  await callback(env, `p:a:${a.body.submissionId}:1`);
  await callback(env, `p:u:${b.body.submissionId}:2`);
  assert.equal(
    rows(db).find((r) => r.id === b.body.submissionId).parking_status,
    "pending",
  );
  await callback(env, `p:a:${b.body.submissionId}:3`);
  assert.equal(
    rows(db).find((r) => r.id === b.body.submissionId).parking_status,
    "pending",
  );
  db.close();
});

test("Concurrent archive confirmation and owner edit serialize without overwriting archived answers", async () => {
  const db = database(),
    env = envFor(db),
    a = await identity(env);
  await save(env, a);
  const token = await lifecycle(env, "archive", a.body.submissionId);
  await Promise.all([
    callback(env, token),
    save(env, edit(a, 1, { message: "racing edit" })),
  ]);
  const row = rows(db)[0];
  assert.equal(row.revision, 2);
  if (row.archived_at) {
    assert.equal(row.message, "До встречи");
    assert.equal((await save(env, a)).data.error, "RESPONSE_ARCHIVED");
  } else assert.equal(row.message, "racing edit");
  db.close();
});

for (const count of [1, 7])
  test(`Archive ${count} approved cars releases exactly those places; two-admin restore races cannot approve`, async () => {
    const db = database(),
      env = envFor(db),
      a = await identity(env, { carCount: count }),
      b = await identity(env, { carCount: 8 - count });
    await save(env, a);
    await save(env, b);
    await callback(env, `p:a:${a.body.submissionId}:1`);
    await callback(env, `p:a:${b.body.submissionId}:1`);
    await callback(env, await lifecycle(env, "archive", a.body.submissionId));
    const sum = () =>
      db.sqlite
        .prepare(
          "SELECT coalesce(sum(cars_requested),0) n FROM rsvp_responses WHERE archived_at IS NULL AND parking_status='approved'",
        )
        .get().n;
    assert.equal(sum(), 8 - count);
    const t1 = await lifecycle(env, "restore", a.body.submissionId);
    await command(env, "/restore " + a.body.submissionId, 22222);
    const t2 =
      telegram.at(-1).data.reply_markup.inline_keyboard[0][0].callback_data;
    await Promise.all([callback(env, t1), callback(env, t2, 22222)]);
    const row = rows(db).find((r) => r.id === a.body.submissionId);
    assert.equal(row.revision, 4);
    assert.equal(row.parking_status, "pending");
    assert.equal(sum(), 8 - count);
    db.close();
  });

test("No parking request restores not_requested; public callers and group admins cannot archive", async () => {
  const db = database(),
    env = envFor(db),
    a = await identity(env, { attending: NO });
  await save(env, a);
  const token = await lifecycle(env, "archive", a.body.submissionId);
  await telegramUpdate(env, {
    update_id: updateNumber++,
    callback_query: {
      id: "group",
      data: token,
      from: { id: 11111 },
      message: { chat: { id: -1, type: "group" }, message_id: 1 },
    },
  });
  assert.equal(rows(db)[0].archived_at, null);
  assert.equal(
    (await call(env, "/archive", "POST", { id: a.body.submissionId }, a.secret))
      .status,
    404,
  );
  await callback(env, token);
  await callback(env, await lifecycle(env, "restore", a.body.submissionId));
  assert.equal(rows(db)[0].parking_status, "not_requested");
  db.close();
});
