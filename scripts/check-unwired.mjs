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
//   - `myne-mobile/src/lib/reminderPass.ts` — `runBoundedReminderPass`, imported
//     by two test files and nothing else.
//   - `myne-mobile/src/lib/vault-unlock.ts` — `isVaultUnlocked`, zero call sites.
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
const WATCHED = ["web/src", "src/lib", "src/hooks"];

/** Every tree that may contain an importer (production or test). */
const IMPORTER_TREES = ["src", "web/src", "editor/src", "dialect/src", "copy/src", "tests", "e2e", "e2e-web"];

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
  ["web/src/platform/clipboard.ts", "platform-seam twin"],
  ["web/src/platform/deepLink.ts", "platform-seam twin"],
  ["web/src/platform/unsupported.ts", "platform-seam twin"],

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
  ["src/lib/ai-qa.ts", "UNWIRED — the AI question-answering binding. `ai-chat.ts` names it in a comment and imports nothing."],
  ["src/lib/reminderLifecycle.ts", "UNWIRED — the reminder lifecycle (cancel-everything-on-lock). `Editor.tsx` names it in a comment; no import."],
  ["src/lib/reminderPermission.ts", "UNWIRED — the notification-permission request. Nothing asks for the permission reminders need."],
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
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,200}?from\s+["']([^"']+)["']/g;
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

console.log(
  `unwired: ok (${WATCHED.join(", ")} — every module has a production importer; ${EXEMPT.size} recorded exemption(s))`,
);
