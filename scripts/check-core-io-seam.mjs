#!/usr/bin/env node
// Filesystem-seam ratchet (phase3-web-client task 17).
//
// # The failure this exists to catch
//
// `std::fs::read` COMPILES for wasm32 and fails at runtime. Same shape as
// `tokio::task::spawn_blocking` (task 80, `check-core-task-seam.mjs`) and caught
// by nothing: not `cargo check`, not clippy on either target, not a native test
// run. The first symptom is a vault that will not open in a browser.
//
// # Why a RATCHET and not a ban
//
// 38 production files under `core/src` reach the filesystem directly today, and
// migrating them is the body of tasks 12, 13, 14 and 44–48 — one plugin at a
// time, each verifiable on its own. A hard ban would have to be landed in one
// 38-file change, which is exactly the shape of change nobody can review.
//
// So the current set is recorded below and the rule is one-directional: **a file
// not on the list may not start using `std::fs`, and a file that leaves the list
// may not come back.** The list is the remaining port surface, and it is
// designed to be deleted from — the script prints its size on every run so the
// number is visible rather than buried.
//
// Deliberately a grep-shaped script with zero dependencies, node built-ins only
// — the same pattern as `check-platform-seam.mjs`, `check-core-task-seam.mjs`
// and lefthook's secret-scan (root CLAUDE.md: adding a dependency is a security
// decision).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = "core/src";

/**
 * Files permitted to reach the filesystem directly, and why.
 *
 * Three kinds live here and they are NOT the same thing:
 *
 *   - **the seam and its dependencies** — `vault_io.rs` IS the seam, and
 *     `atomic_write.rs` is what its native arm delegates to. Permanent.
 *   - **host-only modules** — gated out of the wasm build entirely, so a
 *     `std::fs` call there is correct. Permanent.
 *   - **not yet migrated** — the ratchet's actual subject. Each names the task
 *     that removes it. This group must only ever shrink.
 */
const ALLOWED = new Map([
  // ── the seam itself, and what it delegates to ──────────────────────────────
  ["core/src/vault_io.rs", "IS the seam"],
  ["core/src/atomic_write.rs", "the durability mechanics the seam's native arm delegates to"],
  ["core/src/test_support.rs", "test fixtures; compiled only under `test`/`test-support`"],

  // ── host-only: gated out of the wasm build, so `std::fs` is correct ────────
  ["core/src/plugins/captures/commands.rs", "host-only (cfg tauri-ipc + not wasm32)"],
  ["core/src/plugins/captures/queue.rs", "host-only (cfg tauri-ipc + not wasm32)"],
  ["core/src/plugins/export/commands.rs", "host-only (cfg tauri-ipc + not wasm32)"],
  ["core/src/plugins/share_import/commands.rs", "host-only (cfg tauri-ipc + not wasm32)"],
  ["core/src/plugins/share_import/queue.rs", "host-only (cfg tauri-ipc + not wasm32)"],
  [
    "core/src/plugins/attachments/scheme_core.rs",
    "host-only (cfg tauri-ipc + not wasm32) — the `attachment://` serve path is typed on `tauri::http`; the browser gets an object URL instead (task 44)",
  ],
  // Native BY CONSTRUCTION, which is a stronger claim than "host-gated": this
  // harness spawns a real `myne-server` binary (`std::process::Child`) and drives
  // several simulated devices against it over loopback. There is no browser
  // variant of that, so there is no port to owe — moving it out of the
  // awaiting group is what stops the ratchet count from carrying a file nobody
  // will ever convert. (The rule it does NOT violate: a fixture must go through
  // the seam when it stages files a ported reader will read, because otherwise
  // the port goes unproven. These files are only ever read by the native arm.)
  [
    "core/src/plugins/sync/sim.rs",
    "test-only (`#![cfg(test)]`) and native by construction — it spawns a real `myne-server` process",
  ],

  // ── not yet migrated — each names the task that removes it ─────────────────
  ["core/src/paths.rs", "task 12 (path helpers that stat)"],
  ["core/src/plugins/attachments/ocr/mod.rs", "task 47 (charset file load; OCR's web verdict)"],
  ["core/src/plugins/attachments/text_cache.rs", "task 90 (MYE1 verdict; `remove_extracted` already left)"],
  ["core/src/plugins/notes/commands.rs", "task 13 (notes)"],
  ["core/src/plugins/quick_unlock/commands.rs", "task 40 (quick-unlock PIN path)"],
  ["core/src/plugins/snapshots/commands.rs", "task 83 (snapshots — the capture hook decides first)"],
  ["core/src/plugins/vault_change_password/commands.rs", "task 41 (change password)"],
  ["core/src/plugins/vault_creation/commands.rs", "decided absent on web; port not owed"],
  ["core/src/plugins/vault_recover/account_number_select.rs", "task 32 (recovery entry points)"],
  ["core/src/plugins/vault_recover/commands.rs", "task 32 (recovery entry points)"],
  ["core/src/snapshot_store.rs", "task 83 (snapshots — the capture hook decides first)"],
  ["core/src/vault_registry.rs", "task 12 (vault registry scan)"],
  ["core/src/vault_sweep.rs", "task 72 (vault delete)"],
]);

