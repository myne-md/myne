// Which built assets an artefact grep must read — fail-closed (#273).
//
// The failure this prevents: the web artefact greps each listed the extensions
// they SCAN, so any newly-emitted extension was skipped without a word. The
// bundle ships a 1.2 MB `pdf.worker.min-*.mjs` and a 3.9 MB
// `myne_web_wasm_bg-*.wasm`; four guards whose entire premise is "read the
// bytes that will be served" read neither. `check-web-third-party` printed
// "all recorded" while four unrecorded origins sat in the served tree — three
// in the `.mjs` and one in the `.wasm`.
//
// So the filter is inverted: name what is IGNORED, and fail on anything
// unrecognised. Same posture the crypto layer already takes, applied to
// tooling — an unknown input is a question, not a silent pass.
//
// The walk is recursive for the same reason: `readdirSync` on `assets/` alone
// missed anything a bundler chose to nest.

import { readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/**
 * Extensions a byte-level scan may skip, each with the reason.
 *
 * "It is binary" is NOT a reason on its own — the `.wasm` is binary and is
 * exactly where one of the unrecorded origins was hiding. These are files whose
 * bytes cannot carry the thing being looked for, or whose content is already
 * covered by the source they are generated from.
 */
export const IGNORED_EXTENSIONS = Object.freeze({
  ".map": "source maps are not served to users and are not part of the bundle's behaviour",
  ".png": "raster image; no text content and no executable content",
  ".jpg": "raster image",
  ".jpeg": "raster image",
  ".webp": "raster image",
  ".ico": "raster image",
  ".woff": "font binary; glyph outlines only",
  ".woff2": "font binary; glyph outlines only",
  ".ttf": "font binary; glyph outlines only",
  ".txt": "static text served verbatim — `security.txt` and the licence files. A URL in prose is a reference a human follows, not one the page fetches; scanning them would report every licence link as a third-party origin.",
});

/**
 * Dotfiles with no extension — OS droppings like `.DS_Store` that a local build
 * leaves behind and CI never produces. Skipped rather than refused so a
 * developer's Finder does not fail their commit; they carry no served
 * behaviour.
 */
function isOsDropping(name) {
  return name.startsWith(".") && !name.includes(".", 1);
}

/** Extensions that carry code or markup and MUST be scanned. */
export const SCANNED_EXTENSIONS = Object.freeze([
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
  ".json",
  ".wasm",
  ".svg",
]);

/**
 * Every file under `dir`, recursively, repo-relative to `dir`.
 */
export function walkFiles(dir) {
  const out = [];
  const visit = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(dir);
  return out;
}

/**
 * Partition a built tree into the files a scan must read and the ones it may
 * skip — refusing anything it does not recognise.
 *
 * Returns `{ scan, skipped, unknown }`. A non-empty `unknown` is a FAILURE for
 * the caller: an extension nobody has classified is an extension nobody has
 * checked, and reporting success over it is exactly the "someone checked and it
 * was fine" that is worse than no guard at all.
 */
export function partitionAssets(dir) {
  const scan = [];
  const skipped = [];
  const unknown = [];
  for (const file of walkFiles(dir)) {
    const ext = extname(file).toLowerCase();
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (SCANNED_EXTENSIONS.includes(ext)) scan.push(file);
    else if (ext in IGNORED_EXTENSIONS) skipped.push(file);
    else if (isOsDropping(base)) skipped.push(file);
    else unknown.push(relative(dir, file));
  }
  return { scan, skipped, unknown };
}

/** The message a caller prints before exiting on an unclassified extension. */
export function unknownExtensionMessage(unknown) {
  const exts = [...new Set(unknown.map((f) => extname(f).toLowerCase() || "(none)"))];
  return (
    `✗ unclassified asset extension(s) in the built bundle: ${exts.join(", ")}\n` +
    unknown.map((f) => `    ${f}`).join("\n") +
    "\n\n  Add the extension to SCANNED_EXTENSIONS (it carries code or markup and\n" +
    "  must be read) or to IGNORED_EXTENSIONS with the reason its bytes cannot\n" +
    "  carry what these guards look for — see scripts/lib/scanned-assets.mjs.\n" +
    "  Skipping it silently is what let a 1.2 MB .mjs and a 3.9 MB .wasm go\n" +
    "  unread by four guards whose whole premise is reading the served bytes."
  );
}
