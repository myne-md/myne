#!/usr/bin/env node
// Myne performance baseline — HAND-RUN, dev-only, and NOT a gate.
//
//   node scripts/perf-baseline.mjs            # human table
//   node scripts/perf-baseline.mjs --json     # machine-readable
//
// # Why this exists
//
// The performance campaign's acceptance rule is "same machine, same fixture,
// before and after, and the number moved". Before this there was no single
// command that produced those numbers for the byte-shaped work (the web entry
// closure, the wasm artefact) or for the dev loop (what the watcher walks, what
// the unit suite costs), so every claim about them was an argument rather than a
// measurement. This prints them, repeatably, in one pass.
//
// # What it deliberately does NOT measure
//
// The two numbers that matter most are absent, on purpose, because no Node
// process can produce them honestly:
//
//   - **unlock latency on a large vault** (the post-unlock pipeline, the
//     per-note title extraction). Needs a seeded vault and a real WebView.
//   - **per-keystroke cost** (the whole-document markdown parse, the decoration
//     rebuilds). Needs a real WebView; `jsdom`/V8 numbers would be a lower bound
//     presented as the answer, which is the mistake this file avoids.
//
// Both are manual procedures: `pnpm tauri dev` against a seeded vault, profiled
// by hand. A number invented here would be worse than no number.
//
// # No exit-code opinion
//
// It never fails a build and has no baseline to be over. `--check` and
// `--record` do not exist here, deliberately: the bundle budget ratchet is
// `scripts/check-web-bundle-budget.mjs` and the wasm determinism half is
// `scripts/wasm-repro-check.sh`, both of which ARE gates. This file is the
// instrument, not the limit.
//
// Inputs that are missing are NAMED, not counted as zero — a baseline reporting
// `0 B` for a bundle that was never built is the failure mode every guard in
// `scripts/` is written against.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = process.argv.includes("--json");

// ── web entry closure ─────────────────────────────────────────────────────────
//
// The same definition `scripts/check-web-bundle-budget.mjs` uses: the bytes a
// browser must fetch before the app can run — the entry module, everything the
// entry STATICALLY imports (Vite emits those as `modulepreload`, which is the
// transitive static graph), the stylesheet and the document. Lazily-imported
// chunks are excluded, because counting them would make the figure indifferent
// to whether code-splitting works.
//
// CodeMirror detection is a HEURISTIC and says so: a production bundle is
// minified, so module names are gone, but CodeMirror's own generated class names
// (`cm-editor`, `cm-scroller`, `cm-content`, `cm-line`) and its two small
// dependencies (`w3c-keyname`, `find-cluster-break`) are string literals in its
// code and survive. The marker that matters is `cm-scroller`: it is a real DOM
// class CM sets, not a comment or an error string.
const CM_MARKERS = ["cm-editor", "cm-scroller", "cm-content", "w3c-keyname", "find-cluster-break"];

function entryAssets() {
  const INDEX = join(ROOT, "web", "dist", "index.html");
  if (!existsSync(INDEX)) return null;
  const html = readFileSync(INDEX, "utf8");
  const out = new Set();
  const push = (href) => {
    if (typeof href === "string" && href.startsWith("/")) out.add(href.slice(1));
  };
  for (const re of [
    /<script[^>]*\ssrc="([^"]+)"/g,
    /<link[^>]*\srel="modulepreload"[^>]*\shref="([^"]+)"/g,
    /<link[^>]*\srel="stylesheet"[^>]*\shref="([^"]+)"/g,
    /<link[^>]*\shref="([^"]+)"[^>]*\srel="stylesheet"/g,
  ]) {
    for (const m of html.matchAll(re)) push(m[1]);
  }
  const assets = [];
  for (const rel of [...out].sort()) {
    const abs = join(ROOT, "web", "dist", rel);
    if (!existsSync(abs)) continue;
    const buf = readFileSync(abs);
    const text = buf.toString("utf8");
    const cm = CM_MARKERS.some((k) => text.includes(k));
    assets.push({
      rel,
      rawBytes: buf.length,
      gzipBytes: gzipSync(buf).length,
      codeMirror: cm,
    });
  }
  return assets;
}

// ── wasm glue pair ────────────────────────────────────────────────────────────
//
// Both files, because the thing a user runs is the pair: the `.wasm` alone is
// inert and the glue alone would load a different one. `scripts/build-wasm.sh`
// emits a combined digest for exactly this reason.
function wasmSizes() {
  const dir = join(ROOT, "web", "wasm", "pkg");
  const wasm = join(dir, "myne_web_wasm_bg.wasm");
  const glue = join(dir, "myne_web_wasm.js");
  if (!existsSync(wasm) || !existsSync(glue)) return null;
  const one = (p) => {
    const buf = readFileSync(p);
    return { rawBytes: buf.length, gzipBytes: gzipSync(buf).length };
  };
  return { wasm: one(wasm), glue: one(glue) };
}

