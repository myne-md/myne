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
// referenced ONLY through the opening helper. That dropdown no longer exists —
// the three create actions are direct icon buttons again — so `MENU_ONLY` is
// empty and this rule currently has no subjects. See its comment for why the
// machinery is kept rather than deleted.
//
// SECOND RULE, same failure one menu over (myne#611). The four export formats
// moved behind a single `Export…` row with a submenu, and their leaf ids did NOT
// change, so a scenario reaching straight for `export-markdown` still compiles,
// still reads correct, and simply times out. The first rule cannot express this:
// every row in these menus shares ONE testid (`notes.context-menu-item`,
// `editor.note-actions-menu-item`) and the row is identified by a `data-item-id`
// or `data-action` VALUE, so the roster is keyed on the value instead.
//
// It is also FILE-scoped rather than line-scoped, and that is a deliberate
// weakening. the helper takes the testid as an argument, so the helper
// and the id sit on one line and a line check is exact. The submenu helper takes
// a format and returns the row, so the id and the helper are lines apart, and a
// line rule would fire on the file that legitimately drives the submenu. What
// the file rule still catches is the whole failure mode: a scenario that reaches
// a leaf id without knowing the submenu is there.
//
// Run by hand: node scripts/check-e2e-menu-testids.mjs
// Wired into: lefthook `pre-commit`, CI `pnpm-build`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
// `e2e-web` is the browser lane (MYND-574). It sat outside this walk, which is
// how e35c8a7b's removal of the sidebar `+` menu left `notes.new-menu` clicks in
// two `e2e-web/` files for ~2.7 weeks: the guard written to catch exactly that
// never read the tree they were in. Both lanes reach user-facing controls, so
// both are in scope.
const TREES = ["e2e", "e2e-web"];

// `--scan <dir>`: walk THIS directory instead of the repo, so the guard's own
// test can drive it over a throwaway tree (myne-md/myne#242, found while
// landing that epic).
//
// The seam is not a convenience. `tests/scripts/e2eMenuTestids.test.ts` wrote
// its probe scenario into the REAL `e2e/` tree, arguing, correctly, that a
// fixture directory would test a walk the guard never performs, and that
// probe is a `e2e/*.e2e.ts` file, which is one of
// `scripts/check-manual-test-roster.mjs`'s six denominators. So for as long as
// the probe existed, ANY concurrently-scheduled test running the roster guard
// saw an `e2e` scenario no roster entry claims, and failed. Vitest runs test
// files in parallel workers, so the two overlapped whenever the scheduler put
// them in the same window, which made `pnpm test` red on a pairing nobody
// chose. The objection the test's comment raises dissolves once the ROOT is an
// argument: the walk is identical, it just starts somewhere else. Same shape as
// `check-twin-inventory.mjs --roots` and `check-token-adoption.mjs --scan`,
// both of which exist for exactly this reason.
const scanAt = process.argv.indexOf("--scan");
const ROOT = scanAt === -1 ? REPO : process.argv[scanAt + 1];

/** Testids that render only while the sidebar's `+` menu is open. */
/**
 * Testids that render ONLY inside an open `+` dropdown.
 *
 * EMPTY, and deliberately so rather than deleted. #230 folded the sidebar's
 * loose new-note and new-folder buttons into one `+` menu, which is what this
 * rule was written for; #282 then added a fourth row. The epic that made the
 * sidebar's search row put the three create actions back as direct icon
 * buttons, so none of those ids is behind a menu any more — and a scenario
 * reaching `byTestId("notes.create")` directly is now the CORRECT pattern, not
 * a violation. Leaving them listed would forbid it.
 *
 * The list stays because the failure it guards is a UI shape, not a moment: the
 * create actions have already been loose buttons, then a menu, and now buttons
 * again. If they go behind a menu a third time, the ids go back here in the
 * same change — and the rule below starts working again with no other edit.
 *
 * Rule 2 (`SUBMENU_ONLY`, the export formats) carries the guard meanwhile.
 */
const MENU_ONLY = [];

