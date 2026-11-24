#!/usr/bin/env node
// Re-runnable KDF + OPFS benchmark (phase3-web-client task 63).
//
//   node scripts/bench-web.mjs            # build, serve, print the URL
//   node scripts/bench-web.mjs --native   # also run the native reference first
//
// # What this replaces
//
// The Phase 0 spike (`private-companion/features/phase3-web-client/spike-phase0.md`)
// measured Argon2id and OPFS once, from a scratchpad harness that no longer
// exists. Its own conclusion is that **the ratio is the transferable number** —
// 1.13–1.65× wasm-over-native — because absolute milliseconds belong to the
// machine. A ratio needs both halves measured on the SAME machine in the same
// session, which means both halves have to be re-runnable, which means the
// harness cannot be a scratchpad.
//
// # Cross-origin isolation is not optional
//
// The server below sends COOP `same-origin` + COEP `require-corp` because the
// app always runs isolated, and an un-isolated measurement is not comparable to
// it. The page says so loudly rather than quietly producing a number that looks
// fine.
//
// Node built-ins only — adding a dependency is a security decision in this
// repo, and a benchmark is not a reason to make one.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTool, ToolRunError } from "./lib/run-tool.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const benchDir = join(repoRoot, "web", "bench");
const pkgDir = join(benchDir, "pkg");
const PORT = Number(process.env.BENCH_PORT ?? 1422);

// FATAL (myne#528): a benchmark driver (pnpm/wasm-bindgen/cargo) that cannot
// run must fail the run with its diagnostics printed, not exit 0 against a
// half-built page. The uncaught ToolRunError keeps the non-zero exit.
function run(cmd, args, opts = {}) {
  try {
    runTool([cmd, ...args], { cwd: repoRoot, onToolFailure: "fatal", ...opts });
  } catch (err) {
    if (!(err instanceof ToolRunError)) throw err;
    process.exit(1);
  }
}

// ── the native reference ────────────────────────────────────────────────────
// Served to the page at `/native.json` when measured, so the RATIO is computed
// and displayed by the harness rather than left as arithmetic for the reader.
// The ratio is the deliverable; asking someone to divide two numbers they have
// to find in two places is how a benchmark ends up quoted by its milliseconds.
let nativeJson = null;
if (process.argv.includes("--native")) {
  console.error("== native Argon2id reference ==");
  // FATAL: without the reference the page reports milliseconds only, which the
  // header above says do not transfer between machines — running without it
  // after the user asked for --native is a broken run, not a degraded one.
  const r = runTool(["cargo", "run", "--release", "-p", "protocol", "--example", "bench-kdf", "5"], {
    cwd: repoRoot,
    onToolFailure: "fatal",
  });
  nativeJson = (r.stdout ?? "").trim().split("\n").pop();
  console.error(`   ${nativeJson}`);
} else {
  console.error(
    "== no native reference this run ==\n" +
      "   Pass --native to measure it on THIS machine and get the ratio. Without\n" +
      "   it the page reports milliseconds only, which do not transfer between\n" +
      "   machines — the ratio is the number the Phase 0 report says to compare.\n",
  );
}

// ── build the bench wasm ────────────────────────────────────────────────────
// Release, always: a debug Argon2id at 256 MiB is an order of magnitude slower
// and would report a flattering ratio against an optimised native build.
console.error("== building the benchmark wasm (release) ==");
run("cargo", [
  "build",
  "--release",
  "-p",
  "myne-web-bench",
  "--target",
  "wasm32-unknown-unknown",
]);

const wasmPath = join(
  process.env.CARGO_TARGET_DIR ?? join(repoRoot, "target"),
  "wasm32-unknown-unknown",
  "release",
  "myne_web_bench.wasm",
);
if (!existsSync(wasmPath)) {
  console.error(`no wasm artefact at ${wasmPath}`);
  process.exit(1);
}
run("wasm-bindgen", [wasmPath, "--out-dir", pkgDir, "--target", "web", "--no-typescript"]);

// ── serve it, cross-origin isolated ─────────────────────────────────────────
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/native.json") {
    // 404 when unmeasured, rather than an empty or zero-valued object: the page
    // must be able to tell "no reference" from "a reference of nothing", and a
    // ratio computed against a placeholder would be worse than no ratio.
    if (nativeJson === null) {
      res.writeHead(404).end("no native reference this run");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(nativeJson);
    return;
  }
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = join(benchDir, rel);
  // Path containment: this serves a directory to a browser, and `..` in a
  // request path is the one way that becomes a file read anywhere on disk.
  if (!file.startsWith(benchDir)) {
    res.writeHead(403).end("no");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      // The app's isolation, reproduced — see the header comment.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => {
  console.error(`\n== benchmark ready ==`);
  console.error(`   http://localhost:${PORT}/`);
  console.error(
    `\n   Open it in each target browser. The page prints its JSON and also\n` +
      `   publishes it as \`window.__BENCH_RESULT\` for a driver to read.\n` +
      `   Ctrl-C when done.\n`,
  );
});
