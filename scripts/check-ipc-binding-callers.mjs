#!/usr/bin/env node
// Every IPC binding the BINDING LAYER exports has a PRODUCTION caller.
//
// THE FAILURE THIS PREVENTS. A Tauri command is wired through five places that
// each look complete on their own: `build.rs`, the plugin's permission file, the
// capability bundle, `generate_handler!`, and a TypeScript binding that wraps
// `invoke("plugin:x|y")`. `src-tauri/AGENTS.md` already records that an ACL
// entry does not wire a command; this is the layer above that. Every one of the
// five can be right while NOTHING CALLS THE BINDING, and then the whole feature
// behind it ships inert: the Rust core, its tests, its ACL row and its recorded
// threshold file all exist, and the property they promise is never enforced at
// runtime.
//
// That is not hypothetical. `agentCapability()` shipped this way in
// myne-md/myne#529: the edit-format probe gate had no caller, so agent mode was
// offered on every backend while `core/src/plugins/agent/edit.rs` and
// `probe.rs` both stated, as the reason the anchored format may refuse a
// near-miss rather than fuzzy-match it, that a model which copies anchors badly
// shows the feature as unavailable. Two module docs were false and the tree was
// green.
//
// WHY THE EXISTING GUARDS CANNOT SEE IT.
//   * `check-unwired.mjs` asks whether a MODULE has a production importer. A
//     binding file like `src/lib/agent-run.ts` has many, for its other exports,
//     so the dead one is invisible.
//   * `check-web-command-coverage.mjs` asks whether the command literal is
//     CLASSIFIED for the web target. A command classified `Dispatched` and never
//     called passes.
//   * The per-plugin ACL guard tests compare four Rust-side sources. The caller
//     is on the other side of IPC.
//
// WHAT COUNTS AS A CALLER. Any reference to the exported name from a file that
// is not the declaring module and not a test. A re-export does not count: it
// moves the problem rather than solving it, so the chain has to end at a real
// call.
//
// WHY THE SCOPE IS `src/lib` + `mobile/src/lib` AND NOT EVERY SHARED TREE.
// `scripts/lib/shared-roots.mjs` is the one roster of shared trees, and its rule
// is that a guard claiming shared-tree scope imports it while a guard that scopes
// narrower says so in its own header. This one scopes narrower deliberately, and
// the reason is the caller rule directly above.
//
// Those two directories ARE the binding layer: a module there exists to wrap
// `invoke` for somebody else, so a wrapper referenced only from inside its own
// file is by definition unused. Everywhere else in the shared trees the shape is
// different: a module declares a binding AND consumes it in the same file, which
// is the wiring rather than a symptom. `src/notes/import/ports.ts` declares
// `importReadDir` at its top and installs it into the port record 200 lines
// down; `src/notes/vaultIndices.ts` and `src/notes/loadNoteBatch.ts` do the same.
//
// Measured rather than assumed (myne-md/myne#529 review): widening `BINDING_ROOTS`
// to `presentSharedRoots().present` reports FOUR bindings with no caller, and all
// four are that shape. Zero real defects, four false positives, and recording them
// in `ipc-binding-callers.json` would put non-defects in a list whose every entry
// is supposed to describe one. Widening therefore costs accuracy and buys nothing
// today. If the binding layer ever grows a third directory, add it here; if the
// same-file-consumer shape ever needs covering, that is a change to the caller
// rule above, not to this roster.
//
// The neighbouring guards cover what this one does not: `check-unwired.mjs`
// requires every module under `src/lib`, `src/hooks`, `web/src`, `mobile/src/lib`
// and `mobile/src/hooks` to have a production importer, and
// `check-web-command-coverage.mjs` holds every `plugin:x|y` literal in the shared
// tree to a web classification.
//
// USAGE
//   node scripts/check-ipc-binding-callers.mjs
//   node scripts/check-ipc-binding-callers.mjs --record   # re-baseline (deliberate)
//
// Recorded exemptions live in `scripts/ipc-binding-callers.json` and each one
// carries a REASON. A binding that is genuinely called only by a future client,
// or deliberately reserved, says so there in words rather than by being absent.
// The list is a ratchet: it may shrink, never grow, so a new dead binding costs
// an argument rather than a silent entry.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve } from "node:path";
import { SHARED_ROOTS } from "./lib/shared-roots.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