// ── what the dev-server watcher walks ────────────────────────────────────────
//
// H1's number, and the rule it measures lives in `vite.config.ts`. This READS
// `WATCHED_ROOTS` out of that file rather than keeping a copy: the whole point of
// an allowlist is that it is the one place a watched root is named, and a second
// copy here would be a second thing to go stale. When the array cannot be found
// this section FAILS BY NAME — counting something else and printing a plausible
// figure is the failure every guard in `scripts/` is written against.
//
// Why it matters: with the denylist this replaced, a counting predicate in
// `watch.ignored` measured **84,379 distinct paths** asked about at startup, of
// which 70,217 were under `target/`. Compare the figure below against that.
function watchedRootsFrom(configText) {
  const array = configText.match(/const WATCHED_ROOTS = \[([^\]]*)\]/);
  if (!array) return null;
  const roots = [...array[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return roots.length > 0 ? roots : null;
}

const WALK_SKIP = new Set([".git", "node_modules"]);

function walkFiles(abs, out) {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (WALK_SKIP.has(e.name)) continue;
    const child = join(abs, e.name);
    if (e.isDirectory()) walkFiles(child, out);
    else out.push(child);
  }
}

function watchScope() {
  const CONFIG = join(ROOT, "vite.config.ts");
  if (!existsSync(CONFIG)) {
    return { error: "vite.config.ts not found — nothing compared." };
  }
  const roots = watchedRootsFrom(readFileSync(CONFIG, "utf8"));
  if (roots === null) {
    return {
      error:
        "WATCHED_ROOTS could not be read from vite.config.ts. The dev server's " +
        "watch rule was renamed or reshaped, so nothing was counted.",
    };
  }

  const all = [];
  walkFiles(ROOT, all);
  // Mirrors `isWatchedByDevServer`: a root-level entry is always admitted, and a
  // listed root admits its whole subtree.
  const admitted = all.filter((f) => {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    const slash = rel.indexOf("/");
    if (slash === -1) return true;
    return roots.includes(rel.slice(0, slash));
  });

  return { roots, admittedFiles: admitted.length, repositoryFiles: all.length };
}

// ── report ───────────────────────────────────────────────────────────────────

const report = {
  web: entryAssets(),
  wasm: wasmSizes(),
  watch: watchScope(),
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Myne performance baseline — hand-run, not a gate\n");

  console.log("web first load (entry closure, from web/dist/index.html)");
  if (report.web === null) {
    console.log("  NOT BUILT — run `pnpm web:build`. Nothing was measured.");
  } else {
    const gz = report.web.reduce((n, a) => n + a.gzipBytes, 0);
    const raw = report.web.reduce((n, a) => n + a.rawBytes, 0);
    console.log(`  total   ${(gz / 1024).toFixed(1)} KiB gzip / ${(raw / 1024).toFixed(1)} KiB raw`);
    console.log(`  assets  ${report.web.length}`);
    const cm = report.web.filter((a) => a.codeMirror);
    if (cm.length === 0) {
      console.log("  CodeMirror: no entry asset carries it (heuristic marker scan)");
    } else {
      const cmGz = cm.reduce((n, a) => n + a.gzipBytes, 0);
      console.log(
        `  CodeMirror: ${cm.length} asset(s), ${(cmGz / 1024).toFixed(1)} KiB gzip ` +
          `(heuristic: cm-editor/cm-scroller/…)`,
      );
      for (const a of cm) console.log(`      ${(a.gzipBytes / 1024).toFixed(1)} KiB  ${a.rel}`);
    }
    const top = [...report.web].sort((a, b) => b.gzipBytes - a.gzipBytes).slice(0, 8);
    console.log("  largest assets:");
    for (const a of top) console.log(`      ${(a.gzipBytes / 1024).toFixed(1)} KiB  ${a.rel}`);
  }

  console.log("\nwasm glue pair (web/wasm/pkg)");
  if (report.wasm === null) {
    console.log("  NOT BUILT — run `./scripts/build-wasm.sh`. Nothing was measured.");
  } else {
    for (const [name, s] of Object.entries(report.wasm)) {
      console.log(
        `  ${name.padEnd(5)} ${(s.rawBytes / 1024).toFixed(1)} KiB raw / ` +
          `${(s.gzipBytes / 1024).toFixed(1)} KiB gzip`,
      );
    }
  }

  console.log("\ndev-server watch scope (the allowlist in vite.config.ts)");
  if (report.watch.error) {
    console.log(`  ${report.watch.error}`);
  } else {
    const ratio =
      report.watch.repositoryFiles === 0
        ? "n/a"
        : `${((report.watch.admittedFiles / report.watch.repositoryFiles) * 100).toFixed(1)}%`;
    console.log(`  admitted   ${report.watch.admittedFiles} files (${ratio} of the repository)`);
    console.log(`  repository ${report.watch.repositoryFiles} files (excluding .git, node_modules)`);
    console.log(`  roots      ${report.watch.roots.join(" ")}`);
    console.log("  (a file in the repository root is always admitted; a listed root adds its subtree)");
  }
}
