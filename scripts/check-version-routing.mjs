#!/usr/bin/env node
// Version-routing ratchet (myne-md/myne#442).
//
// # The failure this exists to catch
//
// A vault is either v0.1 or, after the §10.4 migration, v0.2 — and a family of
// helpers has a v0.1-only variant and a version-aware one. The classes below
// carry the full list; the shape is always the same:
//
//     protocol::parse_vault_meta      ->  meta_version_of + parse_vault_meta_any
//     protocol::derive_subkey         ->  derive_subkey_versioned(version, ..)
//     protocol::decode_note (MY01)    ->  notes::decode::decode_note_any
//     protocol::derive_items_key      ->  derive_subkey_versioned + the v0.2 AAD
//     protocol::serialize_vault_meta  ->  serialize_vault_meta_v0_2
//     derive_{password,recovery}_…    ->  the `_v0_2` twin (v0.2 salt domain)
//     aad_{password,recovery,items}…  ->  the `_v0_2` twin (v0.2 AAD prefix)
//     encode_*_blob                   ->  the `_versioned` encoder
//
// The v0.1 variant stays in scope and compiles fine. When a reader forgets,
// NOTHING says so: not the compiler, not clippy on either target, not a test run
// on an unmigrated vault. The symptom appears only on a migrated vault, and the
// worst shape of it is silent — `read_or_empty` collapses the AEAD failure into
// an EMPTY catalog, and the next write persists that emptiness over the user's
// real data (the prefs instance of exactly this, fixed in `94a6ae35`).
//
// This is the recorded twin-reader problem sharpened: the two halves live in
// `myne-core` and `src-tauri`, and the migration made one half version-aware and
// left the other. `src-tauri/src/spell/sync.rs` DID get the treatment, which is
// what makes the rest an oversight rather than a scoping decision.
//
// # Why the class list grew past the original three
//
// The first three classes covered READING a migrated vault, and that framing had
// a blind spot: everything that WRITES one, plus the composite helpers that pin a
// generation inside themselves. Three production defects lived in exactly that
// gap and none of them was visible to the original guard, to any compiler, or to
// a test run — because every blob DECODER is magic-detecting, so a v0.2 vault
// carrying v0.1 blobs reads back perfectly and reports nothing:
//
//   * quick-unlock called `derive_items_key` (v0.1 KEK context AND v0.1 AAD), so
//     a PIN/biometric unlock of a migrated vault failed every time — while the
//     password path next to it branched correctly.
//   * attachment import called `encode_attachment_blob` two lines below a
//     correctly version-routed `derive_subkey_versioned`, writing `MYA1` blobs
//     into a v0.2 vault.
//   * device enrolment derived both credential wrap keys under the v0.1 salt
//     domain with no branch at all, so a migrated vault could not enrol a device.
//
// # Why a RATCHET and not a ban
//
// A handful of call sites are legitimately v0.1-only — the migration itself
// reads the old vault under the old keys, and the dispatcher has to call the
// v0.1 decoder somewhere. Those are recorded below with their reason. Every
// other entry is debt, and the rule is one-directional: **a file not on the list
// may not start using a v0.1-only helper, and a file that leaves the list may
// not come back.**
//
// Zero dependencies, node built-ins only — same pattern as
// `check-core-io-seam.mjs` / `check-core-task-seam.mjs` (root AGENTS.md: adding
// a dependency is a security decision).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isExtractedTestModule } from "./lib/test-module-files.mjs";

// `mobile/src-tauri/src` joined on myne-md/myne#479, and its absence had cost
// exactly what this guard exists to prevent. Mobile's local `workspace` plugin
// parsed `vault.meta` with the v0.1-only `parse_vault_meta`, which hard-rejects
// `NTV5`, so on a MIGRATED vault that client's workspace reads and writes both
// failed while every other mobile plugin, going through `myne-core`, kept
// working. The guard reported `0 still debt` the whole time, over a tree it
// never opened. A root list that omits a whole client is the
// `check-prefs-nonce.mjs` shape the root AGENTS.md records: the success line
// says `ok` and means it about less than the reader assumes.
const ROOTS = ["core/src", "src-tauri/src", "mobile/src-tauri/src", "format/src", "decrypt/src"];

