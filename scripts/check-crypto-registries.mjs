#!/usr/bin/env node
// Crypto-registry chokepoint guard (epic #249).
//
// # The failure this exists to catch
//
// The protocol layer is built out of registries — the `SubkeyRole` table
// (`protocol.md` §3.4), the magic-byte allocation table (§10.3), the u16-BE
// length-prefix convention (§5.2), the never-reuse nonce contract (§5.3/§6.7).
// For each one the crate does the hard half correctly: ONE writer, ONE helper,
// ONE constant. What it could not do is make the second half mechanical, so
// "go through the chokepoint" was held by a doc comment and by review.
//
// When it is forgotten the outcome is identical in all four cases and it is the
// worst possible shape: the code COMPILES, `cargo clippy --workspace
// --all-targets -- -D warnings` is green, every other `scripts/check-*` guard
// passes, `pre-commit` and `pre-push` pass, and CI is green — because every one
// of these rules is invisible to the compiler. The divergence is then silent by
// construction:
//
//   - a wrong-but-self-consistent subkey still AEAD-verifies against blobs
//     written by the same wrong code;
//   - a re-typed §10.3 magic that stops matching makes a blob family quietly
//     stop syncing, with no error surfaced anywhere;
//   - a hand-rolled length prefix that truncates produces AAD bytes nothing
//     compares against;
//   - a reused nonce produces keystream reuse under a live `itemsKey`.
//
// This repo already machine-checks rules whose violation is LOUD — a missing
// i18n key, a `std::fs` call in `core/`, a stray `@tauri-apps/*` import, a
// forgotten `bumpPrefsNonce`. This one covers four whose violation is silent
// and vault-fatal. Neighbouring guard work: #273 (one shared roster of scanned
// roots for every guard), #274 (`check-core-task-seam` wasm32 exemption).
//
// # What it enforces
//
//   1. **HKDF expand.** `.expand(` may appear in no file under `protocol/src`
//      but `subkey.rs`. `derive_with_context` is already `pub(crate)` and
//      `hkdf` is never `pub use`d from `lib.rs`, so OUTSIDE the crate the
//      guarantee is structural. Inside it is not and cannot be: `scram.rs`,
//      `vault_head.rs` and `attachment_blob.rs` all legitimately import
//      `hkdf::Hkdf` for `Hkdf::extract` as the crate's HMAC-SHA-256 (RFC 5869
//      §2.2), and Rust has no way to say "this import may be used for `extract`
//      but not `expand`". A fourth module adding `hk.expand(…)` over a
//      hand-built info string would sit beside three that import the same type
//      and would pass every other gate in the repo.
//
//   2. **§10.3 magic literals.** A 4-byte magic that HAS a registry constant
//      may not be re-typed as a byte-string literal in another file. The
//      registry is discovered from the tree (every `const … : [u8; 4] = *b"…"`
//      declaration), so a magic with no constant — `MYB5` and the other
//      reserved next-major values — is deliberately NOT policed: there is
//      nothing to import. `core/src/note_nonce.rs` and
//      `core/src/attachment_nonce.rs` are the precedent this generalizes; they
//      already source `.myn` / `MYA1` from `protocol` and say why in-source.
//
//   3. **Length-prefix writer.** `.len() as u16` may appear in no file under
//      `protocol/src` but `aead.rs`, whose `push_length_prefixed_u16_be` is the
//      single source of truth for every length-prefixed AAD field. Writer-style
//      on purpose: the length and the bytes are emitted by one call, so a buggy
//      caller cannot write one without the other.
//
//   4. **`_raw` callers.** `encode_*_raw(` — the caller-supplied-nonce encoders
//      — may not be called outside `protocol/src`, `e2e/fixture-gen/` and
//      `#[cfg(test)]` regions. Nonce reuse is catastrophic and is the caller's
//      contract (`protocol/CLAUDE.md`); the `_raw` suffix is a reminder, not a
//      mechanism.
//
//      This rule stays even once the `_raw` encoders move behind a non-default
//      `raw-nonce` feature: Cargo FEATURE UNIFICATION means `cargo test
//      --workspace` and `cargo clippy --all-targets` both build with the
//      feature ON (a `[dev-dependencies]` entry enables it), so only a non-test
//      release build would catch a new production caller. That is a slow, late
//      signal. Do not "simplify" this rule away as redundant.
//
// # Exemptions, and why they are not loopholes
//
//   - **`#[cfg(test)]` regions are skipped for all four rules.** A golden test
//     asserting `&blob[0..4] == b"MYI1"` SHOULD spell the literal — otherwise
//     it asserts that a constant equals itself. Same for a test that hand-rolls
//     expected AAD bytes, or drives a `_raw` encoder with a fixed nonce, which
//     is what those functions exist for.
//   - **Comments and doc comments are stripped before matching.** The AAD /
//     HKDF prefixes and the magic values are discussed in prose all over the
//     crate; a guard that could not tell prose from code would be disabled
//     within a week.
//   - **String contents are ignored for rules 1, 3 and 4** (they are matched
//     against code with string literals blanked), and PRESERVED for rule 2,
//     which is about a byte-string literal.
//
// # Known violations (a RATCHET — this list may shrink, never grow)
//
// See KNOWN below. An entry that no longer matches must be DELETED, and the
// script fails until it is: a list that outlives its subject describes nothing.
//
// Zero dependencies, node built-ins only — same shape as
// `check-platform-seam.mjs` / `check-core-io-seam.mjs` / `check-prefs-nonce.mjs`
// (root CLAUDE.md: adding a dependency is a security decision).
//
// Run by hand: node scripts/check-crypto-registries.mjs
// Wired into: lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { RUST_CLIENT_TREES } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** Every Rust tree that can hold a violation of rules 2 or 4. */
// The two shared crates by name, then every client tree from the one roster.
//
// `mobile/src-tauri/src` was absent from the hand-written list this replaces,
// so from 2026-08-13 (when the mobile client moved in-repo) until now the guard
// that owns the HKDF-expand ownership rule, the u16-cast rule and the §10.3
// magic registry had never scanned a whole client. It reported `ok` throughout.
// Widening found no violation, which is the good outcome and also the reason
// the widening had to happen now rather than after the first one.
const SCANNED_TREES = [
  "protocol/src",
  "core/src",
  ...RUST_CLIENT_TREES,
  "e2e/fixture-gen/src",
];

