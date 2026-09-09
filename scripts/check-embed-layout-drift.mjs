#!/usr/bin/env node
// The form-C embed-layout grammar is written in two languages, and the bound it
// shares must be one number (myne-md/myne#409).
//
// # The failure this prevents
//
// The canonical grammar is TypeScript (`dialect/src/embedLayout.ts`,
// source-consumed by all three clients). The attachments-included export needs
// one narrow slice of it in Rust (`format/src/export_naming.rs`), because that
// rewrite runs backend-side over plaintext the frontend never receives, and the
// wasm direction is Rust to JS rather than the other way, so calling the TS
// grammar from there is not available. The duplication is therefore real and
// justified, and it is deliberately narrow: the Rust side learns that a pixel
// `w=` becomes Obsidian's `|300` spelling, that `alt=` is terminal, and what
// counts as a canonical key.
//
// Both files said, and the decision entry said, that the two halves are "held
// together by the published `embed-layout` vectors". They are not, on any
// machine. `.woodpecker/main.yml`'s `vector-verification` step is commented out in
// full pending a `vectors_token` secret, `MYNE_VECTORS_REQUIRED` is set nowhere
// outside that commented block, and both runners skip silently when the
// companion repository is absent, which is the default in CI and in a fresh
// clone. So the claim described a lock that runs nowhere, and the number could
// drift in either direction with every gate green.
//
// This is the smallest check that actually runs. It does not re-implement the
// grammar: it extracts the one constant both sides declare and compares them,
// the same shape `damm32-table-drift` uses for the frozen quasigroup table.
//
// # What it does NOT cover, stated so it is not mistaken for more
//
// The key vocabulary, the percentage form, the `alt=` terminality rule and the
// passthrough ordering are still held by each side's own unit tests plus the
// vectors when somebody runs them. Only the numeric ceiling is machine-compared
// here. Widening this into a second parser would recreate the problem it exists
// to catch.
//
// Zero dependencies, hand-runnable: node scripts/check-embed-layout-drift.mjs

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TS_FILE = "dialect/src/embedLayout.ts";
const RUST_FILE = "format/src/export_naming.rs";

/** `export const MAX_EMBED_DIMENSION_PX = 8192;` */
const TS_RE = /export const MAX_EMBED_DIMENSION_PX\s*=\s*(\d+)\s*;/;
/** `const MAX_EMBED_DIMENSION_PX: u32 = 8192;` */
const RUST_RE = /const MAX_EMBED_DIMENSION_PX\s*:\s*u32\s*=\s*(\d+)\s*;/;

const failures = [];

/** The declared value, or null with a recorded failure naming the file. */
function declared(file, re, shape) {
  let text;
  try {
    text = readFileSync(join(repoRoot, file), "utf8");
  } catch {
    failures.push(`${file}: not found. This guard is looking at the wrong tree.`);
    return null;
  }
  const m = re.exec(text);
  if (m === null) {
    // Silence would be the wrong answer: a guard that cannot find its input has
    // stopped checking, and that is exactly when it prints ok.
    failures.push(
      `${file}: no \`${shape}\` declaration found. If the constant was renamed or ` +
        `moved, teach this guard the new shape rather than deleting it, or the two ` +
        `grammars go back to drifting silently.`,
    );
    return null;
  }
  return Number(m[1]);
}

const ts = declared(TS_FILE, TS_RE, "export const MAX_EMBED_DIMENSION_PX = <n>");
const rust = declared(RUST_FILE, RUST_RE, "const MAX_EMBED_DIMENSION_PX: u32 = <n>");

if (ts !== null && rust !== null && ts !== rust) {
  failures.push(
    `MAX_EMBED_DIMENSION_PX disagrees: ${TS_FILE} says ${ts}, ${RUST_FILE} says ${rust}.\n` +
      `  The canonical grammar is the TypeScript one. A value between the two numbers ` +
      `renders\n  at one size in the app and exports as a different spelling, or exports as an ` +
      `opaque\n  passthrough segment where the app renders a real width.`,
  );
}

if (failures.length > 0) {
  console.error("embed-layout drift: FAILED");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`embed-layout drift: ok (MAX_EMBED_DIMENSION_PX = ${ts} on both sides)`);
