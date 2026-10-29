import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildManualPage,
  prepareManualPage,
  applyManualPage,
  projectRoot,
} from "../scripts/manual-rsvp-bundle.mjs";
const sitekey = "0x4AAAAAA_PUBLIC_TEST_PLACEHOLDER";
function temp() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wedding-manual-preview-"),
  );
  return {
    directory,
    close() {
      const relative = path.relative(os.tmpdir(), directory);
      assert.ok(
        relative.startsWith("wedding-manual-preview-") &&
          !relative.includes(path.sep),
      );
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
function modules(source, result = new Set()) {
  for (const match of source.matchAll(
    /data:text\/javascript;base64,([a-zA-Z0-9+/=]+)/g,
  )) {
    const text = Buffer.from(match[1], "base64").toString("utf8");
    if (!result.has(text)) {
      result.add(text);
      modules(text, result);
    }
  }
  return result;
}
test("Human preview packages exact existing UI code and real challenge client, never mocks", () => {
  const html = buildManualPage(sitekey);
  const decoded = modules(html);
  assert.equal(decoded.size, 4);
  assert.ok(
    decoded.has(
      fs.readFileSync(path.join(projectRoot, "rsvp-turnstile.mjs"), "utf8"),
    ),
  );
  assert.ok(
    decoded.has(
      fs.readFileSync(path.join(projectRoot, "worker/rsvp-policy.mjs"), "utf8"),
    ),
  );
  const source = [html, ...decoded].join("\n");
  assert.ok(
    source.includes(
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    ),
  );
  assert.ok(
    source.includes("wedding-rsvp-api-test.zakk-horren.workers.dev/rsvp"),
  );
  for (const forbidden of [
    "navigator.webdriver",
    "window.turnstile=",
    "LOCAL_ONLY",
    "BOT_TOKEN",
    "WEBHOOK_SECRET",
    "TURNSTILE_SECRET",
    "route.fulfill",
  ])
    assert.ok(!source.includes(forbidden), forbidden);
  assert.ok(
    !html.includes('src="script.js"') && !html.includes('href="styles.css"'),
  );
  assert.ok(html.includes('src="assets/couple.png"'));
  assert.ok(html.includes('location.origin==="https://zakkhorren.github.io"'));
});
test("Real manual artifact rejects dummy keys; no dummy/real key mixing", () => {
  for (const value of [
    "",
    undefined,
    "LOCAL_PREVIEW",
    "1x00000000000000000000AA",
    "2x00000000000000000000AB",
  ])
    assert.throws(() => buildManualPage(value), /public sitekey/);
});
test("Apply uses the exact DevTools-created document filename and preserves its backup", () => {
  const fixture = temp();
  try {
    prepareManualPage(sitekey, fixture.directory);
    const dir = path.join(
      fixture.directory,
      "overrides",
      "zakkhorren.github.io",
      "wedding",
    );
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "index.html%3Frsvp_preview=1");
    const original = '<!doctype html><form id="rsvp-form"></form>';
    fs.writeFileSync(file, original);
    assert.equal(applyManualPage(fixture.directory), file);
    assert.equal(fs.readFileSync(file, "utf8"), buildManualPage(sitekey));
    applyManualPage(fixture.directory);
    assert.equal(
      fs.readFileSync(
        path.join(fixture.directory, "original-document.html"),
        "utf8",
      ),
      original,
    );
  } finally {
    fixture.close();
  }
});
test("Apply refuses extra API/header files without modifying any file", () => {
  const fixture = temp();
  try {
    prepareManualPage(sitekey, fixture.directory);
    assert.throws(
      () => applyManualPage(fixture.directory),
      /ONLY the main document/,
    );
    const dir = path.join(
      fixture.directory,
      "overrides",
      "zakkhorren.github.io",
      "wedding",
    );
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "index.html");
    const original = '<!doctype html><form id="rsvp-form"></form>';
    fs.writeFileSync(file, original);
    fs.writeFileSync(path.join(dir, ".headers"), "[]");
    assert.throws(
      () => applyManualPage(fixture.directory),
      /No headers, API or Turnstile/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.ok(
      !fs.existsSync(path.join(fixture.directory, "original-document.html")),
    );
  } finally {
    fixture.close();
  }
});
test("Unsupported --test-api fails before opening any automated real-challenge preview", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/preview-rsvp.mjs", "--test-api"],
    { encoding: "utf8", cwd: projectRoot },
  );
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("MANUAL-E2E-WINDOWS.md"));
  assert.ok(!result.stdout.includes("preview ready"));
});
