#!/usr/bin/env node
// Guard: a module nothing imports does not run (#272).
//
// The failure this prevents: a module is written, documented, unit-tested — and
// never wired to a call site. TypeScript does not complain about an unused
// export, lint does not, and the module's own tests pass because they import it
// directly. Later code then depends on the behaviour it was supposed to provide.
//
// This is the cheapest guard in the audit's list and it would have caught the
// single worst web defect on the day it landed:
//
//   - `web/src/vault-lock.ts` — `acquireVaultLock`, the ENTIRE single-tab
//     guarantee: zero production importers, and the lock name was not even in
//     the shipped bundle (tree-shaken). `web/src/worker/opfs.ts` skips its
//     TOCTOU guard *because* it believes that lock is held.
//   - `mobile/src/lib/reminderPass.ts` — `runBoundedReminderPass`, imported
//     by two test files and nothing else.
//   - `mobile/src/lib/vault-unlock.ts` — `isVaultUnlocked`, zero call sites.
//
// The mobile examples above were found BY HAND, because the mobile tree was a
// gitignored companion clone this guard could not walk. It watches `mobile/src`
// now, and the first run turned up three more.
//
// Test importers do not count. A module whose only importer is its own test is
// precisely the shape being looked for: it passes CI and does nothing.
//
// A RATCHET, not a hard gate: the recorded list may shrink, never grow. Some
// modules are legitimately dormant (an entry point nothing imports, a barrel, a
// platform-seam twin whose importer is the substituted file), and each of those
// is an entry with a reason rather than a hole in the rule.
//
// Run by hand: node scripts/check-unwired.mjs
// Wired into: lefthook `pre-commit`, CI `pnpm-build`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/** Trees whose modules must be reachable from production code. */
const WATCHED = [
  "web/src",
  "src/lib",
  "src/hooks",
  "mobile/src/lib",
  "mobile/src/hooks",
  // The mobile platform seam. It was invisible to this guard until myne#788's
  // review: a per-client seam module with no importer (its desktop mirror is
  // what imports it in the other client) is exactly the shape, and the tree
  // sat outside every WATCHED root.
  "mobile/src/platform",
  // The shared decision layer (myne-md/myne#242). It joined
  // `scripts/lib/shared-roots.mjs` in the change that created it and NOT this
  // list, which is the gap this guard exists to close one tree over: a new
  // shared package whose first module has no importer is exactly the shape,
  // and nothing would have said so.
  "client-core/src",
  // `src/notes` joined with myne#587, which found this guard's WATCHED list
  // stopped at `src/lib` + `src/hooks` and so never saw `src/notes` — where
  // the deleted Ask mode's orchestration (`runAskToStore.ts`, imported only by
  // its own test) sat unreported. Measured before adding: zero unwired modules
  // under it, so the addition costs nothing and closes the blind spot.
  "src/notes",
];

/** Every tree that may contain an importer (production or test). */
const IMPORTER_TREES = ["src", "web/src", "mobile/src", "editor/src", "dialect/src", "copy/src", "tests", "e2e", "e2e-web", "mobile/tests"];

/** A file is a TEST importer when it lives here or is named like one. */
function isTestFile(rel) {
  return (
    rel.startsWith("tests/") ||
    rel.startsWith("e2e/") ||
    rel.startsWith("e2e-web/") ||
    /\.(test|spec)\.[jt]sx?$/.test(rel) ||
    /\.e2e\.ts$/.test(rel)
  );
}

/**
 * Modules that are deliberately dormant, each with the reason.
 *
 * The list may SHRINK, never grow — an addition is a claim that a module
 * nobody imports is nonetheless doing its job, and that claim belongs in
 * review. Wiring one up is a one-line deletion here.
 */
