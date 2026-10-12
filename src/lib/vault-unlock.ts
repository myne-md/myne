// Tauri IPC wrappers for the param-less `vault_unlock` plugin commands.
// The `unlock(password)` command stays inline at its call sites
// (CreateVault auto-unlock, Unlock screen submit) so password lifetime
// is visible at the boundary.

import { invoke } from "../platform/core";
import { resetGraphLayoutOnLock } from "../notes/graphLayoutPersist";
import { resetVimStateOnLock } from "../editor/vim";
import { releaseAttachmentUrls } from "../platform/attachments";
import { resetTaskIndexCache } from "../notes/taskIndex";
import { clearAgentForLock } from "../notes/agent/agentStore";
import { clearAwareness } from "../notes/collab/awarenessStore";
import { clearAiOutput } from "../notes/ai/aiOutputStore";
import { clearChat } from "../notes/ai/chatStore";
import { clearChatPersistForLock } from "../notes/ai/chatPersist";
import { resetScrollMemory } from "../notes/scrollMemory";
import { resetRecentNotes } from "../notes/recentNotes";
import { resetDecodedAspects } from "../editor/attachments/decoded-aspect";
import {
  resetMermaidZoom,
  resetPreviewCache,
  resetTranscripts,
} from "../editor/attachments/session-caches";
import { teardownMeetingSessionForLock } from "../notes/meetingSession";
import { resetDateTimeDisplayForLock } from "@myne/editor/host/lib/datetimeFormat";
import { resetPersonIdentityState } from "../components/sync/personIdentityState";

/** Read-only probe of the `UnlockedVault` slot. */
export async function isVaultUnlocked(): Promise<boolean> {
  return await invoke<boolean>("plugin:vault-unlock|vault_is_unlocked");
}

/**
 * Run one plaintext-teardown step so that a throw cannot skip the next one, or
 * the lock (myne-md/myne#535).
 *
 * `runFlushChain` states this rule one layer up ("the chain is best-effort and
 * CANNOT skip the lock"), and the rule was not applied inside the lock itself.
 * The five resets below are module-scope stores, an object-URL cache and a
 * WebView teardown; each is ordinary frontend code that can throw, and a throw
 * from any of them rejected `lockVault()` **before the IPC was ever issued**.
 * Both callers then swallowed that rejection and routed to the lock screen
 * anyway, so the screen stood over a slot that still held `root_key`, with the
 * plaintext-derived state the failed step was supposed to wipe still resident.
 *
 * That is the exact shape task 93 fixed for the flush chain, one level down.
 * Worth stating because the ordering reads as defensive already: the resets run
 * before the invoke deliberately (a vault switch must not carry one vault's
 * positions into another's cache), and "before" quietly became "instead of" on
 * any failure.
 *
 * A `console.warn` in dev only, matching every other best-effort teardown here.
 * There is nothing for a user to do about a failed cache reset, and the thing
 * that matters (the keys) is handled by letting the invoke proceed.
 */
function teardownStep(name: string, run: () => void): void {
  try {
    run();
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn(`[lockVault] ${name} threw; continuing to the lock:`, err);
    }
  }
}

