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
// `check-core-io-seam.mjs` / `check-core-task-seam.mjs` (root CLAUDE.md: adding
// a dependency is a security decision).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// `mobile/src-tauri/src` joined on myne-md/myne#479, and its absence had cost
// exactly what this guard exists to prevent. Mobile's local `workspace` plugin
// parsed `vault.meta` with the v0.1-only `parse_vault_meta`, which hard-rejects
// `NTV5`, so on a MIGRATED vault that client's workspace reads and writes both
// failed while every other mobile plugin, going through `myne-core`, kept
// working. The guard reported `0 still debt` the whole time, over a tree it
// never opened. A root list that omits a whole client is the
// `check-prefs-nonce.mjs` shape the root CLAUDE.md records: the success line
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
  metaw: {
    names: ["serialize_vault_meta"],
    fix: "match the generation: `serialize_vault_meta_v0_2` for V0_2 (see `sync::orchestrator`'s meta merge)",
    why: "`serialize_vault_meta` unconditionally stamps `MYV1` + `0x01`, so writing a v0.2 meta through it claims v0.1 over v0.2 wrap bytes — the next unlock refuses BOTH credentials and strands every `NC05` note",
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
function protocolImports(text) {
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
function callsProtocolName(line, name, imports) {
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
  // ── legitimately v0.1: REBUILDABLE, NEVER-SYNCED CACHES ───────────────────
  // §10.4.1 point 2 DROPS these rather than re-sealing them, and says why their
  // KEK may stay on the v0.1 context: it re-derives through `derive_subkey` on
  // the v0.2 root, which is self-consistent by construction because a cache is
  // written and read only on the migrated vault — it never crosses a generation
  // boundary. Routing them would be churn with no reader on the other side.
  ["core/src/plugins/graph_layout/commands.rs#kek", [2, "cache: vault.graph (GraphLayoutKey), dropped by the migration"]],
  ["core/src/plugins/notes/search_sync_core.rs#kek", [2, "cache: vault.search (SearchIndexKey), dropped by the migration"]],
  ["core/src/plugins/vault_indices/commands.rs#kek", [2, "cache: vault.indices (VaultIndicesKey), dropped by the migration"]],
  ["core/src/plugins/workspace/commands.rs#kek", [2, "cache: vault.workspace (SessionStateKey), dropped by the migration"]],
  ["src-tauri/src/plugins/notes/search_sync.rs#kek", [3, "cache: vault.search (SearchIndexKey) — the desktop twin"]],
  ["src-tauri/src/plugins/local_inference/hydrate.rs#kek", [1, "cache: vault.embeddings (AiEmbeddingsKey), dropped by the migration"]],
  ["src-tauri/src/plugins/local_inference/commands.rs#kek", [2, "cache: attachments-text (AttachmentTextKey), dropped by the migration"]],
  // The mobile twin of the entry above, verbatim reason and verbatim count,
  // which is the point: it seals the same MYE1 transcript cache under the same
  // subkey role, so it is legitimate for exactly the same reason. It enters the
  // record on myne-md/myne#479, with the tree (`mobile/src-tauri/src`) rather
  // than after a change to the file. Its `#meta` sibling did NOT get an entry
  // and was fixed instead: desktop moved to `parse_vault_meta_any` in
  // myne-md/myne#433 and this twin never did, so on a migrated vault it
  // answered `None` and the cache silently stopped sealing.
  ["mobile/src-tauri/src/plugins/local_inference/commands.rs#kek", [2, "cache: attachments-text (AttachmentTextKey), dropped by the migration, the mobile twin of the desktop entry above"]],
  ["src-tauri/src/plugins/attachments/read_text.rs#kek", [1, "cache: attachments-text (AttachmentTextKey)"]],
  // The WRITER of that same cache, and it belongs in this table for exactly the
  // reason its six readers do. `attachments-text/` is device-local, never
  // synced and rebuildable, so §10.4.1 point 2's treatment applies: the KEK
  // re-derives through the v0.1 context on a v0.2 root, self-consistent because
  // a cache never crosses a generation boundary. It called
  // `derive_subkey_versioned` until myne-md/myne#529, which made the writer
  // disagree with every reader on a v0.2 vault and left the cache write-only —
  // an OCR'd image never reached search, a voice transcript never rendered, and
  // both misses look exactly like "there is nothing cached".
  ["core/src/plugins/attachments/commands.rs#kek", [1, "cache: attachments-text (AttachmentTextKey), the write side of the six readers below"]],

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
  ["core/src/plugins/vault_migrate/mod.rs#kek", [5, "the migration reads the OLD vault under the OLD keys (incl. the #441 fail-closed pre-flight, and the #675 chats re-seal under the OLD chats/catalog KEKs)"]],
  ["core/src/plugins/vault_migrate/mod.rs#meta", [1, "the migration parses the OLD `MYV1` meta"]],
  ["core/src/plugins/vault_migrate/mod.rs#note", [1, "the migration decodes the OLD `MY01` notes"]],
  ["core/src/plugins/vault_migrate/mod.rs#pwkdf", [2, "the migration verifies BOTH old credentials against the OLD salt domain"]],
  ["core/src/plugins/vault_migrate/mod.rs#aadwrap", [2, "the migration opens the OLD wraps under the OLD AADs"]],
  ["core/src/plugins/vault_migrate/mod.rs#items", [1, "the migration unwraps the OLD `itemsKey`"]],
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

  // ── DEBT: not yet routed ───────────────────────────────────────────────────
  // EMPTY, and that is the point: #432/#433 drove it to zero. A new entry here
  // needs an argument for why the surface may stay broken on a migrated vault.
  ["core/src/plugins/notes/commands.rs#note", [3, "the v0.1 arm of an explicit `is_nc05_blob` branch — note_read, note_update, note_write_batch"]],
  ["src-tauri/src/plugins/attachments/ocr_queue.rs#kek", [2, "cache: attachments-text (AttachmentTextKey)"]],
]);

const SKIP_DIRS = new Set(["target"]);

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

const argv = process.argv.slice(2);
const all = argv.length ? argv.filter((f) => f.endsWith(".rs")) : ROOTS.flatMap((r) => walk(r));
const files = all.filter((f) => {
  const rel = relative(process.cwd(), f).split(sep).join("/");
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

  for (const [name, { line, count }] of hits) {
    const key = `${rel}#${name}`;
    touching.set(key, count);
    const allowed = ALLOWED.get(key);
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
  : [...ALLOWED].filter(([k, [n]]) => (touching.get(k) ?? 0) < n);

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
const debt = [...ALLOWED].filter(([, [, why]]) => why.startsWith("debt")).reduce((a, [, [n]]) => a + n, 0);
console.log(`version-routing: ok (${files.length} file(s) checked)`);
console.log(
  `  ${total} v0.1-only call site(s) across ${touching.size} (file, class) pair(s); ` +
    `${debt} still debt. This number must only go down.`,
);
