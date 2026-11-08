// @vitest-environment jsdom
//
// The inline status marks: one shape per fact, and motion only for work that
// ends (myne-md/myne#566, myne-md/myne#603).
//
// Reported three times by the person using them, and each fix was a smaller
// version of the same error. Both marks began as 6px circles, where a filled one
// and a hollow one are the same glyph. Both became a three-quarter arc, which
// depicts nothing and reads as a spinner that has stopped, and which the sync
// fact then SHARED with the save readout, so `Editing…` showed two identical
// grey marks a pixel apart meaning two different things. The sync fact then
// became a solid triangle, distinct at last and still depicting nothing, so down
// a column of sidebar rows it read as a bullet point.
//
// They are named icons at 12px now. What these tests pin is the grammar rather
// than the drawing: every fact has its OWN icon, work in flight actually MOVES,
// and per-note sync debt never does.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SaveStatus } from "../../src/notes/components/SaveStatus";
import { NoteRow, type NoteRowProps } from "../../src/notes/components/NoteRow";
import { ICON_PATHS } from "../../src/lib/icons";

afterEach(cleanup);

/** The rotation comes from `.myne-spinner` in tokens.css, and with it the
 *  MYND-630 reduced-motion carve-out. Presence of the class IS the motion. */
function spins(el: Element): boolean {
  return el.classList.contains("myne-spinner");
}

/** Which icon a mark drew, by matching its rendered SVG body against the path
 *  table.
 *
 *  Reverse-lookup rather than a `data-icon` attribute, because an attribute
 *  would be a second place the name lives and a mark could carry the right
 *  attribute while drawing something else. The paths are the drawing. */
