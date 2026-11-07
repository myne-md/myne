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
//      contract (`protocol/AGENTS.md`); the `_raw` suffix is a reminder, not a
//      mechanism.
//
//      This rule stays even once the `_raw` encoders move behind a non-default
//      `raw-nonce` feature: Cargo FEATURE UNIFICATION means `cargo test
//      --workspace` and `cargo clippy --all-targets` both build with the
//      feature ON (a `[dev-dependencies]` entry enables it), so only a non-test
//      release build would catch a new production caller. That is a slow, late
//      signal. Do not "simplify" this rule away as redundant.
//
//   5. **Magic-generation parity.** A file that names a family's BASE magic
//      constant must also name every later generation of it. Both halves exist
//      for every family §10.4.1 migrates (`MYA1`/`MYA5`, `MYC1`/`MYC5`,
//      `MYP1`/`MYP5`, `MYD1`/`MYD5`, `MYT1`/`MYT5`, `MYV1`/`NTV5`,
//      `MY01`/`NC05`), and a reader taught only the base one does not degrade
//      on a migrated vault. It stops, silently, because a magic mismatch
//      returns `None` and `None` reads as "not this family, nothing to do".
//
//      This shipped (myne-md/myne#638); `design-notes/protocol/0567` carries
//      the incident and the measurements. The short version: one hand-written
//      comparison in `core/src/attachment_nonce.rs` named `MYA1` and not
//      `MYA5`, so no attachment body moved in either direction on any migrated
//      vault while the catalog kept syncing, and every gate in this repository
//      was green. The deeper fix went in with it: all five families now read
//      their nonce through `core/src/content_nonce.rs`, which takes the
//      generations as a REQUIRED argument, so the one-generation reader is no
//      longer expressible there. This rule is the backstop for the rest of the
//      tree, where the codecs and the magic-detecting dispatches still name
//      their constants directly.
//
//      The family table is derived from a `_V<n>_<m>_MAGIC` PATTERN rather than
//      from the literal `_V0_2_MAGIC`, so a third generation joins it with no
//      edit here. A rule that exists because one generation was missed must not
//      itself be keyed to one named generation.
//
//      Neighbouring guard, and the distinction is worth knowing before adding
//      an exemption to the wrong one: `scripts/check-version-routing.mjs` owns
//      the same hazard one layer up, at the FUNCTION call (a v0.1-only
//      `decode_note` / `derive_subkey` where a version-aware one exists). This
//      rule owns it at the CONSTANT. A legitimately single-generation reader is
//      recorded in `KNOWN` here and in that script's own `ALLOWED` there.
//
//      The base side is matched in non-test code only (a base-only golden test
//      is legitimate); a later generation counts anywhere in the file,
//      including tests, because the question is whether this file knows the
//      generation exists at all. A file is exempt only when it declares exactly
//      ONE of the family's generations and the rest live elsewhere
//      (`vault_meta.rs` against `vault_meta_v0_2.rs`, `blob.rs` against
//      `crdt_note_blob.rs`), because a declaration accepts nothing. A file that
//      declares SEVERAL generations is a codec, and it gets no exemption: the
//      blanket version of this rule excused every codec in `protocol/src` from
//      the rule whose stated job is those files, most damagingly at the moment
//      it should fire, when a third generation lands in a sibling module and the
//      codec's dispatch still handles two out of three.
//
//      What it structurally cannot see, stated rather than implied: it is keyed
//      on constant NAMES, so it reaches a file that mentions a magic and not
//      one that calls a reader which mentions it, and it does not distinguish
//      mentioning a generation from HANDLING it. Those are why the behavioural
//      half, the two-generation sync scenarios in
//      `core/src/plugins/sync/orchestrator.rs`, is not optional.
//
// # Exemptions, and why they are not loopholes
//
//   - **`#[cfg(test)]` regions are skipped for rules 1 to 4, and for rule 5 in
//     ONE direction only.** A golden test asserting `&blob[0..4] == b"MYI1"`
//     SHOULD spell the literal — otherwise it asserts that a constant equals
//     itself. Same for a test that hand-rolls expected AAD bytes, or drives a
//     `_raw` encoder with a fixed nonce, which is what those functions exist for.
//
//     Rule 5 is deliberately asymmetric and this section used to say the
//     opposite. Its BASE side reads non-test lines only (a golden test pinning
//     v0.1 bytes is legitimate and says nothing about what the reader accepts),
//     while its LATER side matches `bareText`, which spans the whole file
//     including test regions, because the question there is only whether the
//     file knows the generation exists at all. The rule 5 header twenty lines
//     above states this; the count said "all four" after a fifth rule landed,
//     and a stale count beside an inverted claim is how somebody records the
//     wrong exemption.
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
// (root AGENTS.md: adding a dependency is a security decision).
//
// Run by hand: node scripts/check-crypto-registries.mjs
// Wired into: lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { RUST_CLIENT_TREES } from "./lib/shared-roots.mjs";
import { isExtractedTestModule } from "./lib/test-module-files.mjs";

