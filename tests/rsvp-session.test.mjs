import test from "node:test";
import assert from "node:assert/strict";
import { openRsvpSession } from "../rsvp-session.mjs";
const storage = () => {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
  };
};
const endpoint = "https://worker.test/rsvp",
  pageUrl = "https://zakkhorren.github.io/wedding/";
const answer = {
  name: "Компания",
  attending: "Да, конечно!",
  guestCount: 2,
  additionalGuests: "Еще гость",
  drinks: ["Виски"],
  parking: "no",
  message: "Привет",
  consent: true,
};
function service() {
  const rows = new Map(),
    receipts = new Map(),
    calls = [];
  let failAfterSave = false,
    epoch = "epoch-1";
  return {
    rows,
    calls,
    get epoch() {
      return epoch;
    },
    clear() {
      rows.clear();
      receipts.clear();
      epoch = "epoch-2";
    },
    loseNextResponse() {
      failAfterSave = true;
    },
    async fetcher(url, options) {
      calls.push({ url, options });
      if (url.endsWith("/bootstrap"))
        return Response.json({ ok: true, protocol: 2, epoch });
      const secret = options.headers.Authorization?.slice(7);
      if (options.method === "GET") {
        const id = url.split("/").at(-1),
          row = rows.get(id);
        return row
          ? Response.json(row.result)
          : Response.json({ error: "RESPONSE_NOT_FOUND" }, { status: 404 });
      }
      const body = JSON.parse(options.body);
      if (receipts.has(body.requestId))
        return Response.json(receipts.get(body.requestId));
      if (body.epoch !== epoch)
        return Response.json({ error: "STALE_IDENTITY" }, { status: 410 });
      if (body.turnstileToken === "expired")
        return Response.json({ error: "TURNSTILE_RETRY" }, { status: 400 });
      const result = {
        ok: true,
        saved: true,
        submissionId: body.submissionId,
        revision: body.revision + 1,
        epoch,
        answer: body,
      };
      rows.set(body.submissionId, { secret, result });
      receipts.set(body.requestId, result);
      if (failAfterSave) {
        failAfterSave = false;
        throw Error("network lost after commit");
      }
      return Response.json(result);
    },
  };
}
test("Identity persists; private edit link is stripped before network and works on another device", async () => {
  const store = storage(),
    server = service(),
    session = await openRsvpSession({
      endpoint,
      storage: store,
      pageUrl,
      fetcher: server.fetcher,
    });
  await session.save(answer, async () => "valid");
  const same = await openRsvpSession({
    endpoint,
    storage: store,
    pageUrl,
    fetcher: server.fetcher,
  });
  assert.equal(same.submissionId, session.submissionId);
  assert.equal((await same.restore()).revision, 1);
  const link = session.editLink();
  assert.equal(new URL(link).search, "");
  assert.ok(new URL(link).hash.includes("edit_key"));
  let stripped = false;
  const imported = await openRsvpSession({
    endpoint,
    storage: storage(),
    pageUrl: link,
    history: {
      replaceState(a, b, url) {
        assert.equal(new URL(url).hash, "");
        stripped = true;
      },
    },
    fetcher: async (...args) => {
      assert.ok(stripped);
      return server.fetcher(...args);
    },
  });
  assert.equal(imported.submissionId, session.submissionId);
  assert.equal(
    (await imported.save({ ...answer, guestCount: 3 }, async () => "fresh"))
      .revision,
    2,
  );
  for (const call of server.calls) {
    assert.ok(!call.url.includes("edit_key") && !call.url.includes("#"));
    assert.equal(call.options.referrerPolicy, "no-referrer");
    assert.equal(call.options.redirect, "error");
  }
});
test("Network loss after commit/reload retains request ID and never creates a second response", async () => {
  const store = storage(),
    server = service();
  let session = await openRsvpSession({
    endpoint,
    storage: store,
    pageUrl,
    fetcher: server.fetcher,
  });
  server.loseNextResponse();
  await assert.rejects(
    session.save(answer, async () => "valid"),
    { code: "NETWORK_RETRY" },
  );
  const first = JSON.parse(server.calls.at(-1).options.body);
  session = await openRsvpSession({
    endpoint,
    storage: store,
    pageUrl,
    fetcher: server.fetcher,
  });
  await session.save(answer, async () => "fresh");
  assert.equal(
    JSON.parse(server.calls.at(-1).options.body).requestId,
    first.requestId,
  );
  assert.equal(server.rows.size, 1);
});
test("Expired token retains pending identity; changed payload requires explicit restore", async () => {
  const server = service(),
    session = await openRsvpSession({
      endpoint,
      storage: storage(),
      pageUrl,
      fetcher: server.fetcher,
    });
  await assert.rejects(
    session.save(answer, async () => "expired"),
    { code: "TURNSTILE_RETRY" },
  );
  await assert.rejects(
    session.save({ ...answer, guestCount: 3 }, async () => "valid"),
    { code: "PENDING_REQUEST_RETRY_OR_RESTORE" },
  );
  assert.equal((await session.save(answer, async () => "fresh")).saved, true);
});
test("Deleted test identity cannot silently recreate data; guest must explicitly start again", async () => {
  const server = service(),
    session = await openRsvpSession({
      endpoint,
      storage: storage(),
      pageUrl,
      fetcher: server.fetcher,
    });
  await session.save(answer, async () => "valid");
  const old = session.submissionId;
  server.clear();
  await assert.rejects(session.restore(), { code: "RESPONSE_DELETED" });
  await assert.rejects(session.startNewAfterDeletion(false), {
    code: "EXPLICIT_NEW_RESPONSE_REQUIRED",
  });
  await session.startNewAfterDeletion(true);
  assert.notEqual(session.submissionId, old);
  assert.equal((await session.save(answer, async () => "fresh")).saved, true);
});
test("Blocked storage fails before any personal data can be submitted", async () => {
  await assert.rejects(
    openRsvpSession({
      endpoint,
      pageUrl,
      storage: {
        getItem() {
          return null;
        },
        setItem() {
          throw Error("blocked");
        },
      },
      fetcher: async () =>
        Response.json({ ok: true, protocol: 2, epoch: "test" }),
    }),
    { code: "LOCAL_IDENTITY_UNAVAILABLE" },
  );
});

