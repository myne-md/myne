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
//   1. Inside a prefs module, only `writePref` may invoke a prefs WRITE
//      command. Read commands are exempt by name: see `READ_COMMANDS`, which
//      carries the reason per entry. They have nothing to invalidate.
//   2. No module outside a prefs module may invoke a prefs write command at
//      all. Reaching around the module is reaching around the bump.
//
// TWO prefs modules, one per client tree (myne-md/myne#486). The mobile client
// moved in-repo on 2026-08-13 and this guard did not learn about it: `mobile/src`
// was in neither `PREFS_MODULES` nor `SCANNED_TREES`, so both rules were blind to
// a whole client. `mobile/src/lib/prefs.ts` had no chokepoint at all: 47 setters
// with the bump supplied by 29 separate CALL SITES, which is the pre-#251 desktop
// shape. Every one of them happened to be right; the shape is what fails, one
// copied neighbour later. Same rules, both trees, so a mobile setter written
// tomorrow costs a failed commit rather than a stale open editor.
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

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { presentSharedRoots } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

// One per client tree. Each holds its own `writePref`. The two are twins, not a
// shared module: mobile's lives in its own React tree (`mobile/src`) and imports
// its own `prefsNonce`. Rule 1 runs over each; rule 2 exempts each.
//
// DELIBERATELY a named list, not derived from SCANNED_TREES by searching for
// whatever declares `async function writePref(`. Stated precisely, because the
// first version of this comment claimed a concrete counterexample that does not
// exist, and the version after it went stale the moment the tree was fixed:
// `src/hooks/usePrefs.ts` USED to declare a `writePref`, as
// `const writePref = useCallback(`, which that pattern never matches, and it
// held no prefs literal for an exemption to protect. myne-md/myne#507 renamed it
// to `writeOptimisticPref`, so there is no such declaration anywhere today, and
// rule 3 below is what keeps it that way. Searching would work today.
//
// It stays a named list because of the DIRECTION the failure runs. Being on this
// list is an exemption from rule 2: a module here is licensed to hold prefs write
// literals. Deriving membership from a declaration means any file can license
// itself by naming a function, and a guard whose scope widens on a name is the
// wrong shape no matter how few files match right now. The cost is that the list
// can fall behind SCANNED_TREES, which is a silent narrowing rather than a silent
// widening, and `tests/lib/prefsNonce.test.ts` asserts both rosters by name.
export const PREFS_MODULES = ["src/lib/prefs.ts", "mobile/src/lib/prefs.ts"];

// Prefs commands that only READ. They invalidate nothing, so they need no bump
// and may be invoked directly.
// `ai_provider_has_key` (myne#415) answers WHETHER a remote-provider API key is
// stored and returns a bare bool. It is on this list for the same reason as the
// other two — it writes nothing, so there is no value for a sibling `usePrefs`
// to go stale on. It is also the reason a read command exists at all here: the
// key is serde-skipped out of `prefs_read`, so the panel cannot learn "a key is
// set" from the view and must ask separately.
//
// EXPORTED because `mobile/tests/prefs-nonce.test.ts` needs the same
// classification to decide which exports owe a bump, and a mirrored copy there
// would go stale in both directions: a fourth read command would make that test
// demand a bump from a command that writes nothing, and a command moved OUT of
// this set would keep being exempted by the stale copy, silently shrinking the
// only check that proves `writePref` still bumps.
export const READ_COMMANDS = new Set([
  "prefs_read",
  "device_platform",
  "ai_provider_has_key",
  // view-manifests: reads a FILE at a user-chosen path and validates it with the
  // strict reader. It carries no prefs field and writes none, so there is nothing
  // for a nonce bump to invalidate.
  "read_view_manifest",
]);

/**
 * Commands in the `prefs` namespace that carry NO prefs field, so neither rule's
 * reason reaches them: there is no cached value for a nonce bump to invalidate.
 *
 * Kept as its own set rather than added to `READ_COMMANDS`, because that set is
 * counted in the success line as "read command(s) exempt" and a manifest EXPORT is
 * not a read. Folding it in would make the line miscount in the small way this
 * repository has paid for before.
 *
 * `export_view_manifest` (view-manifests) writes a FILE: it canonical-encodes one
 * `SavedView` and durably writes it to a path the OS save dialog named. It does
 * not touch `vault.prefs`, which is why it is the first entry here and why the
 * rule it is excused from (route the write through `writePref`) has nothing to
 * route.
 */
export const NON_FIELD_COMMANDS = new Set(["export_view_manifest"]);

/** Whether a `plugin:prefs|…` command carries a field, and so needs the nonce. */
export function needsNonceBump(command) {
  return !READ_COMMANDS.has(command) && !NON_FIELD_COMMANDS.has(command);
}