// `--root <dir>` points the scan at a synthetic tree, which is how this
// guard's own tests inject each defect it claims to catch (root AGENTS.md:
// "verifying a guard means breaking it, not running it"). A guard verified only
// by mutating the real checkout by hand is verified by evidence that expires
// the moment somebody forgets to restore.
const ROOT_FLAG = process.argv.indexOf("--root");
const FIXTURE_RUN = ROOT_FLAG !== -1;
const ROOT = FIXTURE_RUN
  ? resolve(process.argv[ROOT_FLAG + 1])
  : new URL("..", import.meta.url).pathname;

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
  "format/src",
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
 * Rule 5: magic pairs the `<STEM>_MAGIC` / `<STEM>_V0_2_MAGIC` naming does not
 * describe, named here rather than derived.
 *
 * The note family is the only one: its v0.1 half is `protocol::blob::MAGIC`
 * (`MY01`, no stem at all) and its v0.2 half is `protocol::NC05_MAGIC`, so no
 * pattern over the registry can pair them. Named entries are checked BOTH ways
 * each magic below must still be in the registry, or this list is describing
 * a family that no longer exists and the run fails. A purely derived pair table
 * would silently drop this family; a purely named one would drop every family
 * added later.
 *
 * `v1.token` / `v2.token` are the source spellings a file uses, not the constant
 * names: `MAGIC` alone matches half the crate, while `blob::MAGIC` is how every
 * caller actually writes it.
 *
 * `selfToken` is the spelling used INSIDE the declaring file, and it exists
 * because the caller spelling and the declaration spelling are different words
 * for this family alone. `protocol/src/blob.rs` declares `MAGIC` and then
 * rejects on it (`if &blob[0..MAGIC.len()] != MAGIC` at :587), the identical
 * shape `vault_meta.rs` is failed and then recorded for, but `blob::MAGIC`
 * never matches inside `blob.rs`, so the file the rule most wants to see was
 * the one file it could not. Matching `selfToken` ANYWHERE would be the
 * half-the-crate problem the paragraph above rejects, so it is matched only
 * within the declaring file, which the registry already names.
 */
const EXTRA_MAGIC_PAIRS = [
  {
    family: "note",
    v1: { magic: "MY01", token: "blob::MAGIC", selfToken: "MAGIC" },
    v2: { magic: "NC05", token: "NC05_MAGIC" },
  },
];

/**
 * Recorded violations. `file` + `contains` must both match a live, non-test,
 * non-comment line; the entry is then suppressed for that rule.
 *
 * Ratchet discipline: entries may be deleted, never added without the same
 * scrutiny the rule itself got. A stale entry FAILS the run.
 */