/**
 * The record's path, overridable so a test can drive the `--record` seed path and
 * the `--check` that follows it against a scratch file.
 *
 * `check-prefs-parity.mjs`'s `MYNE_PREFS_PARITY_RECORD` is the precedent, and the
 * reason is the one this file's own header records: the WRITER is the half nobody
 * tests, and driving it against the committed record means saving and restoring a
 * file, which leaves the tree wrong when the run is interrupted.
 */
const RECORD = process.env.MYNE_IPC_BINDING_CALLERS_RECORD
  ? resolve(process.env.MYNE_IPC_BINDING_CALLERS_RECORD)
  : join(ROOT, "scripts", "ipc-binding-callers.json");

/** Trees whose modules may declare an IPC binding. */
const BINDING_ROOTS = ["src/lib", "mobile/src/lib"];
/** Trees a caller may live in. A test does not count. */
const CALLER_ROOTS = ["src", "web/src", "mobile/src", "editor/src", "dialect/src"];

/** Which caller trees answer for which binding tree.
 *
 * **A binding is live when ITS OWN client calls it, not when the other one
 * does.** Both Tauri clients name their bindings identically, so a flat search
 * over every caller root let desktop's caller satisfy mobile's binding and the
 * other way round: the same "each was the other's caller" defect that had been
 * hiding `probeVaultStatus`, one level up. It survived two earlier fixes to this
 * guard in the same change, which is the argument for writing it down as a map
 * rather than as a comment.
 *
 * `editor/src` and `dialect/src` are genuinely shared source packages that both
 * clients compile, so they answer for both. `web/src` answers only for `src`,
 * which is the tree it substitutes a seam into. */
const CALLERS_FOR = new Map([
  ["src/lib", ["src", "web/src", "editor/src", "dialect/src"]],
  ["mobile/src/lib", ["mobile/src", "editor/src", "dialect/src"]],
]);

// The mapping above is this guard's POLICY — which client answers for which
// binding tree is a decision, not a roster — but the tree NAMES in it are not
// this guard's to own (myne-md/myne#605). Every root named here must exist in
// `scripts/lib/shared-roots.mjs`'s roster, checked below at startup: a renamed
// or deleted tree must fail by name rather than silently narrow the search.
// The reverse is deliberately NOT checked: a new shared tree joining the roster
// does not automatically become a caller root. The header's measured decision
// above ("WHY THE SCOPE IS src/lib + mobile/src/lib") is what admits a tree,
// and that admission belongs in review, not in a glob.
for (const [bindingRoot, callers] of CALLERS_FOR) {
  for (const root of [bindingRoot, ...callers]) {
    // A binding root is a SUBDIRECTORY of a shared root (`src/lib` under
    // `src`); either shape counts, since the question is whether the tree the
    // name points at still exists under a known root.
    const known =
      SHARED_ROOTS.includes(root) || SHARED_ROOTS.some((s) => root.startsWith(`${s}/`));
    if (!known) {
      console.error(
        `ipc-binding-callers: CALLERS_FOR names "${root}", which is neither in ` +
          `scripts/lib/shared-roots.mjs nor under one of its roots. A renamed ` +
          `tree narrows this guard's search silently; map the new name or ` +
          `remove the stale one.`,
      );
      process.exit(1);
    }
  }
}

/** The caller trees that answer for the binding file at `rel`. */
export function callerRootsFor(rel) {
  for (const [bindingRoot, callers] of CALLERS_FOR) {
    if (rel.startsWith(`${bindingRoot}/`)) return callers;
  }
  // A binding root nobody mapped falls back to every tree, which is the old
  // behaviour and is the SAFE direction: it can only make a dead binding look
  // live, never the reverse, and `BINDING_ROOTS` is two entries so a third
  // arriving unmapped is a visible edit rather than a silent one.
  return CALLER_ROOTS;
}

