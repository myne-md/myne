#!/usr/bin/env node
// Async-execution seam guard (phase3-web-client task 80).
//
// `core/src/task.rs` is the one place in the crate allowed to reach tokio's
// *execution* surface. The reason it needs a guard rather than a convention is
// the specific failure it prevents:
//
//   `tokio::task::spawn_blocking` COMPILES for wasm32 and PANICS at runtime.
//
// So a call site added outside the seam passes `cargo check`, passes
// `cargo clippy --target wasm32-unknown-unknown`, passes every test that runs
// natively — and kills the Worker the first time a user saves a note. There is
// no compiler diagnostic for it and no lint. A grep is the only thing that
// catches it, which is exactly why it is a grep.
//
// Scope is deliberately narrow: **execution**, not tokio as a whole.
// `tokio::sync` (RwLock, Mutex, mpsc) works fine on wasm and is used throughout
// the crate for real reasons; banning it would be noise, and a noisy guard gets
// suppressed. The banned set is the surface that needs a runtime driver or a
// thread pool.
//
// Deliberately a grep-shaped script in the same pattern as
// `check-platform-seam.mjs` and lefthook's secret-scan — zero dependencies, node
// built-ins only (root CLAUDE.md: adding a dependency is a security decision).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = "core/src";
const SEAM = join("core", "src", "task.rs");

/// Files exempt from [`BANNED`] — the execution-API ban.
///
/// **One entry, and it should stay that way.** Unlike `CLOCK_ALLOWED`, this is
/// not a ratchet with a port owed: a file here is one that legitimately builds a
/// runtime, and the only legitimate reason is being a TEST HARNESS.
///
/// `test_support.rs` compiles only under `test` / `test-support`
/// (`core/src/lib.rs`), so nothing it contains can reach a wasm32 build. It got
/// this entry with phase3-web-client task 86, which made the sync engine async:
/// the two-device scenarios and the simulation harness stay synchronous by
/// design (they drive a deterministic timeline step by step), so each step is
/// driven on a current-thread runtime, and the construction is centralised in
/// `test_support::block_on` rather than repeated at ~30 call sites.
///
/// The in-file `#[cfg(test)] mod tests` case needs no entry — the scanner
/// already skips those regions, which is why a dozen other modules build
/// runtimes in their tests without appearing here. `sim.rs` did need help only
/// because it is gated at its `mod` declaration, so its code is not inside a
/// `#[cfg(test)]` region within the file; it now calls the shared helper.
const EXEC_ALLOWED = new Set(["core/src/test_support.rs"]);

// Execution surface only. Each entry names why it cannot work on wasm32.
const BANNED = [
  ["tokio::task::spawn_blocking", "no blocking pool on wasm32 — compiles, panics at runtime"],
  ["tokio::spawn", "no multi-thread runtime on wasm32"],
  ["tokio::time::sleep", "no timer driver on wasm32"],
  ["tokio::time::interval", "no timer driver on wasm32"],
  ["tokio::time::timeout", "no timer driver on wasm32"],
  ["tokio::runtime::", "no runtime to build on wasm32"],
];