const KNOWN = [
  {
    rule: "magic-parity",
    file: "protocol/src/blob.rs",
    contains: "MAGIC",
    // The generations this entry excuses, and ONLY these. A third note
    // generation changes the missing set and this entry stops applying.
    missing: "NC05_MAGIC",
    why:
      "`decode_note` is deliberately v0.1-only and its single-generation rejection at " +
      "`if &blob[0..MAGIC.len()] != MAGIC` is the correct behaviour for it: the version-aware " +
      "entry point is `decode_note_any` in `core/src/plugins/notes/decode.rs`, which reads the " +
      "first four bytes, decides the generation, and calls this codec only once it has " +
      "established the blob IS `MY01`. Structurally identical to the `vault_meta.rs` entry, " +
      "and recorded for the same reason: a codec behind a dispatcher, not the myne-md/myne#638 " +
      "shape of a reader that silently answers `None`. " +
      "This file became visible to rule 5 only when `EXTRA_MAGIC_PAIRS` gained `selfToken`: the " +
      "note family's caller spelling is `blob::MAGIC` and this file writes the bare `MAGIC`, so " +
      "before that the rule skipped the one file it most wanted to read, and the guard's own " +
      "comment claiming the codecs were covered was overstating what it checked. " +
      "Who holds the other half: `scripts/check-version-routing.mjs` is the ratchet on the " +
      "CALLERS. Delete this entry if `decode_note` ever learns both generations.",
  },
  {
    rule: "magic-parity",
    file: "protocol/src/vault_meta.rs",
    contains: "VAULT_META_MAGIC",
    // A `VAULT_META_V0_3_MAGIC` or a further NTV generation in a sibling module
    // changes this set and the file starts failing again, which is the property
    // a file-wide entry could not have.
    missing: "VAULT_META_NTV6_MAGIC,VAULT_META_NTV7_MAGIC,VAULT_META_NTV8_MAGIC,VAULT_META_V0_2_MAGIC",
    why:
      "`parse_vault_meta` is deliberately v0.1-only and its single-generation rejection at " +
      "`bytes[0..4] != VAULT_META_MAGIC` is the correct behaviour for it: the version-aware " +
      "entry point is `parse_vault_meta_any` in `vault_meta_v0_2.rs`, which reads the first " +
      "four bytes, decides `MetaVersion`, and calls this function only once it has established " +
      "the blob IS v0.1. This is the one case rule 5's failure text names as legitimate, a " +
      "codec behind a dispatcher, rather than the myne-md/myne#638 shape of a reader that " +
      "silently answers `None`. " +
      "Who holds the other half: `scripts/check-version-routing.mjs` is the ratchet on the " +
      "CALLERS, and it is what fails when a new reader reaches for `parse_vault_meta` where a " +
      "version-aware helper exists. That split is why this entry is a recorded exemption and " +
      "not a hole: this guard owns the codec, that one owns who may call it. " +
      "Delete this entry if `parse_vault_meta` ever learns both generations, or if the v0.1 " +
      "path is retired.",
  },
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
      if (isExtractedTestModule(full)) continue;
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
 * A file with none of the five patterns anywhere in it (comment, string or
 * code) cannot hold a violation and cannot declare a registry constant, so it
 * is skipped before the character scanner runs. Keeps the whole-tree run under
 * a pre-commit hook's budget; deliberately over-broad (it does not care whether
 * the hit is real), because narrowing it here would duplicate the rules.
 *
 * `MAGIC` is the fifth, and it is here because rule 5 is the one rule whose
 * subject is a CONSTANT NAME rather than a literal or a call. Without it a file
 * that imports `PREFS_BLOB_MAGIC` and contains no byte-string, no `.expand(`,
 * no `as u16` and no `_raw(` is skipped before rule 5 ever looks at it, and a
 * prefilter blind spot is a rule that reports ok on input it never read, which
 * is the failure mode this whole file exists to make impossible.
 */
