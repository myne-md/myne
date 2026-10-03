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
// and lefthook's secret-scan (root AGENTS.md: adding a dependency is a security
// decision).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Two roots now: `core/src` (the original subject) and `format/src` (the
// on-disk-format crate extracted for the `myne-decrypt` CLI, myne-md/myne#166).
// `format/` is native-only by design, but it is an unconditional dependency of
// `myne-core`, so its `std::fs` calls are in the wasm graph exactly as core's
// are: the ratchet must see them or it is blind to a whole crate.
const ROOTS = ["core/src", "format/src"];

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
  ["core/src/test_support.rs", "test fixtures; compiled only under `test`/`test-support`"],

  // `format/`: the on-disk-format crate (myne-md/myne#166)
  // Native-only by design: the export walk and the backup-container read half
  // are gated out of the wasm build (`#[cfg(not(target_arch = "wasm32"))]` in
  // `format/src/lib.rs`), so their `std::fs` is correct. `atomic_write` is the
  // durability mechanics the native arm delegates to, the same role
  // `core/src/atomic_write.rs` played before it became a re-export shim.
  ["format/src/atomic_write.rs", "the durability mechanics the native arm delegates to (native-only)"],
  ["format/src/backup_container.rs", "native-only (cfg not wasm32): the MYB1 read half is a seek-based reader"],
  ["format/src/export_walk.rs", "native-only (cfg not wasm32): the whole-vault export walk"],
  ["format/src/test_support.rs", "test fixtures; compiled only under `test`"],

  // ── writes to a path the USER chose, outside the vault ────────────────────
  // Surfaced when the detector learned `atomic_write`, and they belong here
  // rather than in the awaiting group: the seam's subject is the vault, and
  // these two write an export destination and a save-as-file destination that
  // the OS dialog just returned. A browser has no such path at all, which is
  // why the web client substitutes the whole affordance with the download seam
  // (`src/lib/secret-export.ts`'s `deliverFile` arm) rather than porting the
  // write. There is no port owed, so counting them as debt would be counting a
  // conversion nobody will ever make.
  [
    "core/src/plugins/attachments/commands.rs",
    "writes the user-chosen EXPORT destination, outside the vault; web substitutes the affordance with a browser download",
  ],
  [
    "core/src/plugins/secret_export/commands.rs",
    "writes the user-chosen save-as-file destination, outside the vault, and privately (0600); web substitutes the affordance with a browser download",
  ],

  // ── host-only: gated out of the wasm build, so `std::fs` is correct ────────
  // The agent's Tauri-host adapters (myne-md/myne#456). Carries a
  // module-level `#![cfg(all(feature = "tauri-ipc", not(target_arch =
  // "wasm32")))]`, so the `std::fs::read` inside it never reaches a wasm build.
  // It is on this list because it MOVED into `core/` in that change, not
  // because it started reading the disk: it did the same thing in `src-tauri/`,
  // where this guard does not look.
  ["core/src/plugins/agent/host_adapters.rs", "host-only (cfg tauri-ipc + not wasm32)"],
  ["core/src/plugins/captures/commands.rs", "host-only (cfg tauri-ipc + not wasm32)"],
  ["core/src/plugins/captures/meeting_manifest.rs", "host-only (cfg tauri-ipc + not wasm32)"],
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
  // Same shape as `sim.rs`: never compiled outside `test`, and what it reads is
  // this repository's own source tree (`env!("CARGO_MANIFEST_DIR")`) in order to
  // assert that no new outbound socket appeared in the sync transport
  // (MYND-650 task 4). A source-scanning guard has nothing to route through the
  // vault seam — there is no vault involved, and no browser build to break.
  [
    "core/src/plugins/sync/no_bypass.rs",
    "test-only (`#[cfg(all(test, not(wasm32)))]`) — it scans this crate's own source, not vault data",
  ],

  // ── not yet migrated — each names the task that removes it ─────────────────
  ["core/src/paths.rs", "task 12 (path helpers that stat)"],
  ["core/src/plugins/attachments/ocr/mod.rs", "task 47 (charset file load; OCR's web verdict)"],
  ["core/src/plugins/attachments/text_cache.rs", "task 90 (MYE1 verdict; `remove_extracted` already left)"],
  ["core/src/plugins/notes/commands.rs", "task 13 (notes)"],
  ["core/src/plugins/quick_unlock/commands.rs", "task 40 (quick-unlock PIN path)"],
  ["core/src/plugins/snapshots/commands.rs", "task 83 (snapshots — the capture hook decides first)"],
  ["core/src/plugins/vault_change_password/commands.rs", "task 41 (change password)"],
  [
    "core/src/plugins/vault_creation/commands.rs",
    "PORTED (`decisions.md` 2026-08-15): `commit_from_host_io` + `vault_artifacts_present_io` " +
      "are the seam-going siblings the web client dispatches. The direct `std::fs` calls that " +
      "remain belong to the NATIVE arm, which runs inside `run_blocking` and would gain nothing " +
      "from the async seam. The old reason on this line — 'decided absent on web; port not " +
      "owed' — became false the day creation shipped there, and a stale reason on an allowlist " +
      "is how a ratchet quietly stops describing anything.",
  ],
  ["core/src/plugins/vault_recover/account_number_select.rs", "task 32 (recovery entry points)"],
  ["core/src/snapshot_store.rs", "task 83 (snapshots — the capture hook decides first)"],
  ["core/src/vault_registry.rs", "task 12 (vault registry scan)"],
  ["core/src/vault_sweep.rs", "task 72 (vault delete)"],
]);

