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
// `docs/decisions/ai/0515` rested its "nothing survives a lock" claim on the
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
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

/** Where a vault session ends, and what the function is called there.
 *
 * **The CHOKE POINT, not its callers, and that correction is the whole lesson.**
 * The first version listed two callers and its own roster entry for
 * `clearAgentForLock` read "Every leaving path", so it reported ok while two
 * further paths locked the vault without clearing: the StorageLost takeover and
 * the invalid-state fail-closed CTA. A guard keyed on an enumeration of callers
 * is a guard that is wrong the moment a fifth caller appears, and it says ok
 * while being wrong, which is worse than not existing.
 *
 * `lockVault` is the one function every one of those paths goes through, so
 * asserting the teardown there is an assertion about all of them, including the
 * ones nobody has written yet. `leaveActiveVault` stays on the roster for the
 * store whose reason is a vault CHANGE rather than a lock, which `lockVault`
 * cannot speak for. */
export const LEAVING_PATHS = [
  {
    id: "desktop-lock",
    file: "src/lib/vault-unlock.ts",
    fn: "lockVault",
    why: "The frontend lock choke point. Every path that ends a vault session calls it: the Lock button, the vault switch, the StorageLost takeover and the invalid-state fail-closed CTA.",
  },
  {
    id: "mobile-lock",
    file: "mobile/src/lib/vault-unlock.ts",
    fn: "lockVault",
    why: "Mobile's own lock choke point: its Lock button, its idle auto-lock and its vault switch all funnel here (`mobile/src/lib/vault-switch.ts` routes through it). It was outside this roster while mobile compiles the SAME `@myne/editor` attachment code and wires a real `attachments` host, so the shared caches filled on mobile and nothing cleared them. That is the twin-drift shape myne#454 already cost this project once, on the Rust side of the same question.",
  },
  {
    id: "desktop-switch",
    file: "src/lib/vault-switch.ts",
    fn: "leaveActiveVault",
    why: "Vault CHANGE specifically, which is a superset of a lock: it is the only path where the next thing opened is a different vault.",
  },
  {
    id: "desktop-delete",
    file: "src/lib/vault-delete.ts",
    fn: "deleteVault",
    why: "The one desktop leaving path that reaches NEITHER of the two above, and the sharpest of the three: the vault it leaves no longer exists, so nothing will ever republish over what a store kept. Added by myne-md/myne#609 after a reviewer traced it; every store on this roster had been asserted on two paths and was resident after the third.",
  },
  {
    id: "mobile-delete",
    file: "mobile/src/lib/vault-delete.ts",
    fn: "deleteVault",
    why: "Mobile's delete, which bypasses `lockVault` exactly as desktop's bypasses both of its chokepoints. Worse here than on desktop: the stage leaves the editor without advancing the prefs nonce, so mobile's publisher never re-reads and the erased vault's values stay resident for the rest of the process.",
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
/** Three skip reasons the roster states once, because each is the SAME fact
 * about a whole class of stores and a hand-copy per entry is a second place to
 * drift. Each is length-checked by `analyse` exactly as an inline reason is. */
const SKIP_DESKTOP_ONLY =
  "the store is DESKTOP-only (it lives under `src/notes/`, which mobile does not compile), so there is nothing on this client to clear. Verified by searching the mobile tree for the symbol rather than assumed from the path. Stated rather than left silent: the two mobile paths joined this roster in myne-md/myne#609, and a skip with no reason is exactly what this guard length-checks for.";

const SKIP_ERASED =
  "the vault is being ERASED, and this store describes that vault's CONTENT, which is going away with it. The display store is the one entry asserted on the delete paths instead, because what it holds describes the READER (their formats and their zone) and therefore outlives the vault.";

const SKIP_NO_SPELL_LAYER =
  "mobile compiles `editor/src` and therefore does hold this store, but it runs no spell layer: there is no `spell_enabled` surface and no dictionary plugin under `mobile/src`, so nothing on this client ever puts a word in the set. If a mobile spell surface lands, this skip is what should fail first.";

export const TEARDOWN_CALLS = [
  {
    call: "clearAgentForLock",
    declaredIn: "src/notes/agent/agentStore.ts",
    holds: "the agent run's proposal: anchors and replacements copied verbatim out of note bodies",
    // Every leaving path. Note plaintext may not outlive the unlocked session,
    // and `docs/decisions/ai/0515` rests its no-blob-family argument on that.
    // Asserted at the choke point, which covers every caller including future
    // ones. Also asserted on the switch, because that path is reached through
    // `leaveActiveVault` and a later refactor could stop routing it through
    // `lockVault` without anything noticing.
    appliesTo: ["desktop-lock", "desktop-switch"],
    skips: {
      "mobile-lock": SKIP_DESKTOP_ONLY,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
    },
  },
  {
    call: "resetDateTimeDisplayForLock",
    declaredIn: "editor/src/host/lib/datetimeFormat.ts",
    holds:
      "the reader's date format, time format and TIME ZONE, all derived from decrypted vault.prefs",
    // Every leaving path, and the ONLY entry here that is asserted on the two
    // delete paths. The zone is what puts it on the roster rather than the
    // formats: it is a coarse-location datum that every other layer keeps per
    // vault, and `dialect/src/taskFields.ts` keeps it out of note bytes for that
    // reason. The store is module scope in a SHARED package, read by every
    // surface that prints a date, and nothing in production returned it to
    // defaults, so after one unlock the previous vault's zone stayed resident
    // through a lock and into the next session until that vault's publisher
    // happened to overwrite it (myne-md/myne#609, found by review).
    //
    // Asserted on the delete paths because what it holds describes the READER
    // rather than the vault: erasing the vault erases the source of the value,
    // never the value, and no publisher will ever overwrite it again.
    appliesTo: [
      "desktop-lock",
      "desktop-switch",
      "desktop-delete",
      "mobile-lock",
      "mobile-delete",
    ],
    skips: {},
  },
  {
    call: "clearChat",
    declaredIn: "src/notes/ai/chatStore.ts",
    holds: "the AI chat transcript: the user's own questions about their notes and the model's answers over them",
    // Every leaving path, for the same reason as the run's proposal above.
    // It had NO entry here and no call on either path: the only thing clearing
    // it was the Editor's own unmount cleanup, which does fire on a lock today
    // and is a rendering fact rather than a guarantee. A refactor that keeps
    // the Editor mounted across a lock would carry one vault's conversation
    // into the next session, and nothing would say so.
    // `docs/decisions/ai/0276` rests its "no new at-rest magic byte, KEK or
    // format" argument on this transcript being RAM-only and dropped on lock.
    appliesTo: ["desktop-lock", "desktop-switch"],
    skips: {
      "mobile-lock": SKIP_DESKTOP_ONLY,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
    },
  },
  {
    call: "clearAiOutput",
    declaredIn: "src/notes/ai/aiOutputStore.ts",
    holds: "the rendered AI output: a summary of a note, and every Q and A answer over note content that src/lib/ai-qa.ts routes through this same store",
    // Every leaving path, and it was left on the OLD teardown when `clearChat`
    // moved onto these two. It sits one line above `clearChat` in the same
    // Editor unmount effect and had no entry here, so this roster reported ok
    // about it by never naming it. The argument for moving `clearChat` is the
    // argument for this one, unchanged: the Editor unmount does fire on a lock
    // today and is a rendering fact rather than a guarantee, and the store's
    // own header calls its contents an AS1-class RAM artifact dropped on lock.
    //
    // The note-SWITCH call in the Editor stays where it is. That one is about a
    // different event (note A's summary must not be insertable into note B) and
    // neither leaving path can speak for it.
    appliesTo: ["desktop-lock", "desktop-switch"],
    skips: {
      "mobile-lock": SKIP_DESKTOP_ONLY,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
    },
  },
  {
    call: "resetScrollMemory",
    declaredIn: "src/notes/scrollMemory.ts",
    holds: "the per-note scroll positions: which notes this vault has and how far into each one the user had read",
    // Every leaving path. Weaker than the four above (it holds no note text,
    // only note ids and offsets) and on the roster for the reason the roster
    // exists: it is a module-scope map, no leaving path reloads the WebView,
    // and the decision behind myne-md/myne#600 is memory that lasts the
    // SESSION, which a lock ends. Its own reset function shipped with zero
    // callers, which is how it earned an entry rather than a comment.
    appliesTo: ["desktop-lock", "desktop-switch"],
    skips: {
      "mobile-lock": SKIP_DESKTOP_ONLY,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
    },
  },
  {
    call: "resetRecentNotes",
    declaredIn: "src/notes/recentNotes.ts",
    holds: "the wikilink picker's recency order: the ids of the notes this vault opened, most recent first",
    // Every leaving path, same category and same shape as the scroll map above.
    // The next vault's ids do not collide with these, so nothing would be
    // mis-RANKED; what the call is for is the list not outliving the session
    // that produced it (myne-md/myne#601).
    appliesTo: ["desktop-lock", "desktop-switch"],
    skips: {
      "mobile-lock": SKIP_DESKTOP_ONLY,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
    },
  },
  {
    call: "resetDecodedAspects",
    declaredIn: "editor/src/attachments/decoded-aspect.ts",
    holds: "the decoded shape of every image this vault has rendered, keyed by attachment id",
    // Every leaving path. It shipped in review with NO production caller and a
    // comment arguing it off this roster, on the grounds that an aspect ratio is
    // neither note content nor a vault's shape. The second half was wrong, and
    // the two entries above are what refute it: the scroll map holds note ids
    // and two numbers, the recency order holds note ids alone, and both are here
    // because they are a live record of what the vault contains. An
    // attachment-id key whose value is derived from decrypted content is that,
    // in the same sense. The cost of clearing it is one first-paint settle after
    // a re-unlock, which is the thing the cache exists to avoid and not the
    // thing it is worth keeping a locked vault's roster in memory for.
    appliesTo: ["desktop-lock", "desktop-switch", "mobile-lock"],
    skips: {
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
    },
  },
  {
    call: "resetPreviewCache",
    declaredIn: "editor/src/attachments/session-caches.ts",
    holds: "up to 24 decrypted attachment previews, each capped at the host's 2 MiB read cap, plus the reads still in flight for them",
    // Every leaving path, and this one holds the decrypted CONTENT rather than a
    // shape derived from it, so it is the stronger case of the entry above. It
    // sat unlisted while `resetDecodedAspects` was argued onto the roster from
    // the same file, which is the false-exhaustiveness shape the root CLAUDE.md
    // records for the `itemsKey-wrap` row: a roster that reads complete while
    // the larger store beside it is missing. The in-flight map is cleared with
    // the cache so a read crossing a lock cannot resolve into the next
    // session's entries.
    appliesTo: ["desktop-lock", "desktop-switch", "mobile-lock"],
    skips: {
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
    },
  },
  {
    call: "resetTranscripts",
    declaredIn: "editor/src/attachments/session-caches.ts",
    holds: "the text of every completed voice-note transcription this session produced",
    // Every leaving path. Its own comment used to argue it off this roster by
    // asserting the module unloads on lock, and that premise is false: a JS
    // module never unloads, the idle auto-lock path reloads the WebView but the
    // manual Lock button and the vault switch do not. `docs/threat-model.md`
    // AS7 classes this surface as AS1-class in-RAM plaintext whose exposure is
    // "not widened" beyond A6/A7/A10, and carrying it into a DIFFERENT vault's
    // session is wider than that.
    appliesTo: ["desktop-lock", "desktop-switch", "mobile-lock"],
    skips: {
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
    },
  },
  {
    call: "resetSessionIgnored",
    declaredIn: "editor/src/decorations/spell.ts",
    holds: "the session's ignored-word set, which is vault-scoped user vocabulary",
    appliesTo: ["desktop-switch"],
    skips: {
      "desktop-lock":
        "A plain lock does not change vault, and the ignore-this-session set is scoped to the session the user is still in. Clearing it at the lock choke point would discard a choice they made about the vault they are about to re-open. The store's own comment states the reason as a vault CHANGE, which is why this one is asserted on the switch path only.",
      "mobile-lock": SKIP_NO_SPELL_LAYER,
      "mobile-delete": SKIP_NO_SPELL_LAYER,
      "desktop-delete": SKIP_ERASED,
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
export function bodyOf(src, at) {
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

/** Every failure the two rosters imply, given the whole world as an argument.
 *
 * `files` is a `{path → source}` record standing in for the tree, on the rule
 * `check-mobile-export-backup.mjs`'s `analyse(io)` follows: the half of a guard
 * worth testing is its decision, and a decision that reads the disk can only be
 * tested by mutating the real tree, which leaves a `git restore` to forget.
 * `tests/scripts/ipcBindingCallers.test.ts` injects each defect class below as a
 * synthetic file set instead, so every case runs on every commit.
 *
 * A path absent from `files` is an absent FILE, which is itself one of the
 * failures (a roster that has outlived its subject is worse than no roster).
 * Returns the messages rather than printing them, so a test can assert WHICH
 * defect was named rather than only that something failed. */
export function analyse({ files, leavingPaths, teardownCalls }) {
  const errors = [];

  // Every leaving path carries a unique id, because the id is the key both
  // `appliesTo` and `skips` are read by. A missing one turns every lookup on
  // that path into `undefined` (so every store reports "gives no reason"), and
  // a duplicated one lets two paths share a verdict without saying so.
  const seenIds = new Set();
  for (const path of leavingPaths) {
    if (typeof path.id !== "string" || path.id.length === 0) {
      errors.push(`${path.file}::${path.fn} has no id (the roster is keyed by id)`);
      continue;
    }
    if (seenIds.has(path.id)) {
      errors.push(`two leaving paths share the id ${path.id}`);
    }
    seenIds.add(path.id);
  }

  // A roster that has outlived its subject is worse than no roster.
  for (const { call, declaredIn } of teardownCalls) {
    const src = files[declaredIn];
    if (src === undefined) {
      errors.push(`${declaredIn} does not exist (roster is stale)`);
      continue;
    }
    if (!new RegExp(`\\b(export\\s+function|export\\s+const)\\s+${call}\\b`).test(src)) {
      errors.push(`${declaredIn} no longer exports ${call} (roster is stale)`);
    }
  }

  for (const path of leavingPaths) {
    const src = files[path.file];
    if (src === undefined) {
      errors.push(`${path.file} does not exist (roster is stale)`);
      continue;
    }
    const decl = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?(?:function\\s+${path.fn}\\b|const\\s+${path.fn}\\s*=)`,
    );
    const at = src.search(decl);
    if (at < 0) {
      errors.push(`${path.file} no longer declares ${path.fn} (roster is stale)`);
      continue;
    }
    const body = bodyOf(src, at);
    if (body === null) {
      errors.push(`could not extract ${path.fn}'s body in ${path.file}`);
      continue;
    }
    // Over-capture would make this guard pass by swallowing a SIBLING function
    // that does call the teardown, which is a false green rather than a false
    // red. Assert the extraction did not run past its own function.
    if (/\n(?:export\s+)?(?:async\s+)?function\s/.test(body)) {
      errors.push(`${path.fn}'s extracted body in ${path.file} spans another function`);
      continue;
    }
    // Keyed on the path's `id`, never on its `fn`. Two clients name their choke
    // point `lockVault` and both name their delete `deleteVault`, so a bare
    // name is the same conflation `check-ipc-binding-callers.mjs` was corrected
    // for one guard over: with it, mobile's `lockVault` was required to call
    // the DESKTOP-only stores, and a mobile skip could not be written at all
    // (myne-md/myne#609, found when the mobile paths joined the roster).
    //
    // An `id` is hand-assigned, so it can drift from the file it labels in a
    // way a derived `<file>::<fn>` key cannot. That is why `idErrors` below
    // runs FIRST: a missing or duplicated id is what the drift looks like, and
    // a duplicate is the shape that would silently answer one path's assertion
    // with another path's roster row.
    for (const t of teardownCalls) {
      if (!t.appliesTo.includes(path.id)) {
        // A skip needs a stated reason, on the same rule the exemption list in
        // the sibling guard follows: a silent absence is indistinguishable from
        // an oversight.
        const why = t.skips?.[path.id];
        if (typeof why !== "string" || why.trim().length < 20) {
          errors.push(`${t.call} does not apply to ${path.id} and gives no reason`);
        }
        continue;
      }
      if (!new RegExp(`\\b${t.call}\\s*\\(`).test(body)) {
        errors.push(
          `${path.file}::${path.fn} does not call ${t.call}()\n` +
            `  That path ends a vault session (${path.why})\n` +
            `  and ${t.call} drops ${t.holds}.\n` +
            `  Module-scope state survives an unmount, and neither a lock nor a switch reloads the WebView.`,
        );
      }
    }
  }
  return errors;
}

/** The tree as `analyse` wants it: every rostered path, present ones only. */
function rosterFiles() {
  const files = {};
  for (const rel of [
    ...TEARDOWN_CALLS.map((t) => t.declaredIn),
    ...LEAVING_PATHS.map((p) => p.file),
  ]) {
    const p = join(ROOT, rel);
    if (existsSync(p)) files[rel] = readFileSync(p, "utf8");
  }
  return files;
}

// Run the check only when this file IS the command, the shape
// `check-mobile-export-backup.mjs` already uses. Without it, importing
// `analyse` or a roster to test it runs the whole check as a side effect, and a
// real failure calls `process.exit(1)` from inside the test runner: the suite
// dies mid-file with a bare exit code instead of reporting a failing test, and
// the guard's own message scrolls past as stray stdout.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const errors = analyse({
    files: rosterFiles(),
    leavingPaths: LEAVING_PATHS,
    teardownCalls: TEARDOWN_CALLS,
  });

  if (errors.length > 0) {
    for (const e of errors) console.error(`frontend-lock-teardown: ${e}`);
    process.exit(1);
  }
  const asserted = TEARDOWN_CALLS.reduce((n, t) => n + t.appliesTo.length, 0);
  const skipped = TEARDOWN_CALLS.reduce(
    (n, t) => n + Object.keys(t.skips ?? {}).length,
    0,
  );
  console.log(
    `frontend-lock-teardown: ok (${LEAVING_PATHS.length} leaving path(s), ${asserted} call(s) asserted, ${skipped} reasoned skip(s))`,
  );
}
