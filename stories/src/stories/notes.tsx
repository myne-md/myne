// Stories for the notes-domain surfaces (myne-md/myne#845 task 16).
//
// These live under `src/notes/components`, which the coverage guard counts as a
// surface root. Each entry renders the real component with the props its own
// signature requires, and a fixture supplying the prefs the panels read; a bare
// mount would render an empty box and would be worse than the recorded debt.

import type { Fixture, StoryDescriptor } from "../types";
import { DEFAULT_PREFS } from "../../fixtures";
import { action } from "../actions";
import { SidebarStateProvider } from "@app/notes/sidebarState";
import { WorkspaceProvider } from "@app/notes/workspaceContext";

import { ArchivePanel } from "@app/notes/components/ArchivePanel";
import { ChatHistoryModal } from "@app/notes/components/ChatHistoryModal";
import { FolderGlyph } from "@app/notes/components/FolderGlyph";
import { MemoryPopover } from "@app/notes/components/MemoryPopover";
import { PanelEmptyState } from "@app/notes/components/PanelEmptyState";
import { TrashPanel } from "@app/notes/components/TrashPanel";
import { TreeRails } from "@app/notes/components/TreeRails";

/** The notes panels read `vault.prefs`; supply the whole default object. */
const NOTES_FIXTURE: Fixture = {
  description: "one unlocked vault with default prefs",
  handlers: {
    "plugin:vault-unlock|vault_list": () => [],
    "plugin:vault-unlock|vault_slot_kind": () => "Unlocked",
    "plugin:prefs|prefs_read": () => DEFAULT_PREFS,
    "plugin:sync|sync_account_status": () => null,
    "plugin:sync|sync_list_devices": () => [],
    "plugin:vault-indices|note_titles": () => [],
  },
};

/** A frame that centres a panel so it is judged in its own box, not the stage. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "var(--space-4)",
        background: "var(--bg-1)",
      }}
    >
      {children}
    </div>
  );
}

export const NOTES_STORIES: StoryDescriptor[] = [
  {
    id: "notes/treerails/depth-3",
    group: "components",
    surface: "TreeRails",
    state: "depth-3",
    description: "The indent rails that mark nesting depth in the file tree.",
    tags: ["notes", "sidebar", "tree", "indent"],
    render: () => (
      <Frame>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
          <TreeRails depth={3} />
          <span style={{ color: "var(--fg-1)" }}>A note three levels deep</span>
        </div>
      </Frame>
    ),
  },
  {
    id: "notes/panelemptystate/default",
    group: "components",
    surface: "PanelEmptyState",
    state: "default",
    description: "The shared empty state a side panel shows when it has nothing to list.",
    tags: ["notes", "empty", "panel", "state"],
    render: () => (
      <Frame>
        <div style={{ width: "320px", background: "var(--bg-2)" }}>
          <PanelEmptyState
            icon="folder"
            title="No notes yet"
            body="Create a note to see it listed here."
          />
        </div>
      </Frame>
    ),
  },
  {
    id: "notes/folderglyph/default",
    group: "components",
    surface: "FolderGlyph",
    state: "default",
    description: "The folder mark, drawn from the folder icon registry.",
    tags: ["notes", "folder", "icon", "sidebar"],
    render: () => (
      <Frame>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <FolderGlyph name="folder" size={16} />
          <span style={{ color: "var(--fg-1)" }}>Projects</span>
        </div>
      </Frame>
    ),
  },
  {
    id: "notes/archivepanel/default",
    group: "components",
    surface: "ArchivePanel",
    state: "default",
    fixture: NOTES_FIXTURE,
    description: "The archive panel listing folders that were archived out of the tree.",
    tags: ["notes", "archive", "folder", "panel"],
    render: () => (
      <Frame>
        <SidebarStateProvider>
          <WorkspaceProvider>
            <ArchivePanel
              open
              onClose={action("onClose")}
              archivedFolders={["projects/old", "notes/2024"]}
              onRestoreFolder={action("onRestoreFolder")}
              onDeleteFolderToTrash={action("onDeleteFolderToTrash")}
            />
          </WorkspaceProvider>
        </SidebarStateProvider>
      </Frame>
    ),
  },
  {
    id: "notes/trashpanel/default",
    group: "components",
    surface: "TrashPanel",
    state: "default",
    fixture: NOTES_FIXTURE,
    description: "The trash panel: soft-deleted notes awaiting restore or erase.",
    tags: ["notes", "trash", "delete", "panel"],
    render: () => (
      <Frame>
        <SidebarStateProvider>
          <WorkspaceProvider>
            <TrashPanel open onClose={action("onClose")} />
          </WorkspaceProvider>
        </SidebarStateProvider>
      </Frame>
    ),
  },
  {
    id: "notes/chathistorymodal/default",
    group: "components",
    surface: "ChatHistoryModal",
    state: "default",
    fixture: NOTES_FIXTURE,
    description: "The list of past AI conversations, with no conversation yet selected.",
    tags: ["notes", "chat", "history", "modal"],
    render: () => (
      <Frame>
        <ChatHistoryModal open onClose={action("onClose")} />
      </Frame>
    ),
  },
  {
    id: "notes/memorypopover/default",
    group: "components",
    surface: "MemoryPopover",
    state: "default",
    fixture: NOTES_FIXTURE,
    description: "The agent-memory popover: what the assistant has been told to remember.",
    tags: ["notes", "ai", "memory", "popover"],
    render: () => (
      <Frame>
        <MemoryPopover
          onClose={action("onClose")}
          onOpenSettings={action("onOpenSettings")}
          onShowToast={action("onShowToast")}
        />
      </Frame>
    ),
  },
];
