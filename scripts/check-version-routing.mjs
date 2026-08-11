#!/usr/bin/env node
// Version-routing ratchet (myne-md/myne#442).
//
// # The failure this exists to catch
//
// A vault is either v0.1 or, after the §10.4 migration, v0.2 — and three
// different helpers have a v0.1-only variant and a version-aware one:
//
//     protocol::parse_vault_meta      ->  meta_version_of + parse_vault_meta_any
//     protocol::derive_subkey         ->  derive_subkey_versioned(version, ..)
//     protocol::decode_note (MY01)    ->  notes::decode::decode_note_any
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

const ROOTS = ["core/src", "src-tauri/src"];

/**
 * The three call classes. `re` is matched per non-comment, non-test line.
 *
 * Each v0.1-only name is anchored on its own call paren, so the version-aware
 * sibling (`parse_vault_meta_any`, `derive_subkey_versioned`, …) cannot match:
 * the character after the base name is `_`, not `(`.
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
};

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
  ["src-tauri/src/plugins/attachments/read_text.rs#kek", [1, "cache: attachments-text (AttachmentTextKey)"]],

  // ── legitimately v0.1: SYNC-PLANE IDENTITY AND AUTH ───────────────────────
  // The reserved sync-ids (`catalog-`/`prefs-`/`themes-sync-id`) and the SCRAM
  // `ServerAuth` secret are derived the same way on every device, so the v0.1
  // context is self-consistent across the fleet. What a re-key changes here is
  // the ROOT, not the context — and that consequence is myne-md/myne#429(e)
  // (the verifier replace path), not a routing mistake at these sites.
  ["core/src/plugins/sync/cycle.rs#kek", [1, "sync: ServerAuth (SCRAM secret)"]],
  ["core/src/plugins/sync/enroll.rs#kek", [2, "sync: ServerAuth (SCRAM secret)"]],
  ["core/src/plugins/sync/orchestrator.rs#kek", [1, "sync: `sync_id_for` — the reserved singleton sync-ids"]],

  // ── legitimately v0.1: THE V0.1 SIDE, BY CONSTRUCTION ─────────────────────
  ["core/src/plugins/vault_creation/commands.rs#kek", [3, "a newly created vault IS v0.1"]],
  ["core/src/plugins/vault_migrate/mod.rs#kek", [3, "the migration reads the OLD vault under the OLD keys"]],
  ["core/src/plugins/vault_migrate/mod.rs#meta", [1, "the migration parses the OLD `MYV1` meta"]],
  ["core/src/plugins/vault_migrate/mod.rs#note", [1, "the migration decodes the OLD `MY01` notes"]],
  ["core/src/plugins/notes/decode.rs#note", [1, "IS the dispatcher's v0.1 arm"]],

  // ── legitimately v0.1: THE V0.1 ARM OF AN EXPLICIT BRANCH ─────────────────
  // Already dispatched — `if is_v0_2 { parse_vault_meta_v0_2 } else { … }` and
  // the `derive_items_key` / `derive_items_key_v0_2` pair. A grep cannot see the
  // branch, so these are recorded rather than rewritten.
  ["core/src/plugins/vault_unlock/commands.rs#meta", [2, "the v0.1 arm of an explicit `is_v0_2` branch"]],
  ["core/src/plugins/vault_unlock/commands.rs#kek", [1, "`derive_items_key`, the v0.1 twin of `derive_items_key_v0_2`"]],
  // ── DEBT: not yet routed (myne-md/myne#432, #433) ─────────────────────────
  // Every entry here is a surface that is BROKEN on a migrated vault today.
  // This group must only ever shrink, and the summary line prints its size so
  // the number is visible rather than buried.
  ["core/src/plugins/attachments/ref_scan.rs#note", [3, "debt #432: the attachment reference scan sees every note as unreadable -> orphan cleanup misfires"]],
  ["core/src/plugins/export/commands.rs#note", [1, "debt #432: vault export aborts on the first note — the escape hatch behind the no-lock-in commitment"]],
  ["core/src/plugins/export/commands.rs#kek", [2, "debt #433: PrefsKey + AttachmentsCatalogKey, both re-sealed to their MY?5 family by the migration"]],
  ["core/src/plugins/notes/commands.rs#note", [4, "debt #432: title extraction and the remaining CRUD readers"]],
  ["core/src/plugins/snapshots/commands.rs#note", [2, "debt #432: snapshot preview + restore"]],
  ["core/src/plugins/sync/conflict.rs#note", [2, "debt #432: the keep-both conflict surfaces"]],
  ["core/src/plugins/quick_unlock/commands.rs#meta", [1, "debt #433: PIN re-enrolment is impossible on the vault the migration deliberately un-enrolled"]],
  ["src-tauri/src/plugins/attachments/blocking_reads.rs#meta", [1, "debt #433: OCR queueing + attachment-text indexing stop"]],
  ["src-tauri/src/plugins/attachments/blocking_reads.rs#kek", [1, "debt #433: AttachmentsCatalogKey — and `read_or_empty` turns the failure into an EMPTY catalog, not an error"]],
  // Mixed: two are the MYE1 attachment-text cache (legitimately v0.1, like its
  // siblings above) and one is AttachmentsCatalogKey, which the migration DOES
  // re-seal. A (file, class) budget cannot split them, so the whole entry stays
  // marked debt until the catalog one is routed and this drops to 2.
  ["src-tauri/src/plugins/attachments/ocr_queue.rs#kek", [3, "debt #433: 1 of 3 is AttachmentsCatalogKey; the other 2 are the MYE1 cache"]],
  ["src-tauri/src/plugins/attachments/read_text.rs#meta", [1, "debt #433: attachment-text export staging"]],
  ["src-tauri/src/plugins/backup/restore.rs#meta", [1, "debt #433: every post-migration backup verifies and is unrestorable"]],
  ["src-tauri/src/plugins/local_inference/commands.rs#meta", [1, "debt #433: the transcript cache is never written"]],
  ["src-tauri/src/plugins/local_inference/hydrate.rs#meta", [1, "debt #433: embeddings never load — a full re-embed every unlock"]],
  ["src-tauri/src/plugins/notes/desktop_commands.rs#note", [2, "debt #432: export note, export note with attachments"]],
  ["src-tauri/src/plugins/notes/search_sync.rs#meta", [1, "debt #433: the search index silently never builds — swallowed as one warn, so search returns zero results forever"]],
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