/**
 * `--menu-only <a,b>`: run rule 1 against THIS roster instead of the empty one.
 *
 * A second test seam beside `--scan`, and it exists for the same reason the
 * first does — except this one is about the rule staying TESTED rather than the
 * tree staying untouched. With the production roster empty, rule 1 has no
 * subjects, so its spec could only assert that nothing happens; injecting the
 * defect it is supposed to catch would pass, which is the vacuous shape this
 * repository keeps finding in its own tests.
 *
 * With the seam, the rule's logic stays under test through the whole period it
 * has no production subjects — so when the create actions go behind a menu a
 * third time and the ids come back, the machinery is known to work rather than
 * hoped to.
 */
const menuOnlyAt = process.argv.indexOf("--menu-only");
const MENU_ONLY_EFFECTIVE =
  menuOnlyAt !== -1 && process.argv[menuOnlyAt + 1] !== undefined
    ? process.argv[menuOnlyAt + 1].split(",").filter((x) => x.length > 0)
    : MENU_ONLY;

/** The one helper allowed to name them — it would open the menu first. */
const HELPER = "clickNewItem";

/** Row discriminator VALUES that render only inside an open SUBMENU, and the
 *  helper that opens it. A file naming one of these must mention that helper. */
const SUBMENU_ONLY = [
  {
    attrs: ["data-item-id", "data-action"],
    values: ["export-markdown", "export-pdf", "export-html", "export-txt"],
    helper: "openExportSubmenuItem",
    why: 'those rows render only inside the open "Export…" submenu (myne#611)',
  },
];

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
      for (const id of MENU_ONLY_EFFECTIVE) {
        // TWO idioms, because the two lanes reach elements differently.
        //   · `byTestId("x")` / `byTestIdAll("x")` / `testIdSelector("x")` — the
        //     desktop lane's three ways.
        //   · `document.querySelector('[data-testid="x"]')` — the browser lane's
        //     scripted click, used where the driver cannot click directly. The
        //     escaped quotes are part of the source, hence the optional `\`.
        // Matching only the first is half of how `notes.new-menu` survived: the
        // web lane's reaches were invisible to this regex even after the tree
        // was in scope.
        const sel = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(
          `(byTestId|byTestIdAll|testIdSelector)\\(\\s*["']${sel}["']` +
            `|data-testid=(?:\\\\?["'])${sel}(?:\\\\?["'])`,
        );
        if (re.test(line)) {
          violations.push({ file: rel, line: i + 1, id });
        }
      }
    });
  }
}

// Second rule: file-scoped, over the submenu row values.
for (const tree of TREES) {
  for (const file of walk(join(ROOT, tree))) {
    const rel = relative(ROOT, file);
    const src = readFileSync(file, "utf8");
    for (const group of SUBMENU_ONLY) {
      // The file knows about the submenu, so its reaches are sanctioned. The
      // helper's own definition is covered by the same test.
      if (src.includes(group.helper)) continue;
      src.split("\n").forEach((line, i) => {
        for (const attr of group.attrs) {
          for (const value of group.values) {
            const re = new RegExp(`"${attr}"\\s*:\\s*"${value}"`);
            if (re.test(line)) {
              violations.push({ file: rel, line: i + 1, id: value, group });
            }
          }
        }
      });
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    const helper = v.group === undefined ? HELPER : v.group.helper;
    const why =
      v.group === undefined
        ? "that control renders only inside the open `+` menu (#230)"
        : v.group.why;
    console.error(
      `✗ e2e-menu-testid: ${v.file}:${v.line} reaches for "${v.id}" directly.\n` +
        `  ${why}, so this waits for something that is not on\n` +
        `  screen and fails as a timeout, which reads like flake. Go through\n` +
        `  \`${helper}\`, which opens the menu first.`,
    );
  }
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log(
  `e2e-menu-testid: ok (${MENU_ONLY_EFFECTIVE.length} menu-only testid(s) through ${HELPER}; ` +
    `${SUBMENU_ONLY.reduce((n, g) => n + g.values.length, 0)} submenu row value(s) through ` +
    `${SUBMENU_ONLY.map((g) => g.helper).join(", ")})`,
);
