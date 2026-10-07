// @vitest-environment jsdom
//
// myne-md/myne#819 follow-up: the Archive panel's "Delete → Trash" must close
// the note's pane tab on SUCCESS (and keep it when the trash rolled back), or a
// resident, still-editable buffer's next autosave writes `trashed:` back off and
// the note returns from the trash.
//
// This drives the SURFACE (a row click), not `closeNoteEverywhere` directly, so
// deleting the `closeNoteEverywhere` call in `ArchivePanel.deleteToTrash`
// reddens it. `useSelectedNote` is mocked; the workspace is REAL, so the tab
// strip is the same one production renders.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const trashWithRollback = vi.hoisted(() => vi.fn());

vi.mock("../../src/notes/sidebarState", () => ({
  useSelectedNote: () => ({
    cache: new Map(),
    selectedId: null,
    trashWithRollback,
    unarchiveWithRollback: vi.fn(),
  }),
  // One archived note row; nothing is in an archived folder.
  archivedRecords: () => [
    {
      noteUuid: "arch-1",
      title: "Archived note",
      folder: null,
      archived: "2026-01-01T00:00:00Z",
      trashed: null,
      updatedAt: null,
    },
  ],
}));

import { ArchivePanel } from "../../src/notes/components/ArchivePanel";
import {
  WorkspaceProvider,
  useWorkspace,
  type WorkspaceApi,
} from "../../src/notes/workspaceContext";

function renderWithWorkspace(ui: ReactNode): { current: WorkspaceApi | null } {
  const api: { current: WorkspaceApi | null } = { current: null };
  function Probe() {
    api.current = useWorkspace();
    return null;
  }
  render(
    <WorkspaceProvider>
      <Probe />
      {ui}
    </WorkspaceProvider>,
  );
  return api;
}

function openNoteIds(
  leaves: Array<{ tabs: Array<{ kind: string; id: string }> }>,
): string[] {
  return leaves
    .flatMap((l) => l.tabs)
    .filter((t) => t.kind === "note")
    .map((t) => t.id);
}

afterEach(() => {
  cleanup();
  trashWithRollback.mockReset();
});

describe("ArchivePanel delete-to-trash closes the note's tab", () => {
  it("closes the tab after a successful trash", async () => {
    trashWithRollback.mockResolvedValue(undefined);
    const api = renderWithWorkspace(
      <ArchivePanel
        open
        onClose={() => {}}
        archivedFolders={[]}
        onRestoreFolder={() => {}}
        onDeleteFolderToTrash={() => {}}
      />,
    );
    act(() => api.current!.openInFocused("arch-1"));
    // PIN the tab. The defect this guards is that a PINNED tab survived its
    // note's trash; an unpinned tab was already closed before the fix, so an
    // unpinned fixture passes on the pre-fix tree and guards nothing.
    act(() =>
      api.current!.setItemPinned(
        api.current!.focusedPaneId,
        { kind: "note", id: "arch-1" },
        true,
      ),
    );
    expect(api.current!.leaves[0]?.tabs[0]?.pinned).toBe(true);
    expect(openNoteIds(api.current!.leaves)).toContain("arch-1");

    fireEvent.click(await screen.findByTestId("archive.delete"));
    await waitFor(() => expect(trashWithRollback).toHaveBeenCalledWith("arch-1"));
    await waitFor(() =>
      expect(openNoteIds(api.current!.leaves)).not.toContain("arch-1"),
    );
  });

  it("keeps the tab when the trash fails (rolled back, note still exists)", async () => {
    trashWithRollback.mockRejectedValue(new Error("boom"));
    const api = renderWithWorkspace(
      <ArchivePanel
        open
        onClose={() => {}}
        archivedFolders={[]}
        onRestoreFolder={() => {}}
        onDeleteFolderToTrash={() => {}}
      />,
    );
    act(() => api.current!.openInFocused("arch-1"));
    act(() =>
      api.current!.setItemPinned(
        api.current!.focusedPaneId,
        { kind: "note", id: "arch-1" },
        true,
      ),
    );

    fireEvent.click(await screen.findByTestId("archive.delete"));
    await waitFor(() => expect(trashWithRollback).toHaveBeenCalledWith("arch-1"));
    await waitFor(() =>
      expect(openNoteIds(api.current!.leaves)).toContain("arch-1"),
    );
  });
});