/**
 * The call classes. `re` is matched per non-comment, non-test line.
 *
 * Each v0.1-only name is anchored on its own call paren, so the version-aware
 * sibling (`parse_vault_meta_any`, `derive_subkey_versioned`, …) cannot match:
 * the character after the base name is `_`, not `(`.
 *
 * A class carrying `names` instead of `re` is **scoped**: the name only counts
 * as a `protocol::` call when the line qualifies it (`protocol::name(`) or the
 * file imports it (`use protocol::{…name…}`), and a `fn name(` definition line
 * never counts. That is the `note` rule generalized, and it is load-bearing for
 * three of the classes below — `derive_items_key`, for one, is ALSO the name of
 * a local version-aware wrapper in `vault_recover` and of the v0.1 twin in
 * `vault_unlock`, so a bare-name match would report both as offenders while
 * missing nothing real.
 *
 * The classes are the v0.1-only helpers that HAVE a v0.2 twin. The
 * magic-detecting decoders (`decode_prefs_blob`, `decode_attachments_catalog`,
 * `decode_attachment_blob`, `decode_themes_blob`, `decode_dictionary_blob`) are
 * deliberately absent: they read the generation off the blob's own magic and
 * dispatch, so calling them from a version-blind site is correct.
 */
const CLASSES = {
  meta: {
    re: /\bparse_vault_meta\s*\(/,
    fix: "meta_version_of(&bytes) + protocol::parse_vault_meta_any(&bytes)",
    why: "`parse_vault_meta` hard-rejects `NTV5`, so a migrated vault reads as corrupt",
  },
  kek: {
    re: /\bderive_subkey\s*\(/,
    fix: "protocol::derive_subkey_versioned(version, root_key, role)",
    why: "a v0.1 KEK does not open a v0.2 blob — and several readers answer `None`/empty rather than erroring, so it fails silently",
  },
  note: {
    // `protocol::decode_note` only. The automerge bridge's same-named
    // `crdt::decode_note` takes one argument and is always call-qualified, so
    // requiring either the `protocol::` path or a `use protocol::{…decode_note…}`
    // import in the same file separates them without a type checker.
    re: /\bdecode_note\s*\(/,
    qualified: /\bprotocol::decode_note\s*\(/,
    needsImport: /use\s+protocol::\{[^}]*\bdecode_note\b/s,
    fix: "crate::plugins::notes::decode::decode_note_any(..)",
    why: "`protocol::decode_note` hard-rejects `NC05`, so every note on a migrated vault reads as undecryptable",
  },
  items: {
    names: ["derive_items_key"],
    fix: "derive_subkey_versioned(version, ..) + aad_vault_items_key_wrap_v0_2 on the v0.2 arm (see `vault_recover::derive_items_key`)",
    why: "`protocol::derive_items_key` pins the v0.1 KEK context AND the v0.1 AAD, so on a v0.2 vault the `itemsKey` unwrap fails outright — every note unreadable through that path",
  },
  // `protocol::parse_vault_meta_ntv6` is the `NTV6`-only tail reader. Its
  // generation-agnostic sibling is `parse_b2b_tail_any`, which accepts BOTH tail
  // generations because `NTV7` keeps the `NTV6` tail byte for byte.
  //
  // This class exists because that distinction cost a whole generation of member
  // paths. When `NTV7` was owner-only, a member could never meet an `NTV7` frame, so
  // every `parse_vault_meta_ntv6` on the member plane was correct-by-accident. The
  // moment sharing a person-born vault shipped (`decisions/protocol/0730`), the
  // member join, the six member-unlock entry points, the durable attribution join,
  // the awareness epoch read, the rotation-outbox drain and the content-epoch
  // stand-down all asked for the wrong frame and answered "not a shared vault" or
  // `None` on it. Nothing failed loudly: `None` reads as "nothing to do".
  ntv6: {
    re: /\bparse_vault_meta_ntv6\s*\(/,
    fix: "protocol::parse_b2b_tail_any(&bytes): the SAME tail on both generations",
    why: "`parse_vault_meta_ntv6` rejects `NTV7`, and `NTV7` is the birth format: a member vault, a rotation, an awareness frame or an attribution join on one reads as absent rather than failing",
  },
  metaw: {
    names: ["serialize_vault_meta"],
    fix: "match the generation: `serialize_vault_meta_v0_2` for V0_2 (see `sync::orchestrator`'s meta merge)",
    why: "`serialize_vault_meta` unconditionally stamps `MYV1` + `0x01`, so writing a v0.2 meta through it claims v0.1 over v0.2 wrap bytes — the next unlock refuses BOTH credentials and strands every `NC05` note",
  },
  // A GENERATION is one question with four answers, and an equality test against one variant is a
  // partial question that reads as a complete one. It is not automatically wrong, and this class must
  // not say it is: `carrier_applies` compares to `B2b` ON PURPOSE, because the carrier is `NTV6`-only
  // and sealing the person keypair under a vault credential on a person-born generation is the
  // cross-vault key escalation that `vault_migrate/ntv7.rs` deletes the carrier for. That site is
  // recorded in ALLOWED, with that reason, and NOT routed.
  //
  // What the class catches is the same spelling used WITHOUT that argument, which is the shape that
  // ages badly: a fifth generation falls out of every partial question silently, and the consumer then
  // answers "not this vault" for a vault it was meant to serve. The shapes that age well are a `match`
  // over all four variants, which turns a fifth generation into a compile error for every consumer,
  // and a named predicate from `sync::meta_kind` (`is_person_born`, `carries_b2b_tail`, `b2b_tail`),
  // which answers the question the caller actually has.
  gen: {
    // `[A-Za-z0-9_]+`, not `[A-Za-z]+`: the variant `B2b` carries a digit, so a letters-only class
    // matches `== Legacy` and silently misses `matches!(g, VaultMetaGeneration::B2b)`. Measured.
    re: /[=!]=\s*(?:protocol::)?VaultMetaGeneration::[A-Za-z0-9_]+|(?:protocol::)?VaultMetaGeneration::[A-Za-z0-9_]+\s*[=!]=|matches!\([^;]*?(?:protocol::)?VaultMetaGeneration::[A-Za-z0-9_]+/,
    fix: "match all four variants, or ask a `sync::meta_kind` predicate. An equality test is right only when the variant IS the caller's question, and then it belongs in ALLOWED with that reason",
    why: "an equality test against ONE generation variant answers a partial question as if it were complete: a fifth generation falls out of it silently, and the consumer answers 'not this vault' for a vault it was meant to serve. Match every variant, or ask the classifier",
  },
  pwkdf: {
    names: [
      "derive_password_wrap_key",
      "derive_recovery_wrap_key",
      "derive_recovery_wrap_key_from_normalized",
    ],
    fix: "the `_v0_2` twin on the v0.2 arm (see `vault_change_password`'s explicit branch)",
    why: "the v0.2 salt domain differs (`myne.v0.2 argon2id-…|`), so a v0.1 derivation produces a wrap key that opens nothing — the credential reads as wrong when it is right",
  },
  aadwrap: {
    names: ["aad_password_wrap", "aad_recovery_wrap", "aad_vault_items_key_wrap"],
    fix: "the `_v0_2` twin on the v0.2 arm",
    why: "a v0.1 AAD prefix never verifies against a v0.2 tag (§10.5 property 2), so the AEAD-open fails and the caller reports a credential/meta error",
  },
  blobw: {
    names: [
      "encode_prefs_blob",
      "encode_attachment_blob",
      "encode_attachments_catalog",
      "encode_themes_blob",
      "encode_dictionary_blob",
    ],
    fix: "the `_versioned` encoder (`encode_prefs_blob_versioned`, `encode_attachments_catalog_versioned`, …) or the `_v0_2` twin",
    why: "these encoders stamp the v0.1 magic unconditionally, so a v0.2 vault silently grows v0.1 blobs — and because every DECODER is magic-detecting, nothing ever reports the hybrid (§10.4.1 point 2 says a v0.2 vault carries `MY?5` throughout)",
  },
};

/** Names a file imports from `protocol` (`use protocol::{a, b}` / `use protocol::a;`). */
export function protocolImports(text) {
  const names = new Set();
  for (const m of text.matchAll(/use\s+protocol::\{([^}]*)\}/gs)) {
    for (const part of m[1].split(",")) {
      const t = part.trim().split(/\s+as\s+/)[0].trim();
      if (t) names.add(t);
    }
  }
  for (const m of text.matchAll(/use\s+protocol::([A-Za-z_][A-Za-z0-9_]*)\s*;/g)) names.add(m[1]);
  return names;
}

/** Does `line` call `protocol::name`, given what the file imports? */
export function callsProtocolName(line, name, imports) {
  if (new RegExp(`\\bfn\\s+${name}\\s*[(<]`).test(line)) return false; // a definition is not a call
  if (new RegExp(`\\bprotocol::${name}\\s*\\(`).test(line)) return true;
  if (!imports.has(name)) return false;
  return new RegExp(`(^|[^:\\w])${name}\\s*\\(`).test(line);
}

/**
 * Call sites permitted to use a v0.1-only helper, and why.
 *
 * Two kinds live here and they are NOT the same thing:
 *
 *   - **legitimately v0.1-only** — the migration reading the OLD vault, and the
 *     dispatcher that owns the v0.1 arm. Permanent.
 *   - **not yet routed** — the ratchet's actual subject. This group must only
 *     ever shrink; the script prints its size on every run.
 *
 * Key is `"<file>#<class>"`, value is `[count, reason]`.
 *
 * **Counts, not presence.** A file can legitimately hold one v0.1-only call and
 * illegitimately grow a second — `vault_unlock/commands.rs` holds a correct one
 * (the v0.1 arm of an explicit `is_v0_2` branch) and would have hidden any
 * number of wrong ones behind it under a presence-only list. Line numbers were
 * the other option and they churn on every edit; a count churns only when the
 * population actually changes, which is the thing being ratcheted.
 */
const ALLOWED = new Map([
  // ── legitimately partial: the variant IS the caller's question ────────────
  // Two sites, and both are here for a reason a reader can check, because an ALLOWED entry is what
  // blesses a site permanently.
  //
  // The decrypter is asking a NARROWER question than "does a person wrap exist" (NTV6 carries none
  // either): `NotPersonWrapped` is "this frame has neither a person wrap nor a recovery wrap, so the
  // phrase is the wrong KIND of credential", and `PersonNoWrap` is that question by name.
  ["decrypt/src/unlock.rs#gen", [1, "`NotPersonWrapped`: neither a person wrap nor a recovery wrap is on this frame, so a phrase is the wrong KIND of credential here, and `PersonNoWrap` names exactly that"]],
  // The one that must NOT be routed. `carrier_applies` is `NTV6`-only ON PURPOSE: on a person-born
  // generation the carrier would let a vault password, or a quick-unlock PIN or a biometric that
  // yields `root_key`, unwrap the person keypair and from it open every other vault that identity
  // owns, offline. `carries_b2b_tail` answers true for `NTV7` and `NTV8`, which is precisely the
  // mistake this predicate must not make, so the variant comparison is the correct spelling here.
  ["core/src/plugins/sync/person_vault_carrier.rs#gen", [1, "`NTV6` only ON PURPOSE: on a person-born generation the carrier is a cross-vault key escalation (see the predicate's own doc and `vault_migrate/ntv7.rs`). DO NOT route it through `carries_b2b_tail`"]],
  // ── legitimately v0.1: REBUILDABLE, NEVER-SYNCED CACHES ───────────────────
  // EMPTY. The last entry here was `local_inference/hydrate.rs#kek`, the KEK
  // for the `vault.embeddings` cache. The AI-embeddings family was retired
  // (`myne-agents/docs/decisions/ai/0703-*`) and the module went with it, so no root-only
  // cache derivation is left in the tree. The SHARED singleton KEKs that used
  // to sit in this section (prefs, search, workspace, indices, graph, themes,
  // dictionary, attachments catalog, attachment-text) moved to
  // `SharedSingletonKey::derive` in myne-md/myne#712 task 6, which picks the
  // GROUP tier on an `NTV6` vault and the root tier otherwise, so their
  // v0.1-only calls are gone and their entries went stale in the same run.

  // ── legitimately v0.1: SYNC-PLANE IDENTITY AND AUTH ───────────────────────
  // The reserved sync-ids (`catalog-`/`prefs-`/`themes-sync-id`) and the SCRAM
  // `ServerAuth` secret are derived the same way on every device, so the v0.1
  // context is self-consistent across the fleet. What a re-key changes here is
  // the ROOT, not the context — and that consequence is myne-md/myne#429(e)
  // (the verifier replace path), not a routing mistake at these sites.
  ["core/src/plugins/sync/cycle.rs#kek", [1, "sync: ServerAuth (SCRAM secret)"]],
  ["core/src/plugins/sync/enroll.rs#kek", [2, "sync: ServerAuth (SCRAM secret)"]],
  ["core/src/plugins/sync/orchestrator.rs#kek", [2, "sync: `sync_id_for` (the reserved singleton sync-ids) + the ServerAuth secret for the #429 verifier replace"]],

  // ── legitimately v0.1: THE V0.1 SIDE, BY CONSTRUCTION ─────────────────────
  ["format/src/notes/decode.rs#note", [1, "IS the dispatcher's v0.1 arm"]],
  ["core/src/test_support.rs#metaw", [1, "test-support builds a v0.1 vault fixture on purpose (the migration's input)"]],

  // ── legitimately v0.1: THE V0.1 ARM OF AN EXPLICIT BRANCH ─────────────────
  // Already dispatched — `if is_v0_2 { parse_vault_meta_v0_2 } else { … }` and
  // the `derive_items_key` / `derive_items_key_v0_2` pair. A grep cannot see the
  // branch, so these are recorded rather than rewritten.
  ["core/src/plugins/vault_unlock/commands.rs#meta", [2, "the v0.1 arm of an explicit `is_v0_2` branch"]],
  ["core/src/plugins/vault_unlock/commands.rs#kek", [1, "`derive_items_key`, the v0.1 twin of `derive_items_key_v0_2`"]],
  ["core/src/plugins/vault_unlock/commands.rs#pwkdf", [1, "`derive_root_key`, the v0.1 twin of `unlock_root_key_v0_2_password`"]],
  ["core/src/plugins/vault_unlock/commands.rs#aadwrap", [2, "the v0.1 AADs of the same two twins"]],
  ["core/src/plugins/vault_change_password/commands.rs#pwkdf", [1, "the v0.1 arm of an explicit `version == V0_2` branch"]],
  ["core/src/plugins/vault_change_password/commands.rs#aadwrap", [2, "the v0.1 arm of an explicit `version == V0_2` branch"]],
  ["core/src/plugins/sync/enroll.rs#pwkdf", [2, "the v0.1 arms of the enrol path's explicit `version == V0_2` branch (password + recovery)"]],
  ["core/src/plugins/sync/enroll.rs#aadwrap", [2, "the v0.1 arms of the same branch"]],
  ["core/src/plugins/sync/member_removal.rs#aadwrap", [1, "the v0.1 arm of an explicit `version == V0_2` branch (the rekey re-seals enc_items_key under the vault's own generation)"]],
  ["core/src/plugins/vault_recover/commands.rs#pwkdf", [1, "the v0.1 arm of an explicit `version == V0_2` branch"]],
  ["core/src/plugins/vault_recover/commands.rs#aadwrap", [2, "the v0.1 arm of an explicit `version == V0_2` branch"]],
  ["core/src/plugins/sync/orchestrator.rs#metaw", [1, "the v0.1 arm of the meta merge's explicit generation match (a cross-generation merge is refused outright)"]],
  ["decrypt/src/unlock.rs#pwkdf", [2, "the v0.1 arms of the CLI unlock's explicit `version` match (password + recovery)"]],
  ["decrypt/src/unlock.rs#aadwrap", [2, "the v0.1 AADs of the same two arms"]],
  ["decrypt/src/unlock.rs#items", [1, "`derive_items_key`, the v0.1 twin of `derive_items_key_v0_2` in the CLI unlock"]],
  // NOTE: `vault_creation/commands.rs` used to hold eleven entries here — the
  // last v0.1 writer in the product. The birth-format flip to v0.2 removed all
  // of them, and this script is what proved it: every one went stale (recorded
  // budget > reality) in the same run, which is a stronger statement than any
  // test, since it is the absence of v0.1 writes rather than the presence of
  // v0.2 ones. Do not re-add an entry here without the flip being reversed.

  // ── legitimately `NTV6`-only: THE OLD GENERATION, BY CONSTRUCTION ─────────
  // Each of these IS the `NTV6` side of something that deliberately names it: the
  // upgrade's SOURCE frame, the NTV5→NTV6 migration's output check, and the arm of
  // an explicit generation branch. A grep cannot see the branch, so they are
  // recorded rather than rewritten; a bare-name match would report them as
  // offenders while missing nothing real.
  ["core/src/plugins/vault_migrate/b2b.rs#ntv6", [1, "the NTV5→NTV6 migration validates the frame it just produced"]],
  ["core/src/plugins/sync/commands.rs#ntv6", [1, "the `AlreadyMigrated` arm reports the epoch of the NTV6 frame that vault already is"]],
  ["core/src/plugins/vault_change_password/commands.rs#ntv6", [1, "the `VaultMetaGeneration::B2b` arm of an explicit match (the `Person` arm sits beside it)"]],
  ["core/src/plugins/vault_unlock/commands.rs#ntv6", [2, "the `NTV6` arms of explicit generation branches: the preview's magic dispatch and the re-key recovery's `is_ntv7` else-arm. The status probe used to be the third, and it left this budget when it became `has_b2b_tail` (myne-md/myne#938): the predicate that survives a new generation cannot be a list of magics"]],
  // A TEST FIXTURE, and recorded rather than skipped because the region tracker
  // loses `mod tests` in this file part-way through (a brace inside the module's
  // own string literals closes the region early). The count is what keeps this
  // honest: the budget is 1, so a second site appearing here in production fires.
  ["core/src/plugins/sync/member_removal.rs#ntv6", [1, "a rotation test's fixture read (`mod tests`), pinned by count because the region tracker drops the region part-way down this file"]],
  // ── DEBT lives in its own table below ──────────────────────────────────────
  // It used to be a section at the end of THIS table, and the count was derived
  // from a reason string (`why.startsWith("debt")`) that no entry in this file
  // has ever carried — so the run printed "0 still debt" while the section it
  // was describing held a live entry. The figure is now a property of the
  // STRUCTURE (`DEBT` below) rather than of prose in a reason.
]);

// The other half of the ratchet's subject, and the reason the count is worth
// printing: these sites have no argument for staying on a v0.1-only helper.
// Membership is the debt; the comment above each entry says why it is recorded
// and the entry leaves this table (or moves up into `ALLOWED` with a real
// argument) when it stops being true.
const DEBT = new Map([
  // Not "wrong", just not yet decided: each of these asks a partial question that happens to have the
  // right answer today, and a fifth generation forces the decision. None of them is a security
  // predicate, so none carries the "do not route this" warning the ALLOWED entries above do.
  ["core/src/plugins/vault_migrate/adopt.rs#gen", [1, "NOT YET ROUTED: `== Legacy` asks whether the local frame is the pre-B2B one before an incoming newer meta may replace it, and a fifth generation forces a deliberate answer here"]],
  ["core/src/plugins/sync/orchestrator.rs#gen", [2, "NOT YET ROUTED: `!= Legacy` twice in the meta-merge condition, the same shape as adopt.rs"]],
  ["core/src/plugins/sync/person_discovery.rs#gen", [1, "NOT YET ROUTED: `is_person_born` spelled as a subset `matches!` over Person|PersonNoWrap, where `meta_kind::is_person_born` is a range and would take a fifth person-born generation with no edit here"]],
  ["core/src/plugins/notes/commands.rs#note", [4, "the v0.1 arm of an explicit `is_nc05_blob` branch — note_read, note_update, note_set_field, note_write_batch"]],
]);

// The lookup the budget check and the staleness check both use. Built here so
// the two directions cannot disagree about what is permitted, and checked for
// overlap: a key in BOTH tables would silently resolve to whichever object
// spread last, which is the shape that made the old reason-prefix filter pass.
const PERMITTED = new Map([...ALLOWED, ...DEBT]);

/** Keys recorded in BOTH tables. Non-empty means the lookup resolves by object
 *  spread order, which is the shape that let the old reason-prefix filter pass. */
export function overlappingKeys(a = ALLOWED, b = DEBT) {
  return [...a.keys()].filter((k) => b.has(k));
}

/** The debt figure, a property of the DEBT table rather than of prose. */
export function debtTotal() {
  return [...DEBT.values()].reduce((a, [n]) => a + n, 0);
}

export { ALLOWED, CLASSES, DEBT };

const SKIP_DIRS = new Set(["target", ".worktrees"]);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".rs")) out.push(full);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
const overlapping = overlappingKeys();
if (overlapping.length) {
  console.error(
    `check-version-routing: ${overlapping.join(", ")} appear in both ALLOWED and DEBT.\n` +
      "  A key is either legitimately v0.1-only or it is debt, never both: the\n" +
      "  lookup would then resolve to whichever table the spread put last.",
  );
  process.exit(1);
}
const argv = process.argv.slice(2);
const all = argv.length ? argv.filter((f) => f.endsWith(".rs")) : ROOTS.flatMap((r) => walk(r));
const files = all.filter((f) => {
  const rel = relative(process.cwd(), f).split(sep).join("/");
  if (isExtractedTestModule(rel)) return false;
  return ROOTS.some((r) => rel === r || rel.startsWith(r + "/"));
});

const offenders = [];
const touching = new Map();

for (const file of files) {
  const rel = relative(process.cwd(), file).split(sep).join("/");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // staged-but-deleted
  }
  // A module-level `#![cfg(test)]` makes the WHOLE file test-only, and the
  // per-attribute brace tracking below cannot see that — it looks for
  // `#[cfg(test)]` opening a block. `sync/sim.rs` is the file that taught this:
  // a test-only simulation harness, 8 v0.1-only call sites, none of them a
  // production reader.
  if (/^\s*#!\[cfg\(test\)\]/m.test(text)) continue;
  const importsDecodeNote = CLASSES.note.needsImport.test(text);
  const imports = protocolImports(text);

  // `#[cfg(test)]` regions are exempt: a test drives whichever codec it means to
  // and is not a production reader. Tracked by brace depth from the attribute,
  // exactly as `check-core-io-seam.mjs` does it.
  let skipping = false;
  let depth = 0;
  const hits = new Map(); // class -> { line, count }
  text.split("\n").forEach((line, i) => {
    if (/^\s*#\[cfg\((any\()?test/.test(line)) {
      skipping = true;
      depth = 0;
    }
    if (skipping) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0 && /\}/.test(line)) skipping = false;
      return;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return;
    for (const [name, c] of Object.entries(CLASSES)) {
      // A definition is not a call site.
      if (new RegExp(`\\bfn\\s+${name === "note" ? "decode_note" : ""}`).test(trimmed) && name === "note") continue;
      if (name === "note") {
        const qualified = c.qualified.test(line);
        const bare = c.re.test(line) && !/\bcrdt::decode_note\s*\(/.test(line);
        if (!(qualified || (bare && importsDecodeNote))) continue;
      } else if (c.names) {
        if (!c.names.some((n) => callsProtocolName(line, n, imports))) continue;
      } else if (!c.re.test(line)) {
        continue;
      }
      const prev = hits.get(name);
      if (prev) prev.count += 1;
      else hits.set(name, { line: i + 1, count: 1 });
    }
  });

  // A `matches!` whose variant list WRAPS is invisible to the per-line loop above, and the one live
  // instance is spelled exactly that way: `person_discovery::person_frame_namespace` re-derives
  // `meta_kind::is_person_born` as `Person | PersonNoWrap` across three lines. One whole-text pass for
  // that shape, bounded so a stray `)` far away cannot stretch the match. Matches that fit on one line
  // are skipped because the per-line pass already counted them.
  for (const m of text.matchAll(/matches!\([\s\S]{0,400}?(?:protocol::)?VaultMetaGeneration::[A-Za-z0-9_]+/g)) {
    if (!m[0].includes("\n")) continue;
    const line = text.slice(0, m.index).split("\n").length;
    const prev = hits.get("gen");
    if (prev) prev.count += 1;
    else hits.set("gen", { line, count: 1 });
  }

  for (const [name, { line, count }] of hits) {
    const key = `${rel}#${name}`;
    touching.set(key, count);
    const allowed = PERMITTED.get(key);
    const budget = allowed ? allowed[0] : 0;
    if (count > budget) {
      offenders.push({ key, file: rel, line, class: name, count, budget });
    }
  }
}

// The other direction of the ratchet: an entry whose call site is gone must be
// REMOVED, or the list stops describing anything. Only meaningful on a
// whole-tree run — a staged-files run sees a subset by design.
// Two staleness shapes: an entry whose call sites are all gone, and one whose
// budget is now larger than the population. Both make the number a lie.
const stale = argv.length
  ? []
  : [...PERMITTED].filter(([k, [n]]) => (touching.get(k) ?? 0) < n);

if (offenders.length || stale.length) {
  if (offenders.length) {
    console.error("A v0.1-only helper in a file that had none:\n");
    for (const o of offenders) {
      console.error(
        `  ${o.file}:${o.line}  [${o.class}]  ${o.count} site(s), ${o.budget} recorded — ${CLASSES[o.class].why}`,
      );
      console.error(`      use: ${CLASSES[o.class].fix}`);
    }
    console.error(`
Why this is a hard rule and not a style note: the v0.1-only variant COMPILES and
passes every test run against an unmigrated vault. The failure appears only on a
vault that has been through the §10.4 migration, and its worst form is silent —
a reader that answers "empty" rather than "error" lets the next write persist
that emptiness over the user's real data.

If the site is genuinely v0.1-only (it reads the OLD vault during the migration,
or it IS the dispatcher's v0.1 arm), add it to this script's ALLOWED table with
that reason.`);
  }
  if (stale.length) {
    console.error("\nStale ALLOWED entries — the recorded budget exceeds reality:\n");
    for (const [k, [n]] of stale) {
      console.error(`  ${k}  recorded ${n}, found ${touching.get(k) ?? 0}`);
    }
    console.error(
      "\nLower them (or delete the entry). The list is the remaining routing debt;\n" +
        "a budget that outlives its subject makes the count meaningless.",
    );
  }
  process.exit(1);
}

const total = [...touching.values()].reduce((a, b) => a + b, 0);
const debt = debtTotal();
console.log(`version-routing: ok (${files.length} file(s) checked)`);
console.log(
  `  ${total} single-generation call site(s) across ${touching.size} (file, class) pair(s); ` +
    `${debt} still debt. This number must only go down.`,
);
}
