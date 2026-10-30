// Transport regression ONLY. Actual Turnstile and remote E2E are verified by
// a human in an ordinary browser, never claimed from this mocked automation.
import { chromium } from "playwright";
import assert from "node:assert/strict";
import {
  buildManualPage,
  manualUrl,
  manualEndpoint,
  manualOrigin,
} from "../scripts/manual-rsvp-bundle.mjs";
import {
  routePreview,
  routeLocalWorker,
  localPreviewWorker,
} from "../scripts/rsvp-preview-support.mjs";
const html = buildManualPage("0x4AAAAAA_PUBLIC_TEST_PLACEHOLDER");
const browser = await chromium.launch(),
  { mf, db } = await localPreviewWorker();
const errors = [],
  requests = [];
async function context() {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  await routePreview(ctx);
  await routeLocalWorker(ctx, mf); // LOCAL test fixtures, not used in the manual generator.
  await ctx.route("https://fonts.googleapis.com/**", (r) =>
    r.fulfill({ contentType: "text/css", body: "" }),
  );
  await ctx.route(manualOrigin + "/wedding/**", async (route) => {
    if (route.request().resourceType() === "document")
      await route.fulfill({ contentType: "text/html", body: html });
    else await route.fallback();
  });
  ctx.on("page", (page) => {
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => requests.push(r));
  });
  return ctx;
}
try {
  const first = await context(),
    page = await first.newPage();
  await page.goto(manualUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !document.querySelector("#rsvp-submit").disabled,
  );
  await page.locator("[name=name]").fill("Manual bundle transport");
  await page.locator('[name=attending][value="Да, конечно!"]').check();
  await page.locator("#guest-plus").click();
  await page.locator("[name=additionalGuests]").fill("Test guest");
  await page.locator("[name=parking][value=no]").check();
  await page.locator("[name=consent]").check();
  await page.locator("#rsvp-submit").click();
  await page.locator("#rsvp-success").waitFor({ state: "visible" });
  const link = await page.locator("#rsvp-link").inputValue();
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM rsvp_responses").first()).n,
    1,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#rsvp-success").waitFor({ state: "visible" });
  const second = await context(),
    other = await second.newPage();
  await other.goto(link, { waitUntil: "domcontentloaded" });
  await other.locator("#rsvp-success").waitFor({ state: "visible" });
  assert.ok(new URL(other.url()).hash === "", "Private fragment not cleared");
  await other.locator("#edit-answer").click();
  assert.equal(await other.locator("[name=guestCount]").inputValue(), "2");
  await other
    .locator("[name=message]")
    .fill("Edited without an external module request");
  await other.locator("#rsvp-submit").click();
  await other.locator("#rsvp-success").waitFor({ state: "visible" });
  assert.equal(
    (await db.prepare("SELECT count(*) n FROM rsvp_responses").first()).n,
    1,
  );
  assert.ok(
    !requests.some(
      (r) =>
        new URL(r.url()).origin === manualOrigin &&
        /\.(js|mjs|css)$/.test(new URL(r.url()).pathname),
    ),
  );
  const apiRequests = requests.filter((r) =>
    r.url().startsWith(manualEndpoint),
  );
  assert.ok(apiRequests.length > 0);
  assert.ok(apiRequests.every((r) => r.headers().origin === manualOrigin));
  assert.ok(requests.every((r) => !r.url().includes("edit_key=")));
  assert.deepEqual(errors, []);
  await first.close();
  await second.close();
  const closed = await context(),
    disabled = await closed.newPage();
  const previous = requests.filter((r) =>
    r.url().startsWith(manualEndpoint),
  ).length;
  await disabled.goto(manualOrigin + "/wedding/", {
    waitUntil: "domcontentloaded",
  });
  assert.equal(
    requests.filter((r) => r.url().startsWith(manualEndpoint)).length,
    previous,
  );
  assert.match(
    (await disabled.locator("#mode-note").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /Демо/,
  );
  await closed.close();
  console.log(
    "PASS: prepared HTML loads unchanged UI, create/restore/another-browser edit through LOCAL Worker/D1, no module 404s, same browser Origin; real challenge/E2E NOT tested by automation",
  );
} finally {
  await browser.close();
  await mf.dispose();
}
