#!/usr/bin/env node
// Web command-coverage guard (phase3-web-client task 11).
//
// # The hole this closes
//
// The shared UI reaches its backend through exactly one call shape,
// `invoke(cmd, args)`, and `src/` is compiled UNCHANGED for both clients. So
// every IPC command name that appears in the shared tree arrives at the web
// client's dispatcher — including the ones whose backend lives in `src-tauri/`
// and was never part of `myne-core` at all (`backup`, `spell`, `workspace`,
// `importer`, `clipper-pairing`, `pdf-export`, `local-inference`,
// `vault-repair`).
//
// Nothing in either compiler relates the two. The command name is a string on
// one side and a `match` arm on the other, so a command added to `src/` and
// never classified in `web/wasm/src/capability.rs` produces no diagnostic at
// all. Its runtime behaviour would be the terminal fallback — which is
// deliberately loud, so this guard is not what stops a *silent* failure. What it
// stops is the failure arriving in a **browser** instead of in `pre-commit`:
// without it, "which commands does the web client answer?" has no answer short
// of reading 180 call sites.
//
// # What it checks
//
// Every `plugin:<plugin>|<command>` literal in the shared tree resolves to
// exactly one of:
//
//   DISPATCHED     — an arm in the router
//   PLUGIN_DEFAULT — a whole-plugin classification
//   PER_COMMAND    — a per-command override
//
// A name matching none of them fails, naming the file it was found in. It also
// fails on a table entry for a plugin that no longer exists in the tree, since a
// stale classification is how a decision outlives the thing it decided.
//
// # Why a grep and not a test
//
// Same reason as `check-platform-seam.mjs` and `check-core-task-seam.mjs`: the
// property spans two languages, so no single compiler or test runner sees both
// halves. Zero dependencies, node built-ins only (root CLAUDE.md: adding a
// dependency is a security decision).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// The analysis is EXPORTED so `tests/web/command-coverage.test.ts` can assert
// the same property without a second implementation (phase3-web-client task 28).
//
// One implementation, two callers: this file as a pre-commit/CI script, and a
// vitest spec so the property also runs wherever `pnpm test` runs. Duplicating
// the logic into a test would have created exactly the drift this project keeps
// finding — two statements of one rule, disagreeing silently.

/**
 * Source trees compiled into BOTH clients. `web/` itself is excluded on
 * purpose — its own modules are web-only by definition, so a command name there
 * is not a shared-UI obligation.
 */
const SHARED_ROOTS = ["src", "editor/src", "dialect/src", "copy"];
const CAPABILITY_RS = join("web", "wasm", "src", "capability.rs");
const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git", "pkg"]);
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an optional root (e.g. `copy/`) that does not exist here
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry)) out.push(full);
  }
  return out;
}

