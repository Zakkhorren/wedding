// Offline release check. Never deploys, changes configuration or calls any API.
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
const scope = { window: {} };
vm.runInNewContext(
  fs.readFileSync(new URL("site.config.js", root), "utf8"),
  scope,
);
const config = scope.window.WEDDING_CONFIG;
const issues = [];
if (config.rsvpMode !== "production")
  issues.push(
    "rsvpMode must be production for launch (maintenance is for a paused site).",
  );
if (
  config.rsvpEndpoint !==
  "https://wedding-rsvp-api.zakk-horren.workers.dev/rsvp"
)
  issues.push("Wrong production endpoint.");
const key = config.turnstileSitekey || "";
if (
  !/^[a-zA-Z0-9_-]{10,100}$/.test(key) ||
  /^[123]x0{10,}/.test(key) ||
  /LOCAL|PLACEHOLDER|SET_|YOUR_/i.test(key)
)
  issues.push(
    "Set the actual PUBLIC Site key of wedding-rsvp-form in site.config.js. Never use the Secret key.",
  );
const worker = fs.readFileSync(
  new URL("worker/wedding-rsvp-api.production.js", root),
  "utf8",
);
if (worker.includes("/clear_test") || worker.includes('"/delete"'))
  issues.push("Final Worker contains test-delete commands.");
for (const file of [
  "worker/wedding-rsvp-api.production.js",
  "worker/migrations/0001_rsvp_v2.sql",
  "worker/migrations/0002_archive_lifecycle.sql",
  "site.config.js",
  "script.js",
  "rsvp-ui.mjs",
  "rsvp-session.mjs",
  "rsvp-turnstile.mjs",
  "worker/rsvp-policy.mjs",
]) {
  const bytes = fs.readFileSync(new URL(file, root));
  console.log(createHash("sha256").update(bytes).digest("hex") + "  " + file);
}
if (issues.length) {
  for (const issue of issues) console.error("BLOCKED: " + issue);
  process.exitCode = 1;
} else
  console.log(
    "PASS: offline production package checks. Cloud settings and permission to launch are separate requirements.",
  );
