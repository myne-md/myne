// @vitest-environment jsdom
//
// myne-md/myne#566: "working" and "done" must be different SHAPES.
//
// Both indicators were 6px circles: a dot that pulsed its opacity beside the
// save readout, and a hollow ring on an unsynced sidebar row. At that size a
// filled circle and a hollow one are the same glyph, and an opacity pulse does
// not read as progress, which is how a user came to report that neither one
// told them anything at all.
//
// The grammar now is: solid dot = settled, static arc = outstanding, rotating
// arc = in flight. These tests pin the two ends that are easy to get wrong:
// that work in flight actually MOVES, and that per-note sync debt does NOT.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SaveStatus } from "../../src/notes/components/SaveStatus";
import { NoteRow, type NoteRowProps } from "../../src/notes/components/NoteRow";

afterEach(cleanup);

/** The rotation comes from `.myne-spinner` in tokens.css, and with it the
 *  MYND-630 reduced-motion carve-out. Presence of the class IS the motion. */
function spins(el: Element): boolean {
  return el.classList.contains("myne-spinner");
}

function readout(status: Parameters<typeof SaveStatus>[0]["status"], unsynced = false) {
  // `syncing` used to be a third parameter spread onto `<SaveStatus>`, which has
  // no such prop: React dropped it, no caller ever passed one, and `tests/` is
  // outside `tsc`'s `include` so nothing said so. It read as coverage for the
  // half of the sync-arc grammar that is not implemented (whether the arc TURNS
  // comes from whether the device is moving bytes, and both unsynced markers are
  // hardcoded `spinning={false}`). A dead parameter naming an unimplemented
  // behaviour is residue the next reader trusts.
  render(<SaveStatus status={status} onRetry={() => {}} unsynced={unsynced} />);
  return screen.getByTestId("editor.save-status");
}

/** Every required `<NoteRow>` prop, so no render here needs a cast. */
function rowProps(over: Partial<NoteRowProps> = {}): NoteRowProps {
  return {
    record: {
      noteUuid: "n1",
      title: "Hello",
      folder: null,
      updatedAt: new Date("2026-06-16T12:00:00.000Z"),
      trashed: null,
      // develop grew TitleRecord while this branch was open, and a fixture that
      // casts past the gap is a fixture that stops describing the type. Listed
      // in full instead, in the order the type declares them.
      deleted: null,
      archived: null,
      template: false,
      folderIndex: false,
      conflict: false,
      conflictOf: null,
      hasSource: false,
      kind: null,
      done: null,
    },
    selected: false,
    renaming: false,
    onSelect: vi.fn(),
    onStartRename: vi.fn(),
    onContextMenu: vi.fn(),
    onCommitRename: vi.fn(),
    onCancelRename: vi.fn(),
    ...over,
  };
}

describe("save readout", () => {
  it("moves while a write is in flight", () => {
    const arc = readout({ status: "saving" }).querySelector('[role="img"]');
    expect(arc).not.toBeNull();
    expect(spins(arc!)).toBe(true);
  });

  it("shows an arc but does NOT move while keystrokes wait on the debounce", () => {
    // `editing` used to render the same inert dot as `saved`, which is why the
    // readout looked identical whether or not anything was owed. It is an arc
    // now, and a STATIC one: `AUTOSAVE_IDLE_MS` is one second, so this is the
    // state a whole writing session is spent in, and an arc turning through all
    // of it is the looping animation `docs/design/README.md` bans by name. Under
    // this component's grammar it is also the wrong shape: outstanding, not in
    // flight.
    const el = readout({ status: "editing" });
    const arc = el.querySelector<HTMLElement>('[role="img"]');
    expect(arc).not.toBeNull();
    expect(arc!.style.borderTopColor).toBe("transparent");
    expect(spins(arc!)).toBe(false);
  });

  it("moves while a conflict copy is being written", () => {
    const arc = readout({ status: "conflict" }).querySelector('[role="img"]');
    expect(spins(arc!)).toBe(true);
  });

  it("stands still once everything has landed", () => {
    for (const status of [{ status: "clean" } as const, { status: "saved", at: new Date() } as const]) {
      cleanup();
      const el = readout(status);
      expect(el.querySelector(".myne-spinner")).toBeNull();
    }
  });
});