// ── the std clocks (phase3-web-client task 12) ──────────────────────────────
//
// `Instant::now()` and `SystemTime::now()` compile for wasm32 and **panic** —
// std has no wasm arm and falls to its `unsupported` backend, whose `now()` is
// `panic!("time not implemented on this platform")`. Verified in std's own
// source at the pinned toolchain, not assumed.
//
// This is not a hypothetical. Two of them were found the expensive way while
// porting `unlock`: the failure presents as a bare `RuntimeError: unreachable`
// from a dead Worker, with no message, no file and no line — the diagnosis took
// a debug wasm build and a browser stack trace each time. A grep would have
// caught both in `pre-commit`.
//
// A RATCHET, like `check-core-io-seam.mjs`: 13 files still call one, and moving
// them is the body of the port tasks. A file not on the list may not start.
const CLOCK_BANNED = [
  ["Instant::now(", "panics on wasm32 — use `HostCtx::monotonic_millis()`"],
  ["SystemTime::now(", "panics on wasm32 — use `HostCtx::now_unix_millis()`"],
  // Found while building the browser sync transport (task 35/84): the sync
  // engine's retry backoff calls it, and it is the SAME trap as the clocks —
  // std has no wasm arm, so `thread::sleep` falls to the `unsupported` backend
  // and panics. It is worse than the clocks in one way: the calls sit on the
  // RETRY path, so a browser would survive a healthy sync and die on the first
  // rate-limit or transient failure, which is exactly when nobody is watching.
  //
  // A blocking sleep is also wrong for a Worker even where it works — it holds
  // the thread that answers every command — so the fix is `task::sleep`, whose
  // wasm arm task 84 owes.
  ["std::thread::sleep(", "panics on wasm32 — use `crate::task::sleep().await`"],
  // Same family, found in the same pass: `wasm32-unknown-unknown` has **no
  // threads**, so `thread::spawn` cannot start one. Seven sites, all in the sync
  // engine (the poke listener's supervisor, a transport test server). Unlike the
  // sleep this is not a panic-on-call so much as a design that has no browser
  // shape at all — a Worker's concurrency is the event loop, and the port has to
  // express these as tasks rather than threads.
  ["std::thread::spawn(", "wasm32 has no threads — express it as an async task"],
];

/** Files that still call a std clock directly, each naming the task that removes it. */
const CLOCK_ALLOWED = new Map([
  ["core/src/host.rs", "IS the seam — the one legitimate place a std clock is read"],
  ["core/src/plugins/attachments/commands.rs", "task 18/44 (attachments)"],
  ["core/src/plugins/notes/commands.rs", "task 13 (notes)"],
  ["core/src/plugins/sync/commands.rs", "tasks 84-86 (sync); the sleep is inside `#[cfg(test)] mod tests`"],
  // Un-gated in `mod.rs` by task 84 so the browser shares the SCHEDULER, but the
  // runtime glue that owns the clock (`spawn_sync_loop`) is gated per-item
  // inside the file. Both remaining calls — `Instant::now` and
  // `tokio::time::interval` — are in that region. Listed for the same reason
  // `orchestrator.rs` is: this guard greps the file rather than parsing its cfg
  // attributes, so a NEW clock call in the pure half would be invisible to it.
  // That is what the entry costs, and it is worth writing down rather than
  // discovering.
  ["core/src/plugins/sync/loop_control.rs", "host-gated glue only after task 84 split the module"],
  ["core/src/plugins/sync/poke_listener.rs", "tasks 84-86 (sync)"],
  ["core/src/plugins/sync/sim.rs", "tasks 84-86 (sync); test-harness only"],
  ["core/src/plugins/vault_change_password/commands.rs", "task 41 (change password)"],
  ["core/src/plugins/vault_creation/commands.rs", "decided absent on web; port not owed"],
  ["core/src/plugins/vault_creation/state.rs", "decided absent on web; port not owed"],
  ["core/src/search/bench.rs", "a benchmark, never compiled into a client"],
  ["core/src/snapshot_store.rs", "task 83 (snapshots — the capture hook decides first)"],
  // `std::thread::sleep` sites, all inside the sync engine. Two of these files
  // are already listed above for the clocks; the rest join for the sleep alone.
  // Every remaining occurrence in this file is inside `#[cfg(test)] mod tests`:
  // the three PRODUCTION retry-backoff sleeps moved onto `task::block_sleep`
  // (task 84). It stays listed because this guard greps the file rather than
  // parsing its cfg attributes — a *new* production call here would be invisible
  // to it, which is the one thing this entry costs and is worth writing down.
  ["core/src/plugins/sync/orchestrator.rs", "test-only after task 84 moved the backoff onto `task::block_sleep`"],
  // NOT reachable on wasm32: `mod.rs` gates `poke_listener` behind
  // `tauri-ipc`+non-wasm and `rustls_transport` behind non-wasm. Listed anyway
  // so the ban still applies to them — a file that is gated out today can be
  // un-gated by the port, and the exemption should be a decision then rather
  // than an inheritance. `loop_control` is exactly that case having happened:
  // task 84 un-gated it, the guard stopped exempting it automatically (the
  // gated set is read from `mod.rs`, not hand-listed), and its entry above had
  // to be re-argued rather than inherited.
  // The remote-provider arm (myne-md/myne#456). Both moved into `core/` in that
  // change and are behind the default-off `remote-ai` feature, whose only
  // enablers are the two native Tauri clients: desktop's `local-inference`
  // implies it and mobile turns it on directly, while `web/wasm` takes the
  // crate with `default-features = false`. So neither file is in a wasm build,
  // and the readings are elapsed-time measurements (an idle deadline and a
  // total-request deadline), which is what a monotonic clock is for.
  //
  // Listed rather than ported to `HostCtx::monotonic_millis()` because the
  // `HostCtx` is not in scope at either site: `cancellable_io` wraps a
  // `std::io::Read` and `provider_transport` owns a blocking TLS stream, and
  // threading a host through both to satisfy a guard about a build they are
  // never in would be the tail wagging the dog.
  ["core/src/inference/cancellable_io.rs", "host-only: `remote-ai` is enabled only by the two native clients; elapsed-time deadline on a blocking read"],
  ["core/src/inference/provider_transport.rs", "host-only: same feature chain; total-request deadline around a blocking TLS stream"],
  ["core/src/plugins/sync/rustls_transport.rs", "gated out of wasm32 entirely (mod.rs); host-only TLS"],
]);

