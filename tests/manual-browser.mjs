import { createLocalRuntime } from "../scripts/local-runtime.mjs";
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
const root = process.cwd();
const server = http.createServer((req, res) => {
  const name = new URL(req.url, "http://localhost").pathname,
    file = path.resolve(root, "." + name);
  try {
    if (!file.startsWith(root + path.sep)) throw Error();
    res.setHeader(
      "Content-Type",
      name.endsWith(".mjs") || name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(fs.readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const mf = createLocalRuntime({
  modules: true,
  scriptPath: "worker/wedding-rsvp-api.js",
  d1Databases: ["DB"],
  bindings: {
    ALLOWED_ORIGIN: origin,
    ADMIN_IDS: "11111",
    BOT_TOKEN: "TEST_ONLY",
    WEBHOOK_SECRET: "TEST_ONLY_WEBHOOK",
    TURNSTILE_SECRET: "TEST_ONLY",
  },
  outboundService: async (request) => {
    if (new URL(request.url).hostname === "challenges.cloudflare.com")
      return Response.json({
        success: true,
        hostname: "127.0.0.1",
        action: "rsvp",
      });
    return Response.json({ ok: true, result: { message_id: 1 } });
  },
});
function statements(file) {
  let buffer = "",
    trigger = false,
    result = [];
  for (const line of fs
    .readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)) {
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
  return result;
}
const browser = await chromium.launch();
try {
  const db = await mf.getD1Database("DB");
  for (const file of [
    "tests/fixtures/legacy-schema.sql",
    "worker/migrations/0001_rsvp_v2.sql",
    "worker/migrations/0002_archive_lifecycle.sql",
  ])
    await db.batch(statements(file).map((sql) => db.prepare(sql)));
  async function context() {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    await context.route("https://worker.test/**", async (route) => {
      const request = route.request(),
        headers = new Headers(request.headers());
      headers.set("Origin", origin);
      const response = await mf.dispatchFetch(request.url(), {
        method: request.method(),
        headers,
        ...(request.postData() ? { body: request.postData() } : {}),
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    await context.route(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
      (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: "window.turnstile={render:(el,options)=>{window.testChallenge=options;queueMicrotask(()=>options.callback('valid'));return 'test-widget'},reset:()=>queueMicrotask(()=>window.testChallenge.callback('fresh'))}",
        }),
    );
    return context;
  }
  const first = await context(),
    page = await first.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/tests/manual-api.html");
  await page.locator("#endpoint").fill("https://worker.test/rsvp");
  await page.locator("#sitekey").fill("PUBLIC_TEST_KEY");
  await page.locator("#connect").click();
  await page.locator("#test-form").waitFor({ state: "visible" });
  await page.locator("[name=name]").fill("Техническая компания");
  await page.locator("[name=guestCount]").fill("3");
  await page.locator("[name=consent]").check();
  await page.locator("#save").click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("База подтвердила"),
  );
  const link = await page.locator("#edit-link").inputValue();
  assert.ok(new URL(link).hash.includes("edit_key"));
  const second = await context(),
    other = await second.newPage();
  other.on("pageerror", (e) => errors.push(e.message));
  await other.goto(link);
  await other.locator("#endpoint").fill("https://worker.test/rsvp");
  await other.locator("#sitekey").fill("PUBLIC_TEST_KEY");
  await other.locator("#connect").click();
  await other.waitForFunction(
    () => document.querySelector("#status").textContent === "Анкета загружена.",
  );
  assert.equal(await other.evaluate(() => location.hash), "");
  assert.equal(await other.locator("[name=guestCount]").inputValue(), "3");
  await other.locator("[name=guestCount]").fill("2");
  await other.locator("#save").click();
  await other.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("База подтвердила"),
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM rsvp_responses").first()).n,
    1,
  );
  assert.equal(
    (await db.prepare("SELECT guest_count FROM rsvp_responses").first())
      .guest_count,
    2,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: manual test page in Chromium + real workerd/D1, create 3 guests, private fragment link on another device, restore/edit to 2 guests, one DB record, no JS errors",
  );
} finally {
  await browser.close();
  await mf.dispose();
  server.close();
}