/** Drop the slot. Idempotent on already-locked. */
export async function lockVault(): Promise<void> {
  // Drop the in-memory graph layout + cancel any pending disk flush BEFORE the
  // slot goes away, so a vault switch can't carry one vault's positions into
  // another's encrypted cache (see `resetGraphLayoutOnLock`).
  teardownStep("resetGraphLayoutOnLock", () => resetGraphLayoutOnLock());
  // vim-keyboard-mode (MYND-313): yank registers and recorded macros live in the
  // vim engine's MODULE-GLOBAL state, which survives the editor unmount that
  // locking performs. Cleared here for the same reason as the graph layout above
  // — so one vault's note text can never be pasted into another's.
  teardownStep("resetVimStateOnLock", () => resetVimStateOnLock());
  // Render-side attachment resources (phase3-web-client task 44). A no-op on
  // desktop, where `attachment://<id>` caches nothing; on web it drops the
  // `blob:` URL strings whose objects the Worker is about to revoke, so a render
  // after a re-unlock cannot paint a revoked URL. Same category as the two calls
  // above: platform state that outlives the slot.
  teardownStep("releaseAttachmentUrls", () => releaseAttachmentUrls());
  // The agent run's proposal, on the same leg and for the strongest version of
  // the same reason: `proposal.edits` holds anchors and replacements copied
  // VERBATIM out of note bodies, `agentStore` is module scope, and no lock path
  // reloads the WebView. It sits HERE rather than at each caller because the
  // callers are the problem: four paths lock the vault (the Lock button, the
  // vault switch, the StorageLost takeover, the invalid-state fail-closed CTA)
  // and only two of them remembered. A choke point cannot be forgotten by the
  // fifth one.
  teardownStep("clearAgentForLock", () => clearAgentForLock());
  // The live-presence peer set (`collab-presence-ui` task 3), on the same leg: it
  // holds other devices' or people's names, cursors and selections for the OPEN
  // note, the store is module scope, and no lock path reloads the WebView. Dropped
  // here rather than at the pane's unmount alone, which is a rendering fact rather
  // than the vault-leaving event.
  teardownStep("clearAwareness", () => clearAwareness());
  // The AI chat transcript, on the same leg. It holds the user's own questions
  // and the model's answers about their notes, `chatStore` is module scope, and
  // it had been relying on the Editor's unmount cleanup alone, which does fire
  // today, and is not a guarantee. The unmount is a rendering fact; the vault
  // leaving is the event that has to drop this, and every path that ends a
  // session comes through here. `design-notes/ai/0276` rests its
  // no-new-blob-family argument on the transcript not outliving the session.
  teardownStep("clearChat", () => clearChat());
  teardownStep("clearChatPersistForLock", () => clearChatPersistForLock());
  // The persist module's write state, on the same leg: the last serialized
  // payload, one stashed failed append, and the lagging flag are the same
  // plaintext the transcript is, and module state survives the wipe above
  // (myne-md/myne#675 review: a stash that survived the lock kept vault A's
  // turns resident into vault B's session, and replayed them there).
  // The rendered AI output, on the same leg and for the same reason. It holds a
  // note's summary and, through `src/lib/ai-qa.ts`, every Q and A answer over
  // note content, and its own header calls that an AS1-class RAM artifact
  // dropped on lock. It was left behind when the transcript moved here: the two
  // sit one line apart in the Editor's unmount effect, and only one of them was
  // given a leaving-path call.
  //
  // Both arrived on this path in myne-md/myne#533 while this branch was open,
  // and both are wrapped for the reason `teardownStep` exists: a throwing reset
  // before the lock IPC used to skip the IPC entirely, which is the one failure
  // here that leaves KEYS resident. The wrapper keeps the call text intact so
  // `scripts/check-frontend-lock-teardown.mjs`'s scan still sees each name.
  teardownStep("clearAiOutput", () => clearAiOutput());
  // The task list is the one nonce consumer that answers from MODULE state
  // rather than refetching in its own mount effect, so unlike every other
  // reader surface it does not self-heal on remount (myne#277). The backend
  // wipes `VaultIndicesState` on lock; a cache keyed on a monotonic counter has
  // to be dropped alongside the data it describes, or the next session reads a
  // pre-lock snapshot. Same category as the three calls above: plaintext-derived
  // state that outlives the slot. (The idle auto-lock path reloads the WebView,
  // which clears this for free — the manual Lock button does not.)
  teardownStep("resetTaskIndexCache", () => resetTaskIndexCache());
  // The per-note scroll positions (myne-md/myne#600). Module scope, keyed by
  // note id, and the decision behind it is session-scoped memory: the session
  // ends here. Nothing in it is note text, but it is a live map of which notes
  // this vault has and how far into each one the user had read, which is the
  // same category of vault-derived RAM as the caches above.
  teardownStep("resetScrollMemory", () => resetScrollMemory());
  // The wikilink picker's recency order (myne-md/myne#601), same leg and same
  // reason: a module-scope list of the note ids this vault opened, which would
  // otherwise rank the NEXT session's picker from the previous one's history.
  teardownStep("resetRecentNotes", () => resetRecentNotes());
  // The decoded image shapes (myne-md/myne#604), same leg and same reason one
  // step further out: the key is an attachment id and the value comes from
  // decrypted content, so the map enumerates every attachment this vault has
  // rendered. Keeping it across a lock would trade that for one first-paint
  // settle on the re-unlock.
  teardownStep("resetDecodedAspects", () => resetDecodedAspects());
  // The two stores that hold decrypted attachment CONTENT rather than a shape
  // derived from it: up to 24 file previews (each capped at the host's 2 MiB
  // read cap) and the text of every completed voice-note transcription. The
  // transcript store carried a comment claiming the module unloads on lock,
  // which is what kept it off this path; a JS module never unloads, and this
  // button does not reload the WebView.
  teardownStep("resetPreviewCache", () => resetPreviewCache());
  teardownStep("resetTranscripts", () => resetTranscripts());
  // The meeting session (myne-md/myne#789): the same class of store as
  // `resetTranscripts` above, and the same failure if it is skipped. The
  // transcript map holds third-party speech decoded from vault attachments and
  // the session bar is body-mounted, so neither goes away on its own; `active`
  // staying set also left `/meeting` silently dead in the next vault.
  teardownStep("teardownMeetingSessionForLock", () => teardownMeetingSessionForLock());
  // The remembered mermaid diagram zoom (myne-md/myne#708): module scope, keyed
  // by a hash of the diagram source, so it is vault-derived the same way the
  // preview cache is. Cleared with its neighbours on this leg.
  teardownStep("resetMermaidZoom", () => resetMermaidZoom());
  // The ambient date/time DISPLAY store, which is module scope in
  // `@myne/editor` and read by every surface that prints a date. It holds the
  // reader's chosen formats and their TIME ZONE, all derived from decrypted
  // `vault.prefs`, and nothing in production returned it to defaults: after one
  // unlock it stayed resident through a lock and into the next vault's session
  // until that vault's publisher happened to overwrite it. The zone is the
  // reason this is on the leaving path rather than left to the next mount: it
  // is a coarse-location datum kept per vault everywhere else, and
  // `dialect/src/taskFields.ts` keeps it out of note bytes for that reason.
  teardownStep("resetDateTimeDisplayForLock", () => resetDateTimeDisplayForLock());
  teardownStep("resetPersonIdentityState", () => resetPersonIdentityState());
  await invoke<void>("plugin:vault-unlock|lock");
}

/**
 * Report window-level user activity to the auto-lock-on-idle timer
 * (MYND-121). Lock-free + infallible on the backend (a single relaxed
 * atomic store, never touches the slot lock). Best-effort from the
 * frontend — callers swallow transport errors; the backend idle timer
 * is the authoritative fail-closed clock.
 */
export async function reportUserActivity(): Promise<void> {
  await invoke<void>("plugin:vault-unlock|report_user_activity");
}
