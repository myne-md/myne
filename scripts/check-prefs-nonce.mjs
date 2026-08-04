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
// Both rules match the COMMAND LITERAL, not the call shape. The first version
// required `invoke<T>("…")` — a mandatory generic and a double quote — and
// `invoke`'s type parameter defaults to `unknown`, so `invoke("plugin:prefs|…")`,
// backticks, single quotes and a hoisted `const cmd` all passed. Four of the five
// shapes a developer actually types were invisible to the rule they violate
// (#387).
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

// `writePref(` is optional in the pattern and mandatory in the rule: any prefs
// literal NOT sitting as writePref's first argument is the violation.
// Quote-agnostic and generic-agnostic, because both are the caller's free choice.
const PREFS_WRITE_CALL = /(writePref\s*\(\s*)?["'`]plugin:prefs\|([a-z0-9_]+)["'`]/g;

// Outside prefs.ts the bare literal IS the rule — `writePref` is module-private,
// so no shape of a prefs literal is legitimate there. Over-matching a name in a
// comment is harmless for the reason check-web-command-coverage.mjs gives: such
// a name is a real command anyway.
const PREFS_LITERAL = /["'`]plugin:prefs\|([a-z0-9_]+)["'`]/g;

/** 1-based line of a match index, so both rules can scan whole-file. */
const lineOf = (src, index) => src.slice(0, index).split("\n").length;

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

/**
 * Run both rules and return what they found. EXPORTED so `tests/lib/prefsNonce.test.ts`
 * can assert on the return rather than restate the rule — the same shape, and the
 * same reason, as `scripts/check-web-command-coverage.mjs`: a spec that
 * reimplemented the scan could pass while the script failed, or agree with a bug.
 *
 * `prefsSource` injects prefs.ts's own text so a spec can drive the MATCHER over
 * the evasion shapes without a fixture the real run would then have to exempt.
 * Rule 2 always reads the real trees.
 */
export function analyse({ prefsSource } = {}) {
  const failures = [];

  // ---- rule 1: inside prefs.ts, writes go through writePref ----------------
  const prefsSrc = prefsSource ?? readFileSync(join(ROOT, PREFS_MODULE), "utf8");

  // Whole-file, not line-by-line: `writePref(\n  "plugin:prefs|…"` spans lines,
  // and the `\s` inside the optional group has to be allowed to cross one.
  PREFS_WRITE_CALL.lastIndex = 0;
  let m;
  while ((m = PREFS_WRITE_CALL.exec(prefsSrc)) !== null) {
    if (m[1]) continue; // sat as writePref's first argument — the chokepoint
    const command = m[2];
    if (READ_COMMANDS.has(command)) continue;
    failures.push({
      file: PREFS_MODULE,
      line: lineOf(prefsSrc, m.index),
      command,
      why: "invokes a prefs write command directly. Route it through writePref(), which bumps the nonce — usePrefs siblings only re-read on that bump (src/hooks/usePrefs.ts), so without it the open editor keeps the old value for the rest of the session.",
    });
  }

  if (!/async function writePref\(/.test(prefsSrc)) {
    failures.push({
      file: PREFS_MODULE,
      line: 0,
      command: "(none)",
      why: "the writePref chokepoint is missing. Every prefs write must flow through it; removing it re-opens the class of defect #251 closed.",
    });
  }

  // ---- rule 2: nobody else invokes a prefs write --------------------------
  for (const tree of SCANNED_TREES) {
    for (const file of walk(join(ROOT, tree))) {
      const rel = relative(ROOT, file);
      if (rel === PREFS_MODULE) continue;
      const src = readFileSync(file, "utf8");
      if (!src.includes("plugin:prefs|")) continue;
      PREFS_LITERAL.lastIndex = 0;
      let hit;
      while ((hit = PREFS_LITERAL.exec(src)) !== null) {
        const command = hit[1];
        if (READ_COMMANDS.has(command)) continue;
        failures.push({
          file: rel,
          line: lineOf(src, hit.index),
          command,
          why: "invokes a prefs write from outside src/lib/prefs.ts. Add a wrapper there instead — reaching around the module reaches around the nonce bump.",
        });
      }
    }
  }

  const writes = (prefsSrc.match(/await writePref\(/g) ?? []).length;
  return { failures, writes };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//
// Only when invoked directly, so importing this module from the spec neither
// prints nor exits.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { failures, writes } = analyse();

  if (failures.length > 0) {
    for (const f of failures) {
      console.error(`✗ prefs-nonce: ${f.file}:${f.line} ${f.command}\n  ${f.why}`);
    }
    console.error(
      `\n${failures.length} violation(s). See scripts/check-prefs-nonce.mjs for why this rule exists.`,
    );
    process.exit(1);
  }

  console.log(
    `prefs-nonce: ok (${writes} write(s) through the chokepoint; ${READ_COMMANDS.size} read command(s) exempt)`,
  );
}
