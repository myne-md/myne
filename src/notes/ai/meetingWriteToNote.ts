// Meeting AI: write the AI sections into a meeting note on disk (meeting-ai
// task 3).
//
// Mirrors `notes/setNoteCover.ts`, the canonical "patch a note that may be
// closed" orchestration: FLUSH every dirty pane first (read-patch-write against
// a note that may be open and dirty, whose autosave is a second writer), read
// the note, upsert the AI block, bump `updated:`, re-encrypt, and re-index so
// search and any open view see the new text. The transcript above the block is
// never in the replaced range (see `meetingWrite.ts`).
//
// Kept apart from `meetingWrite.ts` so that module stays IPC-free and testable;
// this one is the production IO half.

import { patchUpdatedField } from "../../dialect";
import { flushBeforeFrontmatterWrite } from "../flushBeforeFrontmatterWrite";
import { noteRead } from "../readNote";
import {
  settleFrontmatterWrite,
  type FrontmatterSettleTarget,
} from "../settleFrontmatterWrite";
import { noteUpdate } from "../updateNote";
import { reindexNoteFromBody } from "../vaultIndices";
import { buildAiBlock, upsertAiBlock } from "./meetingWrite";
import type { MeetingSections } from "./meetingSections";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Append (or regenerate in place) the AI sections in the note `noteId`.
 * `notice` is the caller-resolved, localized machine-generated notice.
 */
export async function writeMeetingSectionsToNote(
  noteId: string,
  sections: MeetingSections,
  notice: string,
  settle?: FrontmatterSettleTarget,
): Promise<void> {
  // Before the read, not after (myne-md/myne#520): the pane's autosave is a
  // second writer of the same bytes.
  await flushBeforeFrontmatterWrite();
  const current = await noteRead(noteId);
  const next = upsertAiBlock(current, buildAiBlock(sections, notice));
  // A no-op upsert (identical bytes) is not written, so an empty regenerate
  // does not bump `updated:` or push a sync version for nothing.
  if (next === current) return;
  const stamped = decoder.decode(
    patchUpdatedField(encoder.encode(next), new Date().toISOString()),
  );
  await noteUpdate(noteId, stamped);
  // The note's text changed → re-index (live, decrypt-free). Best-effort.
  void reindexNoteFromBody(noteId, stamped);
  // The settle half of the handshake: the meeting note is OPEN in a pane when
  // the dialog inserts, and without a reload the pane's next autosave writes
  // the pre-insert body back over the block (src/AGENTS.md, myne-md/myne#520).
  if (settle !== undefined) {
    void settleFrontmatterWrite(settle, noteId);
  }
}