const SKIP_DIRS = new Set(["target"]);

/**
 * Modules already gated out of the wasm build are exempt — a
 * `spawn_blocking` there is correct, because that code never compiles for
 * wasm32.
 *
 * The gated set is READ FROM THE SOURCE rather than hand-listed: every
 * `mod.rs` is scanned for a `#[cfg(all(feature = "tauri-ipc", …))]` sitting on
 * a `pub mod X;`, and `X`'s directory or file is exempted. A hand-list would
 * drift the moment someone un-gates a module, and it would drift *silently* —
 * the guard would keep exempting code that had become wasm-reachable, which is
 * the exact failure it exists to catch.
 */
/**
 * Does this attribute line gate its item to a NATIVE-ONLY build (#274)?
 *
 * Only those exempt. The inversion that shipped treated any mention of
 * `target_arch = "wasm32"` as an exemption — including the bare, POSITIVE form,
 * which is the arm that runs in the browser and therefore the one arm this
 * guard exists to check. `core/src/plugins/attachments/commands.rs` has a live
 * wasm-only region the guard walked straight past.
 */
function isNativeOnlyGate(line) {
  if (/feature\s*=\s*"tauri-ipc"/.test(line)) return true;
  // `not(target_arch = "wasm32")` — native-only, genuinely exempt.
  if (/not\s*\(\s*target_arch\s*=\s*"wasm32"\s*\)/.test(line)) return true;
  // Anything else mentioning wasm32 is a wasm-only or wasm-inclusive arm.
  return false;
}