const EXEMPT = new Map([
  ["web/src/main.tsx", "the web entry point — the bundler's input, imported by nothing"],
  ["src/main.tsx", "the desktop entry point, same reason"],
  ["web/src/platform/capabilities.ts", "platform-seam twin: its importer is the desktop file it is substituted FOR at build time"],
  ["web/src/platform/core.ts", "platform-seam twin"],
  ["web/src/platform/dialog.ts", "platform-seam twin"],
  ["web/src/platform/download.ts", "platform-seam twin"],
  ["web/src/platform/event.ts", "platform-seam twin"],
  ["web/src/platform/filePicker.ts", "platform-seam twin"],
  ["web/src/platform/opener.ts", "platform-seam twin"],
  ["web/src/platform/path.ts", "platform-seam twin"],
  ["web/src/platform/window.ts", "platform-seam twin"],
  ["web/src/platform/webviewWindow.ts", "platform-seam twin"],
  ["web/src/platform/deepLink.ts", "platform-seam twin"],
  ["web/src/platform/plainFile.ts", "platform-seam twin (myne-md/myne#788): substituted for src/platform/plainFile.ts at web build time"],
  // The mobile mirror of the same seam module. Mobile has no OS file ingress,
  // so nothing imports it yet; it is the per-client refusing shape the
  // twin-inventory records as a `screen` verdict (myne-md/myne#788), not dead
  // code. Recorded here because `mobile/src/platform` was outside every
  // WATCHED root, so this class was invisible to this guard.
  ["mobile/src/platform/plainFile.ts", "platform-seam twin (myne-md/myne#788): the refusing mobile mirror of src/platform/plainFile.ts; no mobile flow opens a plain file yet"],
  ["mobile/src/lib/graph-layout.worker.ts", "worker entry — `WikiGraph.tsx` loads it with `new Worker(new URL(…, import.meta.url))`, a real edge that a static import scan cannot see"],
  // Same shape as the mobile twin above, measured the first time `src/notes`
  // joined WATCHED (myne#587): `GraphCanvas.tsx` loads the worker through
  // `new Worker(new URL("../graphLayout.worker.ts", import.meta.url))`.
  ["src/notes/graphLayout.worker.ts", "worker entry — `src/notes/components/GraphCanvas.tsx` loads it with `new Worker(new URL(…, import.meta.url))`, a real edge that a static import scan cannot see"],

  // ---- RECORDED VIOLATIONS (the starting list; may shrink, never grow) ----
  //
  // Each of these IS the defect this guard describes: written, and never wired.
  // They are recorded rather than fixed here because wiring each one is its own
  // change with its own reasoning — and recording them is what makes the rule
  // enforceable TODAY instead of after that work. Every entry names what it
  // would do if it ran; deleting an entry is the whole fix.
  ["web/src/platform/conformance.ts", "UNWIRED — the seam-conformance probe. Nothing calls it, in production or in a test; only a comment in `web/src/platform/event.ts` mentions it."],
  ["web/src/quota-precheck.ts", "UNWIRED — the storage-quota precheck. Its unit test imports it; the boot path does not, so the precheck the web client is documented to run does not run."],
  ["web/src/sw/update-policy.ts", "UNWIRED — the service-worker update policy. Test-only importer."],
  ["src/lib/reminderLifecycle.ts", "UNWIRED — the reminder lifecycle (cancel-everything-on-lock). `Editor.tsx` names it in a comment; no import."],
  ["src/lib/reminderPermission.ts", "UNWIRED — the notification-permission request. Nothing asks for the permission reminders need."],
  // The first three findings this guard produced against the mobile tree, which
  // it could not see until the client moved in-repo.
  ["mobile/src/lib/query-engine.ts", "UNWIRED — a pure `export * from \"@myne/editor/host/notes/queryEngine\"` shim. Every consumer imports that shared module directly, so the shim forwards for nobody. Dead rather than dangerous; the fix is deleting it."],
  ["mobile/src/lib/reminderPass.ts", "UNWIRED — `runBoundedReminderPass`, the pass that applies the shared scheduling decision core (`@myne/reminder-schedule`) to the OS. Two test files import it; NOTHING in `mobile/src` or `mobile/src-tauri` calls it, so the reminders plugin is installed, the decision core is shared, and the step that would act on either never runs. Note the company it keeps two lines up: `src/lib/reminderLifecycle.ts` and `src/lib/reminderPermission.ts` are the same subsystem, inert on the desktop side. The reminder feature is partly unwired on BOTH clients."],
  // ---- found the first time `src/notes` joined WATCHED (myne#587) ----------
  //
  // All four were already this guard's subject the whole time; the tree was
  // outside WATCHED, so nobody was told. Recorded rather than fixed here for
  // the same reason as the list above: wiring each is its own change with its
  // own reasoning, and recording them is what makes the rule enforceable today.
  ["src/notes/ai/runSummarizeToStore.ts", "UNWIRED — the summarize → render-store orchestration. Production calls `runSummarizeToChat` (`aiToChat.ts`) out of `Editor.tsx`'s `onSummarizeNote` instead; `Editor.tsx:3176` names this module only in a comment. Its test still pins the orchestration shape."],
  ["src/notes/graphLayoutProtocol.ts", "UNWIRED — a pure `export * from \"@myne/editor/host/notes/graphLayout\"` shim; every consumer imports the shared module directly. Dead rather than dangerous; the fix is deleting it."],
  ["src/notes/wordCount.ts", "UNWIRED as production code — `documentStats.ts`'s `computeDocStats` is the live bottom-bar counter (MYND-339). `countBodyWords` survives as the parity oracle `tests/notes/documentStats.test.ts` pins `.words` against, so the fix is moving the oracle INTO that test rather than deleting the guarantee."],
  ["src/notes/workspaceBuffers.tsx", "UNWIRED — the multi-buffer residency layer (MYND-166 task 2). Zero production importers; whether the pane architecture it was written for shipped around it is its own question, and this entry is the question being on the record."],
]);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) yield full;
  }
}

