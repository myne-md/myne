// @vitest-environment jsdom
//
// Lane rename and multi-card move as ONE host-owned action (myne-md/myne#922
// task 7).
//
// This task is the dangerous one, so the assertions are about what the vault and
// the prefs blob end up holding, never about the board's appearance:
//
//   - a rename writes exactly the cards in that lane and no card outside it;
//   - a partial failure is reported per card with its reason, and the count is
//     derived from the lists;
//   - ONE restore puts back every note the action wrote AND the definition it
//     changed, and it moves the version forward with this device's approval;
//   - the view stays approved after its own `lanes` update, and an UNAPPROVED
//     view's rename stays unapproved (the imported-update direction);
//   - the only writers are the field command and the manifest write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SavedView } from "../../src/lib/prefs";
import type { ViewResult } from "../../src/notes/queryEngine";

const h = vi.hoisted(() => ({
  vault: new Map<string, string>(),
  /** note ids whose write must refuse with `FieldChanged`. */
  refusing: new Set<string>(),
  invoke: vi.fn(),
  prefsWrite: vi.fn(),
  /** Every `reindexNoteFromBody(noteId, body)` the restore makes. */
  reindex: vi.fn(),
}));

vi.mock("../../src/platform/core", () => ({ invoke: h.invoke }));
vi.mock("../../src/notes/flushBeforeFrontmatterWrite", () => ({
  flushBeforeFrontmatterWrite: async () => {},
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: async (noteId: string) => h.vault.get(noteId) ?? "",
}));
vi.mock("../../src/notes/vaultIndices", () => ({
  reindexNoteFromBody: h.reindex,
}));
vi.mock("../../src/notes/snapshots", () => ({
  snapshotRestore: async (noteId: string, snapshotId: string) => {
    h.vault.set(noteId, `${h.vault.get(noteId)}restored:${snapshotId}\n`);
  },
}));
// The prefs layer, so the manifest half is observable: the board's own definition
// write goes through `saveLocalViewEdit`, which reads exactly these two.
vi.mock("../../src/lib/prefs", () => ({
  upsertSavedView: (view: SavedView) => h.prefsWrite({ kind: "upsert", view }),
  setViewApproval: (viewId: string, version: number | undefined, definition?: SavedView) =>
    h.prefsWrite({ kind: "approval", viewId, version, definition }),
}));
// The writePref chokepoint the field command's caller also touches is not in this
// path at all; assert that below rather than mocking it.

import { BoardView } from "../../src/notes/views/boardView";
import { renamedLanes, shouldRewriteLanes } from "../../src/notes/views/boardBulk";

afterEach(cleanup);

const NOTE = (status: string, title: string) =>
  `---\nstatus: ${status}\ntitle: ${title}\n---\n${title} body.\n`;

function readField(text: string, field: string): string | null {
  const line = text.split("\n").find((candidate) => candidate.startsWith(`${field}: `));
  return line === undefined ? null : line.slice(field.length + 2);
}

function writeField(text: string, field: string, value: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith(`${field}: `) ? `${field}: ${value}` : line))
    .join("\n");
}

beforeEach(() => {
  h.vault.clear();
  h.vault.set("a1", NOTE("Doing", "Draft the guide"));
  h.vault.set("a2", NOTE("Doing", "Draft the outline"));
  h.vault.set("a3", NOTE("Doing", "Draft the appendix"));
  h.vault.set("b1", NOTE("Backlog", "Pick a name"));
  h.refusing.clear();
  h.invoke.mockReset();
  h.reindex.mockReset();
  h.prefsWrite.mockReset().mockResolvedValue(undefined);
  h.invoke.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command === "plugin:notes|note_set_field") {
        const noteId = args.noteId as string;
        if (h.refusing.has(noteId)) throw { kind: "FieldChanged" };
        const text = h.vault.get(noteId) ?? "";
        if (readField(text, args.field as string) !== (args.expectedValue as string | null)) {
          throw { kind: "FieldChanged" };
        }
        h.vault.set(noteId, writeField(text, args.field as string, args.newValue as string));
        // A pre-write snapshot per note, so the restore half of the one-action
        // promise is exercised rather than skipped as "not restorable".
        return `snap-${noteId}`;
      }
      if (command === "plugin:notes|snapshot_restore") return null;
      throw new Error(`unexpected command in this test: ${command}`);
    },
  );
});

function boardDef(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "b1",
    name: "Release board",
    view_type: "board",
    filters: { kind: "all" },
    group_by: "status",
    write_fields: ["status"],
    lanes: ["Backlog", "Doing", "Done"],
    version: 4,
    ...over,
  };
}

function row(noteId: string, title: string, status: string) {
  return {
    noteId,
    title,
    folder: null,
    values: { status: { key: "status", type: "string" as const, value: status } },
  };
}

