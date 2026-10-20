// IPC primitive for the `note_update` Tauri command.
//
// **Internal — direct callers should prefer `saveNote(noteId, body)` from
// `./saveNote.ts`** (the canonical autosave path that composes
// `patchUpdatedField` surgery BEFORE this primitive per `decisions.md`
// 2026-05-09 "Frontmatter byte-level surgery owned by TS dialect module").
// Calling `noteUpdate` directly without surgery means the frontmatter
// `updated:` field won't advance — a quiet contract violation.
//
// `decisions.md` 2026-05-07 "`note_update` IPC: stateless overwrite,
// verb-noun naming, UI-level autosave coalescing" pins this as the
// canonical IPC; γ1+γ2 hybrid coalescing lives in `./saveNote.ts` +
// `./useAutosave.ts` (Tasks 12 + 26 of the `notes-sidebar-autosave` PRD).

import { invoke } from "../platform/core";
import { patchLiveNote } from "./liveNote";
import { sha256Hex } from "./baseHash";

/**
 * Re-encrypt an existing `.myn` note in place. Stateless idempotent
 * overwrite primitive — autosave coalescing lives at the React-hook
 * layer, not here.
 *
 * `expectedBaseHashHex` (optional, §11.3 expected-base guard): SHA-256
 * hex of the UTF-8 plaintext the caller believes is currently on disk.
 * When present and the disk has moved on (a sync pull-apply raced the
 * editor), the backend rejects with `{kind:"BaseMismatch"}` and writes
 * NOTHING. Omitted → legacy last-write-wins (every non-autosave caller).
 *
 * `base` (optional, live path only): the text `plaintext` was derived from.
 * While a live session owns the note and has moved past `base`, the core
 * three-way merges instead of replacing. The stateless command has no use for
 * it and does not receive it.
 *
 * `onApplied` (live path only): called with the session's text once the write
 * went through a session, before the call settles. The pane's autosave uses it
 * to move its mirror of the session (`LivePatchOptions.onApplied`).
 *
 * Rejects with a `NoteUpdateError` (see `src/types/note-update-error.ts`).
 */
export async function noteUpdate(
  noteId: string,
  plaintext: string,
  expectedBaseHashHex?: string,
  base?: string,
  onApplied?: (after: string) => void,
): Promise<void> {
  // Live funnel (`collab-editor-bridge` task 7): while a live session owns the
  // note it is the SINGLE durable writer (`SYNC-33`), so the backend refuses this
  // stateless overwrite with `LiveSessionOpen`. Route the same bytes through the
  // session's durable frontmatter entry point instead, which applies a minimal
  // `update_text` (merge-safe, myne#428).
  //
  // The caller's `expectedBaseHashHex` goes WITH it (myne-md/myne#849 review, D8).
  // A live peer edit sits unflushed in the session, so the text a caller hashed
  // can be behind the session even though no durable pull raced it; the session
  // evaluates the hash against its OWN text and rejects with the same
  // `{kind:"BaseMismatch"}` the stateless command uses, so a caller's keep-both
  // branch fires on either path.
  if ((await patchLiveNote(noteId, plaintext, { expectedBaseHashHex, base, onApplied })) !== null) {
    return;
  }
  // The session can vanish DURING the call (a delete or a conflict-copy apply
  // evicting it while this write is in flight), and the funnel then answers
  // `null`. The caller skipped the §11.3 hash because a session owned the note, or
  // because it was told none does, so the stateless write below would land its
  // whole text unguarded (myne-md/myne#849 review). Whenever the caller said what
  // its text derives from, guard the fallback with that base: the resulting
  // `BaseMismatch` is what sends the caller down its keep-both path instead of
  // over a peer's text. The condition is about the CALL rather than about
  // `isLiveNote` at entry on purpose: the evict-on-delete paths create exactly the
  // state where no session owns the note while an editor still holds the buffer,
  // and that is the write this has to protect.
  if (expectedBaseHashHex === undefined && base !== undefined) {
    expectedBaseHashHex = await sha256Hex(base);
  }

  await invoke<void>(
    "plugin:notes|note_update",
    expectedBaseHashHex === undefined
      ? { noteId, plaintext }
      : { noteId, plaintext, expectedBaseHashHex },
  );
}