test("Deleted imported edit link offers explicit new identity without reusing the old ID", async () => {
  const server = service(),
    first = await openRsvpSession({
      endpoint,
      storage: storage(),
      pageUrl,
      fetcher: server.fetcher,
    });
  await first.save(answer, async () => "valid");
  const old = first.submissionId,
    link = first.editLink();
  server.clear();
  await assert.rejects(
    openRsvpSession({
      endpoint,
      storage: storage(),
      pageUrl: link,
      history: { replaceState() {} },
      fetcher: server.fetcher,
    }),
    { code: "RESPONSE_DELETED" },
  );
  const fresh = await openRsvpSession({
    endpoint,
    storage: storage(),
    pageUrl: link,
    history: { replaceState() {} },
    fetcher: server.fetcher,
    confirmNewAfterDeletedLink: true,
  });
  assert.notEqual(fresh.submissionId, old);
  assert.equal((await fresh.save(answer, async () => "valid")).saved, true);
});

test("Pending answer is a detached snapshot for recovery UI; blocked localStorage getter fails safely", async () => {
  const server = service(),
    store = storage();
  const session = await openRsvpSession({
    endpoint,
    storage: store,
    pageUrl,
    fetcher: server.fetcher,
  });
  await assert.rejects(
    session.save(answer, async () => {
      throw { code: "TURNSTILE_UNAVAILABLE" };
    }),
    { code: "TURNSTILE_UNAVAILABLE" },
  );
  const pending = session.pendingAnswer;
  assert.equal(pending.name, answer.name);
  pending.name = "modified copy";
  assert.equal(session.pendingAnswer.name, answer.name);
  await session.save(answer, async () => "valid");
  assert.equal(session.pendingAnswer, null);
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked storage");
      },
    });
    await assert.rejects(
      openRsvpSession({ endpoint, pageUrl, fetcher: server.fetcher }),
      { code: "LOCAL_IDENTITY_UNAVAILABLE" },
    );
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});