/** Rule 1: the one module allowed to call `.expand(`. */
const HKDF_EXPAND_OWNER = "protocol/src/subkey.rs";

/** Rule 3: the one module allowed to cast a length to `u16`. */
const LENGTH_PREFIX_OWNER = "protocol/src/aead.rs";

/**
 * Rule 4: trees whose `encode_*_raw(` calls are legitimate.
 *
 * `protocol/src` owns the functions; `e2e/fixture-gen` is a deterministic
 * fixture generator whose whole job is byte-exact output from fixed input
 * (it uses only the `getrandom`-backed surface today — the exemption is for
 * the day it needs a pinned nonce, not cover for a production caller).
 */
const RAW_ALLOWED_TREES = ["protocol/src", "e2e/fixture-gen"];

/**
 * Recorded violations. `file` + `contains` must both match a live, non-test,
 * non-comment line; the entry is then suppressed for that rule.
 *
 * Ratchet discipline: entries may be deleted, never added without the same
 * scrutiny the rule itself got. A stale entry FAILS the run.
 */
const KNOWN = [
  {
    rule: "length-prefix",
    file: "protocol/src/attachments_catalog.rs",
    contains: ".len() as u16",
    why:
      "`aad_attachments_catalog` hand-rolls the u16-BE prefix instead of calling " +
      "`push_length_prefixed_u16_be`. The emitted bytes are correct and pinned by the " +
      "`aad_attachments_catalog_layout` test, so this is not a byte-level divergence — " +
      "but the writer's 'single source of truth' claim is not true of the crate as " +
      "written, and a future fix to the writer would not reach this site. " +
      "Fix: add `push_length_prefixed_u16_be` to the existing `use crate::aead::{…}` and " +
      "replace the two `extend_from_slice` lines with one call, then delete this entry.",
  },
  {
    rule: "raw-nonce",
    file: "core/src/plugins/vault_migrate/mod.rs",
    contains: "encode_vault_meta_v0_2_raw(",
    why:
      "The `vault.meta` family has no non-`_raw` sibling in EITHER generation — there is no " +
      "`encode_vault_meta` and no `encode_vault_meta_v0_2`, so the remedy this rule names does " +
      "not exist for this call. The property the suffix stands for does hold and is visible at " +
      "the call site: all five salts/nonces are filled by `fill_random` (a `getrandom` call with " +
      "a typed `MigrationError::Csprng`) in the eight lines directly above, and each buffer is " +
      "used once for one freshly-minted `root_key`. " +
      "A wrapper here would be a pass-through: the function also takes the new `root_key` and " +
      "`items_key`, which the migration must generate itself because the rest of the migration " +
      "re-keys every blob under them — so moving five `getrandom` calls behind the crate boundary " +
      "would hide the randomness rather than supply it, and would cost a public API plus a " +
      "randomness-failure variant on `ProtocolError` (which is serialized to the TS side). " +
      "Reviewed 2026-08-11 when this guard was found red on `develop`: it landed 2026-08-04 and " +
      "the violations arrived with the 2026-08-10 migration engine, i.e. past a `--no-verify`. " +
      "Delete this entry if a non-`_raw` `vault.meta` constructor is ever added.",
  },
];