const SKIP_DIRS = new Set(["target"]);

// `std::fs::<op>(`, a bare `fs::<op>(` where the module is imported, and the two
// handle constructors. Anchored on the call paren so a prose mention in a
// comment is not a violation — comment lines are dropped anyway, but a doc-link
// like [`std::fs::read`] inside a doc comment would otherwise match.
//
// `crate::atomic_write::atomic_write(..)` is here for a reason this guard
// learned the expensive way. It reaches the filesystem exactly as `std::fs`
// does, and this file's own remediation text already names it as a shape to be
// replaced by `io.write(..)` — but the pattern above never matched it, so a
// call in `vault_recover` sat on a wasm-reachable path through `pre-commit` and
// CI green, on a target where `finalize_atomic` returns `Unsupported` by
// design. A guard whose stated coverage exceeds its real coverage costs more
// than no guard, because the green run is read as evidence.
//
// Injected before adding it: the call in a never-allowlisted file reported
// `ok`. Injected after: named by file and line. And the shape the guard already
// caught, a bare `std::fs::read` in the same file, is still named, so closing
// this blind spot opened no other.
//
// **The lookbehind is not tidying, it is the fix for a false positive that shut
// CI down** (myne-md/myne#647). `fs::` with nothing on its left matches INSIDE
// any path segment ending in those two letters, and Rust has several that carry
// no filesystem meaning whatever: `prefs::`, `refs::`, `defs::`. So
// `protocol::prefs::device_scoped_consent(name)` was reported as direct
// filesystem access in a file that had none, `pnpm-build` went red on develop,
// and the serial chain behind it (`vitest`, `tauri-compile`, `cargo-test-tauri`)
// never ran at all. A guard that fires on code it does not describe costs the
// same as one that stays silent on code it does: both teach a reader to stop
// believing the output.
//
// Verified in BOTH directions, because a fix checked only by "the tree is green
// afterwards" is the non-evidence `AGENTS.md` names: `protocol::prefs::foo(`
// must stop matching, AND a bare `std::fs::read(` must still be caught.
export const FS_CALL =
  /(?<![A-Za-z0-9_])(?:std::)?fs::[a-z_]+\s*\(|\bFile::(?:open|create)\b|\bOpenOptions::new\b|\bcrate::atomic_write::atomic_write[a-z_]*\s*\(/;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".rs")) out.push(full);
  }
  return out;
}

