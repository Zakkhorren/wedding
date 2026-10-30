// Production URLs are intercepted before network: LOCAL final Worker/D1 only.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import {
  routePreview,
  routeLocalWorker,
  localPreviewWorker,
  previewEndpoint,
} from "../scripts/rsvp-preview-support.mjs";

const endpoint = "https://wedding-rsvp-api.zakk-horren.workers.dev/rsvp";
const url = "https://zakkhorren.github.io/wedding/";
const storageKey = "wedding.rsvp.v2:" + endpoint;
const browser = await chromium.launch();
const { mf, db } = await localPreviewWorker({ production: true });
const contexts = [];
const errors = [];
async function context({ maintenance = false, missingKey = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  contexts.push(ctx);
  // Fail closed: no request can reach Cloudflare, Telegram or the public site.
  await ctx.route("**/*", (route) => route.abort());
  await routePreview(ctx, {
    production: true,
    maintenance,
    sitekey: missingKey ? "" : "LOCAL_PREVIEW",
  });
  await routeLocalWorker(ctx, mf, endpoint);
  ctx.on("page", (page) => page.on("pageerror", (e) => errors.push(e.message)));
  return ctx;
}
async function ready(page) {
  await page.waitForFunction(
    () => !document.querySelector("#rsvp-submit").disabled,
  );
}
async function saved(page) {
  await page.locator("#rsvp-success").waitFor({ state: "visible" });
  assert.equal(await page.locator("#rsvp-feedback").isHidden(), true);
}
async function count() {
  return (await db.prepare("SELECT COUNT(*) n FROM rsvp_responses").first()).n;
}
try {
  const ctx = await context();
  // Existing TEST pending state must never seed production answers/identity.
  await ctx.addInitScript(
    ({ key }) => {
      if (location.origin === "https://zakkhorren.github.io")
        localStorage.setItem(key, '{"sentinel":"TEST_PENDING"}');
    },
    { key: "wedding.rsvp.v2:" + previewEndpoint },
  );
  const page = await ctx.newPage();
  const requests = [];
  page.on("request", (req) => requests.push(req.url()));
  await page.goto(url);
  await ready(page);
  assert.equal(await page.locator("[name=name]").inputValue(), "");
  assert.match(await page.locator("#mode-note").textContent(), /организаторам/);
  await page.locator("[name=name]").fill("Локальная production-проверка");
  await page.locator('[name=attending][value="Да, конечно!"]').check();
  await page.locator("#guest-plus").click();
  await page.locator("[name=additionalGuests]").fill("Второй участник");
  await page.locator("[name=parking][value=yes]").check();
  await page.locator("[name=carCount]").fill("2");
  await page.locator('[name=drinks][value="Ром"]').check();
  await page.locator("[name=consent]").check();
  await page.locator("#rsvp-submit").click();
  await saved(page);
  const link = await page.locator("#rsvp-link").inputValue();
  assert.equal(new URL(link).search, "");
  assert.ok(new URL(link).hash.includes("edit_key="));
  assert.equal(await count(), 1);
  const identity = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storageKey,
  );
  const row = await db
    .prepare(
      "SELECT guest_count,cars_requested,parking_status FROM rsvp_responses",
    )
    .first();
  assert.deepEqual(
    [row.guest_count, row.cars_requested, row.parking_status],
    [2, 2, "pending"],
  );
  await page.reload();
  await saved(page);
  assert.equal(await count(), 1);
  const second = await (await context()).newPage();
  await second.goto(link);
  await saved(second);
  assert.equal(new URL(second.url()).hash, "");
  await second.locator("#edit-answer").click();
  await second.locator("[name=message]").fill("Изменено на другом устройстве");
  await second.locator("#rsvp-submit").click();
  await saved(second);
  assert.equal(await count(), 1);
  assert.equal(
    (await db.prepare("SELECT revision FROM rsvp_responses").first()).revision,
    2,
  );
  for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
    await second.setViewportSize({ width, height: 900 });
    await second.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    assert.ok(
      await second.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "overflow " + width,
    );
    await second
      .locator("#rsvp-success")
      .screenshot({
        path: `.qa/production-success-${width}.png`,
        mask: [second.locator("#rsvp-link")],
      });
  }
  assert.ok(
    requests.every(
      (u) =>
        !u.includes("edit_key") &&
        !u.includes(identity.key) &&
        !u.startsWith(previewEndpoint),
    ),
  );
  // Maintenance preserves identity/pending byte-for-byte and never calls API.
  for (const options of [
    { maintenance: true },
    { missingKey: true },
    { testLink: true },
  ]) {
    const blockedCtx = await context(options);
    await blockedCtx.addInitScript(
      ({ key }) => {
        if (location.origin === "https://zakkhorren.github.io")
          localStorage.setItem(key, '"PRESERVE_PENDING"');
      },
      { key: storageKey },
    );
    const blocked = await blockedCtx.newPage();
    const apiRequests = [];
    blocked.on("request", (r) => {
      if (r.url().startsWith(endpoint)) apiRequests.push(r.url());
    });
    await blocked.goto(
      options.testLink
        ? link.replace("/wedding/", "/wedding/?rsvp_preview=1")
        : url,
    );
    await blocked.locator('#rsvp-status[role="alert"]').waitFor();
    assert.equal(await blocked.locator("#rsvp-submit").isDisabled(), true);
    assert.equal(await blocked.locator("#rsvp-success").isHidden(), true);
    assert.deepEqual(apiRequests, []);
    assert.equal(
      await blocked.evaluate((key) => localStorage.getItem(key), storageKey),
      '"PRESERVE_PENDING"',
    );
  }
  assert.equal(await count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: production ordinary URL, final Worker + 0001/0002 LOCAL D1, create/restore/another-device edit, one record, 7 widths; TEST link/state isolation, maintenance and missing sitekey fail closed. No remote requests.",
  );
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
  await mf.dispose();
}
