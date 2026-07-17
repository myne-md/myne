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

/**
 * Idle-debounce N — autosave fires after N ms of no keystrokes since
 * the last input. Pinned at 1000ms by `decisions.md` 2026-05-15.
 */
export const AUTOSAVE_IDLE_MS = 1000;

/**
 * Max-debounce M — autosave fires at most every M ms even during
 * sustained typing (γ2 safety net). Pinned at 10000ms by
 * `decisions.md` 2026-05-15.
 */
export const AUTOSAVE_MAX_MS = 10000;

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
): Promise<string> {
  const stamped = decoder.decode(
    patchUpdatedField(encoder.encode(body), new Date().toISOString()),
  );
  await noteUpdate(noteId, stamped, expectedBaseHashHex);
  return stamped;
}