const IS_TEST = /(^|\/)(tests?|__tests__)\//;
const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (/\.[jt]sx?$/.test(name) && !TEST_FILE.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Exported function names in `src` whose body invokes a `plugin:x|y` command.
 *
 * Takes TEXT rather than a path so `tests/scripts/ipcBindingCallers.test.ts` can
 * inject each defect class as a synthetic source string. */
export function bindingsInSource(src) {
  const found = [];
  // Each exported async function, with its body up to the next top-level
  // `export` or end of file. Deliberately a text scan rather than a parser: the
  // guards in this repo are zero-dependency, and a parser here would be a
  // dependency added to read one shape.
  const re = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*[(<]/g;
  let m;
  const marks = [];
  while ((m = re.exec(src)) !== null) marks.push({ name: m[1], at: m.index });
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].at;
    const end = i + 1 < marks.length ? marks[i + 1].at : src.length;
    const body = src.slice(start, end);
    if (invokesCommand(body) || invokesThroughChokepoint(body)) {
      found.push(marks[i].name);
    }
  }
  return found.concat(reexportedBindings(src));
}

/** A direct `invoke("plugin:x|y", …)` in the body. */
function invokesCommand(body) {
  return /invoke\s*<?[^(]*\(\s*["'`]plugin:[a-z0-9-]+\|/.test(body);
}

/**
 * The mandated-write-path chokepoints: a function whose body must reach its
 * command through one of these rather than through a direct `invoke`.
 *
 * **The shape that made this guard blind, found by measurement (myne-md/myne#605).**
 * `check-prefs-nonce.mjs` rule 1 requires every prefs write to carry its
 * `plugin:prefs|…` literal as `writePref`'s first argument — and `writePref` is
 * module-private and the only thing that calls `invoke`. So one guard's rule
 * structurally made the other guard blind, and neither said so: the success
 * line still counted, it just counted almost nothing (2 of 49 mobile prefs
 * bindings, 3 of 70 desktop). A named constant rather than a regex
 * alternation, so adding a third write path is a one-line edit at a place a
 * reviewer will see.
 */
const CHOKEPOINTS = ["writePref"];

/** `writePref("plugin:x|y", …)`, the literal as the chokepoint's first argument.
 *
 * **The generic form is the same call and this guard used to miss it**
 * (myne-md/myne#880). `check-prefs-nonce.mjs` accepts `writePref<number>("plugin:prefs|…")`,
 * and since myne-md/myne#613 the five set-union mutators are written that way
 * because they return how many additions the reserved byte budget refused. The
 * matcher here required the literal immediately after `writePref(`, so those
 * five desktop and three mobile bindings never entered the denominator at all:
 * measured, desktop showed 71 of its 76 prefs bindings and mobile 55 of its 58.
 * The asymmetry was one guard following the rule and its sibling not.
 *
 * The generic argument list is OPTIONAL and matched up to the call's own
 * parenthesis, so `writePref<Record<string, number>>(…)` is covered too. It is
 * deliberately NOT a generic function-name pattern: `invoke("plugin:…")` must
 * not satisfy a chokepoint test, because a bare `invoke` is the shape the
 * chokepoint exists to forbid. `tests/scripts/ipcBindingCallers.test.ts` asserts
 * both directions.
 *
 * Exported so that test can drive the two shapes directly: the difference is
 * invisible through `deadBindings`, since a direct `invoke` is detected by
 * `invokesCommand` either way. */
export function invokesThroughChokepoint(body) {
  return CHOKEPOINTS.some((fn) =>
    new RegExp(`${fn}\\s*(?:<[^()]*>)?\\s*\\(\\s*["'\`]plugin:[a-z0-9-]+\\|`).test(body),
  );
}

/**
 * Bindings a module re-exports out of a FACTORY's return record.
 *
 * **The shape that made this guard blind, found by the /simplify review of
 * myne-md/myne#456.** Sharing the agent's IPC bindings between two Tauri
 * clients meant moving them inside `makeAgentRun({ invoke, Channel })`, so each
 * client's `agent-run.ts` became:
 *
 * ```ts
 * const bound = makeAgentRun({ invoke, Channel });
 * export const { agentStart, agentApply, agentUndo, … } = bound;
 * ```
 *
 * The scan above matches `export function NAME`, and after that refactor there
 * were none: eight tracked bindings on desktop collapsed to ZERO, mobile's copy
 * never entered the denominator at all, and the guard went on printing `ok`
 * about the 189 it could still see. The binding whose deadness this guard was
 * WRITTEN for, `agentCapability` (myne-md/myne#529), was among the seven it
 * stopped watching.
 *
 * Matching the destructure alone would be the weak version: it would count
 * names the file merely re-exports without checking any of them reaches a
 * command. So the factory's own source has to be in `src` too, which it is
 * whenever the file both calls the factory and destructures it, and the
 * per-client injection files do not, which is why the FACTORY file is scanned
 * for the `plugin:` literals and the CLIENT file contributes the names.
 */
export function reexportedBindings(src) {
  const out = [];
  // `export const { a, b, c } = <expr>;`, the whole record, names only.
  const re = /export\s+const\s*\{([^}]*)\}\s*=/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    for (const raw of m[1].split(",")) {
      // `a: renamed` re-exports under the new name, which is what a caller
      // would use.
      const name = raw.includes(":") ? raw.split(":")[1] : raw;
      const clean = name.trim();
      if (/^[A-Za-z0-9_$]+$/.test(clean)) out.push(clean);
    }
  }
  return out;
}

/** A file's text with its import statements and its COMMENTS removed.
 *
 * **An import is not a call**, and matching one is how this guard passed while
 * the thing it checks was wrong. Verified by breaking it in BOTH directions:
 * injecting a dead binding failed correctly, and then removing the sole CALL of
 * a live binding while leaving its import still reported ok. The repo's own
 * rule says the second direction is the one nobody thinks to try, and this
 * guard proved it on itself before it ever gated anything.
 *
 * **Neither is a comment.** Stripping imports alone left a weaker version of the
 * same hole: a doc comment that names the binding counts as a caller, and a
 * comment is weaker evidence than an import. Found while reviewing
 * myne-md/myne#886, whose new `TranscriptSheet.tsx` names `readTranscript` in
 * its header and calls it once: replacing the call with `Promise.resolve(null)`
 * and leaving the import and the comment still printed `ok`, so deleting the
 * binding's exemption from `scripts/ipc-binding-callers.json` rested on a green
 * gate that a comment can satisfy. The name is kept for the test file's sake;
 * what it removes is "anything that is not code".
 *
 * `tsc --noUnusedLocals` would catch the plain case, but not a name used only in
 * a type position or inside code no branch reaches, so this cannot lean on it. */
export function withoutImports(text) {
  return text
    // Block comments first: they can contain `//`, which the line pass below
    // would otherwise see as the start of a comment.
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // `(^|[^:])` keeps a `https://` inside a string literal from being read as a
    // comment, the same guard `check-token-adoption.mjs` uses for `#`.
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/^\s*import\s+type\s[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s*["'][^"']+["'];?\s*$/gm, "");
}

/** The local names a file gave the imports it renamed, as `original -> aliases`.
 *
 * **A renamed import makes a live binding invisible**, and it does so through
 * this guard's own `withoutImports`: the import line is stripped precisely so a
 * mention in it cannot count as a call, which also deletes the only place the
 * two names appear together. What is left says `clipboardWriteText(...)` and
 * never says `writeText`, so the guard reports a binding that four call sites
 * reach.
 *
 * That is a FALSE POSITIVE, which is the dangerous direction for a ratchet: the
 * fix a reader reaches for is an exemption, and an exemption on live code turns
 * the record from a list of defects into a list of names somebody once argued
 * about. `mobile/src/lib/clipboardTransport.ts:writeText` was reported dead
 * while `mobile/src/editor-host.ts` installs it as the editor's clipboard port.
 *
 * Read from the ORIGINAL text, before stripping, because stripping is what
 * removes the evidence. */
export function importAliases(text) {
  const out = new Map();
  const line = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  for (const m of text.matchAll(line)) {
    for (const clause of m[1].split(",")) {
      const as = /^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(clause);
      if (!as) continue;
      const [, original, alias] = as;
      if (!out.has(original)) out.set(original, new Set());
      out.get(original).add(alias);
    }
  }
  return out;
}

/** Top-level exported function bodies in `src`, as `name -> body`.
 *
 * The unit the second hop needs. Split on a column-0 `export`, which is where a
 * top-level declaration in this tree begins, so a nested `export` inside a
 * string or a block cannot end a body early. */
export function exportedBodies(src) {
  const out = new Map();
  const head = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  const starts = [...src.matchAll(head)].map((m) => ({ name: m[1], at: m.index }));
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1].at : src.length;
    out.set(starts[i].name, src.slice(starts[i].at, end));
  }
  return out;
}

