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
    id: "desktop-create",
    file: "src/App.tsx",
    fn: "onCreateAutoUnlockSuccess",
    why: "Direct first-vault creation and create-another completion are vault boundaries; the callback clears the WebView person session before publishing the new stage.",
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
/** Three skip reasons the roster states once, because each is the SAME fact
 * about a whole class of stores and a hand-copy per entry is a second place to
 * drift. Each is length-checked by `analyse` exactly as an inline reason is. */
const SKIP_DESKTOP_ONLY =
  "the store is DESKTOP-only (it lives under `src/notes/`, which mobile does not compile), so there is nothing on this client to clear. Verified by searching the mobile tree for the symbol rather than assumed from the path. Stated rather than left silent: the two mobile paths joined this roster in myne-md/myne#609, and a skip with no reason is exactly what this guard length-checks for.";

const SKIP_ERASED =
  "the vault is being ERASED, and this store describes that vault's CONTENT, which is going away with it. The display store is the one entry asserted on the delete paths instead, because what it holds describes the READER (their formats and their zone) and therefore outlives the vault.";

const SKIP_NO_SPELL_LAYER =
  "mobile compiles `editor/src` and therefore does hold this store, but it runs no spell layer: there is no `spell_enabled` surface and no dictionary plugin under `mobile/src`, so nothing on this client ever puts a word in the set. If a mobile spell surface lands, this skip is what should fail first.";