// ── source scanning ─────────────────────────────────────────────────────────

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === "target" || name === "pkg" || name === "node_modules") continue;
      yield* walk(full);
    } else if (name.endsWith(".rs")) {
      yield full;
    }
  }
}

/**
 * Split Rust source into two parallel line arrays plus a test-region line set.
 *
 * - `code[i]`   — comments removed, string literals PRESERVED (rule 2 matches
 *                 a byte-string literal, so it needs them).
 * - `bare[i]`   — comments removed AND string/char contents blanked (rules 1,
 *                 3, 4 match code, and a pattern inside a string is not code).
 * - `testLines` — 1-based line numbers inside a `#[cfg(test)]` item.
 *
 * Hand-rolled rather than regex-per-line because `"http://…"` contains `//`
 * and `"{"` contains a brace: a line-wise stripper gets both wrong, and a
 * guard that mis-reads its own input is worse than no guard.
 */
function scanRust(src) {
  const code = [""];
  const bare = [""];
  // Brace depth measured over `bare`, plus the offsets where `#[cfg(test)]`
  // appears, so test regions can be resolved in a second pass.
  const braceEvents = []; // { line, ch: "{" | "}" | ";" }
  const cfgTestLines = [];

  let i = 0;
  let line = 0; // index into code/bare

  const push = (chCode, chBare) => {
    if (chCode === "\n") {
      code.push("");
      bare.push("");
      line += 1;
      return;
    }
    code[line] += chCode;
    bare[line] += chBare;
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // line comment
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }

    // block comment (nesting, as rustc allows)
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (src[i] === "*" && src[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          if (src[i] === "\n") push("\n", "\n");
          i += 1;
        }
      }
      continue;
    }

    // raw string: r"…", r#"…"#, br#"…"#, and the `b`-prefixed forms
    const raw = /^(b?r)(#*)"/.exec(src.slice(i, i + 16));
    if (raw) {
      const hashes = raw[2];
      const open = raw[0];
      for (const ch of open) push(ch, ch === "\n" ? "\n" : " ");
      i += open.length;
      const close = `"${hashes}`;
      while (i < src.length && src.slice(i, i + close.length) !== close) {
        push(src[i], src[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      for (const ch of close) push(ch, " ");
      i += close.length;
      continue;
    }

    // normal string: "…" or b"…"
    if (c === '"' || ((c === "b") && next === '"')) {
      if (c === "b") {
        push("b", " ");
        i += 1;
      }
      push('"', " ");
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") {
          push(src[i], " ");
          i += 1;
          if (i < src.length) {
            push(src[i], src[i] === "\n" ? "\n" : " ");
            i += 1;
          }
          continue;
        }
        push(src[i], src[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < src.length) {
        push('"', " ");
        i += 1;
      }
      continue;
    }

    // char literal — but NOT a lifetime (`'a`) or a label (`'outer:`)
    if (c === "'" || (c === "b" && next === "'")) {
      const at = c === "b" ? i + 1 : i;
      const m = /^'(\\.|[^'\\])'/.exec(src.slice(at, at + 12));
      if (m) {
        if (c === "b") {
          push("b", " ");
          i += 1;
        }
        for (const ch of m[0]) push(ch, " ");
        i += m[0].length;
        continue;
      }
    }

    if (c === "{" || c === "}" || c === ";") braceEvents.push({ line, ch: c });
    if (src.startsWith("#[cfg(test)]", i) || src.startsWith("#[cfg(all(test", i)) {
      cfgTestLines.push(line);
    }
    push(c, c);
    i += 1;
  }

  // Resolve each `#[cfg(test)]` to the span of the item that follows it: from
  // the attribute to the `}` that closes the item's block, or to the first `;`
  // if the item has no block (`#[cfg(test)] use …;`).
  const testLines = new Set();
  for (const start of cfgTestLines) {
    let depth = 0;
    let opened = false;
    let end = null;
    for (const ev of braceEvents) {
      if (ev.line < start) continue;
      if (ev.ch === "{") {
        depth += 1;
        opened = true;
      } else if (ev.ch === "}") {
        depth -= 1;
        if (opened && depth <= 0) {
          end = ev.line;
          break;
        }
      } else if (ev.ch === ";" && !opened) {
        end = ev.line;
        break;
      }
    }
    if (end === null) end = code.length - 1;
    for (let l = start; l <= end; l += 1) testLines.add(l + 1);
  }

  return { code, bare, testLines };
}

