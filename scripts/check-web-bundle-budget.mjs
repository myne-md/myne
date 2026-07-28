#!/usr/bin/env node
// The web client's first-load budget, as a ratchet (phase3-web-client task 68).
//
// # Why a ratchet and not a number
//
// A budget invented before the bundle exists is either trivially met or
// violated on the first honest build, and neither does a budget's job. So the
// number here was MEASURED from a complete build and written down, and this
// script's only opinion is that it must not grow much: growth past the margin
// fails, which forces a bundle increase to be a decision someone makes and
// records, rather than a drift nobody sees.
//
// Re-baselining is a normal thing to do — `--update` exists for exactly that —
// but it is an edit to a committed file, which is the point. It shows up in a
// diff, with a number that changed and an author.
//
// # What "first load" means here, precisely
//
// The bytes a browser MUST fetch before it can run the application: the entry
// module, everything the entry statically imports (Vite emits those as
// `modulepreload` links, which is exactly the transitive static graph), the
// stylesheet, and the HTML itself. Lazily-imported chunks — mermaid, the
// drawing canvas, the 24 locale catalogues — are deliberately NOT counted:
// they are the reason code-splitting exists, and counting them would make the
// budget indifferent to whether splitting works.
//
// # The gzip number is the one that fails the build
//
// It is the transfer size, and the origin serves `encode gzip zstd`
// (`web/container/Caddyfile`). Raw bytes are reported too because they are what
// the browser must PARSE, which is the part a fast connection does not hide.
//
// # The one architectural assertion
//
// The wasm core must not be in this graph at all. It is needed at unlock, not
// at first paint, and the moment it lands on the entry's critical path the
// first render waits on a multi-megabyte compile. That is checked structurally
// here rather than left to a habit.

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "web", "dist");
const BASELINE = join(ROOT, "web", "bundle-baseline.json");
const INDEX = join(DIST, "index.html");

/** Files the browser must fetch before the app can run, from the built HTML. */
export function initialAssetsFrom(html) {
  const out = [];
  const push = (href) => {
    if (typeof href === "string" && href.startsWith("/")) out.push(href.slice(1));
  };
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) push(m[1]);
  for (const m of html.matchAll(/<link[^>]*\srel="modulepreload"[^>]*\shref="([^"]+)"/g)) push(m[1]);
  for (const m of html.matchAll(/<link[^>]*\srel="stylesheet"[^>]*\shref="([^"]+)"/g)) push(m[1]);
  // A `rel=stylesheet` link can also spell its attributes the other way round.
  for (const m of html.matchAll(/<link[^>]*\shref="([^"]+)"[^>]*\srel="stylesheet"/g)) push(m[1]);
  return [...new Set(out)];
}

/** `{ rawBytes, gzipBytes, files }` for a list of dist-relative paths. */
export function measure(files, read) {
  let rawBytes = 0;
  let gzipBytes = 0;
  const detail = [];
  for (const f of files) {
    const bytes = read(f);
    const gz = gzipSync(bytes, { level: 9 }).byteLength;
    rawBytes += bytes.byteLength;
    gzipBytes += gz;
    detail.push({ file: f, raw: bytes.byteLength, gzip: gz });
  }
  return { rawBytes, gzipBytes, files: detail };
}

/** The wasm core must not be reachable from the entry — see the header. */
export function wasmOnCriticalPath(files) {
  return files.filter((f) => /myne_web_wasm|\.wasm$/.test(f));
}

/** Whether `measured` is within `marginPct` of `baseline`. */
export function withinBudget(measuredGzip, baselineGzip, marginPct) {
  return measuredGzip <= Math.floor(baselineGzip * (1 + marginPct / 100));
}

function kib(n) {
  return `${(n / 1024).toFixed(1)} KiB`;
}

function main() {
  const update = process.argv.includes("--update");

  if (!existsSync(INDEX)) {
    console.error(
      "web bundle budget: web/dist/index.html not found — run `pnpm web:build` first.",
    );
    process.exit(1);
  }
  const html = readFileSync(INDEX, "utf8");
  const assets = initialAssetsFrom(html);
  if (assets.length === 0) {
    // A regex that matches nothing would report a 0-byte bundle and pass
    // forever, which is the failure mode of every text-scanning guard.
    console.error("web bundle budget: found no entry assets in index.html — the scan is broken.");
    process.exit(1);
  }

  const onCriticalPath = wasmOnCriticalPath(assets);
  if (onCriticalPath.length > 0) {
    console.error(
      `web bundle budget: the wasm core is on the first-load path (${onCriticalPath.join(", ")}).\n` +
        "It is needed at unlock, not at first paint — keep it behind the Worker.",
    );
    process.exit(1);
  }

  const read = (f) => readFileSync(join(DIST, f));
  const { rawBytes, gzipBytes, files } = measure([...assets, "index.html"], read);

  if (update || !existsSync(BASELINE)) {
    const next = {
      note: "Measured from a complete build. Regenerate deliberately with `node scripts/check-web-bundle-budget.mjs --update`, and say why in the commit.",
      marginPct: existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")).marginPct : 10,
      initial: { rawBytes, gzipBytes },
    };
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(
      `web bundle budget: baseline written — ${kib(gzipBytes)} gzip / ${kib(rawBytes)} raw.`,
    );
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  const cap = Math.floor(baseline.initial.gzipBytes * (1 + baseline.marginPct / 100));
  const delta = gzipBytes - baseline.initial.gzipBytes;
  const pct = ((delta / baseline.initial.gzipBytes) * 100).toFixed(1);

  if (!withinBudget(gzipBytes, baseline.initial.gzipBytes, baseline.marginPct)) {
    console.error(
      `web bundle budget: FAIL — first load is ${kib(gzipBytes)} gzip, ` +
        `${pct}% over the ${kib(baseline.initial.gzipBytes)} baseline (cap ${kib(cap)}).\n` +
        files
          .sort((a, b) => b.gzip - a.gzip)
          .slice(0, 5)
          .map((f) => `    ${f.file} — ${kib(f.gzip)} gzip`)
          .join("\n") +
        "\n  Either shrink it, or re-baseline with `--update` and say why in the commit.",
    );
    process.exit(1);
  }

  console.log(
    `web bundle budget: ok — ${kib(gzipBytes)} gzip / ${kib(rawBytes)} raw ` +
      `(${delta >= 0 ? "+" : ""}${pct}% vs baseline, cap ${kib(cap)}); ` +
      `${assets.length} entry asset(s), wasm off the critical path.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