function iconOf(el: Element): string | null {
  const svg = el.querySelector("svg");
  if (svg === null) return null;
  // Both sides go through the SAME serialiser before comparing. A raw table
  // entry writes `<path d="…"/>` and the DOM re-serialises that as
  // `<path d="…"></path>`, so a direct string match against the table finds
  // nothing and reports every mark as unrecognised.
  const normalise = (markup: string): string => {
    const host = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    host.innerHTML = markup;
    return host.innerHTML;
  };
  const body = normalise(svg.innerHTML);
  return Object.entries(ICON_PATHS).find(([, markup]) => normalise(markup) === body)?.[0] ?? null;
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
  it("draws the app's own in-flight glyph, turning, while a write is in flight", () => {
    // `loader-circle` rather than a bespoke ring, so a disk write here reads the
    // same as every other bounded operation in the product (`VaultSwitcher`,
    // `AttachmentsLibrary`).
    const mark = readout({ status: "saving" }).querySelector<HTMLElement>('[data-status-mark]');
    expect(mark).not.toBeNull();
    expect(iconOf(mark!)).toBe("loader-circle");
    expect(spins(mark!)).toBe(true);
  });

  it("draws a dashed ring, standing still, while keystrokes wait on the debounce", () => {
    // `editing` first rendered the same inert dot as `saved`, so the readout
    // looked identical whether or not anything was owed. It then became a
    // three-quarter arc, which depicts nothing and was read as a spinner that
    // had stopped. `circle-dashed` is a ring drawn in dashes, which is what
    // "started and not closed" looks like (myne-md/myne#603).
    //
    // STATIC: `AUTOSAVE_IDLE_MS` is one second, so this is the state a whole
    // writing session is spent in, and a mark turning through all of it is the
    // looping animation `myne-agents/docs/design/README.md` bans by name. Under the class
    // grammar it is also the wrong sentence: outstanding, not in flight.
    const mark = readout({ status: "editing" }).querySelector<HTMLElement>('[data-status-mark]');
    expect(mark).not.toBeNull();
    expect(iconOf(mark!)).toBe("circle-dashed");
    expect(spins(mark!)).toBe(false);
  });

  it("tells `editing` and `saving` apart by ICON, not only by motion", () => {
    // A state told apart by rotation alone is told apart only to someone
    // watching the screen. The two marks must differ with the animation off,
    // which is also what a reduced-motion reader gets.
    const editing = iconOf(readout({ status: "editing" }).querySelector('[data-status-mark]')!);
    cleanup();
    const saving = iconOf(readout({ status: "saving" }).querySelector('[data-status-mark]')!);
    expect(editing).not.toBeNull();
    expect(saving).not.toBeNull();
    expect(editing).not.toBe(saving);
  });

  it("moves while a conflict copy is being written", () => {
    const mark = readout({ status: "conflict" }).querySelector<HTMLElement>('[data-status-mark]');
    expect(iconOf(mark!)).toBe("loader-circle");
    expect(spins(mark!)).toBe(true);
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
  it("depicts the sentence, in `--fg-3`, and does NOT rotate", () => {
    // Two constraints in one glyph.
    //
    // Honesty: an edit made offline stays unsynced for as long as the device
    // stays offline, so a marker rotating through all of that would be claiming
    // work is in flight that is not happening. It is also never `--accent`,
    // because it has no in-flight variant at all: absent from the server or not.
    //
    // Shape: `cloud-off` (myne-md/myne#603). The three glyphs before it were
    // hand-drawn geometry at 7 to 8px, and each was reported as unreadable in
    // turn: a hollow ring, then the readout's own arc, then a solid triangle
    // that read as a bullet point down a column of rows.
    readout({ status: "saved", at: new Date() }, true);
    const mark = screen.getByTestId("editor.unsynced-marker");
    expect(iconOf(mark)).toBe("cloud-off");
    expect(spins(mark)).toBe(false);
    expect(mark.style.color).toBe("var(--fg-3)");
  });

  it("is a DIFFERENT icon from the save readout's own mark, on the state where both show", () => {
    // The myne-md/myne#603 defect itself. `editing` renders the readout's mark,
    // and an unsynced note renders the sync mark a pixel to its right: the two
    // used to be the same `<SyncArc spinning={false}>`, same size, same colour,
    // one saying "autosave is armed" and the other "not on the server".
    const el = readout({ status: "editing" }, true);
    const own = el.querySelector<HTMLElement>('[data-status-mark]')!;
    const mark = screen.getByTestId("editor.unsynced-marker");
    expect(iconOf(own)).not.toBeNull();
    expect(iconOf(mark)).not.toBeNull();
    expect(iconOf(own)).not.toBe(iconOf(mark));
  });

  it("is separated from the readout text rather than glued to it", () => {
    // `6 min ago▲`. The readout's `gap: 6` is internal to its own span, and the
    // bottom bar's item wrapper sets `align-items: center` with no gap at all,
    // so a bare fragment left the mark touching the last character on all three
    // states that show one. The spacing belongs here, where every host inherits
    // it (myne-md/myne#603).
    const { container } = render(
      <SaveStatus status={{ status: "saved", at: new Date() }} onRetry={() => {}} unsynced />,
    );
    const group = container.firstElementChild as HTMLElement;
    expect(group.contains(screen.getByTestId("editor.unsynced-marker"))).toBe(true);
    expect(group.contains(screen.getByTestId("editor.save-status"))).toBe(true);
    expect(group.style.display).toBe("inline-flex");
    expect(group.style.gap).toBe("var(--space-2)");
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
    // `myne-agents/docs/design/README.md` bans looping animation, and the sidebar draws one
    // of these per unsynced note. Motion stays where the work is bounded and
    // there is one of it: the save readout. The triangle's DIRECTION is what
    // carries "waiting to go out" without moving.
    readout({ status: "saved", at: new Date() }, true);
    expect(spins(screen.getByTestId("editor.unsynced-marker"))).toBe(false);
    cleanup();
    render(<NoteRow {...rowProps({ unsynced: true })} />);
    expect(spins(screen.getByTestId("notes.row-unsynced"))).toBe(false);
  });

  it("is the same icon at the same size on a sidebar row", () => {
    // Two glyphs for one fact would read as two facts. The size is one number
    // now, where a hand-drawn ring needed a different pixel count inside a text
    // run than beside a title: a stroke icon takes its weight from the stroke,
    // so it reads the same in both places.
    //
    // Every required prop is supplied rather than cast past. `as unknown as
    // NoteRowProps` would turn off type-checking on the one render this file
    // exists to assert about, so a prop that becomes required later would arrive
    // here as `undefined` with no compiler error.
    render(<NoteRow {...rowProps({ unsynced: true })} />);
    const mark = screen.getByTestId("notes.row-unsynced");
    expect(spins(mark)).toBe(false);
    expect(iconOf(mark)).toBe("cloud-off");
    expect(mark.querySelector("svg")!.getAttribute("width")).toBe("12");
    expect(mark.style.color).toBe("var(--fg-3)");
  });

  it("takes its spacing from the row rather than adding its own", () => {
    // The row is `display: flex` with `gap: var(--space-2)`. A
    // `margin-inline-start: 6` on the mark ADDED to that, putting it 14px from
    // the title block rather than 8, and its `vertical-align: middle` did
    // nothing whatever to a flex item (myne-md/myne#603).
    render(<NoteRow {...rowProps({ unsynced: true })} />);
    const mark = screen.getByTestId("notes.row-unsynced");
    expect(mark.style.marginInlineStart).toBe("");
    expect(mark.style.verticalAlign).toBe("");
  });
});

describe("the arcs do not each become a live region", () => {
  it("stays silent where the readout beside it already names the state", () => {
    // `role="status"` is an `aria-live` region, and a mark is never one: the
    // announcement, where a surface needs one, is a separate always-mounted
    // node. Inside the readout the mark is decorative outright, because the very
    // next span renders the same phrase as text: an accessible name here made a
    // screen reader say the state twice, once off the `role="img"` and once off
    // the words. `aria-hidden` rather than an empty name, so the mark leaves the
    // tree instead of sitting in it unnamed.
    const el = readout({ status: "saving" });
    expect(el.querySelector('[role="status"]')).toBeNull();
    const mark = el.querySelector('[data-status-mark]');
    expect(mark).not.toBeNull();
    expect(mark!.getAttribute("aria-hidden")).toBe("true");
    expect(mark!.getAttribute("role")).toBeNull();
    expect(mark!.getAttribute("aria-label")).toBeNull();
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
    expect(el.querySelector('[data-status-mark]')!.getAttribute("title")).toBeNull();
  });
});
