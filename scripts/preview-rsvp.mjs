// Automated LOCAL preview only. Real challenges use the human-browser procedure.
import { chromium } from "playwright";
import path from "node:path";
import {
  root,
  previewUrl,
  routePreview,
  localPreviewWorker,
  routeLocalWorker,
} from "./rsvp-preview-support.mjs";
const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const production = args.includes("--production");
if (args.includes("--test-api") || args.includes("--sitekey"))
  throw Error(
    "Real Turnstile is not supported in this Playwright preview. Use the ordinary-browser procedure in MANUAL-E2E-WINDOWS.md. This launcher is local-only.",
  );
let local, context;
try {
  // Initialise workerd before opening a browser; failed startup leaves no empty window.
  local = await localPreviewWorker({ production });
  context = await chromium.launchPersistentContext(
    path.join(root, ".qa", "rsvp-isolated-browser-" + Date.now()),
    {
      headless: smoke && !args.includes("--headed"),
      viewport: args.includes("--mobile") ? { width: 390, height: 844 } : null,
    },
  );
  await routePreview(context, {
    sitekey: "LOCAL_PREVIEW",
    local: true,
    production,
  });
  await routeLocalWorker(
    context,
    local.mf,
    production
      ? "https://wedding-rsvp-api.zakk-horren.workers.dev/rsvp"
      : undefined,
  );
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(
    production ? "https://zakkhorren.github.io/wedding/" : previewUrl,
    { waitUntil: "domcontentloaded" },
  );
  console.log(
    "Local preview ready. API, D1, Turnstile and Telegram are local mocks; nothing is sent remotely.",
  );
  console.log(
    "Close this preview browser to stop. Paste private edit links only into this window, never the terminal.",
  );
  if (smoke) {
    await page.waitForFunction(
      () => !document.querySelector("#rsvp-submit").disabled,
    );
    await context.close();
    console.log("PASS: isolated local preview launcher");
  } else await new Promise((resolve) => context.once("close", resolve));
} finally {
  await context?.close().catch(() => {});
  await local?.mf.dispose();
}
