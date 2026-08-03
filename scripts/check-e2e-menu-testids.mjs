#!/usr/bin/env node
// Guard: E2E must not reach for a testid that only exists inside an open menu (#275).
//
// The failure this prevents: a UI change moves a control behind a menu, and the
// scenarios that clicked it keep compiling and keep reading as correct — they
// just wait for an element that is no longer on screen and fail as a timeout,
// which reads like flake rather than like a stale helper. #230 folded the
// separate new-note and new-folder buttons into one `+` menu; six scenarios
// clicked the old testids directly, and one waited on `notes.create` as an
// "is the sidebar mounted yet" anchor — an anchor that had stopped being one.
//
// The rule: a testid rendered only inside `notes.new-menu-dropdown` may be
// referenced ONLY through `clickNewMenuItem`, which opens the menu first (and
// checks it is not already open, since clicking `+` while open toggles it shut).
//
// Run by hand: node scripts/check-e2e-menu-testids.mjs
// Wired into: lefthook `pre-commit`, CI `pnpm-build`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TREES = ["e2e"];

/** Testids that render only while the sidebar's `+` menu is open. */
const MENU_ONLY = ["notes.create", "notes.new-folder", "notes.create-drawing"];

/** The one helper allowed to name them — it opens the menu first. */
const HELPER = "clickNewMenuItem";

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
    else if (/\.ts$/.test(name)) yield full;
  }
}

const violations = [];
for (const tree of TREES) {
  for (const file of walk(join(ROOT, tree))) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      // The helper's own definition names them as a parameter, not a literal.
      if (line.includes(HELPER)) return;
      for (const id of MENU_ONLY) {
        // `byTestId("x")` / `byTestIdAll("x")` / `testIdSelector("x")` — the
        // three ways a scenario reaches for an element by testid.
        const re = new RegExp(`(byTestId|byTestIdAll|testIdSelector)\\(\\s*"${id.replace(".", "\\.")}"`);
        if (re.test(line)) {
          violations.push({ file: rel, line: i + 1, id });
        }
      }
    });
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    console.error(
      `✗ e2e-menu-testid: ${v.file}:${v.line} reaches for "${v.id}" directly.\n` +
        `  That control renders only inside the open \`+\` menu (#230), so this waits\n` +
        `  for something that is not on screen and fails as a timeout. Use\n` +
        `  \`${HELPER}(session, "${v.id}")\`, which opens the menu first.`,
    );
  }
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log(
  `e2e-menu-testid: ok (${MENU_ONLY.length} menu-only testid(s) reachable only through ${HELPER})`,
);