const SKIP_CREATE =
  "the create-vault callback has no prior editor session to clear: the old vault, when present, is left through the normal switch path before creation, and this callback only publishes the newly created vault.";

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
    appliesTo: ["desktop-lock", "desktop-switch", "mobile-lock", "mobile-background"],
    skips: {
      "desktop-create": SKIP_CREATE,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
    },
    // Both mobile paths reach it through ONE wrapper, which also cancels the
    // host-side run, so the guard checks both hops rather than demanding a
    // literal call in `flushAll`. develop's roster had this store as
    // DESKTOP-only, which was true there and stopped being true when
    // myne-md/myne#456 shipped the agent on mobile: the module is the same one
    // on both clients, so the plaintext at risk is not an analogue of
    // desktop's, it IS desktop's.
    via: {
      "mobile-lock": { fn: "endAgentRun", file: "mobile/src/lib/agent-lifetime.ts" },
      "mobile-background": { fn: "endAgentRun", file: "mobile/src/lib/agent-lifetime.ts" },
    },
  },
  {
    call: "clearAwareness",
    declaredIn: "src/notes/collab/awarenessStore.ts",
    holds:
      "the live-presence peers for the open note: other devices' or people's names, cursors and selections",
    // The store is MODULE scope and outlives every pane, so a vault-leaving path that
    // skips the clear leaves the previous vault's participants resident into the next
    // session. It holds no note plaintext, but a name and a cursor are still a record
    // of who was editing what. Asserted at the lock choke point and on the switch and
    // delete paths, which reach the editor without the pane necessarily unmounting.
    appliesTo: ["desktop-lock", "desktop-switch", "desktop-delete"],
    skips: {
      "desktop-create": SKIP_CREATE,
      "mobile-lock":
        "mobile compiles `src/notes/collab/awarenessStore.ts` (shared tree), but its live-awareness channel is not wired yet, so nothing populates the store on mobile and there is nothing resident to drop. When mobile's channel lands, this row MUST wire `clearAwareness()` into mobile's `lockVault` and delete this skip.",
      "mobile-background":
        "same as mobile-lock: mobile's live-awareness channel is not wired, so the store is always empty there. The skip is coupled to the mobile-lock one; both go together when the channel lands.",
      "mobile-delete":
        "same as mobile-lock: mobile's live-awareness channel is not wired, so the store is always empty there.",
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
    skips: {
      "desktop-create": SKIP_CREATE,
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing here would cost a re-decrypt on resume while protecting nothing the lock path does not already protect. What backgrounding owes is a FLUSH of unsaved state, which is why `flushAll` is the function on the roster.",
    },
  },
  {
    call: "resetPersonIdentityState",
    declaredIn: "src/components/sync/personIdentityState.ts",
    holds: "the process-scoped person identity readiness bit and public owner code",
     appliesTo: ["desktop-lock", "desktop-switch", "desktop-delete", "desktop-create"],
     via: {
       "desktop-switch": { fn: "lockVault", file: "src/lib/vault-unlock.ts" },
     },
     skips: {
      "mobile-lock":
        "the person identity store is DESKTOP-only in this tree: mobile has no production import of src/components/sync/personIdentityState.ts, so there is no state to clear on the mobile lock path.",
      "mobile-delete":
        "the person identity store is DESKTOP-only in this tree: mobile has no production import of src/components/sync/personIdentityState.ts, so there is no state to clear on the mobile delete path.",
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing the process-scoped person readiness bit would discard a still-valid identity for no teardown benefit.",
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
      "desktop-create": SKIP_CREATE,
      "mobile-lock": SKIP_DESKTOP_ONLY,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
      "mobile-background":
        "the store is DESKTOP-only (it lives under `src/notes/`, which mobile does not compile), so there is nothing on either mobile path to clear.",
    },
  },
  {
    call: "clearChatPersistForLock",
    declaredIn: "src/notes/ai/chatPersist.ts",
    holds:
      "the persisted-transcript write state: the last serialized conversation payload, one stashed failed append, the lagging flag, and any scheduled persist retry",
    // Every leaving path, next to `clearChat` above and for its reason plus
    // one of its own: the stash exists precisely to survive `clearChat` (the
    // unlock replay), so without this call a failed lock-time persist keeps
    // vault A's full transcript plaintext resident into vault B's session and
    // replays it into B's store on the next unlock (myne-md/myne#675 review).
    // It cannot live inside `clearChat` itself, which also runs on
    // in-session clears where the stash and the flag are still owed.
    appliesTo: ["desktop-lock", "desktop-switch"],
    skips: {
      "desktop-create": SKIP_CREATE,
      "mobile-lock": SKIP_DESKTOP_ONLY,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
      "mobile-background":
        "the store is DESKTOP-only (it lives under `src/notes/`, which mobile does not compile), so there is nothing on either mobile path to clear.",
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
      "desktop-create": SKIP_CREATE,
      "mobile-lock": SKIP_DESKTOP_ONLY,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
      "mobile-background":
        "the store is DESKTOP-only (it lives under `src/notes/`, which mobile does not compile), so there is nothing on either mobile path to clear.",
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
      "desktop-create": SKIP_CREATE,
      "mobile-lock": SKIP_DESKTOP_ONLY,
      "mobile-delete": SKIP_DESKTOP_ONLY,
      "desktop-delete": SKIP_ERASED,
      "mobile-background":
        "the store is DESKTOP-only (it lives under `src/notes/`, which mobile does not compile), so there is nothing on either mobile path to clear.",
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
      "desktop-create": SKIP_CREATE,
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing here would cost a re-decrypt on resume while protecting nothing the lock path does not already protect. What backgrounding owes is a FLUSH of unsaved state, which is why `flushAll` is the function on the roster.",
    },
  },
  {
    call: "resetPreviewCache",
    declaredIn: "editor/src/attachments/session-caches.ts",
    holds: "up to 24 decrypted attachment previews, each capped at the host's 2 MiB read cap, plus the reads still in flight for them",
    // Every leaving path, and this one holds the decrypted CONTENT rather than a
    // shape derived from it, so it is the stronger case of the entry above. It
    // sat unlisted while `resetDecodedAspects` was argued onto the roster from
    // the same file, which is the false-exhaustiveness shape the root AGENTS.md
    // records for the `itemsKey-wrap` row: a roster that reads complete while
    // the larger store beside it is missing. The in-flight map is cleared with
    // the cache so a read crossing a lock cannot resolve into the next
    // session's entries.
    appliesTo: ["desktop-lock", "desktop-switch", "mobile-lock"],
    skips: {
      "desktop-create": SKIP_CREATE,
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing here would cost a re-decrypt on resume while protecting nothing the lock path does not already protect. What backgrounding owes is a FLUSH of unsaved state, which is why `flushAll` is the function on the roster.",
    },
  },
  {
    call: "resetMermaidZoom",
    declaredIn: "editor/src/attachments/session-caches.ts",
    holds:
      "the session zoom percentage per rendered mermaid diagram, keyed by a hash of the diagram source",
    // Same paths as `resetPreviewCache`, and for the same class of reason: a
    // percentage is not plaintext, but the key is a fingerprint of note content,
    // so the map enumerates the diagrams this vault holds. Left uncleared it
    // would also restore the PREVIOUS vault's scale onto a diagram whose source
    // hash happened to collide. myne-md/myne#708.
    appliesTo: ["desktop-lock", "desktop-switch", "mobile-lock"],
    skips: {
      "desktop-create": SKIP_CREATE,
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing here would cost a re-render on resume while protecting nothing the lock path does not already protect. What backgrounding owes is a FLUSH of unsaved state, which is why `flushAll` is the function on the roster.",
    },
  },
  {
    call: "clearChatHistoryPersistForLock",
    declaredIn: "mobile/src/lib/chatHistory.ts",
    holds:
      "the staged conversation write state: one staged full-transcript payload plus the last-written payload, both serialized plaintext",
    // Mobile lock only. The desktop twin of this state (`clearChatPersistForLock`
    // above) lives in a module the desktop client compiles and this one does
    // not touch, and vice versa: the two persists are separate implementations
    // sharing a shape, not a store. The vault switch routes through
    // `lockVault`, so the one call covers both; the delete erases the vault
    // whose content the stash describes.
    appliesTo: ["mobile-lock"],
    skips: {
      "desktop-create": SKIP_CREATE,
      "desktop-lock":
        "the store is MOBILE-only (it lives under `mobile/src/lib/`, which the desktop client does not compile), so there is nothing on the desktop paths to clear. Verified by searching the desktop tree for the symbol rather than assumed from the path.",
      "desktop-switch":
        "the store is MOBILE-only (it lives under `mobile/src/lib/`, which the desktop client does not compile), so there is nothing on the desktop paths to clear. Verified by searching the desktop tree for the symbol rather than assumed from the path.",
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, and the background flush exists precisely to WRITE staged state rather than drop it (`flushChatHistoryNow` in `flushAll`). Clearing here would lose turns the flush was built to save.",
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
      "desktop-create": SKIP_CREATE,
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing here would cost a re-decrypt on resume while protecting nothing the lock path does not already protect. What backgrounding owes is a FLUSH of unsaved state, which is why `flushAll` is the function on the roster.",
    },
  },
  {
    call: "teardownMeetingSessionForLock",
    declaredIn: "src/notes/meetingSession.ts",
    holds:
      "the transcript of every clip this session transcribed, plus the body-mounted session bar. The transcript is other people's speech decoded from vault attachments, so it is the same class as `resetTranscripts` above and carries the same failure if it survives: the text of a locked vault's meeting staying resident into the next vault's session, and a bar left on the unlock screen showing it.",
    appliesTo: ["desktop-lock", "desktop-switch"],
    skips: {
      "desktop-create": SKIP_CREATE,
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
      "mobile-lock":
        "the meeting session is desktop-only. The module lives under `src/notes/`, which the mobile client does not compile: mobile has its own React tree under `mobile/src` and reaches the shared code through `@myne/editor`, not through `src/`. So on mobile this store is never imported and can never hold anything, and the skip is a statement about reachability rather than a choice to leave plaintext resident. Verified by searching the mobile tree for the symbol rather than assumed from the path.",
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing here would end a meeting the user is still in.",
    },
  },
  {
    call: "clearMeetingAiOffer",
    declaredIn: "src/components/meeting/meetingAiStore.ts",
    holds:
      "the meeting-AI offer: the note id and the full meeting transcript (other people's speech, AS1-class) a session published so the dialog could read it. A lock or a vault switch with the offer live leaves it resident, and the next Editor mount re-renders the dialog from the same module value against the previous vault's note id, which is the myne-md/myne#529 shape one surface over.",
    // Asserted through the meeting-session teardown, which both desktop leaving
    // paths already call: the offer is part of that session's RAM, so it clears
    // in the same function that clears the clip transcripts and the bar.
    appliesTo: ["desktop-lock", "desktop-switch"],
    via: {
      "desktop-lock": { fn: "teardownMeetingSessionForLock", file: "src/notes/meetingSession.ts" },
      "desktop-switch": { fn: "teardownMeetingSessionForLock", file: "src/notes/meetingSession.ts" },
    },
    skips: {
      "desktop-create": SKIP_CREATE,
      "desktop-delete": SKIP_ERASED,
      "mobile-delete": SKIP_ERASED,
      "mobile-lock":
        "the meeting AI dialog is desktop-only; the store lives under `src/components/meeting/`, which the mobile client does not compile, so there is nothing on the mobile path to clear.",
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing here would discard the offer for a session the user is still in.",
    },
  },
  {
    call: "resetSessionIgnored",
    declaredIn: "editor/src/decorations/spell.ts",
    holds: "the session's ignored-word set, which is vault-scoped user vocabulary",
    appliesTo: ["desktop-switch"],
    skips: {
      "desktop-create": SKIP_CREATE,
      "desktop-lock":
        "A plain lock does not change vault, and the ignore-this-session set is scoped to the session the user is still in. Clearing it at the lock choke point would discard a choice they made about the vault they are about to re-open. The store's own comment states the reason as a vault CHANGE, which is why this one is asserted on the switch path only.",
      "mobile-lock": SKIP_NO_SPELL_LAYER,
      "mobile-delete": SKIP_NO_SPELL_LAYER,
      "desktop-delete": SKIP_ERASED,
      "mobile-background":
        "backgrounding is not a vault-LEAVING event: the vault stays unlocked and the same session resumes, so clearing here would cost a re-decrypt on resume while protecting nothing the lock path does not already protect. What backgrounding owes is a FLUSH of unsaved state, which is why `flushAll` is the function on the roster.",
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
 * by writing twice (root `AGENTS.md`, the `'` problem in both directions). */
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
  // A `function` DECLARATION gets its body by walking its own parameter list to
  // the close paren and taking the next `{`. The heuristic below cannot do it:
  // `function f(): void {` has an identifier before the brace, not `)` or `>`,
  // so the scan walked past the real body and took the first `{` inside it,
  // which for `mobile/src/lib/agent-lifetime.ts::endAgentRun` was a
  // `.catch(() => {` arrow. The extracted "body" was that catch block, and the
  // teardown call four lines below it was invisible.
  //
  // Found the moment the `via` wrappers entered the file set (myne-md/myne#456
  // merge): hop two had never executed, because `rosterFiles` did not load the
  // wrapper, so the guard had reported ok about a check it was not running.
  //
  // Only for the `function` form. The arrow form (`const x = useCallback(async
  // () => {`) is exactly the case this cannot handle, and the header records
  // why: the first `(` after such a declaration is `useCallback`'s own.
  const decl = /^\s*(?:export\s+)?(?:async\s+)?function\b/.exec(src.slice(at, at + 40));
  if (decl) {
    const pOpen = src.indexOf("(", at);
    if (pOpen >= 0) {
      let depth = 0;
      for (let k = pOpen; k < src.length; k += 1) {
        if (src[k] === "(") depth += 1;
        else if (src[k] === ")") {
          depth -= 1;
          if (depth === 0) {
            const b = src.indexOf("{", k);
            if (b >= 0) bStart = b;
            break;
          }
        }
      }
    }
  }
  for (let k = bStart < 0 ? src.indexOf("{", at) : -1; k >= 0; k = src.indexOf("{", k + 1)) {
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
    ...LEAVING_PATHS.map((p) => p.file),
    // The `via` wrappers too, or hop two reports every one of them missing:
    // the file set is the guard's whole world, and a wrapper it cannot read is
    // indistinguishable from one that is not there.
    ...TEARDOWN_CALLS.flatMap((t) => Object.values(t.via ?? {}).map((h) => h.file)),
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