describe("unsynced marker", () => {
  it("is an arc, and does NOT rotate, beside the save readout", () => {
    // The honesty constraint. An edit made offline stays unsynced for as long as
    // the device stays offline; a marker rotating through all of that would be
    // claiming work is in flight that is not happening.
    readout({ status: "saved", at: new Date() }, true);
    const mark = screen.getByTestId("editor.unsynced-marker");
    expect(spins(mark)).toBe(false);
    // The gap is what carries "outstanding" while standing still.
    expect(mark.style.borderTopColor).toBe("transparent");
    expect(mark.style.borderRadius).toBe("50%");
  });

  it("keeps the long tooltip rather than replacing it with the terse label", () => {
    // Folding `aria-label` and `title` into one prop silently replaced the hover
    // sentence with the terse label and orphaned `notes.row.unsyncedTitle` in 32
    // catalogs.
    render(<NoteRow {...rowProps({ unsynced: true })} />);
    const mark = screen.getByTestId("notes.row-unsynced");
    expect(mark.getAttribute("title")).toBe(
      "This note's latest changes are only on this device",
    );
    expect(mark.getAttribute("aria-label")).toBe("Not yet on the server");
  });

  it("never turns, on either surface", () => {
    // `docs/design/README.md` bans looping animation, and the sidebar draws one
    // of these per unsynced note. Rotation stays where the work is bounded and
    // there is one of it: the save readout. The gap in the ring is what carries
    // "outstanding" without motion.
    readout({ status: "saved", at: new Date() }, true);
    expect(spins(screen.getByTestId("editor.unsynced-marker"))).toBe(false);
    cleanup();
    render(<NoteRow {...rowProps({ unsynced: true })} />);
    expect(spins(screen.getByTestId("notes.row-unsynced"))).toBe(false);
  });

  it("is the same shape on a sidebar row", () => {
    // Two glyphs for one fact would read as two facts.
    //
    // Every required prop is supplied rather than cast past. `as unknown as
    // NoteRowProps` would turn off type-checking on the one render this file
    // exists to assert about, so a prop that becomes required later would arrive
    // here as `undefined` with no compiler error.
    render(<NoteRow {...rowProps({ unsynced: true })} />);
    const mark = screen.getByTestId("notes.row-unsynced");
    expect(spins(mark)).toBe(false);
    expect(mark.style.borderTopColor).toBe("transparent");
  });
});

describe("the arcs do not each become a live region", () => {
  it("stays silent where the readout beside it already names the state", () => {
    // `role="status"` is an `aria-live` region. Inside the readout the parent
    // span already carries the same phrase, so a second announcement is a
    // duplicate, and the arc is a glyph rather than a message.
    const el = readout({ status: "saving" });
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.querySelector('[role="img"]')).not.toBeNull();
  });

  it("stays silent on a sidebar row, of which there can be a screenful", () => {
    // One live region per unsynced note, all re-labelled at once when a push
    // starts, is an announcement storm a screen-reader user cannot mute.
    render(<NoteRow {...rowProps({ unsynced: true })} />);
    expect(screen.getByTestId("notes.row-unsynced").getAttribute("role")).toBe("img");
  });

  it("speaks the unsynced state from a region that was already there", () => {
    // The arc itself is `role="img"` in every position, and the announcement is
    // a separate always-mounted node. The shape this replaces put `role="status"`
    // on the arc and mounted the arc only while unsynced, so the live region
    // came into existence WITH the change it was supposed to report, which
    // announces nothing: a region has to pre-exist and its TEXT has to change.
    const { rerender } = render(
      <SaveStatus status={{ status: "saved", at: new Date() }} onRetry={() => {}} unsynced={false} />,
    );
    const region = screen.getByTestId("editor.unsynced-announcement");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe("");
    expect(screen.queryByTestId("editor.unsynced-marker")).toBeNull();

    rerender(
      <SaveStatus status={{ status: "saved", at: new Date() }} onRetry={() => {}} unsynced />,
    );
    // The SAME node, now carrying the phrase. Identity matters: a region
    // replaced rather than updated is a new region, which is the bug.
    expect(screen.getByTestId("editor.unsynced-announcement")).toBe(region);
    expect(region.textContent).not.toBe("");
    expect(screen.getByTestId("editor.unsynced-marker").getAttribute("role")).toBe("img");
  });

  it("does not shadow a longer tooltip with a terser one", () => {
    // The glyph is 7px and sits inside a span that already carries a sentence.
    // Defaulting `title` to `label` meant the tooltip changed with whichever
    // pixel the pointer landed on.
    const el = readout({ status: "editing" });
    expect(el.querySelector('[role="img"]')!.getAttribute("title")).toBeNull();
  });
});