function result(): ViewResult {
  return {
    groups: [
      { key: "Backlog", type: "string", rows: [row("b1", "Pick a name", "Backlog")] },
      {
        key: "Doing",
        type: "string",
        rows: [
          row("a1", "Draft the guide", "Doing"),
          row("a2", "Draft the outline", "Doing"),
          row("a3", "Draft the appendix", "Doing"),
        ],
      },
      { key: "Done", type: "string", rows: [] },
    ],
  };
}

function lane(value: string): HTMLElement {
  return screen
    .getAllByTestId("view.lane")
    .find((element) => element.getAttribute("data-lane-value") === value)!;
}

function renameLaneInUi(from: string, to: string): void {
  fireEvent.click(within(lane(from)).getByTestId("view.board-rename"));
  const input = screen.getByTestId("view.board-rename-input");
  fireEvent.change(input, { target: { value: to } });
  fireEvent.click(screen.getByTestId("view.board-rename-save"));
}

describe("renaming a lane", () => {
  it("writes exactly the cards in that lane and no card outside it", async () => {
    render(<BoardView def={boardDef()} result={result()} approved />);
    renameLaneInUi("Doing", "In progress");

    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(3));
    const written = h.invoke.mock.calls.map(([, args]) => args.noteId as string).sort();
    expect(written).toEqual(["a1", "a2", "a3"]);
    // Asserts the NOTES: the three in the lane changed, the one outside is byte
    // for byte what it was.
    expect(h.vault.get("a1")).toBe(NOTE("In progress", "Draft the guide"));
    expect(h.vault.get("a2")).toBe(NOTE("In progress", "Draft the outline"));
    expect(h.vault.get("a3")).toBe(NOTE("In progress", "Draft the appendix"));
    expect(h.vault.get("b1")).toBe(NOTE("Backlog", "Pick a name"));
  });

  it("updates the declared order and keeps this device's approval", async () => {
    const def = boardDef();
    render(<BoardView def={def} result={result()} approved />);
    renameLaneInUi("Doing", "In progress");

    await waitFor(() => expect(h.prefsWrite).toHaveBeenCalledTimes(1));
    const call = h.prefsWrite.mock.calls[0]![0] as {
      kind: string;
      version: number;
      definition: SavedView;
    };
    // ONE prefs write, carrying the definition AND its approval: the person at
    // this device made the change.
    expect(call.kind).toBe("approval");
    expect(call.definition.lanes).toEqual(["Backlog", "In progress", "Done"]);
    expect(call.version).toBe(5);
  });

  it("does not grant an approval the manager is still asking for", async () => {
    render(<BoardView def={boardDef()} result={result()} approved={false} />);
    renameLaneInUi("Doing", "In progress");

    await waitFor(() => expect(h.prefsWrite).toHaveBeenCalledTimes(1));
    const call = h.prefsWrite.mock.calls[0]![0] as { kind: string; view: SavedView };
    // The unapproved direction: the definition lands alone, so the view stays
    // pending at its new version rather than being approved by a rename.
    expect(call.kind).toBe("upsert");
    expect(call.view.lanes).toEqual(["Backlog", "In progress", "Done"]);
  });

  it("reports a partial result per card with each refusal's reason", async () => {
    h.refusing.add("a2");
    render(<BoardView def={boardDef()} result={result()} approved />);
    renameLaneInUi("Doing", "In progress");

    const report = await screen.findByTestId("view.board-bulk-report");
    // The count is derived: two landed, and the report says so.
    expect(report.textContent).toContain("Wrote 2.");
    const refusalLines = within(report).getAllByText(/Draft the outline/);
    expect(refusalLines).toHaveLength(1);
    expect(refusalLines[0]!.textContent).toContain("changed somewhere else");
    // The refused note is untouched; the two that landed are not.
    expect(h.vault.get("a2")).toBe(NOTE("Doing", "Draft the outline"));
    expect(h.vault.get("a1")).toBe(NOTE("In progress", "Draft the guide"));
  });

  it("is one action: one restore returns every note AND the lane order", async () => {
    const def = boardDef();
    const { rerender } = render(<BoardView def={def} result={result()} approved />);
    renameLaneInUi("Doing", "In progress");
    await waitFor(() => expect(h.prefsWrite).toHaveBeenCalledTimes(1));

    // The definition the board is now holding (the parent re-renders from prefs).
    const renamed = { ...def, lanes: ["Backlog", "In progress", "Done"], version: 5 };
    rerender(<BoardView def={renamed} result={result()} approved />);

    // The rename itself reindexed the three notes it wrote (that is
    // `setNoteField`'s own step), so clear before the restore to measure the
    // restore's half only.
    h.reindex.mockClear();
    fireEvent.click(await screen.findByTestId("view.board-restore"));

    await waitFor(() => expect(h.vault.get("a1")).toContain("restored:snap-a1"));
    // Every note the action wrote was restored from its own snapshot. The
    // snapshot reader is the one host call the restore makes per note, and the
    // fake appends its own marker so the assertion is on the note.
    const restoredIds = ["a1", "a2", "a3", "b1"].filter((noteId) =>
      (h.vault.get(noteId) ?? "").includes("restored:"),
    );
    expect(restoredIds).toEqual(["a1", "a2", "a3"]);
    // …and each restored note was read back into the property index. The bytes
    // and the index are two different facts: without this the board keeps
    // drawing the pre-restore lane because the index is what its rows come from
    // (the E2E caught exactly that). The refused/non-restorable note is not
    // reindexed, because nothing was restored into it.
    await waitFor(() =>
      expect(h.reindex.mock.calls.map(([id]) => id).sort()).toEqual([
        "a1",
        "a2",
        "a3",
      ]),
    );
    // …and the declaration came back with it, version forward.
    await waitFor(() => expect(h.prefsWrite).toHaveBeenCalledTimes(2));
    const restoreWrite = h.prefsWrite.mock.calls[1]![0] as {
      kind: string;
      version: number;
      definition: SavedView;
    };
    expect(restoreWrite.kind).toBe("approval");
    expect(restoreWrite.definition.lanes).toEqual(["Backlog", "Doing", "Done"]);
    expect(restoreWrite.version).toBe(6);
    expect(await screen.findByTestId("view.board-lane-order-restored")).toBeTruthy();
  });

  it("says the order did not save when the cards moved and the manifest write failed", async () => {
    h.prefsWrite.mockRejectedValue(new Error("prefs write refused"));
    render(<BoardView def={boardDef()} result={result()} approved />);
    renameLaneInUi("Doing", "In progress");

    // The cards moved, so the sentence has to say BOTH things.
    expect(await screen.findByTestId("view.board-lanes-not-saved")).toBeTruthy();
    expect(h.vault.get("a1")).toBe(NOTE("In progress", "Draft the guide"));
  });
});

