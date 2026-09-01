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
// BOTH TAURI CLIENTS, since myne-md/myne#456. The guard used to walk desktop's
// two leaving paths alone, and that was a blind spot rather than a scope:
// mobile holds the SAME note-derived plaintext in the SAME module-scope store
// (`@myne/agent-store` is one module, aliased into both trees), reached through
// its own lock path, and a roster naming only `src/lib/` reported ok over it
// without ever opening the file. That is the shape `check-prefs-nonce.mjs`
// shipped for months and the reason `scripts/lib/shared-roots.mjs` exists.
//
// Mobile contributes TWO paths and neither mirrors a desktop one. Its vault
// switch calls `lockVault` (`AppShell.tsx` awaits it before dispatching
// `editor.switch-vault`), so there is no `leaveActiveVault` to name and the
// switch is covered by the lock. And it has BACKGROUNDING, which desktop has no
// analogue of: the OS suspends a backgrounded WebView and may reclaim the
// process, so an in-flight run's reply can never arrive and the store would
// hold note text across a suspension with nothing left to settle it.
//
// PATHS ARE KEYED BY `id`, NOT BY FUNCTION NAME, and that changed with the same
// issue. Both clients call their choke point `lockVault`, so a roster keyed on
// the name cannot tell them apart: `appliesTo: ["lockVault"]` would silently
// mean both, and a skip for one would excuse the other. The collision is exactly
// the kind this guard exists to catch, so it is not left to a comment.
//
// A PATH MAY REACH A TEARDOWN THROUGH A NAMED WRAPPER, and the guard then
// checks BOTH hops rather than one. Mobile's two paths call `endAgentRun`,
// which cancels the host-side run and then clears the store: the cancel and the
// clear belong together (a cleared store with a run still spending on a
// provider is the worse half of the failure), and writing them at each call
// site would be two places to get the pair wrong. A `via` entry names the
// wrapper, and the guard asserts the path calls the wrapper AND that the
// wrapper calls the real teardown. Accepting the wrapper without the second hop
// would let an empty function satisfy this guard, which is the exact shape
// `scripts/check-lock-teardown.mjs` exists to catch on the Rust side.
//
// **Hop two reads the wrapper's BODY, not its file**, and the first version did
// the latter. A file-wide grep passes as soon as any sibling function in that
// file calls the teardown, so an empty wrapper beside a live one satisfied it:
// the defect the hop exists for, surviving the hop. It held only because the
// real wrapper file contained one function.
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
    why: "The desktop lock choke point. Every path that ends a vault session calls it: the Lock button, the vault switch, the StorageLost takeover and the invalid-state fail-closed CTA.",
  },
  {
    id: "desktop-switch",
    file: "src/lib/vault-switch.ts",
    fn: "leaveActiveVault",
    why: "Vault CHANGE specifically, which is a superset of a lock: it is the only path where the next thing opened is a different vault.",
  },
  {
    id: "mobile-lock",
    file: "mobile/src/lib/vault-unlock.ts",
    fn: "lockVault",
    why: "Mobile's SINGLE choke point (myne-md/myne#456): the Lock button, the idle auto-lock and the vault switch all route through it, so a store whose reason is a vault CHANGE has to hang off this one.",
  },
  {
    id: "mobile-background",
    file: "mobile/src/app/flows/EditorFlow.tsx",
    fn: "flushAll",
    why: "Backgrounding, which desktop has no analogue of. This is the ONE listener pair for that moment (`visibilitychange` -> hidden, plus `pagehide`), named so a second registration cannot become a second way to get it wrong.",
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
export const TEARDOWN_CALLS = [
  {
    call: "clearAgentForLock",
    declaredIn: "src/notes/agent/agentStore.ts",
    holds: "the agent run's proposal: anchors and replacements copied verbatim out of note bodies",
    // Every leaving path. Note plaintext may not outlive the unlocked session,
    // and `design-notes/ai/0515` rests its no-blob-family argument on that.
    // Asserted at the choke point, which covers every caller including future
    // ones. Also asserted on the switch, because that path is reached through
    // `leaveActiveVault` and a later refactor could stop routing it through
    // `lockVault` without anything noticing.
    // And BOTH mobile paths. It is the same module on both clients
    // (`@myne/agent-store` aliases into mobile), so the plaintext at risk is not
    // an analogue of desktop's, it IS desktop's. Mobile reaches it through
    // `endAgentRun`, which calls this and cancels the host-side run.
    appliesTo: [
      "desktop-lock",
      "desktop-switch",
      "mobile-lock",
      "mobile-background",
    ],
    skips: {},
    // Both mobile paths reach it through one wrapper, which also cancels the
    // host-side run. Both hops are checked; see the header.
    via: {
      "mobile-lock": { fn: "endAgentRun", file: "mobile/src/lib/agent-lifetime.ts" },
      "mobile-background": { fn: "endAgentRun", file: "mobile/src/lib/agent-lifetime.ts" },
    },
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
    // `design-notes/ai/0276` rests its "no new at-rest magic byte, KEK or
    // format" argument on this transcript being RAM-only and dropped on lock.
    appliesTo: ["desktop-lock", "desktop-switch"],
    skips: {
      "mobile-lock":
        "Mobile ships no chat TRANSCRIPT at all. Its AI surface is one composer and one run (`design-notes/ai/0524`), so `chatStore` has no mobile importer and a call here would be a line the guard checks and nothing runs. The note-derived half of a mobile run is the PROPOSAL, and `clearAgentForLock` above covers it on both mobile paths.",
      "mobile-background":
        "Mobile ships no chat TRANSCRIPT at all. Its AI surface is one composer and one run (`design-notes/ai/0524`), so `chatStore` has no mobile importer and a call here would be a line the guard checks and nothing runs. The note-derived half of a mobile run is the PROPOSAL, and `clearAgentForLock` above covers it on both mobile paths.",
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
      "mobile-lock":
        "Same as `clearChat`: `aiOutputStore` backs desktop's summary pane and its Q-and-A answers, and mobile renders neither. Nothing on mobile writes to it, so there is nothing there to outlive a lock or a suspension.",
      "mobile-background":
        "Same as `clearChat`: `aiOutputStore` backs desktop's summary pane and its Q-and-A answers, and mobile renders neither. Nothing on mobile writes to it, so there is nothing there to outlive a lock or a suspension.",
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
      "mobile-lock":
        "On mobile a vault CHANGE and a plain lock are the same call, so there is no path here that means change without also meaning lock. Clearing on either would discard a choice the user made about the vault they are about to re-open, which is exactly the reason the desktop entry skips its own lock path. Backgrounding is not a vault change either: the same session resumes.",
      "mobile-background":
        "On mobile a vault CHANGE and a plain lock are the same call, so there is no path here that means change without also meaning lock. Clearing on either would discard a choice the user made about the vault they are about to re-open, which is exactly the reason the desktop entry skips its own lock path. Backgrounding is not a vault change either: the same session resumes.",
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
      "mobile-lock":
        "Mobile has its own tree and does not import this store: it lives under `src/notes/` (or the desktop editor's own decorations) and nothing under `mobile/src` reaches it, so asserting the call there would demand a clear for something that is never populated. Verified by searching the mobile tree for the symbol rather than assumed from the path.",
      "mobile-background":
        "the store is DESKTOP-only (it lives under `src/notes/`, which mobile does not compile), so there is nothing on this client to clear on either mobile path. Stated rather than left silent: this path joined the roster in myne-md/myne#456 and a skip with no reason is what this guard length-checks for.",
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
      "mobile-lock":
        "Mobile has its own tree and does not import this store: it lives under `src/notes/` (or the desktop editor's own decorations) and nothing under `mobile/src` reaches it, so asserting the call there would demand a clear for something that is never populated. Verified by searching the mobile tree for the symbol rather than assumed from the path.",
      "mobile-background":
        "the store is DESKTOP-only (it lives under `src/notes/`, which mobile does not compile), so there is nothing on this client to clear on either mobile path. Stated rather than left silent: this path joined the roster in myne-md/myne#456 and a skip with no reason is what this guard length-checks for.",
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
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing a shared attachment cache here would cost a re-decrypt on resume while protecting nothing the lock path does not already protect. What backgrounding owes is a FLUSH of unsaved state, which is why `flushAll` is the function on the roster, and mobile's idle auto-lock reaches `lockVault` when the timer fires.",
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
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing a shared attachment cache here would cost a re-decrypt on resume while protecting nothing the lock path does not already protect. What backgrounding owes is a FLUSH of unsaved state, which is why `flushAll` is the function on the roster, and mobile's idle auto-lock reaches `lockVault` when the timer fires.",
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
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing a shared attachment cache here would cost a re-decrypt on resume while protecting nothing the lock path does not already protect. What backgrounding owes is a FLUSH of unsaved state, which is why `flushAll` is the function on the roster, and mobile's idle auto-lock reaches `lockVault` when the timer fires.",
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
  //
  // **A THIRD shape was missing and failed SILENTLY**, which is the worst way
  // for this function to be wrong: `f(...): void {`. The rule above wants the
  // character before the brace to be `)` or `>`, and a `void` return annotation
  // ends in a letter, so the scan walked past the real body and returned the
  // first INNER block whose brace happened to follow a `)`, here an
  // `if (...) {`. Every assertion then ran against a fragment of the function,
  // and `mobile/src/lib/agent-lifetime.ts::endAgentRun` was reported as never
  // calling a teardown it calls on its first line. Found by the /simplify pass
  // on myne-md/myne#456, tightening hop two from file scope to body scope.
  //
  // So the test is now: the brace is the body's when the declaration's own
  // parameter parens have CLOSED before it, or when it directly follows `)` or
  // `>` (which is what keeps the `useCallback(async () => {` shape working,
  // where the parens are still open at the arrow's brace).
  let bStart = -1;
  let depth = 0;
  let closed = false;
  for (let k = at; k < src.length; k += 1) {
    const c = src[k];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) closed = true;
    } else if (c === "{") {
      let b = k - 1;
      while (b >= 0 && /\s/.test(src[b])) b -= 1;
      const afterParenOrArrow = b >= 0 && (src[b] === ")" || src[b] === ">");
      if (afterParenOrArrow || (closed && depth === 0)) {
        bStart = k;
        break;
      }
    }
  }
  if (bStart < 0) return null;
  let braces = 0;
  for (let j = bStart; j < src.length; j += 1) {
    if (src[j] === "{") braces += 1;
    else if (src[j] === "}") {
      braces -= 1;
      if (braces === 0) return src.slice(bStart, j + 1);
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
      // Hop one: the path calls either the teardown itself or its declared
      // wrapper for this path.
      const hop = t.via?.[path.id];
      const expected = hop?.fn ?? t.call;
      if (!new RegExp(`\\b${expected}\\s*\\(`).test(body)) {
        errors.push(
          `${path.file}::${path.fn} does not call ${expected}()\n` +
            `  That path ends a vault session (${path.why})\n` +
            `  and ${t.call} drops ${t.holds}.\n` +
            `  Module-scope state survives an unmount, and neither a lock nor a switch reloads the WebView.`,
        );
        continue;
      }
      // Hop two, and it is the half that stops an EMPTY wrapper passing. A
      // wrapper the path calls but that clears nothing satisfies hop one and is
      // exactly the defect `check-lock-teardown.mjs` was written for.
      if (hop !== undefined) {
        const wrapperSrc = files[hop.file];
        if (wrapperSrc === undefined) {
          errors.push(`${hop.file} does not exist (via entry for ${path.id} is stale)`);
          continue;
        }
        // **Scoped to the WRAPPER'S OWN BODY, not to its file**, and the
        // difference is the whole of what hop two buys. A file-wide grep passes
        // the moment any sibling in that file calls the teardown, so an EMPTY
        // wrapper beside a live one satisfies it: exactly the defect this hop
        // was added to catch, surviving the hop. The real
        // `mobile/src/lib/agent-lifetime.ts` held one function, so the property
        // held by accident of file size rather than by the check. Found by the
        // /simplify altitude pass on myne-md/myne#456 and confirmed by
        // injection.
        const at = wrapperSrc.search(
          new RegExp(
            `(?:export\\s+)?(?:async\\s+)?(?:function\\s+${hop.fn}\\b|const\\s+${hop.fn}\\s*=)`,
          ),
        );
        if (at < 0) {
          errors.push(`${hop.file} no longer declares ${hop.fn} (via entry for ${path.id} is stale)`);
          continue;
        }
        const wrapperBody = bodyOf(wrapperSrc, at);
        if (wrapperBody === null) {
          errors.push(`could not extract ${hop.fn}'s body in ${hop.file}`);
        } else if (!new RegExp(`\\b${t.call}\\s*\\(`).test(wrapperBody)) {
          errors.push(
            `${hop.file} declares ${hop.fn}, which ${path.id} relies on, but never calls ${t.call}()\n` +
              `  A wrapper that clears nothing satisfies the call site and drops none of ${t.holds}.`,
          );
        }
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
    ...TEARDOWN_CALLS.flatMap((t) => Object.values(t.via ?? {}).map((v) => v.file)),
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
