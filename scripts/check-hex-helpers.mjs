#!/usr/bin/env node
// The hex-helper contract (myne-md/myne audit T6.10(c)).
//
// # What this guards
//
// `protocol/src/hex.rs` is the one lowercase-hex implementation and the one
// place the two contract questions are answered (`is_lower_hex` rejects
// uppercase and answers `true` for the empty string; `is_ascii_hex_ci` accepts
// both cases). The encoder and the predicate were nevertheless re-derived by
// hand across the tree, and the copies had drifted — on the empty string
// (`true` in one family, `!s.is_empty()` in another, masked only because every
// caller length-checked first) and on whether uppercase is accepted (rejected by
// the blob families, accepted on purpose by the two queue-id families,
// `protocol.md` §9.20.4).
//
// This guard is a RATCHET, like `check-token-adoption.mjs`: the recorded set of
// remaining local hex helpers is debt that may only SHRINK. A new local
// `fn hex_lower` / `fn is_lower_hex` fails by name — route it through
// `protocol::hex` instead — and a recorded entry whose symbol is gone fails as
// stale, so the roster cannot outlive the code it describes.
//
// # Scope, stated rather than implied
//
// ENCODERS (`hex_lower`) and PREDICATES (`is_lower_hex`, the length-scoped
// `is_lower_hex_of_len` / `is_hex_len`, and the two case-INSENSITIVE queue-id
// predicates `is_share_id` / `is_capture_id`). Decoders (`hex16`, `hex_n`,
// `hex_to_vec`, `hex_bytes`) are a separate concern and are deliberately NOT
// scanned here.
//
// Zero dependencies, hand-runnable: node scripts/check-hex-helpers.mjs [--record]

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The tree this guard reads and the roster it holds to. Overridable so a spec
// can drive it against a temp tree rather than mutating the real one (a guard
// spec that writes and deletes inside `src/` races the other pre-commit guards,
// the `prefsParity.test.ts` flake).
const scanRoot = process.env.MYNE_HEX_HELPERS_ROOT
  ? resolve(process.env.MYNE_HEX_HELPERS_ROOT)
  : repoRoot;
const ROSTER = "scripts/hex-helpers.json";

// The canonical implementation and its test-only delegate are the destination,
// not debt; they are the only files whose definitions are excluded.
const CANONICAL = ["protocol/src/hex.rs", "protocol/src/test_vector_fmt.rs"];

const ENCODER_NAMES = ["hex_lower"];
const PREDICATE_NAMES = [
  "is_lower_hex",
  "is_lower_hex_of_len",
  "is_hex_len",
  "is_ascii_hex_ci",
  // Deliberately case-insensitive (`protocol.md` §9.20.4): a share/capture id
  // is matched in either case. Recorded, not banned — but their existence is a
  // decision, and this roster is where it is written down.
  "is_share_id",
  "is_capture_id",
];
const NAMES = new Set([...ENCODER_NAMES, ...PREDICATE_NAMES]);

const SKIP_DIRS = new Set([
  "target",
  "node_modules",
  "gen",
  ".git",
  // The adversary-range companion, gitignored here and holding a vendored copy
  // of the e2e fixture-gen crate. Scanning it would record debt in a checkout
  // this guard does not own.
  "internal-service",
  // This repository puts its git worktrees under `.opencode/worktrees/<name>`
  // (root AGENTS.md, "Worktrees"), so a SIBLING CHECKOUT sits inside the tree
  // this guard walks. Without this line, any Rust change in the main repo while
  // another session has a worktree open fails here, naming that session's
  // half-finished files as this tree's new hex-helper debt — and a guard that
  // reports another checkout's work is a guard whose red says nothing about the
  // tree it was run in. Found by this guard firing on a sibling worktree during
  // Aşama 3's R1.2; `.opencode/` holds agent configuration and worktrees, never
  // source.
  ".opencode",
]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".rs")) out.push(full);
  }
  return out;
}

/** `relpath::symbol` for every local hex-helper definition, sorted. */
function findHelpers() {
  const found = new Map();
  for (const file of walk(scanRoot)) {
    const rel = relative(scanRoot, file);
    if (rel.split(sep).some((p) => SKIP_DIRS.has(p))) continue;
    if (CANONICAL.includes(rel)) continue;
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line) => {
      const m = /^\s*(?:pub(?:\(crate\))?\s+)?fn\s+([a-z_0-9]+)\s*[(<]/.exec(line);
      if (!m || !NAMES.has(m[1])) return;
      found.set(`${rel}::${m[1]}`, rel);
    });
  }
  return found;
}

const helpers = findHelpers();

if (process.argv.includes("--record")) {
  let roster;
  let existed = true;
  try {
    roster = JSON.parse(readFileSync(join(scanRoot, ROSTER), "utf8"));
  } catch {
    roster = {};
    existed = false; // first seed: there is nothing to grow beyond
  }
  const grown = [...helpers.keys()].filter((k) => !(k in roster));
  if (existed && grown.length > 0) {
    // The command the failure message suggests must not be able to make a
    // growth go away (the `check-twin-drift-ratchet.mjs` refusal).
    console.error("refusing to --record a GROWN hex-helper set:");
    for (const k of grown) console.error(`  + ${k}`);
    console.error(
      "\nA new local hex helper is routed through `protocol::hex`, not recorded. " +
        "Recording it would lock in the duplication this guard exists to shrink.",
    );
    process.exit(1);
  }
  const shrunk = Object.fromEntries(
    Object.keys(roster)
      .filter((k) => helpers.has(k))
      .map((k) => [k, roster[k]]),
  );
  // Seed a fresh entry with a placeholder the reason check REJECTS, so a
  // recorded-but-unreasoned helper fails the next run rather than passing on
  // its own placeholder (the `check-ipc-binding-callers.mjs` lesson).
  for (const k of helpers.keys()) {
    if (!(k in shrunk)) shrunk[k] = "TODO";
  }
  writeFileSync(join(scanRoot, ROSTER), `${JSON.stringify(shrunk, null, 2)}\n`);
  console.log(`hex helpers: recorded ${Object.keys(shrunk).length} remaining entr(y|ies)`);
  process.exit(0);
}

const failures = [];
let roster;
try {
  roster = JSON.parse(readFileSync(join(scanRoot, ROSTER), "utf8"));
} catch {
  console.error(`${ROSTER}: missing or unreadable. Run with --record to seed it.`);
  process.exit(1);
}

for (const key of helpers.keys()) {
  if (!(key in roster)) {
    failures.push(
      `${key}: a new local hex helper. Route it through \`protocol::hex\` ` +
        `(encode_lower / is_lower_hex / is_ascii_hex_ci) rather than re-deriving the ` +
        `contract. The copies drifted once already; that is why the module exists.`,
    );
  }
}
for (const key of Object.keys(roster)) {
  if (!helpers.has(key)) {
    failures.push(`${key}: recorded but no longer defined. Remove it; the roster is the debt.`);
  }
}
for (const [key, reason] of Object.entries(roster)) {
  if (typeof reason !== "string" || reason.trim().length < 12) {
    failures.push(`${key}: roster entry needs a reason (12+ chars).`);
  }
}

if (failures.length > 0) {
  console.error("hex helpers: FAILED");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(
  `hex helpers: ok (${Object.keys(roster).length} local helper(s) recorded as debt; ` +
    `the contract lives in protocol/src/hex.rs)`,
);