/** The tree as `deadBindings` wants it.
 *
 * Both maps are keyed by the SAME relative path, because the `other === rel`
 * identity check is what stops a module calling itself into liveness, and it is
 * silently false when one side is absolute. Every file is read ONCE:
 * re-reading per binding is what turns a 1 s guard into a 40 s one on a tree
 * this size.
 *
 * Exported so `scripts/check-prefs-parity.mjs` reads the tree the same way this
 * guard does rather than keeping a second copy of `BINDING_ROOTS`,
 * `CALLER_ROOTS` and the test filter. That guard asks a different question of
 * the same measurement (which prefs command is surfaced on which client) and
 * imports `deadBindings` for the caller decision, so the read has to be the
 * same read or the two would disagree about what a caller is. */
export function readTree() {
  const bindingFiles = BINDING_ROOTS.flatMap((r) => walk(join(ROOT, r)));
  const callerFiles = [...new Set(CALLER_ROOTS.flatMap((r) => walk(join(ROOT, r))))].filter(
    (f) => !IS_TEST.test(relative(ROOT, f)),
  );
  const read = (fs) => new Map(fs.map((f) => [relative(ROOT, f), readFileSync(f, "utf8")]));
  return {
    bindings: read(bindingFiles),
    callers: read(callerFiles),
    moduleCount: bindingFiles.length,
  };
}

