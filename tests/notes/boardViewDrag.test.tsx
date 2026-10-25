// @vitest-environment jsdom
//
// A drag on the board, end to end through the caller the board actually uses
// (myne-md/myne#922 task 5).
//
// The assertions are on the NOTE, not on the board, because the board's risk is
// not that it looks wrong: it is that it silently disagrees with the vault. So
// every case here checks the bytes the fake vault ends up holding, and the
// rendered assertions exist to prove the card agrees with them:
//
//   - a drag writes exactly one key, through exactly one command;
//   - a refused drag leaves the note byte-identical and puts the card back;
//   - the gesture is driven by a POINTER EVENT, not by calling a handler by
//     hand, because "works when the handler is called" is the test that passes
//     while the wiring is broken;
//   - the keyboard path performs the same write.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SavedView } from "../../src/lib/prefs";
import type { ViewResult } from "../../src/notes/queryEngine";

const h = vi.hoisted(() => ({
  vault: new Map<string, string>(),
  invoke: vi.fn(),
}));

vi.mock("../../src/platform/core", () => ({ invoke: h.invoke }));
vi.mock("../../src/notes/flushBeforeFrontmatterWrite", () => ({
  flushBeforeFrontmatterWrite: async () => {},
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: async (noteId: string) => h.vault.get(noteId) ?? "",
}));
vi.mock("../../src/notes/vaultIndices", () => ({
  reindexNoteFromBody: async () => {},
}));

import { BoardView } from "../../src/notes/views/boardView";

afterEach(cleanup);

const NOTE = "---\nstatus: Doing\ntitle: Draft the guide\n---\nThe body lives here.\n";

function readField(text: string, field: string): string | null {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith(`${field}: `));
  return line === undefined ? null : line.slice(field.length + 2);
}

function writeField(text: string, field: string, value: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((candidate) =>
    candidate.startsWith(`${field}: `),
  );
  if (index === -1) {
    // Insert after the opener, which is where the host's own splice puts a key
    // it has to create.
    lines.splice(1, 0, `${field}: ${value}`);
  } else {
    lines[index] = `${field}: ${value}`;
  }
  return lines.join("\n");
}

beforeEach(() => {
  h.vault.clear();
  h.vault.set("n2", NOTE);
  h.invoke.mockReset();
  h.invoke.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command !== "plugin:notes|note_set_field") {
        throw new Error(`unexpected command in this test: ${command}`);
      }
      const noteId = args.noteId as string;
      const field = args.field as string;
      const text = h.vault.get(noteId) ?? "";
      if (readField(text, field) !== (args.expectedValue as string | null)) {
        throw { kind: "FieldChanged" };
      }
      h.vault.set(noteId, writeField(text, field, args.newValue as string));
      // The host captures a pre-write snapshot; `null` is the shape a CRDT note
      // returns and is a legal answer here.
      return null;
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
    ...over,
  };
}

function result(doingStatus = "Doing"): ViewResult {
  return {
    groups: [
      { key: "Doing", type: "string", rows: [
        { noteId: "n2", title: "Draft the guide", folder: null, values: { status: { key: "status", type: "string", value: doingStatus } } },
      ] },
      { key: "Backlog", type: "string", rows: [
        { noteId: "n1", title: "Pick a name", folder: null, values: { status: { key: "status", type: "string", value: "Backlog" } } },
      ] },
      { key: "Done", type: "string", rows: [] },
    ],
  };
}

function lane(value: string): HTMLElement {
  return screen
    .getAllByTestId("view.lane")
    .find((element) => element.getAttribute("data-lane-value") === value)!;
}

function slotOf(noteId: string): HTMLElement {
  return document.querySelector(
    `[data-testid="view.card-slot"][data-note-id="${noteId}"]`,
  ) as HTMLElement;
}

/** The pointer gesture, dispatched as real events: press on the card, travel far
 *  enough to be a drag, hover the target lane, release on it. */
