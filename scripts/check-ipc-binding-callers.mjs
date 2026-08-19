#!/usr/bin/env node
// Every IPC binding the BINDING LAYER exports has a PRODUCTION caller.
//
// THE FAILURE THIS PREVENTS. A Tauri command is wired through five places that
// each look complete on their own: `build.rs`, the plugin's permission file, the
// capability bundle, `generate_handler!`, and a TypeScript binding that wraps
// `invoke("plugin:x|y")`. `src-tauri/CLAUDE.md` already records that an ACL
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

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RECORD = join(ROOT, "scripts", "ipc-binding-callers.json");

/** Trees whose modules may declare an IPC binding. */
const BINDING_ROOTS = ["src/lib", "mobile/src/lib"];
/** Trees a caller may live in. A test does not count. */
const CALLER_ROOTS = ["src", "web/src", "mobile/src", "editor/src", "dialect/src"];

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
    if (/invoke\s*<?[^(]*\(\s*["'`]plugin:[a-z0-9-]+\|/.test(body)) {
      found.push(marks[i].name);
    }
  }
  return found;
}

/** A file's text with its import statements removed.
 *
 * **An import is not a call**, and matching one is how this guard passed while
 * the thing it checks was wrong. Verified by breaking it in BOTH directions:
 * injecting a dead binding failed correctly, and then removing the sole CALL of
 * a live binding while leaving its import still reported ok. The repo's own
 * rule says the second direction is the one nobody thinks to try, and this
 * guard proved it on itself before it ever gated anything.
 *
 * `tsc --noUnusedLocals` would catch the plain case, but not a name used only in
 * a type position or inside code no branch reaches, so this cannot lean on it. */
export function withoutImports(text) {
  return text
    .replace(/^\s*import\s+type\s[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s*["'][^"']+["'];?\s*$/gm, "");
}

/** The tree as `deadBindings` wants it.
 *
 * Both maps are keyed by the SAME relative path, because the `other === rel`
 * identity check is what stops a module calling itself into liveness, and it is
 * silently false when one side is absolute. Every file is read ONCE:
 * re-reading per binding is what turns a 1 s guard into a 40 s one on a tree
 * this size. */
function readTree() {
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
  const dead = [];
  let checked = 0;
  for (const [rel, src] of bindings) {
    for (const name of bindingsInSource(src)) {
      checked += 1;
      const word = new RegExp(`\\b${name}\\b`);
      let called = false;
      for (const [other, text] of stripped) {
        if (other === rel) continue;
        // A re-export moves the problem rather than solving it.
        if (new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(text)) continue;
        if (word.test(text)) {
          called = true;
          break;
        }
      }
      if (!called) dead.push(`${rel}:${name}`);
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
export function ratchet(dead, exempt) {
  return {
    news: dead.filter((d) => !(d in exempt)),
    unreasoned: Object.entries(exempt)
      .filter(([, why]) => typeof why !== "string" || why.trim().length < 12)
      .map(([k]) => k),
    stale: Object.keys(exempt).filter((k) => !dead.includes(k)),
  };
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
    writeFileSync(
      RECORD,
      `${JSON.stringify(
        {
          $comment: [
            "IPC bindings with no production caller. Each entry needs a REASON,",
            "because an entry without one is indistinguishable from a defect",
            "somebody recorded instead of fixing. Ratchet: may shrink, never grow.",
          ],
          exempt: Object.fromEntries(dead.map((d) => [d, "REASON REQUIRED"])),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`ipc-binding-callers: recorded ${dead.length} exemption(s)`);
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
