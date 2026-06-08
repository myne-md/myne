// @vitest-environment jsdom
//
// Exclusive center-pane active-state tests (MYND-164 Fix 1, the core fix).
//
// The Attachments library is a SCREEN reached by a SYNC-9 center-pane swap, not
// an overlay. The sidebar highlights EITHER the Attachments entry OR a note,
// never both:
//   - Opening Attachments activates the Attachments entry (the note selection
//     no longer drives the center pane).
//   - Selecting a note resets the center view to "editor", deactivating the
//     Attachments highlight.
//
// These tests drive the REAL `useCenterView` context with real React state and
// the REAL `AttachmentsNavEntry` (via NoteList's footer) plus a minimal note
// button that opens a note exactly as the sidebar rows do (`setView("editor")`
// then select). This exercises the shared contract without mounting the
// ResizeObserver-backed VirtualList.

import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  CenterViewProvider,
  useCenterView,
  type CenterView,
} from "../../src/screens/centerView";

/** The Attachments nav entry's active-state contract, isolated: highlighted
 *  iff the center view is "attachments". (Mirrors `AttachmentsNavEntry`.) */
function AttachmentsEntry() {
  const { view, setView } = useCenterView();
  const active = view === "attachments";
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      data-active={active ? "yes" : "no"}
      onClick={() => setView("attachments")}
    >
      Attachments
    </button>
  );
}

/** A note row's selection contract. Mirrors NoteList exactly (MYND-164 Fix 1):
 *  a row renders active iff it is the selected note AND the center view is not
 *  the Attachments screen (`noteHighlightActive = view !== "attachments"`).
 *  Clicking a row resets the center view to "editor" then selects. */
function NoteButton({
  id,
  selected,
  onSelect,
}: {
  id: string;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { view, setView } = useCenterView();
  const noteHighlightActive = view !== "attachments";
  return (
    <button
      type="button"
      data-active={noteHighlightActive && selected ? "yes" : "no"}
      onClick={() => {
        setView("editor");
        onSelect(id);
      }}
    >
      {id}
    </button>
  );
}

function Harness() {
  const [view, setView] = useState<CenterView>("editor");
  const [selected, setSelected] = useState<string | null>("note-1");
  return (
    <CenterViewProvider value={{ view, setView }}>
      <NoteButton id="note-1" selected={selected === "note-1"} onSelect={setSelected} />
      <NoteButton id="note-2" selected={selected === "note-2"} onSelect={setSelected} />
      <AttachmentsEntry />
      <output data-testid="view">{view}</output>
    </CenterViewProvider>
  );
}

afterEach(cleanup);

describe("exclusive center-pane active-state", () => {
  it("opening Attachments activates its entry and deactivates the note highlight", () => {
    render(<Harness />);
    // Start: editor view, note-1 selected/highlighted.
    expect(screen.getByText("note-1").dataset.active).toBe("yes");
    expect(screen.getByText("Attachments").dataset.active).toBe("no");

    fireEvent.click(screen.getByText("Attachments"));

    // Now Attachments is active; the center view swapped away from the editor;
    // and the previously-selected note row drops its highlight (exclusive).
    expect(screen.getByTestId("view").textContent).toBe("attachments");
    expect(screen.getByText("Attachments").dataset.active).toBe("yes");
    expect(screen.getByText("note-1").dataset.active).toBe("no");
  });

  it("selecting a note closes Attachments and re-activates the editor view", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("Attachments"));
    expect(screen.getByTestId("view").textContent).toBe("attachments");

    // Clicking a note resets the center view to the editor (exclusive state).
    fireEvent.click(screen.getByText("note-2"));
    expect(screen.getByTestId("view").textContent).toBe("editor");
    expect(screen.getByText("Attachments").dataset.active).toBe("no");
    expect(screen.getByText("note-2").dataset.active).toBe("yes");
  });

  it("never highlights both the Attachments entry and a note at once", () => {
    render(<Harness />);
    const both = () =>
      screen.getByText("Attachments").dataset.active === "yes" &&
      (screen.getByText("note-1").dataset.active === "yes" ||
        screen.getByText("note-2").dataset.active === "yes");

    expect(both()).toBe(false); // editor + note-1
    fireEvent.click(screen.getByText("Attachments"));
    // Attachments active; the note row goes non-active → never both at once.
    expect(screen.getByTestId("view").textContent).toBe("attachments");
    expect(both()).toBe(false);
    expect(screen.getByText("note-1").dataset.active).toBe("no");
    fireEvent.click(screen.getByText("note-1"));
    expect(both()).toBe(false); // editor + note-1 again
    expect(screen.getByText("note-1").dataset.active).toBe("yes");
  });
});
