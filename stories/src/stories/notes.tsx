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
import { ColorGroupEditor } from "@app/notes/components/ColorGroupEditor";
import { ContextMenu } from "@app/notes/components/ContextMenu";
import { DecorationPopover } from "@app/notes/components/DecorationPopover";
import { DeleteConfirmModal } from "@app/notes/components/DeleteConfirmModal";
import { DiffView } from "@app/notes/components/DiffView";
import { FolderGlyph } from "@app/notes/components/FolderGlyph";
import { LeftRibbon } from "@app/notes/components/LeftRibbon";
import { MemoryPopover } from "@app/notes/components/MemoryPopover";
import { NewTabChooser } from "@app/notes/components/NewTabChooser";
import { NoteActionsMenu } from "@app/notes/components/NoteActionsMenu";
import { NoteRow } from "@app/notes/components/NoteRow";
import { FilterBuilder } from "@app/notes/components/FilterBuilder";
import { TaskListPanel } from "@app/notes/components/TaskListPanel";
import { ViewSettings } from "@app/notes/components/ViewSettings";
import { ViewsSection } from "@app/notes/components/ViewsSection";
import { DEFAULT_TASK_VIEW } from "@app/notes/taskView";
import type { SavedView } from "@app/lib/prefs";
import { PanelEmptyState } from "@app/notes/components/PanelEmptyState";
import { SaveStatus } from "@app/notes/components/SaveStatus";
import { TabStrip } from "@app/notes/components/TabStrip";
import { TrashPanel } from "@app/notes/components/TrashPanel";
import { TreeRails } from "@app/notes/components/TreeRails";
import { VirtualList } from "@app/notes/components/VirtualList";

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

  // ── Batch: the prop-driven surfaces (myne-md/myne#845 task 16) ─────────────
  // Each takes its shape as PROPS rather than from a provider, so these were
  // reachable all along and the earlier "context-bound" reading of the debt list
  // was wrong for them. That is why they are here rather than in a fixture layer.
  {
    id: "notes/savestatus/saved",
    group: "components",
    surface: "SaveStatus",
    state: "saved",
    description: "The save readout at rest, after a write landed.",
    tags: ["notes", "save", "status", "saved"],
    render: () => <SaveStatus status={{ status: "saved", at: new Date() }} onRetry={action("onRetry")} />,
  },
  {
    id: "notes/savestatus/error",
    group: "components",
    surface: "SaveStatus",
    state: "error",
    description: "A failed save, with the retry affordance and the unsynced marker.",
    tags: ["notes", "save", "status", "error", "retry"],
    render: () => (
      <SaveStatus
        status={{ status: "error", error: new Error("disk full") }}
        onRetry={action("onRetry")}
        unsynced
      />
    ),
  },
  {
    id: "notes/contextmenu/default",
    group: "components",
    surface: "ContextMenu",
    state: "default",
    description: "The note context menu, grouped the way the sidebar opens it.",
    tags: ["notes", "menu", "context", "row actions"],
    render: () => (
      <ContextMenu
        x={120}
        y={90}
        onClose={action("onClose")}
        items={[
          { id: "open", label: "Open", group: "open", onSelect: action("open") },
          { id: "side", label: "Open to the side", group: "open", onSelect: action("side") },
          { id: "rename", label: "Rename", group: "edit", onSelect: action("rename") },
          { id: "trash", label: "Move to trash", group: "destructive", onSelect: action("trash") },
        ]}
      />
    ),
  },
  {
    id: "notes/decorationpopover/default",
    group: "components",
    surface: "DecorationPopover",
    state: "default",
    description: "The colour and icon picker a sidebar row opens.",
    tags: ["notes", "colour", "icon", "popover", "decoration"],
    render: () => (
      <DecorationPopover
        x={120}
        y={90}
        color={null}
        onSelectColor={action("onSelectColor")}
        onClose={action("onClose")}
      />
    ),
  },
  {
    id: "notes/deleteconfirmmodal/default",
    group: "components",
    surface: "DeleteConfirmModal",
    state: "default",
    description: "The delete confirmation, naming the note it would remove.",
    tags: ["notes", "delete", "confirm", "modal", "destructive"],
    render: () => (
      <DeleteConfirmModal
        noteTitle="Meeting notes"
        onConfirm={action("onConfirm")}
        onCancel={action("onCancel")}
      />
    ),
  },
  {
    id: "notes/noteactionsmenu/default",
    group: "components",
    surface: "NoteActionsMenu",
    state: "default",
    description: "The per-note actions menu behind the row ellipsis.",
    tags: ["notes", "menu", "actions", "ellipsis"],
    render: () => (
      <NoteActionsMenu
        label="Note actions"
        items={[
          { kind: "action", action: "open", label: "Open", onSelect: action("open") },
          { kind: "action", action: "pin", label: "Pin", onSelect: action("pin") },
          { kind: "divider" },
          { kind: "action", action: "trash", label: "Move to trash", destructive: true, onSelect: action("trash") },
        ]}
      />
    ),
  },
  {
    id: "notes/virtuallist/default",
    group: "components",
    surface: "VirtualList",
    state: "default",
    description: "The virtualised list, rendering a window of rows rather than all of them.",
    tags: ["notes", "list", "virtual", "performance", "sidebar"],
    render: () => (
      <Frame>
        <VirtualList
          items={["Alpha", "Bravo", "Charlie", "Delta", "Echo"]}
          renderItem={(item) => (
            <div style={{ padding: "var(--space-2) var(--space-3)" }}>{item}</div>
          )}
        />
      </Frame>
    ),
  },
  {
    id: "notes/colorgroupeditor/default",
    fixture: NOTES_FIXTURE,
    group: "components",
    surface: "ColorGroupEditor",
    state: "default",
    description: "Colour groups derived from tags, with the affordance to make them editable.",
    tags: ["notes", "colour", "groups", "graph", "tags"],
    render: () => (
      <SidebarStateProvider>
        <Frame>
          <ColorGroupEditor
            derivedGroupCount={3}
            onMaterializeDerived={action("onMaterializeDerived")}
          />
        </Frame>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/leftribbon/default",
    group: "components",
    surface: "LeftRibbon",
    state: "default",
    description: "The left ribbon rail, driven by the command registry.",
    tags: ["notes", "ribbon", "rail", "commands"],
    fixture: NOTES_FIXTURE,
    render: () => (
      <Frame>
        <LeftRibbon />
      </Frame>
    ),
  },
  {
    id: "notes/tabstrip/default",
    group: "components",
    surface: "TabStrip",
    state: "default",
    description: "A pane's tab strip with an active, a pinned and an untitled tab.",
    tags: ["notes", "tabs", "pane", "strip"],
    render: () => (
      <Frame>
        <TabStrip
          paneId="pane-1"
          tabs={["t1", "t2", "t3"]}
          activeTab="t2"
          titleOf={(id) => (id === "t3" ? null : id === "t1" ? "Meeting notes" : "Reading list")}
          onActivate={action("onActivate")}
          onClose={action("onClose")}
          onNewTab={action("onNewTab")}
          onMoveTab={action("onMoveTab")}
        />
      </Frame>
    ),
  },
  {
    id: "notes/newtabchooser/default",
    fixture: NOTES_FIXTURE,
    group: "components",
    surface: "NewTabChooser",
    state: "default",
    description: "The empty-pane chooser: pick a note, start a note, or start a drawing.",
    tags: ["notes", "tab", "chooser", "empty pane"],
    render: () => (
      <SidebarStateProvider>
        <Frame>
          <NewTabChooser
            onPick={action("onPick")}
            onCreate={action("onCreate")}
            onCreateDrawing={action("onCreateDrawing")}
            cancellable
            onCancel={action("onCancel")}
          />
        </Frame>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/diffview/default",
    group: "components",
    surface: "DiffView",
    state: "default",
    description: "A line diff, with an added, a removed and an unchanged line.",
    tags: ["notes", "diff", "review", "agent"],
    render: () => (
      <Frame>
        <DiffView
          diff={[
            { type: "same", text: "## Agenda" },
            { type: "del", text: "- Ship the workbench" },
            { type: "add", text: "- Ship the workbench, and the rules that keep it true" },
          ]}
        />
      </Frame>
    ),
  },
  {
    id: "notes/noterow/selected",
    group: "components",
    surface: "NoteRow",
    state: "selected",
    description: "A sidebar row in its selected state, with a colour slot and a timestamp.",
    tags: ["notes", "sidebar", "row", "selected"],
    render: () => (
      <Frame>
        {/* The sidebar wraps rows in `role="tree"` (NoteList); `role="treeitem"`
            outside one is `aria-required-parent`, and it is a shape the app never
            renders (myne-md/myne#845). */}
        <div role="tree" aria-label="Notes">
          <NoteRow
          record={{
            noteUuid: "n1",
            title: "Meeting notes",
            folder: "Projects/",
            updatedAt: new Date(),
            trashed: null,
            deleted: null,
            archived: null,
            template: false,
            folderIndex: false,
            conflict: false,
            conflictOf: null,
            hasSource: true,
            kind: null,
            done: null,
          }}
          selected
          renaming={false}
          colorSlot="clay"
          showTimestamps
          onSelect={action("onSelect")}
          onStartRename={action("onStartRename")}
          onContextMenu={action("onContextMenu")}
          onCommitRename={action("onCommitRename")}
          onCancelRename={action("onCancelRename")}
        />
        </div>
      </Frame>
    ),
  },
  {
    id: "notes/noterow/untitled",
    group: "components",
    surface: "NoteRow",
    state: "untitled",
    description: "A row with no title yet, which is what a brand-new note looks like.",
    tags: ["notes", "sidebar", "row", "untitled", "empty"],
    render: () => (
      <Frame>
        {/* The sidebar wraps rows in `role="tree"` (NoteList); `role="treeitem"`
            outside one is `aria-required-parent`, and it is a shape the app never
            renders (myne-md/myne#845). */}
        <div role="tree" aria-label="Notes">
          <NoteRow
          record={{
            noteUuid: "n2",
            title: null,
            folder: null,
            updatedAt: null,
            trashed: null,
            deleted: null,
            archived: null,
            template: false,
            folderIndex: false,
            conflict: false,
            conflictOf: null,
            hasSource: true,
            kind: null,
            done: null,
          }}
          selected={false}
          renaming={false}
          onSelect={action("onSelect")}
          onStartRename={action("onStartRename")}
          onContextMenu={action("onContextMenu")}
          onCommitRename={action("onCommitRename")}
            onCancelRename={action("onCancelRename")}
          />
        </div>
      </Frame>
    ),
  },
  {
    id: "notes/filterbuilder/default",
    fixture: NOTES_FIXTURE,
    group: "components",
    surface: "FilterBuilder",
    state: "default",
    description: "The view filter builder with one seeded condition and a folder choice.",
    tags: ["notes", "views", "filter", "builder"],
    render: () => (
      <SidebarStateProvider>
        <Frame>
          <FilterBuilder
            title="Edit filter"
            initialDraft={{
              combinator: "and",
              groups: [
                {
                  combinator: "and",
                  conditions: [{ type: "tag", value: "project", negated: false }],
                },
              ],
            }}
            folderOptions={[{ path: "Projects/", label: "Projects" }]}
            onCancel={action("onCancel")}
            onSave={action("onSave")}
          />
        </Frame>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/tasklistpanel/default",
    group: "components",
    surface: "TaskListPanel",
    state: "default",
    description: "The vault-wide task list with an open, a due and a completed task.",
    tags: ["notes", "tasks", "list", "panel"],
    render: () => (
      <Frame>
        <TaskListPanel
          tasks={[
            {
              noteId: "n1",
              noteTitle: "Meeting notes",
              noteFolder: "Projects/",
              lineIndex: 12,
              rawLine: "- [ ] Send the recap",
              completed: false,
              oversized: false,
              due: "2026-10-12",
            },
            {
              noteId: "n1",
              noteTitle: "Meeting notes",
              noteFolder: "Projects/",
              lineIndex: 13,
              rawLine: "- [x] Book the room",
              completed: true,
              oversized: false,
            },
            {
              noteId: "n2",
              noteTitle: null,
              noteFolder: null,
              lineIndex: null,
              rawLine: "- [ ] Untitled note task",
              completed: false,
              oversized: false,
              priority: "high",
            },
          ]}
          view={DEFAULT_TASK_VIEW}
          today="2026-10-09"
          rowScope="vault"
          onViewChange={action("onViewChange")}
        />
      </Frame>
    ),
  },
  {
    id: "notes/viewsettings/default",
    group: "components",
    surface: "ViewSettings",
    state: "default",
    description: "The per-view display settings, seeded from the view being edited.",
    tags: ["notes", "views", "settings", "display"],
    render: () => (
      <Frame>
        <ViewSettings
          title="Reading list"
          initial={{}}
          propertyKeys={["status", "priority", "owner"]}
          onCancel={action("onCancel")}
          onSave={action("onSave")}
        />
      </Frame>
    ),
  },
  {
    id: "notes/viewssection/default",
    group: "components",
    surface: "ViewsSection",
    state: "default",
    description: "The saved-views list with one active view and one unfiltered view.",
    tags: ["notes", "views", "sidebar", "section"],
    render: () => {
      const views: SavedView[] = [
        {
          id: "v1",
          name: "Reading list",
          view_type: "list",
          filters: { kind: "hasTag", tag: "reading" },
        },
        {
          id: "v2",
          name: "Everything",
          view_type: "table",
          filters: { kind: "all" },
        },
      ];
      return (
        <Frame>
          <ViewsSection
            views={views}
            activeViewId="v1"
            onOpenView={action("onOpenView")}
            onNewView={action("onNewView")}
            onEditFilter={action("onEditFilter")}
            onViewSettings={action("onViewSettings")}
            onRename={action("onRename")}
            onDelete={action("onDelete")}
            onMoveView={action("onMoveView")}
          />
        </Frame>
      );
    },
  },
];