// The shared-tree roster, imported rather than copied. `scripts/lib/shared-roots.mjs`
// exists because "each guard kept a private copy" is a recorded past bug (#273),
// and its header states the rule: a guard claiming shared-tree scope imports it,
// one scoping narrower says so in its own header. Rule 2 claims exactly that
// scope, so it imports.
//
// This guard kept a private copy anyway, and paid for it the way the roster
// predicts: `mobile/src` had been ON the roster since the mobile client moved
// in-repo (2026-08-13) and was absent from the copy here, so rule 2 was blind to
// a whole client while the success line read `ok`. Importing also picks up
// `web/src` and `ornaments/src`, which the copy omitted with a justification
// that did not apply to them (it named "the Rust side", but `walk` only yields
// `.ts`/`.tsx`, so no Rust file was ever in scope to excuse).
//
// `missing` is carried, not discarded. Every shared root is in-repo today, so it
// is expected empty, and taking `.present` alone would reproduce the failure
// this import just fixed: a root that vanishes shrinks the scan and the run
// still prints `ok`. `shared-roots.mjs` calls itself "the single place that
// would notice", and noticing only works if an importer acts on it, which is why
// `analyse` turns a missing root into a failure rather than into a smaller walk.
export const { present: SCANNED_TREES, missing: SCANNED_TREES_MISSING } = presentSharedRoots();

