// Static transport for human DevTools Local Overrides. No browser control,
// fetch interception, challenge mocking, tokens or server configuration.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const manualOrigin = "https://zakkhorren.github.io";
export const manualUrl = manualOrigin + "/wedding/?rsvp_preview=1";
export const manualEndpoint =
  "https://wedding-rsvp-api-test.zakk-horren.workers.dev/rsvp";
export const manualDirectory = path.join(
  projectRoot,
  ".qa",
  "manual-turnstile",
);
const read = (file) =>
  fs.readFileSync(path.join(projectRoot, file), "utf8").replace(/^\uFEFF/, "");
const dataModule = (source) =>
  "data:text/javascript;base64," + Buffer.from(source).toString("base64");
function replaceOnce(source, oldValue, newValue) {
  if (source.split(oldValue).length !== 2)
    throw Error("Client source changed; update and retest the manual bundle.");
  return source.replace(oldValue, () => newValue);
}
const scriptText = (source) => source.replace(/<\/script/gi, "<\\/script");

export function buildManualPage(sitekey) {
  if (
    !/^[a-zA-Z0-9_-]{10,100}$/.test(sitekey || "") ||
    /^[123]x0{10,}/.test(sitekey) ||
    sitekey === "LOCAL_PREVIEW"
  )
    throw Error(
      "Supply the existing TEST widget's public sitekey, not a dummy key or secret.",
    );
  const policy = dataModule(read("worker/rsvp-policy.mjs"));
  const session = dataModule(
    replaceOnce(
      read("rsvp-session.mjs"),
      '"./worker/rsvp-policy.mjs"',
      JSON.stringify(policy),
    ),
  );
  const turnstile = dataModule(read("rsvp-turnstile.mjs"));
  let ui = replaceOnce(
    read("rsvp-ui.mjs"),
    '"./rsvp-session.mjs"',
    JSON.stringify(session),
  );
  ui = replaceOnce(ui, '"./rsvp-turnstile.mjs"', JSON.stringify(turnstile));
  const main = replaceOnce(
    read("script.js"),
    "import('./rsvp-ui.mjs')",
    "import(" + JSON.stringify(dataModule(ui)) + ")",
  );
  const config =
    read("site.config.js") +
    "\nwindow.WEDDING_CONFIG.rsvpMode='demo';window.WEDDING_CONFIG.rsvpPreview=" +
    JSON.stringify({
      enabled: false,
      endpoint: manualEndpoint,
      turnstileSitekey: sitekey,
    }) +
    ";\nwindow.WEDDING_CONFIG.rsvpPreview.enabled=" +
    "location.origin===" +
    JSON.stringify(manualOrigin) +
    "&&location.pathname==='/wedding/'&&new URLSearchParams(location.search).get('rsvp_preview')==='1';";
  let html = read("index.html");
  html = replaceOnce(
    html,
    '<link rel="stylesheet" href="styles.css" />',
    "<style>" +
      read("styles.css").replace(/<\/style/gi, "<\\/style") +
      "</style>",
  );
  for (const file of ["site.config.js", "script.js"])
    html = replaceOnce(html, '<script defer src="' + file + '"></script>', "");
  // One HTML override avoids query-filename guessing, missing-module 404/MIME
  // issues, and overriding any API response or challenge resource.
  html = replaceOnce(
    html,
    "</body>",
    "<script>" +
      scriptText(config) +
      "</script>\n<script>" +
      scriptText(main) +
      "</script>\n</body>",
  );
  return html;
}

export function prepareManualPage(sitekey, directory = manualDirectory) {
  const html = buildManualPage(sitekey);
  fs.mkdirSync(path.join(directory, "overrides"), { recursive: true });
  fs.writeFileSync(path.join(directory, "preview.html"), html, "utf8");
  return {
    document: path.join(directory, "preview.html"),
    overrides: path.join(directory, "overrides"),
  };
}

export function applyManualPage(directory = manualDirectory) {
  const overrides = path.join(directory, "overrides");
  const files = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw Error(
          "Symlinks are not allowed in the dedicated override folder.",
        );
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  }
  walk(overrides);
  const candidates = files.filter((file) => {
    const relative = path.relative(overrides, file).split(path.sep).join("/");
    return (
      relative.startsWith("zakkhorren.github.io/wedding/") &&
      !/edit_key|rsvp_id|\.headers|#|%23/i.test(relative) &&
      fs.readFileSync(file, "utf8").includes('id="rsvp-form"') &&
      /^\s*<!doctype html>/i.test(fs.readFileSync(file, "utf8"))
    );
  });
  if (files.length !== 1 || candidates.length !== 1)
    throw Error(
      "Use a dedicated folder containing ONLY the main document saved by DevTools Override content. No headers, API or Turnstile overrides.",
    );
  const source = path.join(directory, "preview.html");
  if (!fs.existsSync(source))
    throw Error("Prepare preview.html with the public sitekey first.");
  const backup = path.join(directory, "original-document.html");
  if (!fs.existsSync(backup)) fs.copyFileSync(candidates[0], backup);
  fs.copyFileSync(source, candidates[0]);
  return candidates[0];
}