describe("moving several cards", () => {
  it("moves every selected card and says how many landed", async () => {
    render(<BoardView def={boardDef()} result={result()} approved />);
    fireEvent.click(
      within(lane("Doing"))
        .getAllByTestId("view.board-select-card")
        .find((toggle) => toggle.getAttribute("data-note-id") === "a1")!,
    );
    fireEvent.click(
      within(lane("Doing"))
        .getAllByTestId("view.board-select-card")
        .find((toggle) => toggle.getAttribute("data-note-id") === "a2")!,
    );
    // The target lane is chosen through the shared Select; its trigger is the
    // button carrying this testid.
    fireEvent.click(screen.getByTestId("view.board-move-target"));
    fireEvent.click(screen.getByRole("option", { name: "Done" }));
    fireEvent.click(screen.getByTestId("view.board-move-apply"));

    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2));
    expect(
      h.invoke.mock.calls.map(([, args]) => [args.noteId, args.newValue]),
    ).toEqual([
      ["a1", "Done"],
      ["a2", "Done"],
    ]);
    expect(h.vault.get("a1")).toBe(NOTE("Done", "Draft the guide"));
    expect(h.vault.get("a3")).toBe(NOTE("Doing", "Draft the appendix"));
    const report = await screen.findByTestId("view.board-bulk-report");
    expect(report.textContent).toContain("Wrote 2.");
  });

  it("never writes the manifest for a plain move", async () => {
    render(<BoardView def={boardDef()} result={result()} approved />);
    fireEvent.click(screen.getByTestId("view.board-select-all"));
    fireEvent.click(screen.getByTestId("view.board-move-target"));
    fireEvent.click(screen.getByRole("option", { name: "Done" }));
    fireEvent.click(screen.getByTestId("view.board-move-apply"));

    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(4));
    // A lane value that was not declared appends in first-appearance order, so
    // there is nothing about the definition to change.
    expect(h.prefsWrite).not.toHaveBeenCalled();
  });

  it("offers no selection at all where the view cannot write the lane", () => {
    render(<BoardView def={boardDef({ write_fields: [] })} result={result()} />);
    expect(screen.queryAllByTestId("view.board-select-card")).toHaveLength(0);
    expect(screen.queryByTestId("view.board-bulk-bar")).toBeNull();
  });
});

describe("the declared order rewrite", () => {
  it("replaces every occurrence, because the format may repeat a value", () => {
    expect(renamedLanes(["Doing", "Doing", "Done"], "Doing", "X")).toEqual([
      "X",
      "X",
      "Done",
    ]);
  });

  it("returns null when the declaration never named the lane", () => {
    expect(renamedLanes(undefined, "Doing", "X")).toBeNull();
    expect(renamedLanes(["Done"], "Doing", "X")).toBeNull();
  });

  it("rewrites an empty lane's declaration but not a lane where everything refused", () => {
    const nothing = {
      actionId: null,
      written: [],
      refused: [{ noteId: "a1", reason: { kind: "FieldChanged" as const } }],
      writtenCount: 0,
      refusedCount: 1,
    };
    // Cards existed and every one refused: nothing carries the new name, so the
    // lane was not renamed.
    expect(shouldRewriteLanes(nothing, 1)).toBe(false);
    // An empty declared lane has nothing to disagree: renaming it is the setup a
    // board is for.
    expect(shouldRewriteLanes(nothing, 0)).toBe(true);
  });
});
