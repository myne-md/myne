// `saveNote` — canonical autosave call-path.
//
// Per `decisions.md` 2026-05-09 "Frontmatter byte-level surgery owned
// by TS dialect module" + 2026-05-15 "Save-handler discipline: src/notes/
// IPC orchestration module": every `note_update` invocation site MUST
// orchestrate `patchUpdatedField(bytes, now()) → invoke('note_update')`.
// This helper IS that orchestration; direct `noteUpdate(...)` callers
// outside `src/notes/` are a discipline violation (reviewer enforced
// via grep on `plugin:notes|note_update`).
//
// The `useAutosave` hook (Task 26, `src/notes/useAutosave.ts`) layers
// the γ1+γ2 hybrid state machine (idle-debounce + max-debounce +
// latest-wins gate + flush triggers) ON TOP of this primitive. The
// timing constants are exported from THIS file so the hook and any
// future callers share a single source of truth (Phase 2 settings UI
// reads from here per `decisions.md` 2026-05-15 "Autosave γ1+γ2 hybrid
// concrete timings").

import { patchUpdatedField } from "../dialect/surgery";
import { noteUpdate } from "./updateNote";

// The cadence pair lives in `@myne/client-core/autosave`: the phone autosaves on
// the same numbers, and a second pair of literals is how the two clients drift
// apart with nothing failing. Re-exported so this module's callers are unchanged.
export { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS } from "@myne/client-core/autosave";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Canonical autosave call: stamp `updated:` frontmatter via surgery,
 * then fire `note_update` over IPC. Returns the patched body (with the
 * fresh `updated:` timestamp injected) so callers can mirror the
 * stamped state back into the editor's local content — without this
 * mirror, the editor's frontmatter only updates on close-reopen
 * (`note_read` reload). Rejects on IPC failure; callers (the
 * `useAutosave` hook) map rejection to status state.
 *
 * `body` arrives as a `string` (the editor's React state); surgery
 * operates on `Uint8Array` bytes, so we encode + decode at the
 * boundary. The double-conversion overhead is negligible (the editor
 * body is bounded by the protocol's 16 MiB plaintext cap, and the
 * autosave cadence is at most every `AUTOSAVE_IDLE_MS`).
 */
export async function saveNote(
  noteId: string,
  body: string,
  expectedBaseHashHex?: string,
  live?: LiveSaveContext,
): Promise<string> {
  const stamped = decoder.decode(
    patchUpdatedField(encoder.encode(body), new Date().toISOString()),
  );
  await noteUpdate(
    noteId,
    stamped,
    expectedBaseHashHex,
    live?.base,
    live === undefined ? undefined : () => live.onSent(stamped),
  );
  return stamped;
}

/**
 * What an editor's save hands a live session (myne-md/myne#849 review round 4).
 * `base` is the editor's mirror of the session, the text its buffer derives from,
 * so the core merges a save from a buffer that has not caught up rather than
 * replacing the session with it. `onSent` runs with the STAMPED text once the
 * session took it, before the save settles, so the editor moves its mirror to
 * exactly what it sent. Ignored when no session owns the note.
 */
export interface LiveSaveContext {
  base: string | undefined;
  onSent: (sent: string) => void;
}