// ---- collect every import specifier in the tree ---------------------------
// The `{0,2000}` window, not `{0,200}`: a long NAMED-IMPORT list overruns a
// short one and the importer then goes uncounted, so a module every panel uses
// reads as dead. Measured, not guessed — `ArchivePanel.tsx` puts 265 characters
// between `import` and `from` for `./notePanelStyles`, and `TrashPanel.tsx`
// puts 282, so both were invisible here. The bug was latent for as long as SOME
// importer of that module had a short enough import; it surfaced the moment
// myne-md/myne#776 removed the one that did, which is the worst way to find a
// guard's blind spot — as a false accusation against an innocent change.
// A bound is still wanted (an unbounded `[\s\S]*?` would let one `import` reach
// across the whole file to an unrelated `from`), and 2000 clears the largest
// import block in the tree by an order of magnitude.
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,2000}?from\s+["']([^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["']([^"']+)["']\s*\)/g;
const VITEST_MOCK_RE = /vi\.(?:mock|doMock)\(\s*["']([^"']+)["']/g;

/** basename (no extension) → { prod: n, test: n } */
const importsByName = new Map();

function note(name, fromRel) {
  const rec = importsByName.get(name) ?? { prod: 0, test: 0 };
  if (isTestFile(fromRel)) rec.test += 1;
  else rec.prod += 1;
  importsByName.set(name, rec);
}

for (const tree of IMPORTER_TREES) {
  for (const file of walk(join(ROOT, tree))) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, "utf8");
    for (const re of [IMPORT_RE, DYNAMIC_RE, VITEST_MOCK_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) {
        const spec = m[1];
        // Only relative/aliased module specifiers can name a file in this repo.
        if (!spec.startsWith(".") && !spec.startsWith("@myne/")) continue;
        // A BARE workspace specifier (`@myne/client-core`, no subpath) names
        // that package's `src/index.ts`, which every `@myne/*` package's
        // exports map points `"."` at. Without this arm the basename is the
        // PACKAGE name and the barrel it actually imports looks unimported: a
        // package front door reads as dead code no matter how many production
        // call sites use it, and the only way past the guard is an exemption
        // that would be false. Found when `client-core/src` joined `WATCHED`
        // (myne-md/myne#242) and three production importers left the count at
        // zero.
        const bare = /^@myne\/[^/]+$/.test(spec);
        if (bare) {
          note("index", rel);
          continue;
        }
        const leaf = basename(spec).replace(/\.(ts|tsx|js|jsx)$/, "");
        note(leaf === "index" ? basename(spec.slice(0, spec.lastIndexOf("/"))) : leaf, rel);
      }
    }
  }
}

// ---- report modules with no PRODUCTION importer ---------------------------
const unwired = [];
for (const tree of WATCHED) {
  for (const file of walk(join(ROOT, tree))) {
    const rel = relative(ROOT, file);
    if (EXEMPT.has(rel)) continue;
    if (isTestFile(rel)) continue;
    const name = basename(rel).replace(/\.(ts|tsx)$/, "");
    const rec = importsByName.get(name) ?? { prod: 0, test: 0 };
    // A module importing itself is not an importer; the count is over the whole
    // tree, so subtract nothing — a file's own imports name OTHER modules.
    if (rec.prod === 0) unwired.push({ rel, testImporters: rec.test });
  }
}

if (unwired.length > 0) {
  for (const u of unwired) {
    console.error(
      `✗ unwired: ${u.rel}\n` +
        `    production importers: 0  (test importers: ${u.testImporters})\n` +
        "    A module nothing imports does not run. Wire it, or record it in\n" +
        "    EXEMPT with the reason it is intentionally dormant.",
    );
  }
  console.error(
    `\n${unwired.length} unwired module(s). See scripts/check-unwired.mjs for why this rule exists —\n` +
      "the single-tab vault lock shipped this way and the OPFS write path skipped its\n" +
      "TOCTOU guard on the strength of it.",
  );
  process.exit(1);
}

// ---- a stale exemption is a module told to stop being looked at (myne#587) --
//
// `ai-qa.ts` was recorded as UNWIRED, deleted with the Ask mode, and this guard
// kept printing `ok (24 recorded exemption(s))` while one of the twenty-four
// described a file that no longer existed. `check-ipc-binding-callers.mjs`
// already fails on a stale exemption and `check-twin-inventory.mjs` on a
// verdict whose files are gone; this is the same arm here, so an exemption can
// only shrink with the tree rather than outlive it.
const stale = [];
for (const rel of EXEMPT.keys()) {
  let present;
  try {
    statSync(join(ROOT, rel));
    present = true;
  } catch {
    present = false;
  }
  if (!present) stale.push(rel);
}
if (stale.length > 0) {
  for (const rel of stale) {
    console.error(
      `✗ unwired: STALE EXEMPTION — scripts/check-unwired.mjs records ${rel},\n` +
        "    which does not exist. Delete the entry; an exemption nobody can\n" +
        "    re-read is a module this guard has been told to stop looking at.",
    );
  }
  process.exit(1);
}

console.log(
  `unwired: ok (${WATCHED.join(", ")} — every module has a production importer; ${EXEMPT.size} recorded exemption(s))`,
);
