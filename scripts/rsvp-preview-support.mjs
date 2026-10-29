import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const previewOrigin = "https://zakkhorren.github.io";
export const previewUrl = previewOrigin + "/wedding/?rsvp_preview=1#rsvp";
export const previewEndpoint =
  "https://wedding-rsvp-api-test.zakk-horren.workers.dev/rsvp";

export async function routePreview(
  context,
  { sitekey, enabled = true, local = false } = {},
) {
  const allowed = new Set([
    "index.html",
    "site.config.js",
    "script.js",
    "styles.css",
    "rsvp-ui.mjs",
    "rsvp-session.mjs",
    "rsvp-turnstile.mjs",
    "worker/rsvp-policy.mjs",
  ]);
  await context.route(previewOrigin + "/wedding/**", async (route) => {
    const url = new URL(route.request().url());
    let relative;
    try {
      relative =
        decodeURIComponent(url.pathname.slice("/wedding/".length)) ||
        "index.html";
    } catch {
      await route.abort();
      return;
    }
    const file = path.resolve(root, relative);
    if (
      relative.split(/[\\/]/).some((part) => part === ".." || part === ".") ||
      !file.startsWith(root + path.sep) ||
      !(allowed.has(relative) || relative.startsWith("assets/"))
    ) {
      await route.fulfill({
        status: 404,
        body: "Not available in isolated preview",
      });
      return;
    }
    try {
      let body = fs.readFileSync(file);
      const extension = path.extname(file);
      if (relative === "site.config.js")
        body = Buffer.concat([
          body,
          Buffer.from(
            "\nwindow.WEDDING_CONFIG.rsvpPreview=" +
              JSON.stringify({
                enabled,
                endpoint: previewEndpoint,
                turnstileSitekey: sitekey || "",
                local,
              }) +
              ";\n",
          ),
        ]);
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
      };
      await route.fulfill({
        contentType: types[extension] || "application/octet-stream",
        body,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch {
      await route.fulfill({ status: 404, body: "Missing preview resource" });
    }
  });
}

function sqlStatements(file) {
  let buffer = "",
    trigger = false;
  const statements = [];
  for (const line of fs
    .readFileSync(path.join(root, file), "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("--")) continue;
    if (/^CREATE TRIGGER/i.test(line.trim())) trigger = true;
    buffer += line + "\n";
    if (
      (!trigger && line.trim().endsWith(";")) ||
      (trigger && line.trim() === "END;")
    ) {
      statements.push(buffer);
      buffer = "";
      trigger = false;
    }
  }
  if (buffer.trim()) throw Error("Incomplete SQL fixture");
  return statements;
}
export async function localPreviewWorker() {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: path.join(root, "worker/wedding-rsvp-api.js"),
      compatibilityDate: "2026-10-28",
      d1Databases: ["DB"],
      bindings: {
        ALLOWED_ORIGIN: previewOrigin,
        ADMIN_IDS: "11111",
        BOT_TOKEN: "LOCAL_ONLY",
        WEBHOOK_SECRET: "LOCAL_ONLY",
        TURNSTILE_SECRET: "LOCAL_ONLY",
      },
      outboundService: async (request) => {
        const hostname = new URL(request.url).hostname;
        if (hostname === "challenges.cloudflare.com")
          return Response.json({
            success: true,
            hostname: "zakkhorren.github.io",
            action: "rsvp",
          });
        if (hostname === "api.telegram.org")
          return Response.json({ ok: true, result: { message_id: 1 } });
        throw Error("Unexpected local preview outbound request");
      },
    }),
  );
  const db = await mf.getD1Database("DB");
  for (const file of [
    "tests/fixtures/legacy-schema.sql",
    "worker/migrations/0001_rsvp_v2.sql",
    "worker/migrations/0002_archive_lifecycle.sql",
  ])
    await db.batch(sqlStatements(file).map((sql) => db.prepare(sql)));
  return { mf, db };
}
export async function routeLocalWorker(context, mf) {
  await context.route(previewEndpoint + "**", async (route) => {
    const request = route.request();
    const response = await mf.dispatchFetch(request.url(), {
      method: request.method(),
      headers: request.headers(),
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
        body: "let n=0;window.turnstile={render:(el,o)=>{window.localChallenge=o;queueMicrotask(()=>o.callback('LOCAL_ONLY_'+ ++n));return 'local'},reset:()=>queueMicrotask(()=>window.localChallenge.callback('LOCAL_ONLY_'+ ++n))};",
      }),
  );
}