function gatedModulePaths(root) {
  const exempt = new Set();
  for (const file of walk(root)) {
    if (!file.endsWith("mod.rs") && !file.endsWith("lib.rs")) continue;
    const dir = file.slice(0, file.lastIndexOf(sep));
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = /^\s*(?:pub )?mod\s+([a-z_0-9]+)\s*;/.exec(line);
      if (!m) return;
      // Look back over attributes for a tauri-ipc / non-wasm32 gate.
      for (let j = i - 1; j >= 0 && lines[j].trim().startsWith("#["); j--) {
        // #274: only a NOT-wasm32 gate exempts. A bare
        // `#[cfg(target_arch = "wasm32")]` is the arm that runs in the browser,
        // which is the one this guard exists to check — treating it as an
        // exemption skipped exactly the code that matters.
        if (isNativeOnlyGate(lines[j])) {
          exempt.add(join(dir, m[1]));       // directory module
          exempt.add(join(dir, `${m[1]}.rs`)); // file module
          return;
        }
      }
    });
  }
  return exempt;
}

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
  return rel === ROOT || rel.startsWith(ROOT + sep) || rel.startsWith(ROOT + "/");
});

const GATED = gatedModulePaths(ROOT);
const isGated = (rel) => [...GATED].some((g) => rel === g || rel.startsWith(g + sep));