/** The bindings with no production caller, given the whole world as an argument.
 *
 * Takes `{name → source}` maps rather than walking the tree, on the same rule
 * `check-mobile-export-backup.mjs`'s `analyse(io)` follows: the half of this
 * guard worth testing is the caller decision, and a decision function that
 * reads the disk can only be tested by mutating the real tree. Every case in
 * `tests/scripts/ipcBindingCallers.test.ts` is a synthetic file set instead, so
 * there is no `git restore` to forget and the cases run on every commit.
 *
 * `bindings` is keyed by the path the failure message should name;
 * `callers` is keyed by anything, since only identity against a binding key
 * matters (a module does not call itself into liveness). */
export function deadBindings({ bindings, callers }) {
  // Stripped ONCE, not per binding. Re-stripping inside the inner loop is what
  // turns a 1 s guard into a 40 s one, for the same reason the read is hoisted.
  const stripped = [...callers].map(([k, v]) => [k, withoutImports(v)]);
  // Harvested from the UNSTRIPPED text, which is the only place the renamed
  // import still names both sides. Built once, for the same reason `stripped`
  // is: per-binding re-parsing is what turns a 1 s guard into a 40 s one.
  const aliases = new Map([...callers].map(([k, v]) => [k, importAliases(v)]));
  const dead = [];
  let checked = 0;
  for (const [rel, src] of bindings) {
    for (const name of bindingsInSource(src)) {
      checked += 1;
      const word = new RegExp(`\\b${name}\\b`);
      // **A file that DECLARES the binding is not a caller of it**, and the
      // declaring FILE is not the only place a declaration can be. That was
      // enough while every binding was `export function agentApply` in the file
      // being checked; myne-md/myne#456 moved the agent's bindings inside a
      // factory (`makeAgentRun({ invoke, Channel })`) so two clients could
      // share them, and each client's module now re-exports them out of the
      // factory's return record. The factory's own source sits in `src/lib`,
      // which is a caller root, so it mentions every one of those names and
      // every one of them looked called. Verified by injecting a binding with
      // no caller anywhere: before this, the guard counted it and passed.
      const declares = new RegExp(
        `(?:function|const|let|var)\\s+${name}\\b|\\b${name}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\()`,
      );
      // **A destructuring re-export is a declaration too**, and missing that
      // left the third blind spot in a row. The first fix taught the scan to
      // SEE `export const { agentStart, … } = bound`; without teaching the
      // caller test the same shape, each client's copy of that line counted as
      // the other client's caller, which is the identical "each was the other's
      // caller" defect the first two fixes closed for `probeVaultStatus`. The
      // symptom was `agentCapability` reported live while nothing on mobile
      // calls it.
      const reexports = new RegExp(`export\\s+const\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=`);
      const answering = callerRootsFor(rel);
      if (!reaches(name)) dead.push(`${rel}:${name}`);

      /** Is `wanted` mentioned by a production file that does not declare it?
       *
       * Hoisted into a closure because the SECOND HOP asks the same question of
       * a different name, and asking it twice by copy would be a second place
       * for the alias rule and the re-export rule to drift apart. */
      function reachedFromAnotherFile(wanted) {
        const w = new RegExp(`\\b${wanted}\\b`);
        const dec = new RegExp(
          `(?:function|const|let|var)\\s+${wanted}\\b|\\b${wanted}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\()`,
        );
        const reex = new RegExp(`export\\s+const\\s*\\{[^}]*\\b${wanted}\\b[^}]*\\}\\s*=`);
        for (const [other, text] of stripped) {
          if (other === rel) continue;
          // Only the trees that answer for this binding's client.
          if (!answering.some((root) => other.startsWith(`${root}/`))) continue;
          // A re-export moves the problem rather than solving it.
          if (new RegExp(`export\\s*\\{[^}]*\\b${wanted}\\b[^}]*\\}`).test(text)) continue;
          if (dec.test(text) || reex.test(text)) continue;
          if (w.test(text)) return true;
          // The name the importing file actually calls it by.
          for (const alias of aliases.get(other)?.get(wanted) ?? []) {
            if (new RegExp(`\\b${alias}\\b`).test(text)) return true;
          }
        }
        return false;
      }

      /** Reached directly, or through one exported function in its own file.
       *
       * **The second hop is not a relaxation of the caller rule, it is the rule
       * applied twice.** This guard's header argues that a wrapper referenced
       * only from inside its own file is by definition unused, and records that
       * as MEASURED over the binding layer. The measurement was taken before
       * the caller search was scoped per client, so it only ever read the
       * desktop tree: `mobile/src/lib/workspace-persist.ts` declares
       * `workspaceRead`, calls it from `ensureWorkspaceHydrated` twenty lines
       * down, and exports that instead. The binding is reached on every unlock.
       *
       * ONE hop, deliberately. A chain the guard follows arbitrarily far stops
       * being able to say a binding is unreachable, because a cycle of dead
       * functions inside one file would carry each other. One hop covers the
       * shape that occurs and refuses the shape that hides. (The case that
       * named this limit — a binding called only by `persistHorizon`, itself
       * uncalled — has since left the tree; the limit stands without it.) */
      function reaches(wanted) {
        if (reachedFromAnotherFile(wanted)) return true;
        for (const [fn, body] of exportedBodies(src)) {
          if (fn === wanted) continue;
          if (!new RegExp(`\\b${wanted}\\s*\\(`).test(body)) continue;
          if (reachedFromAnotherFile(fn)) return true;
        }
        return false;
      }
    }
  }
  dead.sort();
  return { dead, checked };
}

