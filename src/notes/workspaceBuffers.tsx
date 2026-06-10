// `workspaceBuffers` — multi-buffer residency layer (MYND-166, Task 2).
//
// Each OPEN note (one per the global duplicate-forbid invariant from
// `workspaceState`) gets exactly one resident `<NoteBuffer>`: its own
// decrypted-content state + its own `useAutosave` loop. Buffers are
// EAGER — every open tab is mounted, not just the visible ones — so a
// background tab keeps its edits + dirty state. The visible buffers
// (active-tab-per-pane) additionally render a live editor surface; the
// rest hold state but render nothing.
//
// Why one keyed component per note rather than one shared content slot:
//  - **Independence + no clobber:** separate component instances ⇒
//    separate state + separate autosave timers. Combined with the
//    duplicate-forbid invariant (one note ⇒ one buffer ⇒ one writer to a
//    given `.myn`), two buffers can never race to save the same file.
//  - **Switch preserves edits:** toggling a buffer's visibility is a prop
//    change, not a remount — content + dirty state survive a tab switch.
//  - **Close frees + flushes:** closing a tab removes its id from
//    `openNoteIds`, unmounting the keyed buffer; `useAutosave`'s unmount
//    cleanup fires the best-effort flush + clears its timers.
//
// This module is the residency engine; wiring it into the pane layout
// (rendering buffers into the focused/visible panes) lands with the tab
// strip + split UI (Tasks 3/4).

import { useEffect, useState, type ReactNode } from "react";
import { noteRead } from "./readNote";
import type { NoteId } from "./sidebarState";
import { useAutosave, type SaveFn, type SaveStatus } from "./useAutosave";

/** Decrypt-and-read seam (defaults to the real `noteRead` IPC). */
export type ReadFn = (noteId: NoteId) => Promise<string>;

/** Render-prop payload handed to the host for one resident buffer. */
export type NoteBufferRenderProps = {
  noteId: NoteId;
  /** Whether this buffer is the active tab in its pane (i.e. visible). */
  active: boolean;
  /** Current (possibly edited) decrypted body. */
  content: string;
  /** Apply an edit — the live editor calls this on every change. */
  setContent: (next: string) => void;
  status: SaveStatus;
  retry: () => void;
};

const DEFAULT_READ: ReadFn = noteRead;

type NoteBufferProps = {
  noteId: NoteId;
  active: boolean;
  readImpl: ReadFn;
  saveImpl?: SaveFn;
  render: (props: NoteBufferRenderProps) => ReactNode;
};

/**
 * Loads the note body once, then mounts the autosave-bearing inner buffer
 * with that body as the INITIAL content — so `useAutosave` sees the load
 * as "loaded content", never as an edit (no spurious save-on-open).
 */
function NoteBuffer({
  noteId,
  active,
  readImpl,
  saveImpl,
  render,
}: NoteBufferProps) {
  const [initial, setInitial] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void readImpl(noteId).then((body) => {
      if (alive) setInitial(body);
    });
    return () => {
      alive = false;
    };
    // `noteId` is fixed per keyed instance; `readImpl` is a stable seam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  if (initial === null) return null; // still loading — nothing resident yet
  return (
    <LoadedNoteBuffer
      noteId={noteId}
      active={active}
      initialContent={initial}
      saveImpl={saveImpl}
      render={render}
    />
  );
}

type LoadedNoteBufferProps = {
  noteId: NoteId;
  active: boolean;
  initialContent: string;
  saveImpl?: SaveFn;
  render: (props: NoteBufferRenderProps) => ReactNode;
};

function LoadedNoteBuffer({
  noteId,
  active,
  initialContent,
  saveImpl,
  render,
}: LoadedNoteBufferProps) {
  const [content, setContent] = useState(initialContent);
  // `setContent` doubles as the autosave `onSaved` sink so a frontmatter
  // `updated:` patch mirrors back into the buffer without a close-reopen.
  const { status, retry } = useAutosave(noteId, content, saveImpl, setContent);
  return <>{render({ noteId, active, content, setContent, status, retry })}</>;
}

export type WorkspaceBuffersProps = {
  /** Every open note across all panes (eager residency). */
  openNoteIds: readonly NoteId[];
  /** The active-tab note in each pane (the visible buffers). */
  visibleNoteIds: readonly NoteId[];
  render: (props: NoteBufferRenderProps) => ReactNode;
  readImpl?: ReadFn;
  saveImpl?: SaveFn;
};

/**
 * Mounts one keyed `<NoteBuffer>` per open note. Keying by `noteId` is
 * what makes residency correct: opening mounts a fresh buffer, closing
 * unmounts one (→ autosave flush + teardown), and a visibility toggle
 * never remounts (edits + dirty state survive a tab switch).
 */
export function WorkspaceBuffers({
  openNoteIds,
  visibleNoteIds,
  render,
  readImpl = DEFAULT_READ,
  saveImpl,
}: WorkspaceBuffersProps) {
  const visible = new Set(visibleNoteIds);
  return (
    <>
      {openNoteIds.map((id) => (
        <NoteBuffer
          key={id}
          noteId={id}
          active={visible.has(id)}
          readImpl={readImpl}
          saveImpl={saveImpl}
          render={render}
        />
      ))}
    </>
  );
}
