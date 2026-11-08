#!/usr/bin/env node
// The hex-helper contract (myne-md/myne audit T6.10(c), extended for R1.2).
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
// # The decoder half (audit 2026-10-18, R1.2)
//
// The predicates were unified and the DECODERS were not, so hand-written
// `fn hex_decode_16`-shaped helpers grew across `core/` and two of them
// disagreed about the case of the same 32-character id space: one accepted
// `A`–`F` and the other rejected it. Nothing panicked and nothing errored — the
// caller got `None`, which reads as "no such thing" rather than "your spelling
// is wrong". `protocol::hex::decode_lower` (strict, own-writer data) and
// `protocol::hex::decode_ci` (lenient, a value that arrived from elsewhere)
// are the two policies; this half is the SAME ratchet over the local decoders
// that remain.
//
// A local decoder is flagged when it is a function whose NAME is in the
// decoder family OR whose BODY hand-rolls a hex decode (`from_str_radix(…, 16)`
// / `to_digit(16)`). A function that already routes through
// `protocol::hex::decode_lower` / `decode_ci` (a thin delegate) is NOT flagged:
// it has adopted the contract, which is the whole point. Test functions
// (`#[test]` + friends) are skipped, or every test named after the helper it
// exercises would read as debt.
//
// # Scope, stated rather than implied
//
// ENCODERS (`hex_lower`) and PREDICATES (`is_lower_hex`, the length-scoped
// `is_lower_hex_of_len` / `is_hex_len`, and the two case-INSENSITIVE queue-id
// predicates `is_share_id` / `is_capture_id`). DECODERS are the second half,
// scanned the same way over the same tree.
//
// Zero dependencies, hand-runnable: node scripts/check-hex-helpers.mjs [--record]

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
const DECODER_ROSTER = "scripts/hex-helpers-decoders.json";

// The floor on decoder sites the scan must find. It is a NON-VACUITY floor, not
// the debt (the roster is the debt): it is what stops an unreadable root or a
// broken detector from printing ok over an empty denominator, which is the
// "green because it checked nothing" shape this file's siblings record. Set
// comfortably below the measured set so ordinary migration (a decoder routed
// through `protocol::hex` and deleted) does not trip it; it may only be RAISED
// by hand. Overridable so a spec can drive the floor against a synthetic tree
// that holds one or two functions rather than the real tree's set.
const DECODER_SCAN_FLOOR = Number(process.env.MYNE_HEX_HELPERS_DECODER_FLOOR ?? 10);

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

// The decoder family, by name. A new helper in one of these shapes is caught
// even if it is a pure delegate, so the point where a caller picks a policy
// stays visible; a delegate that routes through `protocol::hex` is exempted
// below, because adopting the contract is the fix rather than the debt.
const DECODER_NAME_PATTERNS = [
  /^hex_decode/,
  /^hex16$/,
  /^hex_n$/,
  /^hex_to_/,
  /^hex_bytes$/,
  /^from_hex/,
  /^parse_.*hex/,
  /_from_hex$/,
  /^unhex$/,
  /^decode_.*hex/,
];
// The other signal: a body that HAND-ROLLS the nibble walk rather than calling
// the canonical decoder, whatever the function is named.
const DECODE_MARK = /from_str_radix\s*\([^;]*?,\s*16\s*\)|to_digit\s*\(\s*16\s*\)/;
// A body that already adopted the contract, either spelling.
const ROUTES_CANONICAL = /(?:protocol|crate)::hex::decode_(?:lower|ci)\s*(?:::<|:|\()/;

const SKIP_DIRS = new Set([
  "target",
  "node_modules",
  "gen",
  ".git",
  // The adversary-range companion, gitignored here and holding a vendored copy
  // of the e2e fixture-gen crate. Scanning it would record debt in a checkout
  // this guard does not own.
  "myne-range",
  // This repository puts its git worktrees under `.worktrees/<name>`
  // (root AGENTS.md, "Worktrees"), so a SIBLING CHECKOUT sits inside the tree
  // this guard walks. Without this line, any Rust change in the main repo while
  // another session has a worktree open fails here, naming that session's
  // half-finished files as this tree's new hex-helper debt — and a guard that
  // reports another checkout's work is a guard whose red says nothing about the
  // tree it was run in. Found by this guard firing on a sibling worktree during
  // Aşama 3's R1.2; `.opencode/` holds agent configuration and worktrees, never
  // source.
  ".opencode", ".worktrees"]);

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

const FN_DECL = /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?fn\s+([a-z_0-9]+)/;

/** Every `fn` body in `text`, by indentation (the tree is rustfmt-clean), as
 * `{ name, body, isTest }`. Exported so `tests/scripts/hexHelpers.test.ts` can
 * drive the detector directly as well as through the process. */
export function decoderFunctions(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = FN_DECL.exec(lines[i]);
    if (!m) continue;
    const indent = m[1];
    let body = lines[i];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].startsWith(`${indent}}`)) break;
      body += `\n${lines[j]}`;
    }
    // A test function is skipped: it is named after the helper it exercises, so
    // a name match would read every `fn hex_decode_rejects_uppercase` as debt.
    let isTest = false;
    for (let k = i - 1; k >= 0; k -= 1) {
      const prev = lines[k].trim();
      if (prev === "") continue;
      if (prev.startsWith("#[")) {
        if (/test/.test(prev)) isTest = true;
        continue;
      }
      break;
    }
    out.push({ name: m[2], body, isTest });
  }
  return out;
}