// ── the inventory: every IPC command name the shared tree mentions ────────────
//
// Matched as a STRING LITERAL rather than by finding `invoke(` and reading its
// first argument. That was the first implementation and it under-counted: a call
// like `invoke<Record<string, string[]>>("plugin:…")` defeats any regex that
// tries to skip the generic, and the miss is silent. Scanning for the literal
// shape cannot miss one. It over-counts a name mentioned only in a comment,
// which is harmless — such a name is a real command and wants a classification
// anyway.
const NAME_PATTERN = /["'`](plugin:[a-z0-9-]+\|[a-z0-9_]+)["'`]/g;

/**
 * Run the whole analysis. Pure: reads the tree, returns findings, prints nothing
 * and exits nothing — so a test can assert on it and the CLI below can format it.
 */
export function analyse() {
  const inventory = new Map(); // name -> first file it was seen in
  for (const root of SHARED_ROOTS) {
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(NAME_PATTERN)) {
        if (!inventory.has(m[1])) inventory.set(m[1], relative(process.cwd(), file));
      }
    }
  }

  // ── the tables, read out of the Rust source ──────────────────────────────────
  //
  // Read rather than duplicated. A second copy of the classification in JS would
  // be the exact drift this script exists to detect, one level up.
  const rust = readFileSync(CAPABILITY_RS, "utf8");

  /**
   * The `= &[ … ]` VALUE body of a named const, or `null`.
   *
   * Anchored on `= &[` rather than on the first `[` after the name: a Rust slice
   * const spells its TYPE with brackets too (`DISPATCHED: &[&str] = &[…]`), so
   * taking the first bracket yields `&str` — the type — and every literal scan over
   * it comes back empty. Which is exactly the vacuous-pass the assertion below
   * catches, and how this bug was found.
   */
  function constBody(name) {
    const nameAt = rust.indexOf(`${name}: `);
    if (nameAt === -1) return null;
    const valueAt = rust.indexOf("= &[", nameAt);
    if (valueAt === -1) return null;
    const open = valueAt + "= &".length;
    let depth = 0;
    for (let i = open; i < rust.length; i++) {
      if (rust[i] === "[") depth++;
      else if (rust[i] === "]") {
        depth--;
        if (depth === 0) return rust.slice(open + 1, i);
      }
    }
    return null;
  }

  /**
   * String literals in a const body, ignoring comments.
   *
   * The comment strip is load-bearing, not tidiness. Every entry in these tables
   * carries a `//` comment citing the decision that justifies it, and those
   * comments quote the decision text — `// … "Absent on web: clipper"`. Scanning
   * the raw body therefore harvested prose fragments as if they were plugin names,
   * and the staleness check then reported a dozen phantom "stale entries".
   */
  function stringLiterals(body) {
    if (body === null) return [];
    const withoutComments = body
      .split("\n")
      .map((line) => {
        const at = line.indexOf("//");
        return at === -1 ? line : line.slice(0, at);
      })
      .join("\n");
    return [...withoutComments.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  const dispatched = new Set(stringLiterals(constBody("DISPATCHED")));
  // `PER_COMMAND` and `PLUGIN_DEFAULT` are `&[(&str, Class)]`, so the string
  // literals alternate with `Class::…` idents — taking every literal is enough,
  // since the class itself is not what this guard checks.
  const perCommand = new Set(stringLiterals(constBody("PER_COMMAND")));
  const pluginDefault = new Set(stringLiterals(constBody("PLUGIN_DEFAULT")));

  const problems = [];

  // A table that failed to parse would make every check below vacuously pass —
  // the classic failure of a source-scanning guard.
  if (dispatched.size === 0 || pluginDefault.size === 0) {
    problems.push(
      `could not read the classification tables out of ${CAPABILITY_RS} ` +
        `(DISPATCHED=${dispatched.size}, PLUGIN_DEFAULT=${pluginDefault.size}). ` +
        `If the const names or their \`&[…]\` shape changed, update this guard.`,
    );
  }
  if (inventory.size === 0) {
    problems.push(
      `found no IPC command names in ${SHARED_ROOTS.join(", ")} — the scan is broken, ` +
        `not the tree.`,
    );
  }

  const pluginOf = (name) => name.slice("plugin:".length).split("|")[0];

  // 1. Every name in the shared tree is classified.
  const unclassified = [];
  for (const [name, file] of inventory) {
    if (dispatched.has(name) || perCommand.has(name)) continue;
    if (pluginDefault.has(pluginOf(name))) continue;
    unclassified.push([name, file]);
  }

  // 2. No table entry refers to a plugin the tree no longer has.
  const livePlugins = new Set([...inventory.keys()].map(pluginOf));
  const stalePlugins = [...pluginDefault].filter((p) => !livePlugins.has(p));
  const staleCommands = [...perCommand, ...dispatched].filter((c) => !inventory.has(c));

  if (unclassified.length) {
    problems.push(
      `${unclassified.length} IPC command(s) in the shared tree have no web classification:\n` +
        unclassified.map(([n, f]) => `    ${n}\n        first seen: ${f}`).join("\n") +
        `\n\n  Classify each one in ${CAPABILITY_RS}:\n` +
        `    - a whole plugin absent on web  -> PLUGIN_DEFAULT, Class::Unsupported (cite the decision)\n` +
        `    - a port still owed             -> PLUGIN_DEFAULT, Class::Pending (name the task)\n` +
        `    - one command differing from its plugin -> PER_COMMAND\n` +
        `    - answered by the router now    -> DISPATCHED + a match arm\n\n` +
        `  Class::Unsupported is a PRODUCT DECISION, not a shortcut for "not written yet":\n` +
        `  task 27's capability descriptor makes an Unsupported affordance permanently\n` +
        `  ABSENT from the UI. Use Class::Pending unless a recorded decision says otherwise.`,
    );
  }

  if (stalePlugins.length || staleCommands.length) {
    problems.push(
      `stale entries in ${CAPABILITY_RS} — the shared tree no longer mentions these:\n` +
        [...stalePlugins.map((p) => `    plugin: ${p}`), ...staleCommands.map((c) => `    ${c}`)].join(
          "\n",
        ) +
        `\n\n  Remove them. A classification that outlives its command is a decision\n` +
        `  nobody can find the subject of.`,
    );
  }

  const pendingCount = [...inventory.keys()].filter((name) => {
    if (dispatched.has(name) || perCommand.has(name)) return false;
    return pluginDefault.has(pluginOf(name));
  }).length;

  return {
    problems,
    unclassified,
    stalePlugins,
    staleCommands,
    counts: {
      inventory: inventory.size,
      dispatched: dispatched.size,
      pending: pendingCount,
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//
// Only when invoked directly, so importing this module (from the vitest spec)
// neither prints nor exits.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, counts } = analyse();
  if (problems.length) {
    console.error("web command coverage:\n");
    for (const p of problems) console.error(`  ${p}\n`);
    process.exit(1);
  }
  console.log(
    `web command coverage: ok (${counts.inventory} IPC command(s) across ` +
      `${SHARED_ROOTS.filter((r) => walk(r).length).length} shared tree(s); ` +
      `${counts.dispatched} dispatched)`,
  );
  console.log(
    `  ${counts.pending} classified by plugin default — see PLUGIN_DEFAULT for which are ` +
      `Pending (a port owed) vs Unsupported (decided absent).`,
  );
}