const files = [];
for (const tree of SCANNED_TREES) {
  for (const abs of walk(join(ROOT, tree))) {
    files.push({ rel: relative(ROOT, abs).split("\\").join("/"), abs });
  }
}

/**
 * A file with none of the four patterns anywhere in it — comment, string or
 * code — cannot hold a violation and cannot declare a registry constant, so it
 * is skipped before the character scanner runs. Keeps the whole-tree run under
 * a pre-commit hook's budget; deliberately over-broad (it does not care whether
 * the hit is real), because narrowing it here would duplicate the rules.
 */
const CANDIDATE = /\.expand\(|b"|as u16|_raw\s*\(/;

const scanned = new Map();
let skipped = 0;
for (const f of files) {
  const src = readFileSync(f.abs, "utf8");
  if (!CANDIDATE.test(src)) {
    skipped += 1;
    continue;
  }
  scanned.set(f.rel, scanRust(src));
}

// ── the §10.3 registry, discovered from the tree ────────────────────────────
//
// `const NAME: [u8; 4] = *b"MYX1";` / `const NAME: &[u8; 4] = b"MYX1";`
const MAGIC_DECL_RE =
  /const\s+([A-Z][A-Z0-9_]*)\s*:\s*&?\[u8;\s*4\]\s*=\s*\*?b"([\x20-\x7E]{4})"/;

/** magic value -> { name, file, line } */
const registry = new Map();
for (const [rel, s] of scanned) {
  s.code.forEach((text, idx) => {
    const m = MAGIC_DECL_RE.exec(text);
    if (!m) return;
    if (s.testLines.has(idx + 1)) return; // a fixture constant is not the registry
    if (!registry.has(m[2])) registry.set(m[2], { name: m[1], file: rel, line: idx + 1 });
  });
}

// ── rules ───────────────────────────────────────────────────────────────────

const failures = [];
const knownHit = new Set();

function isKnown(rule, rel, text) {
  const idx = KNOWN.findIndex(
    (k) => k.rule === rule && k.file === rel && text.includes(k.contains),
  );
  if (idx === -1) return false;
  knownHit.add(idx);
  return true;
}

const MAGIC_USE_RE = /b"([\x20-\x7E]{4})"/g;

for (const [rel, s] of scanned) {
  const inProtocol = rel.startsWith("protocol/src/");
  const rawExempt = RAW_ALLOWED_TREES.some((t) => rel.startsWith(`${t}/`));

  s.bare.forEach((text, idx) => {
    const line = idx + 1;
    if (s.testLines.has(line)) return;

    // rule 1 — HKDF expand outside the canonical helper
    if (inProtocol && rel !== HKDF_EXPAND_OWNER && text.includes(".expand(")) {
      if (!isKnown("hkdf-expand", rel, text)) {
        failures.push({
          rule: "hkdf-expand",
          file: rel,
          line,
          why:
            `direct HKDF expand outside ${HKDF_EXPAND_OWNER}. Derive through ` +
            "`derive_subkey(root_key, SubkeyRole::…)` instead (protocol.md §3.2.1). An ad-hoc " +
            "`info` string produces a different subkey that still AEAD-verifies against blobs " +
            "written by the same wrong code — the divergence never surfaces as an error.",
        });
      }
    }

    // rule 3 — hand-rolled u16-BE length prefix
    if (inProtocol && rel !== LENGTH_PREFIX_OWNER && /\.len\(\)\s+as\s+u16\b/.test(text)) {
      if (!isKnown("length-prefix", rel, text)) {
        failures.push({
          rule: "length-prefix",
          file: rel,
          line,
          why:
            "hand-rolled u16-BE length prefix. Call `crate::aead::push_length_prefixed_u16_be`, " +
            "the crate's single writer for every length-prefixed AAD field (protocol.md §5.2). " +
            "Emitted by hand, a length without its payload — or a truncating `as u16` — " +
            "produces AAD bytes nothing in the tree ever compares against.",
        });
      }
    }

    // rule 4 — caller-supplied-nonce encoder in production code
    if (!rawExempt) {
      const m = /\b(encode_[a-z0-9_]*_raw)\s*\(/.exec(text);
      if (m && !isKnown("raw-nonce", rel, text)) {
        failures.push({
          rule: "raw-nonce",
          file: rel,
          line,
          why:
            `production call to \`${m[1]}\`, which takes a caller-supplied nonce. Use the ` +
            "`getrandom`-backed wrapper without the `_raw` suffix. Nonce reuse under a live " +
            "`itemsKey` is keystream reuse (protocol.md §6.7), and the crate cannot detect a " +
            "cross-call collision — the `_raw` suffix is a reminder, not a mechanism.",
        });
      }
    }
  });

  // rule 2 — a re-typed §10.3 magic (needs string literals, so `code`)
  s.code.forEach((text, idx) => {
    const line = idx + 1;
    if (s.testLines.has(line)) return;
    if (MAGIC_DECL_RE.test(text)) return; // the declaration site itself
    MAGIC_USE_RE.lastIndex = 0;
    let m;
    while ((m = MAGIC_USE_RE.exec(text)) !== null) {
      const entry = registry.get(m[1]);
      if (!entry || entry.file === rel) continue;
      if (isKnown("magic-literal", rel, text)) continue;
      failures.push({
        rule: "magic-literal",
        file: rel,
        line,
        why:
          `re-typed §10.3 magic "${m[1]}"; import ${entry.name} from ${entry.file} instead. ` +
          "A re-typed magic that stops matching does not error — the reader returns `None`, the " +
          "blob reads as unchanged, and that family silently stops syncing. `core/src/note_nonce.rs` " +
          "and `core/src/attachment_nonce.rs` already source their magic from `protocol` for exactly " +
          "this reason.",
      });
    }
  });
}

// ── report ──────────────────────────────────────────────────────────────────

const stale = KNOWN.map((k, i) => ({ k, i })).filter(({ i }) => !knownHit.has(i));

if (failures.length || stale.length) {
  for (const f of failures) {
    console.error(`✗ crypto-registries [${f.rule}]: ${f.file}:${f.line}\n  ${f.why}\n`);
  }
  if (stale.length) {
    console.error("Stale KNOWN entries — these violations are gone:\n");
    for (const { k } of stale) console.error(`  [${k.rule}] ${k.file} — "${k.contains}"`);
    console.error(
      "\nDelete them from scripts/check-crypto-registries.mjs. The list is a ratchet:\n" +
        "it may shrink, never grow, and an entry that outlives its subject describes nothing.",
    );
  }
  if (failures.length) {
    console.error(
      `${failures.length} violation(s). See scripts/check-crypto-registries.mjs for why each ` +
        "rule exists — every one of them is invisible to the compiler, to clippy and to CI.",
    );
  }
  process.exit(1);
}

console.log(
  `crypto-registries: ok (${scanned.size} of ${scanned.size + skipped} Rust file(s) scanned; ` +
    `${registry.size} §10.3 magic(s) in the registry; ${KNOWN.length} recorded violation(s) ` +
    "left to clear)",
);