function dragWithPointer(noteId: string, target: string): void {
  fireEvent.pointerDown(slotOf(noteId), {
    button: 0,
    pointerId: 7,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 90, clientY: 10 });
  fireEvent.pointerOver(lane(target), { pointerId: 7, clientX: 90, clientY: 10 });
  fireEvent.pointerUp(lane(target), { pointerId: 7, clientX: 90, clientY: 10 });
}

describe("a drag is one field write", () => {
  it("changes exactly the one key on the note and nothing else in it", async () => {
    render(<BoardView def={boardDef()} result={result()} />);
    dragWithPointer("n2", "Done");

    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    const [command, args] = h.invoke.mock.calls[0]!;
    expect(command).toBe("plugin:notes|note_set_field");
    // Value-anchored: the value the card was RENDERED with, not the whole note.
    expect(args).toEqual({
      noteId: "n2",
      viewId: "b1",
      field: "status",
      expectedValue: "Doing",
      newValue: "Done",
    });
    // The note's bytes, asserted as bytes: the status line moved, the title, the
    // body and every other key are the bytes they were.
    expect(h.vault.get("n2")).toBe(NOTE.replace("status: Doing", "status: Done"));
  });

  it("moves the card into the target lane without adding a lane", async () => {
    const { rerender } = render(<BoardView def={boardDef()} result={result()} />);
    dragWithPointer("n2", "Done");

    await waitFor(() =>
      expect(within(lane("Done")).getAllByTestId("view.card")).toHaveLength(1),
    );
    expect(within(lane("Doing")).queryAllByTestId("view.card")).toHaveLength(0);
    expect(screen.getAllByTestId("view.lane")).toHaveLength(3);
    // …and once the data reports the same thing, the card is still there once.
    rerender(<BoardView def={boardDef()} result={result("Done")} />);
    expect(
      screen.getAllByTestId("view.card").filter(
        (card) => card.getAttribute("data-note-id") === "n2",
      ),
    ).toHaveLength(1);
    expect(within(lane("Done")).getAllByTestId("view.card")).toHaveLength(1);
  });

  it("offers no drag at all when the view does not declare the lane field", () => {
    render(<BoardView def={boardDef({ write_fields: [] })} result={result()} />);
    expect(slotOf("n2").getAttribute("aria-keyshortcuts")).toBeNull();
    dragWithPointer("n2", "Done");
    expect(h.invoke).not.toHaveBeenCalled();
  });
});

describe("a refused drag", () => {
  it("leaves the note byte-identical and puts the card back, saying why", async () => {
    h.invoke.mockImplementation(async () => {
      throw { kind: "FieldChanged" };
    });
    render(<BoardView def={boardDef()} result={result()} />);
    dragWithPointer("n2", "Done");

    const refusal = await screen.findByTestId("view.board-refusal");
    expect(refusal.textContent).toContain("changed somewhere else");
    // Back in the lane the NOTE reports, which is the lane it came from.
    expect(within(lane("Doing")).getAllByTestId("view.card")).toHaveLength(1);
    expect(within(lane("Done")).queryAllByTestId("view.card")).toHaveLength(0);
    // Nothing was written: the bytes are the bytes.
    expect(h.vault.get("n2")).toBe(NOTE);
  });
});

describe("the keyboard performs the same move", () => {
  it("writes the neighbouring lane through the same command", async () => {
    render(<BoardView def={boardDef()} result={result()} />);
    const cardOpen = within(slotOf("n2")).getByTestId("view.card-open");
    fireEvent.keyDown(cardOpen, { key: "ArrowRight", altKey: true });

    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    expect(h.invoke.mock.calls[0]![1]).toMatchObject({
      noteId: "n2",
      field: "status",
      expectedValue: "Doing",
      newValue: "Done",
    });
    expect(h.vault.get("n2")).toBe(NOTE.replace("status: Doing", "status: Done"));
  });

  it("publishes the shortcut on the card slot, so it is discoverable", () => {
    render(<BoardView def={boardDef()} result={result()} />);
    expect(slotOf("n2").getAttribute("aria-keyshortcuts")).toBe(
      "Alt+ArrowLeft Alt+ArrowRight",
    );
  });
});
