#!/usr/bin/env node
// Every path that LEAVES a vault clears every module-scope vault-derived store.
//
// THE FAILURE THIS PREVENTS. A store held at module scope outlives everything
// React unmounts. Locking or switching a vault does not reload the WebView on
// the desktop client, so whatever such a store holds is still resident in the
// next session, including the next VAULT's session. When what it holds is
// note-derived plaintext, that is a documented guarantee going quietly false.
//
// `scripts/check-lock-teardown.mjs` already holds the RUST side of this: a
// client that keeps a plaintext-derived host state may not leave its teardown
// hook body empty. This is the WebView half, and it had no guard at all. The
// asymmetry cost myne-md/myne#529 a real miss: `clearAgentForLock()` was
// written, documented as "the lock and vault-switch variant", and wired to the
// two Editor lock paths and NOT to `leaveActiveVault`, which is the switch. The
// agent's proposal, whose anchors and replacements are text copied verbatim out
// of note bodies, therefore survived a vault switch into the next vault, while
// `design-notes/ai/0515` rested its "nothing survives a lock" claim on the
// opposite.
//
// WHAT IT CHECKS, and why it is keyed this way. Two hand-maintained rosters,
// because both halves are judgement calls a scan cannot make:
//
//   * LEAVING_PATHS: the functions that end a vault session. There are few and
//     they change rarely; a new one is a decision, and this guard failing by
//     name is how that decision gets noticed.
//   * TEARDOWN_CALLS: the clear-on-leave function each vault-derived store
//     exposes. Named rather than derived, for the same reason
//     `check-prefs-nonce.mjs` keeps its module list named: deriving membership
//     from a declaration would let any store license itself out of the rule.
//
// It asserts the cross product. A path missing ONE call fails by naming both
// the path and the call, because "some teardown happens here" is exactly the
// state that makes this class invisible.
//
// It also fails when a roster entry no longer exists in the tree, so a rename
// cannot leave the guard checking a function nobody calls any more. A guard
// whose subject has moved is a guard reporting ok about nothing.
//
// USAGE
//   node scripts/check-frontend-lock-teardown.mjs

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

/** Where a vault session ends, and what the function is called there. */
const LEAVING_PATHS = [
  {
    file: "src/lib/vault-switch.ts",
    fn: "leaveActiveVault",
    why: "Vault switch and the device-join door both route through it. It locks the active vault, so the host tears its half down; this is the WebView half.",
  },
  {
    file: "src/screens/Editor.tsx",
    fn: "handleLockFlushed",
    why: "The Lock button's flush-then-lock handler. The user-initiated lock that keeps the page alive.",
  },
];

/** The clear-on-leave call each module-scope vault-derived store exposes.
 *
 * **`appliesTo` is per store, not a cross product, and that asymmetry is the
 * point.** The first version of this guard asserted every call on every path
 * and immediately reported a failure that was not one: `resetSessionIgnored`
 * exists so a prior vault's "ignore this session" words do not suppress
 * squiggles in the TARGET vault, which is a statement about a vault CHANGE. On
 * a plain lock and re-unlock of the same vault the session legitimately
 * continues. Flattening that would have taught the reader to add a call whose
 * own comment argues against it, which is worse than no guard.
 *
 * A store that applies to fewer paths says which, and says why for each one it
 * skips. The reason is the load-bearing field: it is what a later reader checks
 * when the store's contents change. */
const TEARDOWN_CALLS = [
  {
    call: "clearAgentForLock",
    declaredIn: "src/notes/agent/agentStore.ts",
    holds: "the agent run's proposal: anchors and replacements copied verbatim out of note bodies",
    // Every leaving path. Note plaintext may not outlive the unlocked session,
    // and `design-notes/ai/0515` rests its no-blob-family argument on that.
    appliesTo: ["leaveActiveVault", "handleLockFlushed"],
    skips: {},
  },
  {
    call: "resetSessionIgnored",
    declaredIn: "editor/src/decorations/spell.ts",
    holds: "the session's ignored-word set, which is vault-scoped user vocabulary",
    appliesTo: ["leaveActiveVault"],
    skips: {
      handleLockFlushed:
        "A plain lock does not change vault, and the ignore-this-session set is scoped to the session the user is still in. Clearing it here would discard a choice they made about the vault they are about to re-open. The store's own comment states the reason as a vault CHANGE.",
    },
  },
];

/** The balanced-brace body of the declaration starting at `at`, or `null`.
 *
 * **Not "up to the next `}` at column 0"**, which was the first version and was
 * wrong on the very first function it read: `leaveActiveVault` takes a
 * destructured object parameter whose closing brace sits at column 0, so the
 * extracted body was the SIGNATURE and every teardown call looked missing. The
 * guard reported two false failures on code that was already correct.
 *
 * Walks the parameter parens first, then the body braces. A brace inside a
 * string literal would still fool it; the two call sites here contain none, the
 * over-capture assertion at the call site bounds the damage, and a
 * comment-and-string-aware walk is the thing this repo has already been burned
 * by writing twice (root `CLAUDE.md`, the `'` problem in both directions). */
