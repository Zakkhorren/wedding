// Browser-only file interception: no server deployment, no origin/captcha bypass.
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
const remote = args.includes("--test-api");
const smoke = args.includes("--smoke");
if (remote && smoke) throw Error("Smoke check is local-only");
const sitekey = args[args.indexOf("--sitekey") + 1];
if (
  remote &&
  (!args.includes("--sitekey") || !sitekey || sitekey.startsWith("--"))
)
  throw Error("Use --test-api --sitekey PUBLIC_SITEKEY (never a secret key)");
let local;
const context = await chromium.launchPersistentContext(
  path.join(
    root,
    ".qa",
    remote && !args.includes("--fresh-browser")
      ? "rsvp-test-api-browser"
      : "rsvp-isolated-browser-" + Date.now(),
  ),
  {
    headless: smoke,
    viewport: args.includes("--mobile") ? { width: 390, height: 844 } : null,
  },
);
try {
  await routePreview(context, {
    sitekey: remote ? sitekey : "LOCAL_PREVIEW",
    local: !remote,
  });
  if (!remote) {
    local = await localPreviewWorker();
    await routeLocalWorker(context, local.mf);
  }
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(previewUrl, { waitUntil: "domcontentloaded" });
  console.log(
    remote
      ? "Isolated preview ready. Only explicit form submissions go to the TEST Worker. No site deployment."
      : "Local preview ready. API, D1, Turnstile and Telegram are local mocks; nothing is sent remotely.",
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
  await context.close().catch(() => {});
  await local?.mf.dispose();
}
