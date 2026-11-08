// The tab-kind registry (myne-md/myne#773, epic #772 lane 0d).
//
// Two things are pinned here and they pull in opposite directions, which is the
// point. The registry must COVER the `WorkspaceItem` union — TypeScript cannot
// check a runtime array against a union type, so an unregistered kind throws at
// render rather than failing to compile — and the persisted reader must NOT
// require coverage, because an older client meeting a newer kind has to degrade
// instead of losing the whole workspace.

import { describe, expect, it } from "vitest";
import {
  TAB_KINDS,
  TAB_KIND_TAGS,
  canonicalTabId,
  isSingletonTabKind,
  tabKindSpec,
} from "../../src/notes/tabKinds";
import {
  ATTACHMENTS_TAB_ID,
  AGENT_TAB_ID,
  GRAPH_TAB_ID,
  TASKS_TAB_ID,
  TEMPLATES_TAB_ID,
  itemKey,
  parseItemKey,
  type WorkspaceItem,
} from "../../src/notes/workspaceState";

describe("the registry covers the union", () => {
  it("registers every kind the union declares", () => {
    // Hand-listed on purpose: this array IS the assertion. Widening the union
    // without registering the kind must fail HERE, and a derived list would
    // derive the same omission.
    const unionKinds: WorkspaceItem["kind"][] = [
      "note",
      "view",
      "graph",
      "tasks",
      "attachments",
      "templates",
      "agent",
      // myne-md/myne#1037: an event is a note and a vault has one schedule, so
      // the calendar is a singleton tab beside the graph and the task list.
      "calendar",
    ];
    expect([...TAB_KIND_TAGS].sort()).toEqual([...unionKinds].sort());
    for (const kind of unionKinds) {
      expect(() => tabKindSpec(kind), `${kind} is unregistered`).not.toThrow();
    }
  });

  it("gives every kind a glyph, and every singleton a label key", () => {
    for (const spec of TAB_KINDS) {
      expect(spec.icon, `${spec.kind} has no icon`).toBeTruthy();
      if (spec.singletonId !== undefined) {
        expect(spec.labelKey, `singleton ${spec.kind} has no label key`).toBeTruthy();
      }
    }
  });

  it("derives singleton-ness from the sentinel rather than a second list", () => {
    expect(isSingletonTabKind("graph")).toBe(true);
    expect(isSingletonTabKind("tasks")).toBe(true);
    expect(isSingletonTabKind("agent")).toBe(true);
    expect(isSingletonTabKind("note")).toBe(false);
    expect(isSingletonTabKind("view")).toBe(false);
  });

  it("answers the note-floats question for every kind, not only for note", () => {
    // The floats act on an open NOTE. A new kind that forgets to answer would
    // inherit `note`'s answer if this were a literal comparison, and the
    // failure is a backlinks panel over a surface with no note behind it.
    expect(tabKindSpec("note").showsFocusedNote).toBe(true);
    for (const spec of TAB_KINDS.filter((s) => s.kind !== "note")) {
      expect(spec.showsFocusedNote, `${spec.kind} must not claim note floats`).toBe(false);
    }
  });
});

describe("singleton ids are canonical, whatever a stored key claimed", () => {
  it("normalizes a singleton's id to its sentinel", () => {
    expect(canonicalTabId("graph", "whatever-was-stored")).toBe(GRAPH_TAB_ID);
    expect(canonicalTabId("tasks", "whatever-was-stored")).toBe(TASKS_TAB_ID);
    expect(canonicalTabId("agent", "whatever-was-stored")).toBe(AGENT_TAB_ID);
  });

  it("leaves a per-entity id alone", () => {
    expect(canonicalTabId("note", "abc-123")).toBe("abc-123");
    expect(canonicalTabId("view", "v-9")).toBe("v-9");
  });

  it("round-trips every kind through itemKey / parseItemKey", () => {
    const items: WorkspaceItem[] = [
      { kind: "note", id: "n1" },
      { kind: "view", id: "v1" },
      { kind: "graph", id: GRAPH_TAB_ID },
      { kind: "tasks", id: TASKS_TAB_ID },
      { kind: "attachments", id: ATTACHMENTS_TAB_ID },
      { kind: "templates", id: TEMPLATES_TAB_ID },
      { kind: "agent", id: AGENT_TAB_ID },
    ];
    for (const item of items) {
      expect(parseItemKey(itemKey(item))).toEqual(item);
    }
  });

  it("still reads a bare id as a note, the pre-prefix handle shape", () => {
    expect(parseItemKey("just-an-id")).toEqual({ kind: "note", id: "just-an-id" });
  });

  it("reads an UNKNOWN prefix as a note id rather than throwing", () => {
    // `parseItemKey` is fed handles from drag payloads and focus restoration as
    // well as from storage, so it must be total. The id keeps its prefix here
    // because the whole string is treated as the note id — which is the legacy
    // behaviour and is what keeps a colon-containing note id working.
    //
    // The prefix must be one the registry does NOT know: `agent:xyz` was this
    // test's example until `agent` became a registered kind (myne-md/myne#771),
    // which is exactly the failure this case exists to catch one level up.
    expect(parseItemKey("widget:xyz")).toEqual({ kind: "note", id: "widget:xyz" });
  });
});