const CANDIDATE = /\.expand\(|b"|as u16|_raw\s*\(|MAGIC/;

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

// ── rule 5's family table: derived from the registry, plus the named
// off-pattern family, and checked BOTH ways so neither half goes out of date ──

/** `\b`-anchored matcher for a source token (a constant name, or `mod::NAME`). */
const reFor = (token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

/** constant name -> { magic, file } */
const byName = new Map([...registry].map(([magic, e]) => [e.name, { magic, file: e.file }]));

/**
 * Every family carrying more than one generation, as
 * `{ family, base, later: [...] }`, with each token's matcher compiled ONCE.
 *
 * The generation suffix is read as a PATTERN rather than as the literal
 * `_V0_2_MAGIC`, and that is deliberate: a rule written because one generation
 * was missed must not itself be keyed to one named generation. When a family
 * grows a `_V0_3_MAGIC` constant it joins `later` with no edit here, and a file
 * that knows v0.1 and v0.2 but not v0.3 starts failing by name.
 */
const magicFamilies = [];
const GENERATION_SUFFIX = /^(.+)_V(\d+)_(\d+)_MAGIC$/;
// The vault-meta family names its later generations `NTV5`/`NTV6` rather than
// `_V0_2_MAGIC`, so a second pattern maps them to the same `VAULT_META` stem.
// Without it `VAULT_META_NTV6_MAGIC` is invisible to rule 5 and the third
// generation of a family the rule exists for goes unchecked.
const NTV_GENERATION_SUFFIX = /^(.+)_NTV(\d+)_MAGIC$/;
const laterByStem = new Map();
for (const [name, e] of byName) {
  const m = GENERATION_SUFFIX.exec(name);
  if (!m) continue;
  const generations = laterByStem.get(m[1]) ?? [];
  generations.push({
    magic: e.magic,
    token: name,
    gen: `v${m[2]}.${m[3]}`,
    file: e.file,
    re: reFor(name),
  });
  laterByStem.set(m[1], generations);
}
for (const [name, e] of byName) {
  const m = NTV_GENERATION_SUFFIX.exec(name);
  if (!m) continue;
  const generations = laterByStem.get(m[1]) ?? [];
  generations.push({
    magic: e.magic,
    token: name,
    gen: `ntv${m[2]}`,
    file: e.file,
    re: reFor(name),
  });
  laterByStem.set(m[1], generations);
}
for (const [stem, later] of laterByStem) {
  const baseToken = `${stem}_MAGIC`;
  const base = byName.get(baseToken);
  // A later-generation constant with no `<STEM>_MAGIC` base means the base is
  // spelled differently; EXTRA_MAGIC_PAIRS is where such a family is named.
  if (!base) continue;
  magicFamilies.push({
    family: stem.toLowerCase(),
    base: { magic: base.magic, token: baseToken, gen: "base", file: base.file, re: reFor(baseToken) },
    later,
  });
}
for (const p of EXTRA_MAGIC_PAIRS) {
  const base = registry.get(p.v1.magic);
  const later = registry.get(p.v2.magic);
  if (!base || !later) {
    failures.push({
      rule: "magic-parity",
      file: "scripts/check-crypto-registries.mjs",
      line: 1,
      why:
        `EXTRA_MAGIC_PAIRS names the ${p.family} family as ${p.v1.magic}/${p.v2.magic}, but ` +
        `${base ? p.v2.magic : p.v1.magic} is no longer a declared §10.3 constant anywhere in ` +
        "the tree. A named pair that outlives its subject checks nothing: fix the magic or " +
        "delete the entry.",
    });
    continue;
  }
  // The SPELLINGS, checked. The block comment above claims named entries are
  // compared both ways so a pair cannot outlive its subject, and until now that
  // was true only of the magic VALUES: `registry.get("MY01")` succeeds as long
  // as SOMETHING declares `MY01`, whatever it is called. Rename or re-home
  // `protocol::blob::MAGIC` and both lookups still pass while `reFor(...)`
  // matches nothing, every file short-circuits at the `baseRe` test, and the
  // note family's parity check ceases to exist with the guard printing ok. That
  // is the silent-pass shape rule 5 exists to remove, and this is the pair the
  // round-2 commit already had to repair once for a spelling reason.
  //
  // The registry records the CONSTANT NAME it saw at the declaration, so the
  // final segment of each hand-typed token must equal it. `selfToken`, when
  // present, IS that bare name and is compared to the same thing.
  for (const [side, tok, reg] of [
    ["v1", p.v1, base],
    ["v2", p.v2, later],
  ]) {
    const spelled = tok.token.split("::").pop();
    if (spelled !== reg.name) {
      failures.push({
        rule: "magic-parity",
        file: "scripts/check-crypto-registries.mjs",
        line: 1,
        why:
          `EXTRA_MAGIC_PAIRS spells the ${p.family} family's ${side} token ` +
          `\`${tok.token}\`, whose final segment is \`${spelled}\`, but ${tok.magic} is ` +
          `declared as \`${reg.name}\` in ${reg.file}. The magic VALUE still resolves, so ` +
          "both roster lookups pass while every match in rule 5 silently stops firing for " +
          "this family. Fix the token spelling or the constant name.",
      });
    }
  }
  if (p.v1.selfToken && p.v1.selfToken !== base.name) {
    failures.push({
      rule: "magic-parity",
      file: "scripts/check-crypto-registries.mjs",
      line: 1,
      why:
        `EXTRA_MAGIC_PAIRS gives the ${p.family} family the declaring-file spelling ` +
        `\`${p.v1.selfToken}\`, but ${p.v1.magic} is declared as \`${base.name}\` in ` +
        `${base.file}. The declaring file is exactly the one this spelling exists to make ` +
        "visible, so a wrong one restores the blind spot it was added to close.",
    });
  }
  magicFamilies.push({
    family: p.family,
    base: {
      magic: p.v1.magic,
      token: p.v1.token,
      gen: "base",
      file: base.file,
      // Inside the declaring file the base is spelled `selfToken`; everywhere
      // else it is the namespaced `token`. One regex per file, chosen by which
      // file is being scanned, so the bare spelling never leaks outside.
      re: reFor(p.v1.token),
      selfRe: p.v1.selfToken ? reFor(p.v1.selfToken) : null,
    },
    later: [
      { magic: p.v2.magic, token: p.v2.token, gen: "v0.2", file: later.file, re: reFor(p.v2.token) },
    ],
  });
}

/** Does this file COMPARE bytes against one of the family's magic constants,
 *  outside a `#[cfg(test)]` region?
 *
 *  This is the one condition that narrows rule 5's declaration exemption, so
 *  what it matches and what it deliberately does not both matter.
 *
 *  MATCHES a decision about what the file accepts:
 *      if bytes[0..4] != VAULT_META_MAGIC
 *      if &blob[0..MAGIC.len()] != MAGIC
 *      Some(m) if m == VAULT_META_MAGIC.as_slice()
 *      header.starts_with(&NC05_MAGIC)
 *
 *  DOES NOT MATCH a write, which is what keeps every encoder exempt:
 *      out[0..4].copy_from_slice(&VAULT_META_MAGIC)
 *
 *  The token may be namespaced (`blob::MAGIC` in `EXTRA_MAGIC_PAIRS`), so the
 *  final segment is what a call site actually spells after a `use`. Both forms
 *  are accepted rather than only the bare one, because a fully-qualified
 *  comparison is still a comparison. */
function comparesMagic(s, tokens) {
  for (let i = 0; i < s.bare.length; i += 1) {
    if (s.testLines.has(i + 1)) continue;
    const text = s.bare[i];
    if (text === "") continue;
    for (const t of tokens) {
      const bare = t.token.split("::").pop();
      const name = `(?:[A-Za-z_][A-Za-z0-9_]*::)*${bare}`;
      // `x == NAME` / `x != NAME`, either operand order, optional `&`.
      if (new RegExp(`[!=]=\\s*&?${name}\\b`).test(text)) return true;
      if (new RegExp(`\\b${name}\\b[^=!<>]*[!=]=`).test(text)) return true;
      if (new RegExp(`starts_with\\(\\s*&?${name}\\b`).test(text)) return true;
    }
  }
  return false;
}

/** Is this violation on the recorded ratchet?
 *
 *  ALWAYS false under `--root`, and that is the load-bearing half. `KNOWN` names
 *  real paths in this repository, and a fixture is free to write a file at any
 *  path it likes, so a fixture that reproduces `protocol/src/vault_meta.rs` was
 *  being suppressed by the real entry for that file. The case asserting the
 *  declaration exemption still holds was therefore comparing the guard against a
 *  second copy of itself: injecting `return true` into `comparesMagic`, which
 *  disables the exemption outright, left all ten cases green. That is the exact
 *  non-evidence pattern root AGENTS.md records.
 *
 *  The stale-entry check at the report section already skips under `FIXTURE_RUN`
 *  for the mirror-image reason (a fixture tree cannot satisfy entries about the
 *  real one). Suppression had to follow it. */
function isKnown(rule, rel, text, missingTokens = null) {
  if (FIXTURE_RUN) return false;
  const idx = KNOWN.findIndex(
    (k) =>
      k.rule === rule &&
      k.file === rel &&
      text.includes(k.contains) &&
      // `missing` is required for `magic-parity` and absent everywhere else.
      // Compared for EQUALITY rather than membership: an entry excusing "this
      // file knows MY01 and not NC05" must stop applying the moment the file
      // also fails to know a third generation, which is a different fact.
      (missingTokens === null || k.missing === missingTokens),
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

  // rule 5: a family's base magic named without every later generation of it.
  // File-scoped rather than line-scoped: the question is whether this file knows
  // the migrated generations exist, and the answer can legitimately live in a
  // test or in a `use` twenty lines from the comparison.
  //
  // The cheap disqualifier runs FIRST and against the joined file rather than
  // per line. Measured on this tree, the naive order (whole-file scan for the
  // later generation, per-line regex construction) cost 552 ms of the guard's
  // 1142 ms whole-tree run, which `pre-commit` pays on every commit including a
  // docs-only one: 1449 file-times-family combos were evaluated and 21 of them
  // had the base token at all.
  const bareText = magicFamilies.length > 0 ? s.bare.join("\n") : "";
  for (const fam of magicFamilies) {
    const all = [fam.base, ...fam.later];
    // A file is exempt only when it declares exactly ONE of the family's
    // generations and the others live elsewhere. `vault_meta.rs` declares `MYV1`
    // while `NTV5` is a sibling module: a declaration accepts nothing, so
    // requiring both names there would fail the declaration itself. A file that
    // declares SEVERAL of a family's generations is a codec, and a codec that
    // knows two generations out of three is exactly what this rule is for.
    //
    // The distinction is not pedantry, and it is where the first version of this
    // rule was wrong. Exempting every declaration site excused all six codecs and
    // their magic-detecting dispatches (`attachment_blob.rs`, `attachments_catalog.rs`,
    // `prefs.rs`, `themes_blob.rs`, `dictionary_blob.rs`, `vault_meta*.rs`) from a
    // rule whose stated job is exactly those files, and it did so most damagingly
    // at the moment it should fire: a third generation declared in a sibling
    // module leaves the original codec exempt while its dispatch still handles
    // two generations out of three.
    //
    // The exemption is narrowed by one condition, and the condition is the
    // difference between a file that only DECLARES and one that also READS.
    // The paragraph above rests on "a declaration accepts nothing", and that
    // sentence is false of every codec in this set: `protocol/src/vault_meta.rs`
    // declares `MYV1` and then rejects anything else at `parse_vault_meta`, so
    // a file-scoped skip excused the tree's remaining live single-generation
    // first-bytes rejection of a two-generation family — the exact shape of
    // myne-md/myne#638, in the rule written to catch it. `blob.rs`,
    // `crdt_note_blob.rs` and `vault_meta_v0_2.rs` carried the same blanket.
    //
    // A COMPARISON is the discriminator rather than any mention, and the
    // distinction is load-bearing: `out[0..4].copy_from_slice(&MAGIC)` is an
    // encoder legitimately writing one generation, while `bytes[0..4] != MAGIC`
    // is a reader deciding what it accepts. Only the second form matches below,
    // so the encoders stay exempt and the readers do not.
    const declaredHere = all.filter((g) => g.file === rel).length;
    const declaredIn = new Set(all.map((g) => g.file));
    if (declaredHere === 1 && declaredIn.size > 1 && !comparesMagic(s, all)) continue;
    // Keyed on the BASE magic, and the symmetric form was tried and rejected
    // rather than not considered. Asking "a file naming ANY generation must
    // name all of them" reports two legitimate sites as violations:
    // `core/src/plugins/notes/crdt.rs`'s `is_nc05_blob` and `protocol/src/lib.rs`'s
    // re-export. Both ask "is this ONE generation", which is a real question
    // with a one-generation answer, so the symmetric rule cannot tell a
    // generation PREDICATE from a generation-blind READER and every future
    // predicate would owe an exemption.
    //
    // What the asymmetry leaves open is stated rather than claimed closed, and
    // the claim it replaces was circular. Three places used to say the hole was
    // covered "on the other side": this comment pointed at `content_nonce_at`
    // taking a slice, `core/src/content_nonce.rs` pointed BACK at rule 5 plus
    // the unused-import lint, and decision entry 0541 repeated both. Nothing
    // forces `base` to be the family's oldest generation, and rule 5 fires only
    // when the base magic is NAMED in the file, so a reader spelling only later
    // generations is seen by neither layer.
    //
    // What the slice does buy is real and smaller than the old sentence: adding
    // a generation is an append to `later` rather than a change to `base`, and
    // a zero-generation reader is refused by the signature. What it does not
    // buy is any check that `base` is the oldest. Closing that needs either an
    // assertion inside `content_nonce_at` or a symmetric rule with the two
    // known predicates recorded, and the symmetric rule was measured and
    // rejected above; the honest position until then is that this direction is
    // unguarded.
    // Inside the declaring file the base is spelled `selfToken` (see
    // EXTRA_MAGIC_PAIRS); everywhere else it is the namespaced form.
    const baseRe = fam.base.selfRe && fam.base.file === rel ? fam.base.selfRe : fam.base.re;
    if (!baseRe.test(bareText)) continue; // the base is not named in this file
    const missing = all.filter((g) =>
      !(g === fam.base ? baseRe : g.re).test(bareText),
    );
    if (missing.length === 0) continue; // the file knows every generation
    const hit = s.bare.findIndex((t, i) => !s.testLines.has(i + 1) && baseRe.test(t));
    if (hit === -1) continue; // named only inside a test region
    // Generation-SPECIFIC, and the distinction is the whole point. `isKnown`
    // matches `contains` against the first non-test line naming the base magic,
    // which in a codec is the declaration itself, so a `magic-parity` entry
    // keyed only on that line suppresses every failure the file can ever
    // produce, for any generation. A `VAULT_META_V0_3_MAGIC` in a sibling module
    // joins the derived family table with no edit, `vault_meta.rs` then knows one
    // of three generations, and a file-wide entry swallows it: the exact blanket
    // the rule 5 header condemns as myne-md/myne#638's shape, re-entered through
    // the ratchet. The fixture at `cryptoRegistriesMagicParity.test.ts` asserts
    // the guard fires for precisely that shape, so a file-wide entry would leave
    // the tree contradicting its own test.
    //
    // A `magic-parity` entry therefore names the generations it excuses, and it
    // excuses the file only when the missing set is EXACTLY that. A new
    // generation changes the set and the entry stops applying, which is also
    // what lets it go stale: keyed on the declaration line it never could,
    // because the base magic is always named there.
    const missingTokens = missing.map((g) => g.token).sort().join(",");
    if (isKnown("magic-parity", rel, s.bare[hit], missingTokens)) continue;
    failures.push({
      rule: "magic-parity",
      file: rel,
      line: hit + 1,
      why:
        `names the ${fam.family} family's base magic (${fam.base.magic}) with no ` +
        "mention of " +
        `${missing.map((g) => `${g.token} (${g.magic}, ${g.gen})`).join(", ")} anywhere in the ` +
        "file. " +
        "A vault carries whichever generation it was written under, and a reader taught only " +
        "some of them does not fail. It returns `None`, which every caller " +
        'reads as "not this family, nothing to do". That is how myne-md/myne#638 stopped ' +
        "attachment sync dead in BOTH directions with every compiler, every lint and every " +
        "other gate green. Read the nonce through `core/src/content_nonce.rs`, which takes the " +
        "generations as a required argument, route the codec through a `_versioned` helper, or " +
        "record a KNOWN entry saying why one generation is right here.",
    });
  }
}

// ── report ──────────────────────────────────────────────────────────────────

// The KNOWN ratchet describes THIS checkout, so a synthetic tree has no
// business being measured against it.
const stale = FIXTURE_RUN
  ? []
  : KNOWN.map((k, i) => ({ k, i })).filter(({ i }) => !knownHit.has(i));

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
    `${registry.size} §10.3 magic(s) in the registry, ${magicFamilies.length} multi-generation famil(ies) among them; ${KNOWN.length} recorded violation(s) ` +
    "left to clear)",
);
