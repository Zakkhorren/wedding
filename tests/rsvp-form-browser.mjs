import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  routePreview,
  routeLocalWorker,
  localPreviewWorker,
  previewUrl,
  previewOrigin,
  previewEndpoint,
} from "../scripts/rsvp-preview-support.mjs";
const browser = await chromium.launch();
const { mf, db } = await localPreviewWorker();
const problems = [];
let checks = 0;
const storageKey = "wedding.rsvp.v2:" + previewEndpoint;
async function context(options = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await routePreview(ctx, {
    sitekey: options.missingKey ? "" : "LOCAL_PREVIEW",
    enabled: options.enabled !== false,
    local: true,
  });
  await routeLocalWorker(ctx, mf);
  ctx.on("page", (page) =>
    page.on("pageerror", (error) => problems.push(error.message)),
  );
  return ctx;
}
async function ready(page, url = previewUrl) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      !document.querySelector("#rsvp-submit").disabled ||
      document.querySelector(
        "#rsvp-retry:not([hidden]),#rsvp-new:not([hidden])",
      ) ||
      document.querySelector("#rsvp-status").getAttribute("role") === "alert",
  );
}
async function fill(page) {
  await page.locator("[name=name]").fill("Тестовая семья");
  await page.locator('[name=attending][value="Да, конечно!"]').check();
  await page.locator("#guest-plus").click();
  await page.locator("#guest-plus").click();
  await page.locator("[name=additionalGuests]").fill("Соня, Лёша");
  await page.locator("[name=parking][value=yes]").check();
  await page.locator("[name=carCount]").fill("2");
  await page.locator('[name=drinks][value="Виски"]').check();
  await page.locator('[name=drinks][value="Ром"]').check();
  await page.locator("[name=otherDrink]").fill("Сидр");
  await page.locator("[name=message]").fill("До встречи!");
  await page.locator("[name=consent]").check();
}
async function saved(page) {
  await page.locator("#rsvp-success").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#rsvp-success").getAttribute("role"),
    "region",
  );
  assert.equal(
    await page.locator("#rsvp-success").getAttribute("aria-labelledby"),
    "rsvp-success-title",
  );
  assert.equal(await page.locator("#rsvp-feedback").isHidden(), true);
  assert.equal(await page.locator("#rsvp-feedback").boundingBox(), null);
  assert.equal(await page.locator("#rsvp-status").textContent(), "");
  const announcement = page.locator("#rsvp-save-announcement");
  assert.equal(await announcement.getAttribute("aria-live"), "polite");
  assert.equal(await announcement.getAttribute("aria-atomic"), "true");
  assert.match(await announcement.ariaSnapshot(), /сохранён/);
  assert.equal(
    await announcement.evaluate((el) => getComputedStyle(el).position),
    "absolute",
  );
  assert.equal(
    (await page.locator("#rsvp-success-title").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    "Спасибо за ответ!",
  );
  assert.match(
    (await page.locator("#success-message").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /сохранён/,
  );
}
async function count() {
  return (await db.prepare("SELECT count(*) n FROM rsvp_responses").first()).n;
}
async function state(page) {
  return page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)),
    storageKey,
  );
}
async function post(route) {
  const req = route.request();
  return mf.dispatchFetch(req.url(), {
    method: req.method(),
    headers: req.headers(),
    body: req.postData(),
  });
}
async function deliver(route, response) {
  await route.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  });
}
try {
  fs.mkdirSync(".qa", { recursive: true });
  // No flag => no API, no challenge, even if the preview config is enabled.
  const demo = await context(),
    dp = await demo.newPage();
  let apiCalls = 0,
    challenges = 0;
  dp.on("request", (r) => {
    if (r.url().startsWith(previewEndpoint)) apiCalls++;
    if (r.url().includes("challenges.cloudflare.com")) challenges++;
  });
  await dp.goto(previewOrigin + "/wedding/", { waitUntil: "domcontentloaded" });
  await fill(dp);
  await dp.locator("#rsvp-submit").click();
  await dp.locator("#rsvp-success").waitFor({ state: "visible" });
  assert.match(
    (await dp.locator("#success-message").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /демо/,
  );
  assert.equal(apiCalls, 0);
  assert.equal(challenges, 0);
  assert.equal(await count(), 0);
  await demo.close();
  checks++;
  for (const opts of [{ enabled: false }, { missingKey: true }]) {
    const ctx = await context(opts),
      p = await ctx.newPage();
    let calls = 0;
    p.on("request", (r) => {
      if (r.url().startsWith(previewEndpoint)) calls++;
    });
    await ready(p);
    assert.equal(await p.locator("#rsvp-submit").isDisabled(), true);
    assert.equal(calls, 0);
    await ctx.close();
    checks++;
  }
  const first = await context(),
    page = await first.newPage();
  const urls = [];
  page.on("request", (r) => urls.push(r.url()));
  await ready(page);
  await fill(page);
  await page.locator("#rsvp-submit").click();
  await saved(page);
  assert.equal(
    await page.locator(".rsvp-warning-icon").getAttribute("aria-hidden"),
    "true",
  );
  assert.equal(
    await page.locator(".rsvp-warning-icon").evaluate((el) => {
      const color = getComputedStyle(document.querySelector("#rsvp")).color;
      return (
        getComputedStyle(el).color === color &&
        getComputedStyle(el.querySelector("path")).stroke === color &&
        getComputedStyle(el.querySelector("circle")).fill === color
      );
    }),
    true,
  );
  assert.ok(
    !(await page.locator(".rsvp-link-warning-title").textContent()).includes(
      "❗",
    ),
  );
  assert.match(
    (await page.locator("#success-message").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /ждёт отдельного подтверждения/,
  );
  assert.equal(
    await page.locator(".rsvp-link-warning-title").evaluate((el) => {
      const title = getComputedStyle(el),
        detail = getComputedStyle(
          document.querySelector(".rsvp-link-warning-detail"),
        );
      return parseFloat(title.fontSize) > parseFloat(detail.fontSize);
    }),
    true,
  );
  assert.equal(await count(), 1);
  const identity = await state(page),
    id = identity.id;
  assert.equal(
    (
      await db
        .prepare("SELECT guest_count FROM rsvp_responses WHERE id=?")
        .bind(id)
        .first()
    ).guest_count,
    3,
  );
  const link = await page.locator("#rsvp-link").inputValue();
  for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator(".rsvp-wrap").screenshot({
      path: ".qa/rsvp-success-" + width + ".png",
      mask: [page.locator("#rsvp-link")],
      maskColor: "#92A8B3",
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(new URL(link).search, "?rsvp_preview=1");
  assert.ok(new URL(link).hash.includes("edit_key="));
  await page.locator("#rsvp-copy").click();
  assert.ok(
    (await page.evaluate(() => navigator.clipboard.readText())) === link,
    "Clipboard link mismatch",
  );
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw Error("denied");
        },
      },
    }),
  );
  await page.locator("#rsvp-copy").click();
  assert.match(
    (await page.locator("#rsvp-copy-status").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /выделена/,
  );
  checks++;

  await page.locator("#edit-answer").click();
  assert.equal(await page.locator("[name=guestCount]").inputValue(), "3");
  await page.locator("[name=message]").fill("Несохранённое изменение");
  await mf.dispatchFetch(previewEndpoint.replace("/rsvp", "/telegram"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "LOCAL_ONLY",
    },
    body: JSON.stringify({
      update_id: 700,
      callback_query: {
        id: "parking",
        data: "p:a:" + id + ":1",
        from: { id: 11111 },
        message: { message_id: 1, chat: { id: 11111, type: "private" } },
      },
    }),
  });
  await page.locator("#rsvp-submit").click();
  await page.locator("#rsvp-reload").waitFor({ state: "visible" });
  assert.equal(await page.locator("#rsvp-feedback").isVisible(), true);
  assert.equal(await page.locator("#rsvp-save-announcement").textContent(), "");
  assert.equal(
    await page
      .locator("#rsvp-status")
      .evaluate((el) => getComputedStyle(el).textAlign),
    "start",
  );
  assert.equal(await page.locator("#rsvp-success").isHidden(), true);
  assert.equal(
    await page.locator("[name=message]").inputValue(),
    "Несохранённое изменение",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#rsvp-reload").click();
  assert.equal(
    await page.locator("[name=message]").inputValue(),
    "Несохранённое изменение",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#rsvp-reload").click();
  await page.waitForFunction(
    () => !document.querySelector("#rsvp-submit").disabled,
  );
  assert.equal(
    await page.locator("[name=message]").inputValue(),
    "До встречи!",
  );
  await page.locator("[name=guestCount]").fill("2");
  await page.locator("#rsvp-submit").click();
  await saved(page);
  assert.match(
    (await page.locator("#success-message").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /подтвердили парковку/,
  );
  assert.equal(await count(), 1);
  checks++;
  await page.reload({ waitUntil: "domcontentloaded" });
  await saved(page);
  await page.locator("#edit-answer").click();
  assert.equal(await page.locator("[name=guestCount]").inputValue(), "2");
  assert.equal((await state(page)).id, id);
  checks++;

  const second = await context(),
    other = await second.newPage();
  await ready(other, link);
  await saved(other);
  assert.ok(
    new URL(other.url()).hash === "",
    "Private fragment was not cleared",
  );
  await other.locator("#edit-answer").click();
  assert.equal(await other.locator("[name=otherDrink]").inputValue(), "Сидр");
  assert.equal(await other.locator("[name=guestCount]").inputValue(), "2");
  await other.locator("[name=message]").fill("Из другого браузера");
  await other.locator("#rsvp-submit").click();
  await saved(other);
  assert.equal((await state(other)).id, id);
  assert.equal(await count(), 1);
  checks++;

  // Loss after COMMIT and reload: same pending answer/request, never a new company.
  await other.locator("#edit-answer").click();
  await other.locator("[name=message]").fill("Ответ при потере связи");
  let lose = true;
  await second.route(previewEndpoint, async (route) => {
    const response = await post(route);
    if (lose) {
      lose = false;
      await route.abort();
    } else await deliver(route, response);
  });
  await other.locator("#rsvp-submit").click();
  await other.locator("#rsvp-retry").waitFor({ state: "visible" });
  const pending = (await state(other)).pending;
  assert.ok(pending);
  assert.equal(
    await other.locator("[name=message]").inputValue(),
    "Ответ при потере связи",
  );
  await other.reload({ waitUntil: "domcontentloaded" });
  await other.locator("#rsvp-retry").waitFor({ state: "visible" });
  assert.equal(await other.locator("#rsvp-success").isHidden(), true);
  assert.equal(
    await other.locator("[name=message]").inputValue(),
    "Ответ при потере связи",
  );
  assert.equal((await state(other)).pending.requestId, pending.requestId);
  await other.locator("#rsvp-retry").click();
  await saved(other);
  assert.equal(await count(), 1);
  assert.equal((await state(other)).pending, null);
  checks++;

  // Server-side rejection is distinct from a pending request.
  await db
    .prepare(
      "UPDATE rsvp_responses SET parking_status='rejected',revision=revision+1 WHERE id=?",
    )
    .bind(id)
    .run();
  await other.reload({ waitUntil: "domcontentloaded" });
  await saved(other);
  assert.match(
    (await other.locator("#success-message").textContent()).replaceAll(
      "\u00a0",
      " ",
    ),
    /парковку отклонена/,
  );

  // Both negative attendance branches clear/disable all irrelevant data.
  for (const attendance of ["К сожалению, нет", "Отвечу чуть позже"]) {
    await other.locator("#edit-answer").click();
    await other.locator('[name=attending][value="' + attendance + '"]').check();
    assert.equal(await other.locator("[name=carCount]").isDisabled(), true);
    await other.locator("#rsvp-submit").click();
    await saved(other);
    const row = await db
      .prepare("SELECT * FROM rsvp_responses WHERE id=?")
      .bind(id)
      .first();
    assert.equal(row.guest_count, 0);
    assert.equal(row.additional_guests, "");
    assert.equal(row.drinks_json, "[]");
    assert.equal(row.cars_requested, 0);
    assert.equal(row.parking_status, "not_requested");
    assert.ok(
      !(await other.locator("#success-message").textContent())
        .toLowerCase()
        .includes("парков"),
    );
  }
  checks++;

  // Positive attendance without a parking request still has no parking message.
  for (const choice of ["no", "unknown"]) {
    await other.locator("#edit-answer").click();
    await other.locator('[name=attending][value="Да, конечно!"]').check();
    await other.locator('[name=parking][value="' + choice + '"]').check();
    await other.locator("#rsvp-submit").click();
    await saved(other);
    assert.ok(
      !(await other.locator("#success-message").textContent())
        .toLowerCase()
        .includes("парков"),
    );
  }
  checks++;

  // Archived link blocks writes and never offers to create a replacement.
  await db
    .prepare(
      "UPDATE rsvp_responses SET archived_at=CURRENT_TIMESTAMP,revision=revision+1 WHERE id=?",
    )
    .bind(id)
    .run();
  const archived = await context(),
    ap = await archived.newPage();
  await ready(ap, link);
  assert.match(
    (await ap.locator("#rsvp-status").textContent()).replaceAll("\u00a0", " "),
    /архиве/,
  );
  assert.equal(await ap.locator("#rsvp-new").isHidden(), true);
  assert.equal(await count(), 1);
  checks++;
  await archived.close();

  // Deleted identity requires confirmation before creating a fresh identity.
  await db.prepare("DELETE FROM rsvp_responses WHERE id=?").bind(id).run();
  await other.reload({ waitUntil: "domcontentloaded" });
  await other.locator("#rsvp-new").waitFor({ state: "visible" });
  other.once("dialog", (dialog) => dialog.dismiss());
  await other.locator("#rsvp-new").click();
  assert.equal((await state(other)).id, id);
  other.once("dialog", (dialog) => dialog.accept());
  await other.locator("#rsvp-new").click();
  await other.waitForFunction(
    () => !document.querySelector("#rsvp-submit").disabled,
  );
  assert.notEqual((await state(other)).id, id);
  assert.equal(await count(), 0);
  checks++;

  // Layout, keyboard focus and compact auto-growing message, all requested widths.
  await fill(other);
  for (const width of [320, 375, 390, 430, 768, 1024, 1440]) {
    await other.setViewportSize({ width, height: 900 });
    await other.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await other
      .locator("[name=message]")
      .fill("Многострочное сообщение\n".repeat(12));
    await other.waitForFunction(
      () => {
        const el = document.querySelector("[name=message]");
        return el.clientHeight >= el.scrollHeight - 1;
      },
      null,
      { timeout: 5000 },
    );
    const metrics = await other.evaluate(() => {
      const el = document.querySelector("[name=message]"),
        style = getComputedStyle(el);
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        height: el.clientHeight,
        scroll: el.scrollHeight,
        border: style.borderTopWidth,
      };
    });
    assert.ok(metrics.overflow <= 1, "overflow at " + width);
    assert.ok(
      metrics.height >= metrics.scroll - 1,
      JSON.stringify({ width, ...metrics }),
    );
    assert.equal(metrics.border, "0px");
    await other
      .locator("#rsvp")
      .screenshot({ path: ".qa/rsvp-preview-" + width + ".png" });
  }
  checks++;
  assert.ok(
    urls.every(
      (url) => !url.includes("edit_key") && !url.includes(identity.key),
    ),
  );
  assert.deepEqual(problems, []);
  await first.close();
  await second.close();
  console.log(
    "PASS: " +
      checks +
      " real-form scenarios; all 7 widths; actual local Worker/D1; no remote API/bot writes",
  );
} finally {
  await browser.close();
  await mf.dispose();
}