function bodyOf(src, at) {
  // The body's opening brace is the first `{` whose preceding non-whitespace
  // character is `)` or `>`. That covers all four shapes these files use:
  // `f(...) {`, `f(...): Promise<void> {`, `async () => {`, and the
  // `useCallback(async () => {` wrapper. It EXCLUDES a destructured parameter
  // (`deps: {`, preceded by `:`), which the first version took for the body,
  // and it excludes an object literal in a default value for the same reason.
  //
  // Walking the parameter parens instead was the second version, and it was
  // wrong on the arrow shape: the first `(` after a `const x = useCallback(`
  // declaration is `useCallback`'s own, so its match is the END of the whole
  // call and the brace found after it belongs to a later function.
  let bStart = -1;
  for (let k = src.indexOf("{", at); k >= 0; k = src.indexOf("{", k + 1)) {
    let b = k - 1;
    while (b >= 0 && /\s/.test(src[b])) b -= 1;
    if (b >= 0 && (src[b] === ")" || src[b] === ">")) {
      bStart = k;
      break;
    }
  }
  if (bStart < 0) return null;
  let depth = 0;
  for (let j = bStart; j < src.length; j += 1) {
    if (src[j] === "{") depth += 1;
    else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(bStart, j + 1);
    }
  }
  return null;
}

let failed = false;

// A roster that has outlived its subject is worse than no roster.
for (const { call, declaredIn } of TEARDOWN_CALLS) {
  const p = join(ROOT, declaredIn);
  if (!existsSync(p)) {
    console.error(`frontend-lock-teardown: ${declaredIn} does not exist (roster is stale)`);
    failed = true;
    continue;
  }
  if (!new RegExp(`\\b(export\\s+function|export\\s+const)\\s+${call}\\b`).test(readFileSync(p, "utf8"))) {
    console.error(
      `frontend-lock-teardown: ${declaredIn} no longer exports ${call} (roster is stale)`,
    );
    failed = true;
  }
}

for (const path of LEAVING_PATHS) {
  const p = join(ROOT, path.file);
  if (!existsSync(p)) {
    console.error(`frontend-lock-teardown: ${path.file} does not exist (roster is stale)`);
    failed = true;
    continue;
  }
  const src = readFileSync(p, "utf8");
  // The function's body: from its declaration to the next top-level `}` at
  // column 0, which is the shape every function in these files has. A text scan
  // rather than a parser, matching the other guards in this directory.
  const decl = new RegExp(
    `(?:export\\s+)?(?:async\\s+)?(?:function\\s+${path.fn}\\b|const\\s+${path.fn}\\s*=)`,
  );
  const at = src.search(decl);
  if (at < 0) {
    console.error(
      `frontend-lock-teardown: ${path.file} no longer declares ${path.fn} (roster is stale)`,
    );
    failed = true;
    continue;
  }
  const body = bodyOf(src, at);
  if (body === null) {
    console.error(
      `frontend-lock-teardown: could not extract ${path.fn}'s body in ${path.file}`,
    );
    failed = true;
    continue;
  }
  // Over-capture would make this guard pass by swallowing a SIBLING function
  // that does call the teardown, which is a false green rather than a false
  // red. Assert the extraction did not run past its own function.
  if (/\n(?:export\s+)?(?:async\s+)?function\s/.test(body)) {
    console.error(
      `frontend-lock-teardown: ${path.fn}'s extracted body in ${path.file} spans another function`,
    );
    failed = true;
    continue;
  }
  for (const t of TEARDOWN_CALLS) {
    if (!t.appliesTo.includes(path.fn)) {
      // A skip needs a stated reason, on the same rule the exemption list in
      // the sibling guard follows: a silent absence is indistinguishable from
      // an oversight.
      const why = t.skips?.[path.fn];
      if (typeof why !== "string" || why.trim().length < 20) {
        console.error(
          `frontend-lock-teardown: ${t.call} does not apply to ${path.fn} and gives no reason`,
        );
        failed = true;
      }
      continue;
    }
    if (!new RegExp(`\\b${t.call}\\s*\\(`).test(body)) {
      console.error(
        `frontend-lock-teardown: ${path.file}::${path.fn} does not call ${t.call}()\n` +
          `  That path ends a vault session (${path.why})\n` +
          `  and ${t.call} drops ${t.holds}.\n` +
          `  Module-scope state survives an unmount, and neither a lock nor a switch reloads the WebView.`,
      );
      failed = true;
    }
  }
}

if (failed) process.exit(1);
const asserted = TEARDOWN_CALLS.reduce((n, t) => n + t.appliesTo.length, 0);
const skipped = TEARDOWN_CALLS.reduce(
  (n, t) => n + Object.keys(t.skips ?? {}).length,
  0,
);
console.log(
  `frontend-lock-teardown: ok (${LEAVING_PATHS.length} leaving path(s), ${asserted} call(s) asserted, ${skipped} reasoned skip(s))`,
);