const violations = [];
for (const file of files) {
  const rel = relative(process.cwd(), file);
  if (rel === SEAM) continue; // the seam is the one place that may.
  if (isGated(rel)) continue; // never compiled for wasm32.

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // staged-but-deleted
  }

  // Two kinds of region are exempt, and both are tracked the same way — by
  // brace depth from the attribute that opens them:
  //
  //   `#[cfg(test)]`            — never compiled for wasm32.
  //   `#[cfg(… tauri-ipc …)]`   — an ITEM-level host gate. Module-level gates
  //                               are handled by `gatedModulePaths`; this
  //                               catches a single gated `fn` inside an
  //                               otherwise-shared file, which is the shape a
  //                               plugin's `init()` has.
  let skipping = false;
  let depth = 0;
  let sawBrace = false;
  text.split("\n").forEach((line, i) => {
    // myne-md/myne#411: `!skipping` guards the reset. A NESTED gate, on a helper
    // already inside `#[cfg(test)] mod tests`, must not restart the tracker:
    // resetting there ends the outer exemption at the inner helper's closing
    // brace, and everything after it in the test module is checked as
    // production code. The outer region already covers the inner item.
    //
    // No file in this tree has that shape today, and this clause changes no
    // output here. It is carried because the io-seam guard, whose gate regex is
    // broader, did hit it for real. Keeping the two trackers identical is worth
    // more than trimming a clause that costs nothing.
    if (
      !skipping &&
      (/^\s*#\[cfg\(test\)\]/.test(line) ||
        (/^\s*#\[cfg\(/.test(line) && isNativeOnlyGate(line)))
    ) {
      skipping = true;
      depth = 0;
      sawBrace = false;
    }
    if (skipping) {
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      depth += opens - closes;
      if (opens > 0) sawBrace = true;
      // #274: a BRACE-LESS gated item — a `type` alias, a `use`, a `mod x;` —
      // never closes a block, so the old brace-depth exit left `skipping` true
      // for the whole rest of the file. Everything after `core/src/hooks.rs`'s
      // gated type aliases was silently unchecked. An item that ends in `;`
      // before any brace opened IS the whole item.
      // The `;` test runs on the line with any trailing `//` comment stripped:
      // `#[cfg(test)]` + `use std::fs; // test-only` otherwise fails the test,
      // `sawBrace` stays false, and the exemption swallows the next production
      // item whole. The merge-base guard had this hole too, so it is not a
      // regression, but the #274 note above claims the `;` shape is covered and
      // a guard whose stated coverage exceeds its real coverage is the thing
      // root CLAUDE.md says costs more than no guard.
      const code = line.replace(/\/\/.*$/, "");
      if (!sawBrace && /;\s*$/.test(code) && !/^\s*#\[/.test(line)) {
        skipping = false;
        return;
      }
      // #411: a brace-less gated item closed by its ENCLOSING block, not by a
      // `;`: a trailing `#[cfg(test)]` enum variant ends at the enum's `}`.
      // Without this the exemption runs to end-of-file. The `;` arm above has
      // covered the `use`/`type`/`mod x;` shapes since #274 and never this one.
      if (!sawBrace && closes > 0) {
        skipping = false;
        return;
      }
      if (sawBrace && depth <= 0 && closes > 0) skipping = false;
      return;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return; // prose may name them
    if (!EXEC_ALLOWED.has(rel)) {
      for (const [needle, why] of BANNED) {
        if (line.includes(needle)) violations.push({ file: rel, line: i + 1, needle, why });
      }
    }
    if (!CLOCK_ALLOWED.has(rel)) {
      for (const [needle, why] of CLOCK_BANNED) {
        if (line.includes(needle)) violations.push({ file: rel, line: i + 1, needle, why });
      }
    }
  });
}

// Stale-entry check, same as the io-seam ratchet: an allowance that outlives its
// subject makes the remaining-work count meaningless. Whole-tree runs only — a
// staged-files run sees a subset by design.
if (!argv.length) {
  const stillCalls = new Set();
  for (const file of walk(ROOT)) {
    const rel = relative(process.cwd(), file);
    const text = readFileSync(file, "utf8");
    if (CLOCK_BANNED.some(([needle]) => text.includes(needle))) stillCalls.add(rel);
  }
  const stale = [...CLOCK_ALLOWED.keys()].filter((f) => !stillCalls.has(f));
  if (stale.length) {
    console.error("Stale CLOCK_ALLOWED entries — these no longer call a std clock:\n");
    for (const f of stale) console.error(`  ${f}`);
    console.error("\nRemove them; the list is the remaining port surface.");
    process.exit(1);
  }
}

if (violations.length) {
  // Split by kind: reporting a clock violation under a "tokio" heading sends the
  // reader to the wrong seam, which is the opposite of what a guard is for.
  const clocks = violations.filter((v) => v.needle.includes("::now("));
  const tokio = violations.filter((v) => !v.needle.includes("::now("));

  if (clocks.length) {
    console.error("Direct std clock outside the host seam:\n");
    for (const v of clocks) {
      console.error(`  ${v.file}:${v.line}  ${v.needle}`);
      console.error(`      ${v.why}`);
    }
    console.error(`
Take the reading from \`HostCtx\` instead:

    std::time::Instant::now()      ->   host.monotonic_millis()      (elapsed time)
    std::time::SystemTime::now()   ->   host.now_unix_millis()       (wall clock)

Both std clocks COMPILE for wasm32 and then panic — std has no wasm arm and
falls to its \`unsupported\` backend. The symptom is a dead Worker reporting a
bare \`RuntimeError: unreachable\`, with no message, no file and no line.

Which one you want is not a style choice: a monotonic reading is for measuring
elapsed time (idle timers, TTLs, durations) and never steps backwards; a wall
clock is for values compared across devices or sessions (LWW stamps, \`last_unlock\`)
and is the only one meaningful outside this process.
`);
  }

  if (!tokio.length) process.exit(1);
  console.error("Direct tokio execution API outside the async seam:\n");
  for (const v of tokio) {
    console.error(`  ${v.file}:${v.line}  ${v.needle}`);
    console.error(`      ${v.why}`);
  }
  console.error(`
Route it through \`crate::task\` instead (${SEAM}):

    tokio::task::spawn_blocking(f).await   ->   crate::task::run_blocking(f).await

Why this is a hard rule and not a style note: these APIs COMPILE for wasm32 and
fail at runtime. Nothing in the build catches them — not cargo check, not clippy
on either target, not a native test run. The first symptom is a dead Worker in a
browser.

If the call genuinely belongs to a host-only module, gate the module
(\`#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]\`) rather than
reaching around this guard.`);
  process.exit(1);
}

console.log(`core task-seam: ok (${files.length} file(s) checked)`);
console.log(
  `  ${CLOCK_ALLOWED.size} file(s) still call \`Instant::now\` / \`SystemTime::now\` directly ` +
    `(both panic on wasm32). This number must only go down.`,
);