/** The ratchet's verdict on a measured `dead` list against a recorded `exempt`.
 *
 * Three failures, and the last two are the ones a "does it still pass" check
 * cannot see: a NEW dead binding, an exemption carrying no reason, and a STALE
 * exemption whose binding has since acquired a caller. A guard that only
 * reported the first would let the record drift into a list of licences nobody
 * re-argued. */
/** What `--record` writes into every fresh entry.
 *
 * **A sentinel, not a reason, and the guard has to know the difference.** The
 * reason check was a length floor, and this string is 15 characters, so the
 * tool's own placeholder passed the tool's own gate: `--record` produced a file
 * that went green while every entry in it said, in words, that its reason was
 * missing. Seven entries sat that way. Exported so the check and the writer
 * cannot drift to two spellings of it. */
export const PLACEHOLDER = "REASON REQUIRED";

export function ratchet(dead, exempt) {
  return {
    news: dead.filter((d) => !(d in exempt)),
    unreasoned: Object.entries(exempt)
      .filter(
        ([, why]) =>
          typeof why !== "string" || why.trim().length < 12 || why.trim() === PLACEHOLDER,
      )
      .map(([k]) => k),
    stale: Object.keys(exempt).filter((k) => !dead.includes(k)),
  };
}

/**
 * What `--record` writes: the measured dead set, with every reason that still
 * describes a live entry carried over.
 *
 * **This is a MERGE, and it is a fix rather than a nicety.** The writer used to
 * build the file from the measured set alone, so every entry got the
 * placeholder: running the command the failure message recommends destroyed all
 * thirty hand-written reasons in one go, and the reader then had to re-derive
 * what each dead binding was. The header and the root `AGENTS.md` row both
 * described the merge as existing behaviour, so the code and its own
 * documentation had already parted company.
 *
 * The placeholder survives where it belongs: an entry with no prior reason is
 * still written as the placeholder, which `ratchet` rejects BY NAME, so a
 * genuinely new exemption still fails until a human argues for it. A stale entry
 * (the binding acquired a caller) is dropped, which is the one edit `--record`
 * exists to make.
 *
 * Exported so `tests/scripts/ipcBindingCallers.test.ts` can drive it: the write
 * half is the half this file's own history says nobody tests.
 */