// `writePref(` is optional in the pattern and mandatory in the rule: any prefs
// literal NOT sitting as writePref's first argument is the violation.
//
// Quote-agnostic and generic-agnostic, because both are the caller's free
// choice. The generic half is not hypothetical: `writePref<number>("plugin:…")`
// is how the set mutators read their budget refusal count back
// (myne-md/myne#613), and a pattern blind to `<…>` reports every one of them as
// a direct invoke. The type-argument list is bounded to exclude `<`, `>` and
// parens so it cannot run past its own closing angle bracket into the call.
const PREFS_WRITE_CALL =
  /(writePref\s*(?:<[^<>()]*>\s*)?\(\s*)?["'`]plugin:prefs\|([a-z0-9_]+)["'`]/g;

// Rule 3's matcher: any BINDING named `writePref`, in any of the spellings a
// module can use, outside a prefs module.
//
// The rule exists because the collision has now happened three times, and been
// fixed by hand each time: myne#251 is the defect the chokepoint was built to
// close, myne#496 renamed a colliding local on the mobile side, and myne#507
// renamed `src/hooks/usePrefs.ts`'s optimistic-cache core one layer from the
// chokepoint. Two functions with the same name and different semantics, one
// layer apart, is how the original went unnoticed; nothing stopped the fourth
// until this.
//
// It is a LEGIBILITY rule, not a correctness one, and that is why it is separate
// from rules 1 and 2 rather than folded into them: a colliding local breaks
// nothing today (rule 1's matcher requires `async function`, and a hook holds no
// prefs literal for rule 2 to catch). What it costs is a reader of either file
// being unable to tell which `writePref` is the IPC chokepoint.
export const WRITE_PREF_BINDING =
  /\b(?:async\s+function|function|const|let|var)\s+writePref\b|\bwritePref\s*[:=]\s*(?:async\s*)?(?:\(|function\b)/g;

// Outside prefs.ts the bare literal IS the rule — `writePref` is module-private,
// so no shape of a prefs literal is legitimate there. Over-matching a name in a
// comment is harmless for the reason check-web-command-coverage.mjs gives: such
// a name is a real command anyway.
const PREFS_LITERAL = /["'`]plugin:prefs\|([a-z0-9_]+)["'`]/g;

/** 1-based line of a match index, so both rules can scan whole-file. */
const lineOf = (src, index) => src.slice(0, index).split("\n").length;

// `withFileTypes` rather than a `statSync` per entry: the walk covers ~1300
// entries across the shared roots and this runs in `pre-commit`, so the saved
// syscall per entry is most of the walk's cost (measured 63 ms -> 26 ms).
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
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
 * `missingTrees` injects the absent-root list for the same reason `prefsSource`
 * injects module text: the rule that turns a vanished shared tree into a failure
 * is otherwise unreachable from a spec, because every shared root IS on disk, so
 * the only way to see it fire would be to delete one for real. A rule nobody has
 * watched fail is a rule nobody has tested, and this one exists precisely to
 * catch a silent narrowing.
 *
 * `prefsSource` injects one prefs module's own text so a spec can drive the
 * MATCHER over the evasion shapes without a fixture the real run would then have
 * to exempt. When given it REPLACES the real modules for rule 1 (one virtual
 * module, not an addition) AND skips rule 2 entirely, so an injected-source
 * assertion counts only its own findings instead of passing because the real
 * trees happen to be clean today. Rule 2's own coverage comes from the
 * no-argument call, which is what the real run makes.
 */
export function analyse({ prefsSource, missingTrees } = {}) {
  const failures = [];
  // Asked once, at the top. The two spellings of this question used to sit 40
  // lines apart and a reader had to hold "is this the real run or the spec run?"
  // across the whole function.
  const injected = prefsSource !== undefined;

  // ---- rule 1: inside each prefs module, writes go through writePref -------
  const modules = injected
    ? [["(injected source)", prefsSource]]
    : PREFS_MODULES.map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")]);

  for (const [rel, prefsSrc] of modules) {
    // Whole-file, not line-by-line: `writePref(\n  "plugin:prefs|…"` spans lines,
    // and the `\s` inside the optional group has to be allowed to cross one.
    PREFS_WRITE_CALL.lastIndex = 0;
    let m;
    while ((m = PREFS_WRITE_CALL.exec(prefsSrc)) !== null) {
      if (m[1]) continue; // sat as writePref's first argument, the chokepoint
      const command = m[2];
      if (!needsNonceBump(command)) continue;
      failures.push({
        file: rel,
        line: lineOf(prefsSrc, m.index),
        command,
        why: `invokes a prefs write command directly. Route it through the writePref() in this client's prefs module (${PREFS_MODULES.join(", ")}), which bumps the nonce. usePrefs siblings only re-read on that bump, so without it the open editor keeps the old value for the rest of the session.`,
      });
    }

    // Same generic tolerance as `PREFS_WRITE_CALL` above, and for the same
    // reason: `async function writePref<T = void>(` IS the chokepoint, and
    // reading it as absent turns every legitimate write in the file into a
    // violation while hiding the one arm that would have been real.
    if (!/async function writePref\s*(?:<[^<>()]*>\s*)?\(/.test(prefsSrc)) {
      failures.push({
        file: rel,
        line: 0,
        command: "(none)",
        why: "the writePref chokepoint is missing. Every prefs write must flow through it; removing it re-opens the class of defect #251 closed.",
      });
    }
  }

  // The injected run stops here. Rule 2 is skipped by design (see the docstring),
  // and `writes` is a count over the REAL modules, so returning it for a virtual
  // one would be a number about nothing. The specs assert on `failures`.
  if (injected) return { failures, writes: 0 };

  const writes = modules.reduce(
    (n, [, src]) => n + (src.match(/await writePref\(/g) ?? []).length,
    0,
  );

  // A shared root that is not on disk means rule 2 is about to scan less than it
  // claims. Reported as a failure rather than skipped: "scanned fewer trees, said
  // ok" is the exact shape this guard's private roster copy used to have.
  for (const rel of missingTrees ?? SCANNED_TREES_MISSING) {
    failures.push({
      file: rel,
      line: 0,
      command: "(missing tree)",
      why: "is on the shared-roots roster but absent from this checkout, so rule 2 would silently scan one tree fewer. Restore it, or remove it from scripts/lib/shared-roots.mjs where its absence is a decision somebody can read.",
    });
  }

  // ---- rule 2: nobody else invokes a prefs write --------------------------
  for (const tree of SCANNED_TREES) {
    for (const file of walk(join(ROOT, tree))) {
      const rel = relative(ROOT, file);
      if (PREFS_MODULES.includes(rel)) continue;
      const src = readFileSync(file, "utf8");

      // ---- rule 3: the chokepoint's NAME is not reused elsewhere ----------
      if (src.includes("writePref")) {
        WRITE_PREF_BINDING.lastIndex = 0;
        let named;
        while ((named = WRITE_PREF_BINDING.exec(src)) !== null) {
          failures.push({
            file: rel,
            line: lineOf(src, named.index),
            command: "(name collision)",
            why: `declares a binding named writePref outside a prefs module (${PREFS_MODULES.join(", ")}), where that name is the IPC chokepoint that bumps the prefs nonce. Give this one a name that says what it does (myne#496 used writeDraftPref, myne#507 used writeOptimisticPref). Two functions with that name and different semantics one layer apart is how myne#251 went unnoticed.`,
          });
        }
      }

      if (!src.includes("plugin:prefs|")) continue;
      PREFS_LITERAL.lastIndex = 0;
      let hit;
      while ((hit = PREFS_LITERAL.exec(src)) !== null) {
        const command = hit[1];
        if (!needsNonceBump(command)) continue;
        failures.push({
          file: rel,
          line: lineOf(src, hit.index),
          command,
          why: `invokes a prefs write from outside a prefs module (${PREFS_MODULES.join(", ")}). Add a wrapper in the one for this client's tree instead. Reaching around the module reaches around the nonce bump.`,
        });
      }
    }
  }

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
    `prefs-nonce: ok (${writes} write(s) through the chokepoint; ${READ_COMMANDS.size} read command(s) exempt, ${NON_FIELD_COMMANDS.size} field-less command(s) exempt; the chokepoint's name is unique across ${SCANNED_TREES.length} shared tree(s))`,
  );
}
