// Stories for the graph family (myne-md/myne#845 task 14).
//
// Split out of `notes.tsx` so that file stays readable: the four surfaces share
// a model shape and a settings object, and the pane story needs the whole
// provider stack. Each renders the real component against a small linked model.

import type { Fixture, StoryDescriptor } from "../types";
import { DEFAULT_PREFS } from "../../fixtures";
import { action } from "../actions";
import { SidebarStateProvider, type SidebarState } from "@app/notes/sidebarState";
import { WorkspaceProvider } from "@app/notes/workspaceContext";
import type { TitleRecord } from "@app/notes/loadNoteBatch";
import type { WikilinkEdge, GraphModel } from "@app/notes/graphModel";
import type { LeafPane, WorkspaceState } from "@app/notes/workspaceState";
import { DEFAULT_GRAPH_SETTINGS } from "@app/notes/graphSettings";
import { foldSegment } from "@app/dialect/folderPath";

import { GraphPane } from "@app/notes/components/GraphView";
import GraphCanvas from "@app/notes/components/GraphCanvas";
import { GraphList } from "@app/notes/components/GraphList";
import { GraphSettingsPanel } from "@app/notes/components/GraphSettingsPanel";

/** A `TitleRecord` with every field the sidebar derives from, defaulted. */
function noteRecord(over: Partial<TitleRecord> & { noteUuid: string }): TitleRecord {
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

const SEEDED_CACHE = new Map<string, TitleRecord>([
  ["n1", noteRecord({ noteUuid: "n1", title: "Meeting notes", folder: "Projects/" })],
  ["n2", noteRecord({ noteUuid: "n2", title: "Reading list", folder: null })],
  ["n3", noteRecord({ noteUuid: "n3", title: "Weekly review", folder: "Projects/" })],
]);

const SEEDED_SIDEBAR: SidebarState = {
  selectedId: null,
  selectedIds: new Set(),
  anchorId: null,
  renamingId: null,
  justCreatedId: null,
  cache: SEEDED_CACHE,
  contentReloadNonce: 0,
};

const EMPTY_LEAF: LeafPane = { kind: "leaf", id: "pane-1", tabs: [], activeTab: null };

const SEEDED_WORKSPACE: WorkspaceState = {
  root: EMPTY_LEAF,
  focusedPaneId: "pane-1",
};

/** One wikilink edge, the shape `vault_indices_all_edges` returns per source. */
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

const GRAPH_FIXTURE: Fixture = {
  description: "one unlocked vault with three notes and two wikilinks between them",
  handlers: {
    "plugin:prefs|prefs_read": () => DEFAULT_PREFS,
    "plugin:vault-indices|vault_indices_tag_tree": () => [
      { key: "project", display: "project", depth: 0, directCount: 2, subtreeCount: 2 },
    ],
    "plugin:vault-indices|vault_indices_all_edges": () => [
      ["n1", [wikilinkEdge("Reading list")]],
      ["n2", [wikilinkEdge("Meeting notes")]],
    ],
    "plugin:vault-indices|vault_indices_by_tag": () => ["n1", "n3"],
    "plugin:vault-indices|vault_indices_orphans": () => ["n3"],
    "plugin:graph-layout|graph_layout_read": () => null,
  },
};

/** A small linked model, notes plus one tag hub, for the list and canvas. */
const MODEL: GraphModel = {
  nodes: [
    { id: "n1", title: "Meeting notes" },
    { id: "n2", title: "Reading list" },
    { id: "tag:project", title: "#project", kind: "tag" },
  ],
  edges: [
    { source: "n1", target: "n2", weight: 1 },
    { source: "tag:project", target: "n1", weight: 1 },
  ],
};

function Box({
  width,
  height,
  children,
}: {
  width: number;
  height: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        width,
        height,
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

export const GRAPH_STORIES: StoryDescriptor[] = [
  {
    id: "notes/graphview/whole-vault",
    group: "components",
    surface: "GraphView",
    state: "whole-vault",
    description: "The graph tab rendering the whole vault, with its filter and view controls.",
    tags: ["notes", "graph", "pane", "vault", "canvas"],
    fixture: GRAPH_FIXTURE,
    render: () => (
      <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
        <WorkspaceProvider initialState={SEEDED_WORKSPACE}>
          <Box width={640} height={420}>
            <GraphPane />
          </Box>
        </WorkspaceProvider>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/graphlist/populated",
    group: "components",
    surface: "GraphList",
    state: "populated",
    description: "The accessible list rendering of the graph: note rows and one tag hub row.",
    tags: ["notes", "graph", "list", "accessible", "tags"],
    render: () => (
      <Box width={420} height={300}>
        <GraphList model={MODEL} onOpen={action("onOpen")} onOpenTag={action("onOpenTag")} />
      </Box>
    ),
  },
  {
    id: "notes/graphsettingspanel/open",
    group: "components",
    surface: "GraphSettingsPanel",
    state: "open",
    description: "The graph settings panel: appearance, forces and colour-group sections.",
    tags: ["notes", "graph", "settings", "appearance", "forces"],
    fixture: GRAPH_FIXTURE,
    render: () => (
      <SidebarStateProvider initialState={SEEDED_SIDEBAR}>
        <div style={{ padding: "var(--space-4)", background: "var(--bg-1)" }}>
          <GraphSettingsPanel
            open
            onClose={action("onClose")}
            settings={DEFAULT_GRAPH_SETTINGS}
            onChange={action("onChange")}
            onReset={action("onReset")}
            derivedGroupCount={3}
            onMaterializeDerived={action("onMaterializeDerived")}
          />
        </div>
      </SidebarStateProvider>
    ),
  },
  {
    id: "notes/graphcanvas/small-model",
    group: "components",
    surface: "GraphCanvas",
    state: "small-model",
    description: "The canvas renderer for a three-node model, with two nodes colour-grouped.",
    tags: ["notes", "graph", "canvas", "renderer", "colours"],
    // The canvas needs a real Worker to lay the graph out; the shared renderer
    // falls back to a synchronous settle when the Worker cannot be constructed,
    // which is what happens under jsdom and is the same final picture. In a real
    // browser this story paints; the element and its controls render either way.
    render: () => (
      <Box width={520} height={360}>
        <GraphCanvas
          model={MODEL}
          ariaLabel="Graph of 2 notes"
          onNodeClick={action("onNodeClick")}
          nodeColors={new Map([["n1", "group-teal"]])}
        />
      </Box>
    ),
  },
];