/** Is this one function a local decoder the contract says to route? */
export function isLocalDecoder({ name, body }) {
  if (ROUTES_CANONICAL.test(body)) return false;
  return DECODER_NAME_PATTERNS.some((re) => re.test(name)) || DECODE_MARK.test(body);
}

/** `relpath::symbol` for every local decoder definition. */
function findDecoders() {
  const found = new Map();
  for (const file of walk(scanRoot)) {
    const rel = relative(scanRoot, file);
    if (rel.split(sep).some((p) => SKIP_DIRS.has(p))) continue;
    if (CANONICAL.includes(rel)) continue;
    const text = readFileSync(file, "utf8");
    for (const fn of decoderFunctions(text)) {
      if (fn.isTest) continue;
      if (isLocalDecoder(fn)) found.set(`${rel}::${fn.name}`, rel);
    }
  }
  return found;
}

function readRoster(name) {
  return JSON.parse(readFileSync(join(scanRoot, name), "utf8"));
}

function verifyRoster(rosterName, found, hint) {
  const failures = [];
  let roster;
  try {
    roster = readRoster(rosterName);
  } catch {
    console.error(`${rosterName}: missing or unreadable. Run with --record to seed it.`);
    process.exit(1);
  }
  for (const key of found.keys()) {
    if (!(key in roster)) {
      failures.push(`${key}: ${hint}`);
    }
  }
  for (const key of Object.keys(roster)) {
    if (!found.has(key)) {
      failures.push(`${key}: recorded but no longer defined. Remove it; the roster is the debt.`);
    }
  }
  for (const [key, reason] of Object.entries(roster)) {
    if (typeof reason !== "string" || reason.trim().length < 12 || reason.trim() === "TODO") {
      failures.push(`${key}: roster entry needs a reason (12+ chars).`);
    }
  }
  return failures;
}

function recordRoster(label, rosterName, found) {
  let roster;
  let existed = true;
  try {
    roster = readRoster(rosterName);
  } catch {
    roster = {};
    existed = false; // first seed: there is nothing to grow beyond
  }
  const grown = [...found.keys()].filter((k) => !(k in roster));
  if (existed && grown.length > 0) {
    // The command the failure message suggests must not be able to make a
    // growth go away (the `check-twin-drift-ratchet.mjs` refusal).
    console.error(`refusing to --record a GROWN ${label} set:`);
    for (const k of grown) console.error(`  + ${k}`);
    console.error(
      `\nA new local hex ${label} is routed through \`protocol::hex\`, not recorded. ` +
        "Recording it would lock in the duplication this guard exists to shrink.",
    );
    process.exit(1);
  }
  const shrunk = Object.fromEntries(
    Object.keys(roster)
      .filter((k) => found.has(k))
      .map((k) => [k, roster[k]]),
  );
  // Seed a fresh entry with a placeholder the reason check REJECTS, so a
  // recorded-but-unreasoned helper fails the next run rather than passing on
  // its own placeholder (the `check-ipc-binding-callers.mjs` lesson).
  for (const k of found.keys()) {
    if (!(k in shrunk)) shrunk[k] = "TODO";
  }
  writeFileSync(join(scanRoot, rosterName), `${JSON.stringify(shrunk, null, 2)}\n`);
  return Object.keys(shrunk).length;
}

function main() {
  // A root that cannot be read must fail BY NAME rather than scanning nothing
  // and printing ok.
  if (!existsSync(scanRoot)) {
    console.error(`check-hex-helpers: scan root does not exist: ${scanRoot}`);
    process.exit(1);
  }

  const helpers = findHelpers();
  const decoders = findDecoders();

  if (process.argv.includes("--record")) {
    const encCount = recordRoster("hex-helper", ROSTER, helpers);
    const decCount = recordRoster("decoder", DECODER_ROSTER, decoders);
    console.log(
      `hex helpers: recorded ${encCount} encoder entr(y|ies) and ${decCount} decoder entr(y|ies)`,
    );
    process.exit(0);
  }

  const failures = [];
  if (decoders.size < DECODER_SCAN_FLOOR) {
    failures.push(
      `decoder scan found ${decoders.size} site(s), below the floor of ${DECODER_SCAN_FLOOR}: ` +
        "an empty or narrowed denominator must fail by name, not print ok. " +
        "If decoders were migrated, lower the floor deliberately.",
    );
  }

  failures.push(
    ...verifyRoster(
      ROSTER,
      helpers,
      "a new local hex helper. Route it through `protocol::hex` " +
        "(encode_lower / is_lower_hex / is_ascii_hex_ci) rather than re-deriving the " +
        "contract. The copies drifted once already; that is why the module exists.",
    ),
  );
  failures.push(
    ...verifyRoster(
      DECODER_ROSTER,
      decoders,
      "a new local hex decoder. Route it through `protocol::hex` " +
        "(decode_lower for own-writer data, decode_ci for a value that arrived from " +
        "elsewhere) rather than re-deriving the nibble walk. If it is NOT decoding an " +
        "id (a JSON escape, an HTTP chunk size), record it with that reason instead.",
    ),
  );

  if (failures.length > 0) {
    console.error("hex helpers: FAILED");
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }

  console.log(
    `hex helpers: ok (${Object.keys(readRoster(ROSTER)).length} local helper(s) recorded as debt; ` +
      `${Object.keys(readRoster(DECODER_ROSTER)).length} local decoder(s) recorded as debt; ` +
      `${decoders.size} decoder site(s) found; the contract lives in protocol/src/hex.rs)`,
  );
}

// Run the check only when this file IS the command: importing the exported
// detector from the spec must not walk the tree and `process.exit` inside the
// test runner (the `check-ipc-binding-callers.mjs` shape).
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
