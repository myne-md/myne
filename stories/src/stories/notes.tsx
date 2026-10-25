// Stories for the notes-domain surfaces (myne-md/myne#845 task 16).
//
// These live under `src/notes/components`, which the coverage guard counts as a
// surface root. Each entry renders the real component with the props its own
// signature requires, and a fixture supplying the prefs the panels read; a bare
// mount would render an empty box and would be worse than the recorded debt.

import { useRef } from "react";
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
import { IconButton } from "@app/components/primitives/IconButton";
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

// ── Batch: the context-bound and prop-driven surfaces (myne-md/myne#845 task 14).
// The graph family lives in `graph.tsx` to keep this file readable.
import { useEffect, type ReactNode } from "react";
import type { SidebarState } from "@app/notes/sidebarState";
import type { TitleRecord } from "@app/notes/loadNoteBatch";
import type { FolderNode } from "@app/notes/folderTree";
import type { ResolverNote } from "@app/notes/resolveWikilink";
import type { WikilinkEdge } from "@app/notes/graphModel";
import {
  tasksItem,
  type LeafPane,
  type WorkspaceNode,
  type WorkspaceState,
} from "@app/notes/workspaceState";
import { foldSegment } from "@app/dialect/folderPath";
import { emitStoryEvent } from "../host/internals";

import { BacklinksTab } from "@app/notes/components/BacklinksTab";
import { WhoIsHereTab } from "@app/notes/components/WhoIsHereTab";
import { setAwareness } from "@app/notes/collab/awarenessStore";
import { participantWithColor } from "@app/notes/collab/participant";
import { ChatComposer } from "@app/notes/components/ChatComposer";
import { ConflictsView } from "@app/notes/components/ConflictsView";
import { FolderRow } from "@app/notes/components/FolderRow";
import { NoteList } from "@app/notes/components/NoteList";
import { OutlineTab } from "@app/notes/components/OutlineTab";
import { PaneTree } from "@app/notes/components/PaneTree";
import { PaneView } from "@app/notes/components/PaneView";
import { ProposalDiffModal } from "@app/notes/components/ProposalDiffModal";
import { SidebarSearchRow } from "@app/notes/components/SidebarSearchRow";
import { SnapshotFailedIndicator } from "@app/notes/components/SnapshotFailedIndicator";
import { SnapshotsPanel } from "@app/notes/components/SnapshotsPanel";
import { TagBrowser } from "@app/notes/components/TagBrowser";
import { TasksPane } from "@app/notes/components/TasksPane";
import { UnlinkedMentionsSection } from "@app/notes/components/UnlinkedMentionsSection";

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
    // The memory surfaces read `{ rows, cap }` since myne-md/myne#867: the cap
    // travels WITH the roster so no client keeps a second copy of the number.
    // An unhandled command answers `[]`, which reads as a response with no
    // `rows` at all and throws in the popover, which is how the stories lane
    // found this, rather than a reviewer.
    "plugin:memory|memory_list": () => ({
      rows: [
        { id: "m1", created_at: 1, updated_at: 2, version: 1, quarantined: false },
      ],
      cap: 100,
    }),
    "plugin:memory|memory_read": () => "The user's name is Ömer.",
  },
};

/** The composer's own host read, answered two ways.
 *
 *  `agent_preview_grant` is what the composer asks for the size of its scope,
 *  and the two states that come from it are the ones a story has to be able to
 *  reach: a scope the clamp emptied, and a count that has not arrived yet. The
 *  unhandled default (`[]`) reads as "not empty, not known", which is the third
 *  state and the one the idle story already shows. */
const EMPTY_SCOPE_FIXTURE: Fixture = {
  ...NOTES_FIXTURE,
  description: "one unlocked vault whose scope resolves to no notes",
  handlers: {
    ...NOTES_FIXTURE.handlers,
    "plugin:agent|agent_preview_grant": () => ({
      noteCount: 0,
      excludedCount: 0,
      unknownCount: 0,
      newTotal: 0,
    }),
  },
};

