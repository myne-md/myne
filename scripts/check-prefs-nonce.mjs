#!/usr/bin/env node
// Guard: every `vault.prefs` WRITE goes through the one chokepoint that bumps
// the prefs nonce (#251).
//
// The failure this prevents: `src/lib/prefs.ts` holds ~56 prefs commands, and
// each writer must ALSO call `bumpPrefsNonce()` after the disk write. That call
// is the only mechanism by which sibling `usePrefs` instances re-read
// (`src/hooks/usePrefs.ts`), so forgetting it produces a UI that reports a
// change the user's open editor never receives. It was an optional second line
// in ~56 places and it got forgotten in 31 of them, including:
//
//   - `setFavorites`      — favourites starred from the sidebar silently dropped,
//                           AND the deletion synced (`favorites` is SequenceLww)
//   - `setRightPanelActiveTab` — "Show outline" / "Open AI Chat" do nothing
//   - `setAiEnabled`      — the AI opt-in never reaches the editor's gate
//   - `setRemindersEnabled` / `setReminderHorizonDays`
//                         — reminders keep firing after being turned off
//
// The rule was written down two functions away from the code that broke it.
// Documentation was not enough: a developer writing a new setter copies a
// neighbour, and some neighbours were wrong. So the bump moved INTO the write
// path (`writePref`), and this guard keeps it there.
//
// What it enforces:
//   1. Inside `src/lib/prefs.ts`, only `writePref` may invoke a prefs WRITE
//      command. Read commands (`prefs_read`, `device_platform`) are exempt by
//      name — they have nothing to invalidate.
//   2. No module outside `src/lib/prefs.ts` may invoke a prefs write command at
//      all. Reaching around the module is reaching around the bump.
//
// Skipping the bump is still possible — `writePref(cmd, args, { bump: false })`
// — but it costs an explicit argument that a reviewer can see, which is the
// whole point.
//
// Run by hand: node scripts/check-prefs-nonce.mjs
// Wired into: lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PREFS_MODULE = "src/lib/prefs.ts";

// Prefs commands that only READ. They invalidate nothing, so they need no bump
// and may be invoked directly.
const READ_COMMANDS = new Set(["prefs_read", "device_platform"]);

// Trees that may legitimately hold a `plugin:prefs|` literal without being the
// TS wrapper module: the Rust side names its own commands, and the web
// dispatcher/capability tables classify every command in the tree.
const SCANNED_TREES = ["src", "editor/src", "dialect/src", "copy/src"];

const INVOKE_RE = /invoke\s*<[^>]*>\s*\(\s*"plugin:prefs\|([a-z_]+)"/g;

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
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(name)) {
      yield full;
    }
  }
}

const failures = [];

// ---- rule 1: inside prefs.ts, writes go through writePref ------------------
const prefsPath = join(ROOT, PREFS_MODULE);
const prefsSrc = readFileSync(prefsPath, "utf8");
const prefsLines = prefsSrc.split("\n");

prefsLines.forEach((line, i) => {
  INVOKE_RE.lastIndex = 0;
  let m;
  while ((m = INVOKE_RE.exec(line)) !== null) {
    const command = m[1];
    if (READ_COMMANDS.has(command)) continue;
    // The single legal invoke is the one inside `writePref` itself, which
    // invokes a command it received as a PARAMETER — so it never matches this
    // literal pattern. Any literal match here is a setter reaching around it.
    failures.push({
      file: PREFS_MODULE,
      line: i + 1,
      command,
      why: "invokes a prefs write command directly. Route it through writePref(), which bumps the nonce — usePrefs siblings only re-read on that bump (src/hooks/usePrefs.ts), so without it the open editor keeps the old value for the rest of the session.",
    });
  }
});

if (!/async function writePref\(/.test(prefsSrc)) {
  failures.push({
    file: PREFS_MODULE,
    line: 0,
    command: "(none)",
    why: "the writePref chokepoint is missing. Every prefs write must flow through it; removing it re-opens the class of defect #251 closed.",
  });
}

// ---- rule 2: nobody else invokes a prefs write ----------------------------
for (const tree of SCANNED_TREES) {
  for (const file of walk(join(ROOT, tree))) {
    const rel = relative(ROOT, file);
    if (rel === PREFS_MODULE) continue;
    const src = readFileSync(file, "utf8");
    if (!src.includes("plugin:prefs|")) continue;
    src.split("\n").forEach((line, i) => {
      INVOKE_RE.lastIndex = 0;
      let m;
      while ((m = INVOKE_RE.exec(line)) !== null) {
        const command = m[1];
        if (READ_COMMANDS.has(command)) continue;
        failures.push({
          file: rel,
          line: i + 1,
          command,
          why: "invokes a prefs write from outside src/lib/prefs.ts. Add a wrapper there instead — reaching around the module reaches around the nonce bump.",
        });
      }
    });
  }
}

if (failures.length > 0) {
  for (const f of failures) {
    console.error(
      `✗ prefs-nonce: ${f.file}:${f.line} ${f.command}\n  ${f.why}`,
    );
  }
  console.error(
    `\n${failures.length} violation(s). See scripts/check-prefs-nonce.mjs for why this rule exists.`,
  );
  process.exit(1);
}

const writes = (prefsSrc.match(/await writePref\(/g) ?? []).length;
console.log(
  `prefs-nonce: ok (${writes} write(s) through the chokepoint; ${READ_COMMANDS.size} read command(s) exempt)`,
);