export function mergeRecord(dead, prior) {
  const exempt = {};
  for (const key of dead) {
    const why = prior?.[key];
    exempt[key] = typeof why === "string" && why.trim() ? why : PLACEHOLDER;
  }
  return exempt;
}

// Run the check only when this file IS the command, the shape
// `check-mobile-export-backup.mjs` already uses. Without it, importing
// `deadBindings` or `ratchet` to test them walks the whole tree as a side
// effect and, on a real failure, calls `process.exit(1)` from inside the test
// runner: the suite dies mid-file with a bare exit code instead of reporting a
// failing test, and the guard's own message scrolls past as stray stdout.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}

function main() {
  const tree = readTree();
  const { dead, checked } = deadBindings(tree);

  if (process.argv.includes("--record")) {
    const existing = existsSync(RECORD)
      ? JSON.parse(readFileSync(RECORD, "utf8"))
      : null;
    const exempt = mergeRecord(dead, existing?.exempt ?? {});
    const kept = dead.filter((d) => exempt[d] !== PLACEHOLDER).length;
    writeFileSync(
      RECORD,
      `${JSON.stringify(
        {
          $comment: Array.isArray(existing?.$comment)
            ? existing.$comment
            : [
                "IPC bindings with no production caller. Each entry needs a REASON,",
                "because an entry without one is indistinguishable from a defect",
                "somebody recorded instead of fixing. Ratchet: may shrink, never grow.",
                "",
                "THIS FILE FAILS THE GUARD AS WRITTEN, deliberately: every entry",
                "carries the placeholder and the guard rejects it by name. `--record`",
                "gives you the LIST, never the licence. Replace each one with what",
                "you found out, or the entry is not an exemption.",
              ],
          exempt,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `ipc-binding-callers: recorded ${dead.length} exemption(s); ` +
        `${kept} kept their reason, ${dead.length - kept} carry the placeholder`,
    );
    process.exit(0);
  }

  const record = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : { exempt: {} };
  const exempt = record.exempt ?? {};

  const { news, unreasoned, stale } = ratchet(dead, exempt);

  // A recorded exemption with no reason is not an exemption.
  if (unreasoned.length > 0) {
    console.error(
      `ipc-binding-callers: ${unreasoned.length} recorded exemption(s) carry no reason:\n  ${unreasoned.join("\n  ")}`,
    );
    process.exit(1);
  }

  if (news.length > 0) {
    console.error(
      `ipc-binding-callers: ${news.length} IPC binding(s) have NO production caller:\n  ${news.join("\n  ")}\n\n` +
        "  A command can be declared, permitted, registered, mirrored in TypeScript\n" +
        "  and still never run. Call it, or record it in scripts/ipc-binding-callers.json\n" +
        "  WITH A REASON.",
    );
    process.exit(1);
  }
  if (stale.length > 0) {
    console.error(
      `ipc-binding-callers: ${stale.length} recorded exemption(s) are stale (the binding now has a caller):\n  ${stale.join("\n  ")}\n\n` +
        "  Remove them with --record so the list keeps describing the tree.",
    );
    process.exit(1);
  }

  console.log(
    `ipc-binding-callers: ok (${checked} binding(s) across ${tree.moduleCount} module(s); ${Object.keys(exempt).length} recorded exemption(s))`,
  );
}