const PENDING_SCOPE_FIXTURE: Fixture = {
  ...NOTES_FIXTURE,
  description: "one unlocked vault, the scope's size still in flight",
  handlers: {
    ...NOTES_FIXTURE.handlers,
    // Never settles, which is the state: the composer has asked and has no
    // answer, and it must say so rather than claim the vault is empty.
    "plugin:agent|agent_preview_grant": () => new Promise(() => {}),
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

/** A `TitleRecord` with every field the sidebar derives from, defaulted. */
function noteRecord(
  over: Partial<TitleRecord> & { noteUuid: string },
): TitleRecord {
  return {
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
    ...over,
  };
}

/** Three live notes: two in a folder, one loose, so a tree renders populated. */
const SEEDED_CACHE = new Map<string, TitleRecord>([
  [
    "n1",
    noteRecord({
      noteUuid: "n1",
      title: "Meeting notes",
      folder: "Projects/",
      updatedAt: new Date("2026-10-09T09:00:00Z"),
    }),
  ],
  [
    "n2",
    noteRecord({
      noteUuid: "n2",
      title: "Reading list",
      folder: null,
      updatedAt: new Date("2026-10-08T09:00:00Z"),
    }),
  ],
  [
    "n3",
    noteRecord({
      noteUuid: "n3",
      title: "Weekly review",
      folder: "Projects/",
      updatedAt: new Date("2026-10-07T09:00:00Z"),
    }),
  ],
]);

/** A sidebar seeded with those notes and "Meeting notes" open. */
const SEEDED_SIDEBAR: SidebarState = {
  selectedId: "n1",
  selectedIds: new Set(),
  anchorId: null,
  renamingId: null,
  justCreatedId: null,
  cache: SEEDED_CACHE,
  contentReloadNonce: 0,
};

/** The resolver note-set the reader surfaces resolve wikilinks against. */
const SEEDED_RESOLVER_NOTES: ResolverNote[] = [
  { noteUuid: "n1", title: "Meeting notes", folder: "Projects/" },
  { noteUuid: "n2", title: "Reading list", folder: null },
  { noteUuid: "n3", title: "Weekly review", folder: "Projects/" },
];

/** One wikilink edge, the shape the index returns for `forward`/candidates. */
function wikilinkEdge(target: string): WikilinkEdge {
  return {
    target,
    targetKind: "title",
    titleKey: foldSegment(target),
    anchor: null,
    blockId: null,
    alias: null,
    embed: false,
    byteStart: 0,
    byteEnd: 0,
  };
}

/** A workspace descriptor for a seeded pane tree. */
function seedWorkspace(
  root: WorkspaceNode,
  focusedPaneId: string,
): WorkspaceState {
  return { root, focusedPaneId };
}

/** One empty leaf pane, the state a fully-closed workspace lands in. */
const EMPTY_LEAF: LeafPane = {
  kind: "leaf",
  id: "pane-1",
  tabs: [],
  activeTab: null,
};

/** A row split of two empty panes, for the pane-tree story. */
const SPLIT_TREE: WorkspaceNode = {
  kind: "split",
  id: "split-1",
  direction: "row",
  children: [
    { kind: "leaf", id: "pane-1", tabs: [], activeTab: null },
    { kind: "leaf", id: "pane-2", tabs: [], activeTab: null },
  ],
};

/**
 * Fire a backend event once, after the child has subscribed.
 *
 * The child's passive effect runs before this parent's (React flushes child
 * effects first), and the fake host registers a listener synchronously inside
 * `listen`'s `invoke`, so the emit lands on a live subscription. Used by the
 * two event-driven surfaces, whose only reachable state is the one the event
 * produces (myne-md/myne#845).
 */
function EmitStoryEvent({
  name,
  payload,
  children,
}: {
  name: string;
  payload?: unknown;
  children: ReactNode;
}) {
  useEffect(() => {
    emitStoryEvent(name, payload);
  }, [name, payload]);
  return <>{children}</>;
}

/** A fixed-size box so a full-bleed surface is judged in its own frame. */
function Box({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        width,
        height,
        background: "var(--paper-2)",
        border: "1px solid var(--line-1)",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/**
 * The default prefs plus the IPC the reader surfaces call. `note_read` returns
 * one body with a heading structure, `backlink_candidates`/`forward` return the
 * edges that resolve against {@link SEEDED_RESOLVER_NOTES}, and `tag_tree` /
 * `by_tag` drive the tag browser. All three reuse the same three notes so the
 * stories stay consistent.
 */
const NOTES_POPULATED_FIXTURE: Fixture = {
  description: "one unlocked vault with three notes and the index answers they need",
  handlers: {
    ...NOTES_FIXTURE.handlers,
    "plugin:notes|note_read": () =>
      "# Meeting notes\n\n## Agenda\n\n### Attendees\n\n## Actions\n",
    "plugin:notes|note_search": () => [
      {
        note_id: "n2",
        title: "Reading list",
        score: 1,
        matched_in: { title: false, body: true },
        attachment_id: null,
      },
    ],
    "plugin:vault-indices|vault_indices_backlink_candidates": () => [
      { source: "n2", edge: wikilinkEdge("Meeting notes") },
    ],
    "plugin:vault-indices|vault_indices_forward": () => [
      wikilinkEdge("Reading list"),
    ],
    "plugin:vault-indices|vault_indices_tag_tree": () => [
      { key: "project", display: "project", depth: 0, directCount: 2, subtreeCount: 2 },
      { key: "project/alpha", display: "project/alpha", depth: 1, directCount: 1, subtreeCount: 1 },
    ],
    "plugin:vault-indices|vault_indices_by_tag": () => ["n1", "n3"],
    "plugin:vault-indices|vault_indices_tasks": () => [
      {
        noteId: "n1",
        noteTitle: "Meeting notes",
        noteFolder: "Projects/",
        lineIndex: 4,
        rawLine: "- [ ] Send the recap",
        completed: false,
        oversized: false,
        due: "2026-10-12",
      },
      {
        noteId: "n1",
        noteTitle: "Meeting notes",
        noteFolder: "Projects/",
        lineIndex: 5,
        rawLine: "- [x] Book the room",
        completed: true,
        oversized: false,
      },
    ],
    "plugin:snapshots|snapshot_list": () => [
      {
        snapshot_uuid: "00000000-0000-7000-8000-0000000000b1",
        captured_at_ms: Date.UTC(2026, 9, 9, 8, 55, 0),
        size_bytes: 4096,
        resolved_author: { kind: "Device", name: "Ada's Laptop", code: "aabbcc" },
      },
      {
        snapshot_uuid: "00000000-0000-7000-8000-0000000000b2",
        captured_at_ms: Date.UTC(2026, 9, 8, 17, 20, 0),
        size_bytes: 2048,
        resolved_author: { kind: "Unknown" },
      },
    ],
  },
};

/**
 * `MemoryPopover` takes its trigger as a REF rather than rendering one
 * (myne-md/myne#867): `AnchoredPanel` measures the anchor and portals the card
 * to the body, so a story with no real anchor element renders nothing at all.
 * The trigger below is the same icon button the chat header mounts it beside.
 */
function MemoryPopoverStory() {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  return (
    <Frame>
      <span ref={anchorRef} style={{ display: "inline-flex" }}>
        <IconButton icon="bookmark" label="Memory" onClick={action("onToggle")} />
      </span>
      <MemoryPopover
        anchorRef={anchorRef}
        onClose={action("onClose")}
        onOpenSettings={action("onOpenSettings")}
        onShowToast={action("onShowToast")}
      />
    </Frame>
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
    render: () => <MemoryPopoverStory />,
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
    description:
      "The per-view settings, seeded from the view being edited: render type, grouping, sort, columns, the writable-field set a shared view carries, and the read-only version. Look for archived, deleted and trashed to be absent from the writable picker, because the import path refuses them outright.",
    tags: ["notes", "views", "settings", "display", "sharing", "version"],
    render: () => (
      <Frame>
        <ViewSettings
          title="Reading list"
          initial={{ write_fields: ["status"] }}
          version={4}
          onExport={action("onExport")}
          // `archived` is in the vault's key universe on purpose: the picker
          // filters it out rather than the fixture hiding it.
          propertyKeys={["status", "priority", "owner", "archived", "trashed"]}
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

  // ── Batch: the remaining surfaces (myne-md/myne#845 task 14) ───────────────
  {
    id: "notes/folderrow/populated",
    group: "components",
    surface: "FolderRow",
    state: "populated",
    description: "A folder row with notes inside, its disclosure chevron and a colour label.",
    tags: ["notes", "folder", "row", "sidebar", "tree"],
    render: () => {
      const node: FolderNode = {
        path: "Projects/",
        key: "projects",
        name: "Projects",
        depth: 1,
        deliberate: true,
        noteIds: ["n1", "n3"],
        indexNoteId: null,
        indexConflictIds: [],
        children: [],
      };
      return (
        <Frame>
          {/* `role="treeitem"` needs a `role="tree"` parent; the sidebar always
              supplies one (NoteList), and a bare treeitem is an
              `aria-required-parent` violation the app never renders. */}
          <div role="tree" aria-label="Notes" style={{ width: 260 }}>
            <FolderRow
              node={node}
              depth={1}
              hierarchy={{ level: 1, posInSet: 1, setSize: 1 }}
              collapsed={false}
              empty={false}
              colorSlot="clay"
              onToggle={action("onToggle")}
              onContextMenu={action("onContextMenu")}
              onCommitRename={action("onCommitRename")}
              onCancelRename={action("onCancelRename")}
              onOpenIndexNote={action("onOpenIndexNote")}
              onCreateFolderNote={action("onCreateFolderNote")}
              onActivate={action("onActivate")}
            />
          </div>
        </Frame>
      );
    },
  },
  {
    id: "notes/sidebarsearchrow/default",
    group: "components",
    surface: "SidebarSearchRow",
    state: "default",
    description: "The sidebar search entry, with the command palette's chord in its tooltip.",
    tags: ["notes", "sidebar", "search", "palette"],
    fixture: NOTES_FIXTURE,
    render: () => (
      <Frame>
        <Box width={260} height={48}>
          <div style={{ padding: "var(--space-2)" }}>
            <SidebarSearchRow />
          </div>
        </Box>
      </Frame>
    ),
  },
  {
    id: "notes/notelist/populated",
    group: "components",
    surface: "NoteList",
    state: "populated",
    description: "The notes sidebar with a folder, its notes and a loose note in the tree.",
    tags: ["notes", "sidebar", "list", "tree", "folder"],
    fixture: NOTES_POPULATED_FIXTURE,
    render: () => (
      <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
        <WorkspaceProvider initialState={seedWorkspace(EMPTY_LEAF, "pane-1")}>
          <Box width={280} height={520}>
            <NoteList />
          </Box>
        </WorkspaceProvider>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/backlinkstab/populated",
    group: "components",
    surface: "BacklinksTab",
    state: "populated",
    description: "The links tab with one incoming and one outgoing wikilink row.",
    tags: ["notes", "backlinks", "links", "right panel"],
    fixture: NOTES_POPULATED_FIXTURE,
    render: () => (
      <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
        <Box width={280} height={260}>
          <div style={{ padding: "var(--space-3)" }}>
            <BacklinksTab />
          </div>
        </Box>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/whoisheretab/populated",
    group: "components",
    surface: "WhoIsHereTab",
    state: "populated",
    description:
      "The 'Who's here' live-presence roster with two peers editing the open note, each a colour dot and a jump button.",
    tags: ["notes", "collab", "presence", "roster", "right panel"],
    fixture: NOTES_POPULATED_FIXTURE,
    render: () => {
      // The awareness store is module-scope; seed it so the roster shows peers.
      // Peers are keyed by NOTE (`peersByNote`), and the tab reads the peers of the
      // sidebar's SELECTED note, so the seeded note id must match `selectedId`.
      const rosterNoteId = "n1";
      setAwareness({
        peersByNote: new Map([
          [
            rosterNoteId,
            new Map(
              [
                participantWithColor({
                  id: "device:a",
                  noteId: rosterNoteId,
                  label: { kind: "text", text: "Ada's Laptop" },
                  unAttributed: false,
                  caret: 12,
                  selection: null,
                }),
                participantWithColor({
                  id: "device:b",
                  noteId: rosterNoteId,
                  label: { kind: "text", text: "Bob" },
                  unAttributed: false,
                  caret: 3,
                  selection: null,
                }),
              ].map((p) => [p.id, p]),
            ),
          ],
        ]),
        droppedAt: null,
      });
      return (
        <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
          <Box width={280} height={200}>
            <div style={{ padding: "var(--space-3)" }}>
              <WhoIsHereTab />
            </div>
          </Box>
        </SidebarStateProvider>
      );
    },
  },
  {
    id: "notes/outlinetab/populated",
    group: "components",
    surface: "OutlineTab",
    state: "populated",
    description: "The outline tab listing the open note's heading structure.",
    tags: ["notes", "outline", "headings", "right panel"],
    fixture: NOTES_POPULATED_FIXTURE,
    render: () => (
      <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
        <Box width={280} height={260}>
          <div style={{ padding: "var(--space-3)" }}>
            <OutlineTab />
          </div>
        </Box>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/unlinkedmentionssection/populated",
    group: "components",
    surface: "UnlinkedMentionsSection",
    state: "populated",
    description: "The unlinked-mentions section with one note that names this title in prose.",
    tags: ["notes", "mentions", "backlinks", "right panel"],
    // `backlink_candidates` answers EMPTY here, unlike the shared fixture: a
    // note that already wikilinks this title is excluded from unlinked
    // mentions by construction, so the two answers cannot both hold for n2.
    fixture: {
      description: "one note mentions the open title in prose without linking it",
      handlers: {
        ...NOTES_POPULATED_FIXTURE.handlers,
        "plugin:vault-indices|vault_indices_backlink_candidates": () => [],
      },
    },
    render: () => (
      <Box width={300} height={220}>
        <div style={{ padding: "var(--space-3)" }}>
          <UnlinkedMentionsSection
            openNoteId="n1"
            openTitle="Meeting notes"
            notes={SEEDED_RESOLVER_NOTES}
            onNavigate={action("onNavigate")}
            onLinkMention={async () => {
              action("onLinkMention")();
              return true;
            }}
            asTab
          />
        </div>
      </Box>
    ),
  },
  {
    id: "notes/tagbrowser/seeded-tag",
    group: "components",
    surface: "TagBrowser",
    state: "seeded-tag",
    description: "The tag browser opened on one tag, its chips and the filtered note list.",
    tags: ["notes", "tags", "browser", "filter", "modal"],
    fixture: NOTES_POPULATED_FIXTURE,
    render: () => (
      <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
        <TagBrowser open onClose={action("onClose")} seedTagKey="project" />
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/taskspane/vault-tasks",
    group: "components",
    surface: "TasksPane",
    state: "vault-tasks",
    description: "The vault-wide task tab with an open and a completed task.",
    tags: ["notes", "tasks", "pane", "list"],
    fixture: NOTES_POPULATED_FIXTURE,
    render: () => (
      <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
        <WorkspaceProvider initialState={seedWorkspace(EMPTY_LEAF, "pane-1")}>
          <Box width={520} height={420}>
            <TasksPane paneId="pane-1" item={tasksItem()} />
          </Box>
        </WorkspaceProvider>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/paneview/empty-pane",
    group: "components",
    surface: "PaneView",
    state: "empty-pane",
    description: "A pane with no active tab: its tab strip and the new-tab chooser.",
    tags: ["notes", "pane", "tabs", "empty", "chooser"],
    fixture: NOTES_FIXTURE,
    render: () => (
      <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
        <WorkspaceProvider initialState={seedWorkspace(EMPTY_LEAF, "pane-1")}>
          <Box width={520} height={380}>
            <PaneView leaf={EMPTY_LEAF} focused onReadout={action("onReadout")} />
          </Box>
        </WorkspaceProvider>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/panetree/row-split",
    group: "components",
    surface: "PaneTree",
    state: "row-split",
    description: "A workspace split into two side-by-side panes, each showing its own chooser.",
    tags: ["notes", "pane", "split", "layout", "workspace"],
    fixture: NOTES_FIXTURE,
    render: () => (
      <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
        <WorkspaceProvider initialState={seedWorkspace(SPLIT_TREE, "pane-1")}>
          <Box width={640} height={380}>
            <PaneTree node={SPLIT_TREE} focusedPaneId="pane-1" onReadout={action("onReadout")} />
          </Box>
        </WorkspaceProvider>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/conflictsview/grouped",
    group: "components",
    surface: "ConflictsView",
    state: "grouped",
    description: "Two conflict copies of one note, grouped, with their reconcile actions.",
    tags: ["notes", "conflicts", "sync", "reconcile", "diff"],
    render: () => {
      const originalUuid = "00000000-0000-7000-8000-0000000000aa";
      const groups = new Map<string, TitleRecord[]>([
        [
          originalUuid,
          [
            noteRecord({
              noteUuid: "c1",
              title: "Meeting notes (conflict)",
              conflict: true,
              conflictOf: originalUuid,
            }),
            noteRecord({
              noteUuid: "c2",
              title: "Meeting notes (conflict 2)",
              conflict: true,
              conflictOf: originalUuid,
            }),
          ],
        ],
      ]);
      return (
        <Frame>
          <div style={{ width: 560 }}>
            <ConflictsView
              groups={groups}
              onKeepBoth={action("onKeepBoth")}
              onDiscard={action("onDiscard")}
              onTakeTheirs={action("onTakeTheirs")}
              onCompare={action("onCompare")}
              compare={null}
              onCloseCompare={action("onCloseCompare")}
            />
          </div>
        </Frame>
      );
    },
  },
  {
    id: "notes/proposaldiffmodal/default",
    group: "components",
    surface: "ProposalDiffModal",
    state: "default",
    description: "A frozen agent proposal: one edit diffed and one new note.",
    tags: ["notes", "agent", "proposal", "diff", "modal"],
    render: () => (
      <ProposalDiffModal
        open
        onClose={action("onClose")}
        proposal={{
          edits: [
            {
              noteId: "n1",
              kind: "replace",
              anchor: "## Agenda\n\n- Ship the workbench",
              replacement: "## Agenda\n\n- Ship the workbench, and the rules that keep it true",
            },
          ],
          newNotes: [
            {
              title: "Follow-ups",
              body: "- Confirm the room\n- Send the recap",
              folder: "Projects/",
            },
          ],
        }}
      />
    ),
  },
  {
    id: "notes/snapshotspanel/listed",
    group: "components",
    surface: "SnapshotsPanel",
    state: "listed",
    description: "The snapshot panel listing two encrypted snapshots of the open note.",
    tags: ["notes", "snapshots", "recovery", "history", "modal"],
    fixture: NOTES_POPULATED_FIXTURE,
    render: () => (
      <SnapshotsPanel
        open
        onClose={action("onClose")}
        noteId="n1"
        noteTitle="Meeting notes"
        onRestored={action("onRestored")}
      />
    ),
  },
  {
    id: "notes/chatcomposer/idle",
    group: "components",
    surface: "ChatComposer",
    state: "idle",
    description: "The agent composer at rest, with the open note as its scope.",
    tags: ["notes", "ai", "agent", "composer", "chat"],
    fixture: NOTES_FIXTURE,
    render: () => (
      <Box width={320} height={220}>
        <div style={{ padding: "var(--space-3)" }}>
          <ChatComposer
            surface="sidebar"
            openNoteId="n1"
            folders={["Projects/"]}
            onNotesWritten={action("onNotesWritten")}
          />
        </div>
      </Box>
    ),
  },
  {
    id: "notes/chatcomposer/anchored-session",
    group: "components",
    surface: "ChatComposer",
    state: "anchored-session",
    description:
      "A session opened FROM a note: its scope is that note, so it renders no scope picker at all and the note cannot be moved out of the run by accident. Widening a session is a session-level decision, a new conversation starts vault-wide (myne-md/myne#848).",
    tags: ["notes", "ai", "agent", "composer", "scope", "anchored"],
    fixture: NOTES_FIXTURE,
    render: () => (
      <Box width={320} height={220}>
        <div style={{ padding: "var(--space-3)" }}>
          <ChatComposer
            surface="sidebar"
            openNoteId="n1"
            anchoredNoteId="n1"
            folders={["Projects/"]}
            onNotesWritten={action("onNotesWritten")}
          />
        </div>
      </Box>
    ),
  },
  {
    id: "notes/chatcomposer/scope-empty",
    group: "components",
    surface: "ChatComposer",
    state: "scope-empty",
    description:
      "The scope resolved to no notes: the field refuses the keystroke, the picker is outlined, and the placeholder says why. The count and the excluded figure stay on the line, they are the disclosure, not the picker (myne-md/myne#848).",
    tags: ["notes", "ai", "agent", "composer", "blocked", "excluded"],
    fixture: EMPTY_SCOPE_FIXTURE,
    render: () => (
      <Box width={320} height={220}>
        <div style={{ padding: "var(--space-3)" }}>
          <ChatComposer
            surface="sidebar"
            openNoteId="n1"
            folders={["Projects/"]}
            onNotesWritten={action("onNotesWritten")}
          />
        </div>
      </Box>
    ),
  },
  {
    id: "notes/chatcomposer/count-pending",
    group: "components",
    surface: "ChatComposer",
    state: "count-pending",
    description:
      "The host has not yet answered how many notes the scope holds: the box says it is getting ready rather than making a claim about the vault. Unanswered is not the same as empty, which the previous state shows (myne-md/myne#848).",
    tags: ["notes", "ai", "agent", "composer", "loading", "pending"],
    fixture: PENDING_SCOPE_FIXTURE,
    render: () => (
      <Box width={320} height={220}>
        <div style={{ padding: "var(--space-3)" }}>
          <ChatComposer
            surface="sidebar"
            openNoteId="n1"
            folders={["Projects/"]}
            onNotesWritten={action("onNotesWritten")}
          />
        </div>
      </Box>
    ),
  },
  {
    id: "notes/snapshotfailedindicator/failed",
    group: "components",
    surface: "SnapshotFailedIndicator",
    state: "failed",
    description: "The non-blocking notice shown when a pre-overwrite snapshot could not be written.",
    tags: ["notes", "snapshots", "notice", "toast", "error"],
    render: () => (
      <Frame>
        {/* The notice renders `null` until the backend fires
            `snapshot://write-failed`, and there is no other way to reach it: the
            fake host dispatches that event for the story. */}
        <EmitStoryEvent name="snapshot://write-failed">
          <SnapshotFailedIndicator />
        </EmitStoryEvent>
      </Frame>
    ),
  },
];
