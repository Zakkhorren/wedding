import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import fs from "node:fs";
import assert from "node:assert/strict";
const origin = "https://zakkhorren.github.io";
const notices = [];
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: "worker/wedding-rsvp-api.js",
    compatibilityDate: "2026-10-28",
    d1Databases: ["DB"],
    bindings: {
      ALLOWED_ORIGIN: origin,
      ADMIN_IDS: "11111,22222",
      BOT_TOKEN: "TEST_ONLY",
      WEBHOOK_SECRET: "TEST_ONLY_WEBHOOK",
      TURNSTILE_SECRET: "TEST_ONLY_TURNSTILE",
      ENABLE_TEST_DELETIONS: "true",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "challenges.cloudflare.com")
        return Response.json({
          success: true,
          hostname: new URL(origin).hostname,
          action: "rsvp",
        });
      if (url.hostname === "api.telegram.org") {
        notices.push(await request.json());
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      throw Error("Unexpected network request");
    },
  }),
);
function statements(file) {
  const source = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  let buffer = "",
    trigger = false,
    result = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("--")) continue;
    if (/^CREATE TRIGGER/i.test(line.trim())) trigger = true;
    buffer += line + "\n";
    if (
      (!trigger && line.trim().endsWith(";")) ||
      (trigger && line.trim() === "END;")
    ) {
      result.push(buffer);
      buffer = "";
      trigger = false;
    }
  }
  if (buffer.trim()) throw Error("Unparsed SQL");
  return result;
}
try {
  const db = await mf.getD1Database("DB");
  await db.batch(
    statements("tests/fixtures/legacy-schema.sql").map((sql) =>
      db.prepare(sql),
    ),
  );
  await db
    .prepare("INSERT INTO rsvp_responses(id,name,attending) VALUES(?,?,?)")
    .bind(crypto.randomUUID(), "Legacy", "Да, конечно!")
    .run();
  await db.batch(
    statements("worker/migrations/0001_rsvp_v2.sql").map((sql) =>
      db.prepare(sql),
    ),
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM rsvp_responses").first()).n,
    1,
  );
  const meta = await (
    await mf.dispatchFetch("https://worker.test/rsvp/bootstrap", {
      headers: { Origin: origin },
    })
  ).json();
  const payloads = [];
  const ids = [crypto.randomUUID(), crypto.randomUUID()],
    keys = ids.map(() =>
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64url",
      ),
    );
  for (let i = 0; i < 2; i++) {
    const payload = {
      submissionId: ids[i],
      requestId: crypto.randomUUID(),
      revision: 0,
      epoch: meta.epoch,
      name: "Runtime company",
      attending: "Да, конечно!",
      guestCount: 3,
      drinks: ["Виски"],
      parking: "yes",
      carCount: i ? 4 : 5,
      consent: true,
      turnstileToken: "mock",
    };
    payloads.push(payload);
    const response = await mf.dispatchFetch("https://worker.test/rsvp", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Authorization: "Bearer " + keys[i],
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.saved, true);
  }
  await Promise.all(
    ids.map((id, i) =>
      mf.dispatchFetch("https://worker.test/telegram", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "TEST_ONLY_WEBHOOK",
        },
        body: JSON.stringify({
          update_id: 100 + i,
          callback_query: {
            id: "callback-" + i,
            data: `p:a:${id}:1`,
            from: { id: i ? 22222 : 11111 },
            message: { message_id: 1, chat: { id: i ? 22222 : 11111, type: "private" } },
          },
        }),
      }),
    ),
  );
  const used = await db
    .prepare(
      "SELECT SUM(cars_requested) n FROM rsvp_responses WHERE parking_status='approved'",
    )
    .first();
  assert.ok(used.n <= 8 && used.n >= 4);
  const read = await mf.dispatchFetch("https://worker.test/rsvp/" + ids[0], {
    headers: { Origin: origin, Authorization: "Bearer " + keys[0] },
  });
  assert.equal(read.status, 200);
  const current = await read.json();
  const revised = {
    ...payloads[0],
    requestId: crypto.randomUUID(),
    revision: current.revision,
    guestCount: 2,
    message: "Edited in workerd",
  };
  const changed = await mf.dispatchFetch("https://worker.test/rsvp", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Authorization: "Bearer " + keys[0],
    },
    body: JSON.stringify(revised),
  });
  const updated = await changed.json();
  assert.equal(changed.status, 200, JSON.stringify(updated));
  assert.equal(updated.parkingStatus, current.parkingStatus);
  const again = await mf.dispatchFetch("https://worker.test/rsvp", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Authorization: "Bearer " + keys[0],
    },
    body: JSON.stringify(revised),
  });
  assert.equal((await again.json()).revision, updated.revision);
  async function admin(update) {
    const response = await mf.dispatchFetch("https://worker.test/telegram", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "TEST_ONLY_WEBHOOK",
      },
      body: JSON.stringify(update),
    });
    assert.equal(response.status, 200);
  }
  await admin({
    update_id: 200,
    message: {
      text: "/delete " + ids[0],
      from: { id: 11111 },
      chat: { id: 11111, type: "private" },
    },
  });
  const prompt = notices.findLast((n) =>
    n.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith("d:"),
  );
  assert.ok(prompt?.reply_markup);
  await admin({
    update_id: 201,
    callback_query: {
      id: "delete-confirm",
      data: prompt.reply_markup.inline_keyboard[0][0].callback_data,
      from: { id: 11111 },
      message: { chat: { id: 11111, type: "private" }, message_id: 1 },
    },
  });
  assert.equal(
    await db
      .prepare("SELECT id FROM rsvp_responses WHERE id=?")
      .bind(ids[0])
      .first(),
    null,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM rsvp_requests WHERE response_id=?")
        .bind(ids[0])
        .first()
    ).n,
    0,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM rsvp_outbox WHERE response_id=?")
        .bind(ids[0])
        .first()
    ).n,
    0,
  );
  console.log(
    "PASS: real workerd/Miniflare D1 migration preserves legacy row; create/read/edit/retry; concurrent approvals <=8; confirmed deletion and FK cascade; all external calls mocked",
  );
} finally {
  await mf.dispose();
}