const SKIP_DIRS = new Set(["target"]);

// `std::fs::<op>(`, a bare `fs::<op>(` where the module is imported, and the two
// handle constructors. Anchored on the call paren so a prose mention in a
// comment is not a violation — comment lines are dropped anyway, but a doc-link
// like [`std::fs::read`] inside a doc comment would otherwise match.
const FS_CALL = /(?:std::)?fs::[a-z_]+\s*\(|\bFile::(?:open|create)\b|\bOpenOptions::new\b/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".rs")) out.push(full);
  }
  return out;
}

const argv = process.argv.slice(2);
const files = (argv.length ? argv.filter((f) => f.endsWith(".rs")) : walk(ROOT)).filter((f) => {
  const rel = relative(process.cwd(), f);
  return rel === ROOT || rel.startsWith(ROOT + sep);
});

const offenders = [];
const touching = new Set();

for (const file of files) {
  const rel = relative(process.cwd(), file).split(sep).join("/");
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // staged-but-deleted
  }

  // `#[cfg(test)]` regions are exempt: test code never compiles for wasm32.
  // Tracked by brace depth from the attribute, exactly as
  // `check-core-task-seam.mjs` does it.
  let skipping = false;
  let depth = 0;
  const hits = [];
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
    if (line.trim().startsWith("//")) return;
    if (FS_CALL.test(line)) hits.push(i + 1);
  });

  if (hits.length === 0) continue;
  touching.add(rel);
  if (!ALLOWED.has(rel)) offenders.push({ file: rel, line: hits[0], count: hits.length });
}

// The other direction of the ratchet: an entry that no longer touches the
// filesystem must be REMOVED, or the list stops describing anything. Only
// meaningful on a whole-tree run — a staged-files run sees a subset by design.
const stale = argv.length
  ? []
  : [...ALLOWED.keys()].filter((f) => !touching.has(f));

if (offenders.length || stale.length) {
  if (offenders.length) {
    console.error("Direct filesystem access in a file that had none:\n");
    for (const o of offenders) {
      console.error(`  ${o.file}:${o.line}  (${o.count} site(s))`);
    }
    console.error(`
Route it through \`crate::vault_io::VaultIo\` instead:

    std::fs::read(&p)?                    ->   io.read(&p).await?
    crate::atomic_write::atomic_write(..)  ->   io.write(&p, &bytes, WriteOpts::default()).await?

Why this is a hard rule and not a style note: \`std::fs\` COMPILES for wasm32 and
fails at runtime. Nothing in the build catches it — not cargo check, not clippy
on either target, not a native test run. The first symptom is a vault that will
not open in a browser.

If the call genuinely belongs to a host-only module, gate the module
(\`#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]\`) and add it to
the host-only group of this script's ALLOWED table with that reason.`);
  }
  if (stale.length) {
    console.error("\nStale ALLOWED entries — these no longer touch the filesystem:\n");
    for (const f of stale) console.error(`  ${f}`);
    console.error(
      "\nRemove them. The list is the remaining port surface; an entry that\n" +
        "outlives its subject makes the count meaningless.",
    );
  }
  process.exit(1);
}

const pending = [...ALLOWED].filter(([, why]) => why.startsWith("task")).length;
console.log(`core io-seam: ok (${files.length} file(s) checked)`);
console.log(
  `  ${touching.size} file(s) still reach the filesystem directly; ${pending} of them are ` +
    `awaiting a port. This number must only go down.`,
);
