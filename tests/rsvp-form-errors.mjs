import { chromium } from "playwright";
import assert from "node:assert/strict";
import {
  routePreview,
  routeLocalWorker,
  localPreviewWorker,
  previewUrl,
  previewEndpoint,
} from "../scripts/rsvp-preview-support.mjs";
const browser = await chromium.launch(),
  { mf, db } = await localPreviewWorker();
const key = "wedding.rsvp.v2:" + previewEndpoint;
const contexts = [];
let checks = 0;
async function setup() {
  const ctx = await browser.newContext({
    viewport: { width: 320, height: 800 },
    reducedMotion: "reduce",
  });
  contexts.push(ctx);
  await routePreview(ctx, { sitekey: "LOCAL_PREVIEW", local: true });
  await routeLocalWorker(ctx, mf);
  await ctx.route("https://fonts.googleapis.com/**", (r) =>
    r.fulfill({ contentType: "text/css", body: "" }),
  );
  return { ctx, page: await ctx.newPage() };
}
async function ready(page) {
  await page.goto(previewUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !document.querySelector("#rsvp-submit").disabled,
  );
}
async function fill(page) {
  await page.locator("[name=name]").fill("Проверка ошибок");
  await page.locator('[name=attending][value="Да, конечно!"]').check();
  await page.locator("[name=message]").fill("Не терять эти ответы");
  await page.locator("[name=consent]").check();
}
async function retryVisible(page) {
  await page.locator("#rsvp-retry").waitFor({ state: "visible" });
  assert.equal(await page.locator("#rsvp-feedback").isVisible(), true);
  assert.equal(await page.locator("#rsvp-save-announcement").textContent(), "");
}
async function state(page) {
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);
}
async function exists(id) {
  return await db
    .prepare("SELECT id FROM rsvp_responses WHERE id=?")
    .bind(id)
    .first();
}
try {
  const boot = await setup();
  let offline = true;
  await boot.ctx.route(previewEndpoint + "/bootstrap", (r) =>
    offline ? r.abort() : r.fallback(),
  );
  await boot.page.goto(previewUrl, { waitUntil: "domcontentloaded" });
  await retryVisible(boot.page);
  assert.equal(await boot.page.locator("#rsvp-submit").isDisabled(), true);
  offline = false;
  await boot.page.locator("#rsvp-retry").click();
  await boot.page.waitForFunction(
    () => !document.querySelector("#rsvp-submit").disabled,
  );
  await fill(boot.page);
  const attempts = [];
  let expire = true;
  await boot.ctx.route(previewEndpoint, async (r) => {
    attempts.push(JSON.parse(r.request().postData()));
    if (expire) {
      expire = false;
      await r.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "TURNSTILE_RETRY" }),
      });
    } else await r.fallback();
  });
  await boot.page.locator("#rsvp-submit").click();
  await retryVisible(boot.page);
  assert.equal(await boot.page.locator("#rsvp-success").isHidden(), true);
  assert.equal(
    await boot.page.locator("[name=message]").inputValue(),
    "Не терять эти ответы",
  );
  await boot.page.locator("#rsvp-retry").click();
  await boot.page.locator("#rsvp-success").waitFor({ state: "visible" });
  assert.equal(attempts[0].requestId, attempts[1].requestId);
  assert.notEqual(attempts[0].turnstileToken, attempts[1].turnstileToken);
  assert.equal(
    await boot.page.evaluate(() => window.localChallenge.action),
    "rsvp",
  );
  assert.equal(
    await boot.page.evaluate(() => window.localChallenge.size),
    "compact",
  );
  checks += 2;

  const ack = await setup();
  let invalid = true;
  await ack.ctx.route(previewEndpoint, (r) =>
    invalid
      ? r.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, saved: false }),
        })
      : r.fallback(),
  );
  await ready(ack.page);
  await fill(ack.page);
  await ack.page.locator("#rsvp-submit").click();
  await retryVisible(ack.page);
  assert.equal(await ack.page.locator("#rsvp-success").isHidden(), true);
  assert.equal(await exists((await state(ack.page)).id), null);
  invalid = false;
  await ack.page.locator("#rsvp-retry").click();
  await ack.page.locator("#rsvp-success").waitFor({ state: "visible" });
  checks++;

  const captcha = await setup();
  let blockCaptcha = true;
  await captcha.ctx.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    (r) => (blockCaptcha ? r.abort() : r.fallback()),
  );
  await ready(captcha.page);
  await fill(captcha.page);
  await captcha.page.locator("#rsvp-submit").click();
  await retryVisible(captcha.page);
  assert.equal(await captcha.page.locator("#rsvp-success").isHidden(), true);
  const original = (await state(captcha.page)).pending.requestId;
  blockCaptcha = false;
  await captcha.page.locator("#rsvp-retry").click();
  await captcha.page.locator("#rsvp-success").waitFor({ state: "visible" });
  assert.equal((await state(captcha.page)).pending, null);
  assert.ok(original);
  checks++;

  const storage = await setup();
  let calls = 0;
  await storage.ctx.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    }),
  );
  storage.page.on("request", (r) => {
    if (r.url().startsWith(previewEndpoint)) calls++;
  });
  await storage.page.goto(previewUrl, { waitUntil: "domcontentloaded" });
  await storage.page.waitForFunction(
    () =>
      document.querySelector("#rsvp-status").getAttribute("role") === "alert",
  );
  assert.match(
    (await storage.page.locator("#rsvp-status").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /хранилище/,
  );
  assert.equal(calls, 0);
  assert.equal(await storage.page.locator("#rsvp-submit").isDisabled(), true);
  checks++;

  const before = await setup();
  let lose = true;
  await before.ctx.route(previewEndpoint, (r) =>
    lose ? r.abort() : r.fallback(),
  );
  await ready(before.page);
  await fill(before.page);
  await before.page.locator("#rsvp-submit").click();
  await retryVisible(before.page);
  const pending = (await state(before.page)).pending,
    id = (await state(before.page)).id;
  assert.equal(await exists(id), null);
  await before.page.reload({ waitUntil: "domcontentloaded" });
  await retryVisible(before.page);
  assert.equal((await state(before.page)).pending.requestId, pending.requestId);
  assert.equal(
    await before.page.locator("[name=message]").inputValue(),
    "Не терять эти ответы",
  );
  lose = false;
  await before.page.locator("#rsvp-retry").click();
  await before.page.locator("#rsvp-success").waitFor({ state: "visible" });
  assert.ok(await exists(id));
  checks++;
  const malformed = await setup();
  await malformed.page.goto(
    previewUrl.replace("#rsvp", "#rsvp_id=bad&edit_key=bad"),
    { waitUntil: "domcontentloaded" },
  );
  await malformed.page.waitForFunction(
    () =>
      document.querySelector("#rsvp-status").getAttribute("role") === "alert",
  );
  assert.equal(new URL(malformed.page.url()).hash, "");
  assert.match(
    (await malformed.page.locator("#rsvp-status").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /повреждена/,
  );
  assert.equal(await malformed.page.locator("#rsvp-new").isHidden(), true);
  checks++;
  const wrong = await setup();
  const wrongUrl = new URL(previewUrl);
  wrongUrl.hash = new URLSearchParams({
    rsvp_id: (await state(boot.page)).id,
    edit_key: "Z".repeat(43),
  }).toString();
  await wrong.page.goto(wrongUrl.href, { waitUntil: "domcontentloaded" });
  await wrong.page.waitForFunction(
    () =>
      document.querySelector("#rsvp-status").getAttribute("role") === "alert",
  );
  assert.equal(new URL(wrong.page.url()).hash, "");
  assert.match(
    (await wrong.page.locator("#rsvp-status").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /недействительна/,
  );
  assert.equal(await wrong.page.locator("#rsvp-new").isHidden(), true);
  checks++;
  const stale = await setup();
  await ready(stale.page);
  await fill(stale.page);
  const staleId = (await state(stale.page)).id;
  await db
    .prepare(
      "UPDATE rsvp_control SET epoch=lower(hex(randomblob(16))) WHERE singleton=1",
    )
    .run();
  await stale.page.locator("#rsvp-submit").click();
  await stale.page.locator("#rsvp-new").waitFor({ state: "visible" });
  assert.equal(await exists(staleId), null);
  stale.page.once("dialog", (dialog) => dialog.accept());
  await stale.page.locator("#rsvp-new").click();
  await stale.page.waitForFunction(
    () => !document.querySelector("#rsvp-submit").disabled,
  );
  assert.notEqual((await state(stale.page)).id, staleId);
  assert.equal(await exists((await state(stale.page)).id), null);
  checks++;
  console.log(
    "PASS: " +
      checks +
      " real-form error scenarios: offline, captcha/storage, missing acknowledgement, pending retry, invalid links and stale identity",
  );
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
  await mf.dispose();
}
