// @vitest-environment jsdom
//
// Adding a card from a template (myne-md/myne#922 task 6).
//
// The two things that matter are both about bytes and authority, not about the
// button: the new note's body is the template's body and NONE of the template's
// own frontmatter, and the lane value is written by the host-owned field command
// rather than spliced into the note here. The remaining cases are the ones a
// design that looks right can still get wrong: the affordance must be ABSENT
// where the view cannot write its lane property, and a card must appear in the
// lane only after the placement landed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SavedView } from "../../src/lib/prefs";
import type { ViewResult } from "../../src/notes/queryEngine";

const h = vi.hoisted(() => ({
  template: "",
  templateReadable: true,
  created: [] as string[],
  invoke: vi.fn(),
}));

vi.mock("../../src/platform/core", () => ({ invoke: h.invoke }));
vi.mock("../../src/notes/flushBeforeFrontmatterWrite", () => ({
  flushBeforeFrontmatterWrite: async () => {},
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: async () => {
    if (!h.templateReadable) throw new Error("gone");
    return h.template;
  },
}));
vi.mock("../../src/notes/vaultIndices", () => ({
  reindexNoteFromBody: async () => {},
}));

import { BoardView } from "../../src/notes/views/boardView";
import { noteBody, templateCardPlaintext } from "../../src/notes/views/addCard";
import { initialNotePlaintext } from "../../src/notes/createNote";

afterEach(cleanup);

const TEMPLATE =
  '---\ntitle: Template card\nstatus: Done\nfolder: Projects\ntemplate: true\n---\nThe shape every card begins with.\n';

beforeEach(() => {
  h.template = TEMPLATE;
  h.templateReadable = true;
  h.created = [];
  h.invoke.mockReset();
  h.invoke.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command === "plugin:notes|note_create") {
        h.created.push(args.plaintext as string);
        return "new-note";
      }
      if (command === "plugin:notes|note_set_field") {
        return null;
      }
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
    lanes: ["Backlog", "Doing"],
    ...over,
  };
}

function result(): ViewResult {
  return {
    groups: [
      { key: "Backlog", type: "string", rows: [] },
      { key: "Doing", type: "string", rows: [
        { noteId: "n2", title: "Draft the guide", folder: null, values: {} },
      ] },
    ],
  };
}

function lane(value: string): HTMLElement {
  return screen
    .getAllByTestId("view.lane")
    .find((element) => element.getAttribute("data-lane-value") === value)!;
}

function addButton(value: string): HTMLElement | null {
  return within(lane(value)).queryByTestId("view.board-add-card");
}

describe("the plaintext a template card is created with", () => {
  it("carries the template's body byte for byte", () => {
    const created = templateCardPlaintext(TEMPLATE);
    expect(noteBody(created)).toBe(noteBody(TEMPLATE));
    expect(noteBody(created)).toContain("The shape every card begins with.");
  });

  it("carries none of the template's own frontmatter keys", () => {
    const created = templateCardPlaintext(TEMPLATE);
    // Anywhere in the note, not just in the first block: a copied frontmatter
    // block is still inherited state, wherever the reader's parser finds it.
    expect(created).not.toContain("status:");
    expect(created).not.toContain("folder:");
    expect(created).not.toContain("template:");
    // A title field, because the title is frontmatter-only in Myne.
    expect(created).toContain('title: ""');
  });

  it("treats a template with no frontmatter as all body", () => {
    const created = templateCardPlaintext("Just a body.\n");
    expect(noteBody(created)).toBe("Just a body.\n");
    expect(created.startsWith('---\ntitle: ""\n---\n')).toBe(true);
  });
});

