#!/usr/bin/env node
// Every IPC binding a shared tree exports has a PRODUCTION caller.
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

/** Exported function names in `file` whose body invokes a `plugin:x|y` command. */
function bindingsIn(file) {
  const src = readFileSync(file, "utf8");
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

const bindingFiles = BINDING_ROOTS.flatMap((r) => walk(join(ROOT, r)));
const callerFiles = [...new Set(CALLER_ROOTS.flatMap((r) => walk(join(ROOT, r))))].filter(
  (f) => !IS_TEST.test(relative(ROOT, f)),
);

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
function withoutImports(text) {
  return text
    .replace(/^\s*import\s+type\s[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s[\s\S]*?from\s*["'][^"']+["'];?\s*$/gm, "")
    .replace(/^\s*import\s*["'][^"']+["'];?\s*$/gm, "");
}

// Read every caller file once. Re-reading per binding is what turns a 1 s guard
// into a 40 s one on a tree this size.
const callerText = new Map(
  callerFiles.map((f) => [f, withoutImports(readFileSync(f, "utf8"))]),
);

const dead = [];
let checked = 0;
for (const file of bindingFiles) {
  const rel = relative(ROOT, file);
  for (const name of bindingsIn(file)) {
    checked += 1;
    const word = new RegExp(`\\b${name}\\b`);
    let called = false;
    for (const [other, text] of callerText) {
      if (other === file) continue;
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

// A recorded exemption with no reason is not an exemption.
const unreasoned = Object.entries(exempt)
  .filter(([, why]) => typeof why !== "string" || why.trim().length < 12)
  .map(([k]) => k);
if (unreasoned.length > 0) {
  console.error(
    `ipc-binding-callers: ${unreasoned.length} recorded exemption(s) carry no reason:\n  ${unreasoned.join("\n  ")}`,
  );
  process.exit(1);
}

const news = dead.filter((d) => !(d in exempt));
// The ratchet's other direction: an exemption whose binding now HAS a caller is
// stale, and a stale exemption is a licence nobody re-argued.
const stale = Object.keys(exempt).filter((k) => !dead.includes(k));

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
  `ipc-binding-callers: ok (${checked} binding(s) across ${bindingFiles.length} module(s); ${Object.keys(exempt).length} recorded exemption(s))`,
);