// Everything below is the RUN. It is behind a main-module guard so
// `tests/scripts/coreIoSeam.test.ts` can import `FS_CALL` without the import
// walking `core/src` and calling `process.exit`. Same shape as
// `check-i18n-coverage.mjs`.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
const argv = process.argv.slice(2);
const files = (argv.length
  ? argv.filter((f) => f.endsWith(".rs"))
  : ROOTS.flatMap((r) => walk(r))
).filter((f) => {
  const rel = relative(process.cwd(), f);
  return ROOTS.some((r) => rel === r || rel.startsWith(r + sep));
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
  // Tracked by brace depth from the attribute, the same way
  // `check-core-task-seam.mjs` does it, including both of its corrections,
  // which this file was missing while its comment claimed parity.
  //
  // #274: a BRACE-LESS gated item (a `use`, a `type` alias, a `mod x;`) never
  // closes a block, so a plain brace-depth exit leaves `skipping` true for the
  // whole rest of the file and the guard goes silently blind. An item ending in
  // `;` before any brace opened IS the whole item.
  //
  // myne-md/myne#411: a NESTED `#[cfg(test)]`, on a helper already inside
  // `#[cfg(test)] mod tests`, must not restart the tracker. Resetting there ends
  // the outer exemption at the inner helper's closing brace, and every later
  // `std::fs` call in the test module gets reported as a production seam
  // violation. The outer region already covers the inner item, so ignore it.
  //
  // **No file in this tree exhibits that shape today**, and the clause is worth
  // keeping anyway rather than being mistaken for a fix to something present.
  // It was observed for real: while #411 was being built, a helper carrying a
  // redundant `#[cfg(test)]` inside its own `#[cfg(test)] mod tests` made this
  // guard report plainly test-only code, and the redundant attribute was dropped
  // rather than the guard being changed. The clause exists so the next writer of
  // that shape gets a guard that is right instead of one they have to work
  // around. It costs nothing measurable: removing it leaves both seam guards
  // byte-identical in output over all of `core/src`.
  let skipping = false;
  let depth = 0;
  let sawBrace = false;
  const hits = [];
  text.split("\n").forEach((line, i) => {
    if (!skipping && /^\s*#\[cfg\((any\()?test/.test(line)) {
      skipping = true;
      depth = 0;
      sawBrace = false;
    }
    if (skipping) {
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      depth += opens - closes;
      if (opens > 0) sawBrace = true;
      // The `;` test runs on the line with any trailing `//` comment stripped:
      // `#[cfg(test)]` + `use std::fs; // test-only` otherwise fails the test,
      // `sawBrace` stays false, and the exemption swallows the next production
      // item whole. The merge-base guard had this hole too, so it is not a
      // regression, but the #274 note above claims the `;` shape is covered and
      // a guard whose stated coverage exceeds its real coverage is the thing
      // root AGENTS.md says costs more than no guard.
      const code = line.replace(/\/\/.*$/, "");
      if (!sawBrace && /;\s*$/.test(code) && !/^\s*#\[/.test(line)) {
        skipping = false;
        return;
      }
      // A brace-less gated item can also be closed by its ENCLOSING block rather
      // than by a `;`: a trailing `#[cfg(test)]` enum variant ends at the enum's
      // own `}`. Without this arm the exemption runs to end-of-file and every
      // later production call goes unchecked. Found by breaking it: a
      // `std::fs::read` in `double_buffer.rs::write_next` (a production fn, in a
      // file NOT on the allowlist) read as clean while the pre-#274 tracker
      // caught it, so porting #274 here fixed one blind spot and opened another.
      if (!sawBrace && closes > 0) {
        skipping = false;
        return;
      }
      if (sawBrace && depth <= 0 && closes > 0) skipping = false;
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
}