describe("adding a card", () => {
  it("creates the note from the template and places it through the field command", async () => {
    render(<BoardView def={boardDef({ template: "tpl-1" })} result={result()} />);
    fireEvent.click(addButton("Backlog")!);

    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2));
    const [createCommand, createArgs] = h.invoke.mock.calls[0]!;
    expect(createCommand).toBe("plugin:notes|note_create");
    expect(noteBody(createArgs.plaintext as string)).toBe(noteBody(TEMPLATE));

    const [setCommand, setArgs] = h.invoke.mock.calls[1]!;
    expect(setCommand).toBe("plugin:notes|note_set_field");
    // The lane value goes through the host command, value-anchored on "the note
    // has no value yet". It is never spliced into the note here.
    expect(setArgs).toEqual({
      noteId: "new-note",
      viewId: "b1",
      field: "status",
      expectedValue: null,
      newValue: "Backlog",
    });
  });

  it("uses the vault's default new note when the view names no template", async () => {
    render(<BoardView def={boardDef()} result={result()} />);
    fireEvent.click(addButton("Doing")!);

    await waitFor(() => expect(h.created).toHaveLength(1));
    expect(h.created[0]).toBe(initialNotePlaintext(null));
    expect(h.invoke.mock.calls[1]![1]).toMatchObject({ newValue: "Doing" });
  });

  it("opens the new note in a new tab, so the board stays where it was", async () => {
    const onOpenNote = vi.fn();
    render(
      <BoardView def={boardDef()} result={result()} onOpenNote={onOpenNote} />,
    );
    fireEvent.click(addButton("Backlog")!);

    await waitFor(() => expect(onOpenNote).toHaveBeenCalledTimes(1));
    expect(onOpenNote).toHaveBeenCalledWith("new-note", {
      newTab: true,
      toSide: false,
    });
  });

  it("offers nothing at all when the view does not declare its lane field", () => {
    render(<BoardView def={boardDef({ write_fields: ["owner"] })} result={result()} />);
    // Absence, not a disabled button: an offer the host must refuse is a trap.
    expect(screen.queryAllByTestId("view.board-add-card")).toHaveLength(0);
    expect(addButton("Backlog")).toBeNull();
  });

  it("offers nothing on a board with no lane property", () => {
    render(
      <BoardView
        def={boardDef({ group_by: undefined })}
        result={{ groups: [{ key: "", type: "none", rows: [] }] }}
      />,
    );
    expect(screen.queryAllByTestId("view.board-add-card")).toHaveLength(0);
  });
});

describe("when the placement is refused", () => {
  it("says the card was created and could not be placed, with the reason", async () => {
    h.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "plugin:notes|note_create") {
        h.created.push(args.plaintext as string);
        return "new-note";
      }
      throw { kind: "FieldNotDeclared" };
    });
    render(<BoardView def={boardDef()} result={result()} />);
    fireEvent.click(addButton("Backlog")!);

    const line = await screen.findByTestId("view.board-add-error");
    expect(line.textContent).toContain("created");
    expect(line.textContent).toContain("does not declare that field");
    // The note really was created: the line says both facts rather than
    // pretending nothing happened.
    expect(h.created).toHaveLength(1);
  });

  it("creates nothing when the template cannot be read, and says so", async () => {
    h.templateReadable = false;
    render(<BoardView def={boardDef({ template: "tpl-1" })} result={result()} />);
    fireEvent.click(addButton("Backlog")!);

    const line = await screen.findByTestId("view.board-add-error");
    expect(line.textContent).toContain("No card was created");
    expect(h.created).toHaveLength(0);
  });
});

describe("the card arrives with the data", () => {
  it("does not appear until the write landed, then appears in its lane", async () => {
    const { rerender } = render(<BoardView def={boardDef()} result={result()} />);
    fireEvent.click(addButton("Backlog")!);
    await waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2));
    // Nothing optimistic: the board has no row to draw, because the note it
    // created carries no title, lane or column values yet.
    expect(within(lane("Backlog")).queryAllByTestId("view.card")).toHaveLength(0);

    rerender(
      <BoardView
        def={boardDef()}
        result={{
          groups: [
            { key: "Backlog", type: "string", rows: [
              { noteId: "new-note", title: null, folder: null, values: { status: { key: "status", type: "string", value: "Backlog" } } },
            ] },
            { key: "Doing", type: "string", rows: [] },
          ],
        }}
      />,
    );
    expect(within(lane("Backlog")).getAllByTestId("view.card")).toHaveLength(1);
  });
});
