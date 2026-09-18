// @vitest-environment jsdom
//
// The cover banner's hover controls and the seam contract behind them
// (myne-md/myne#410).
//
// The property under test is the one the EditorHost seam exists to provide and
// that `tsc` cannot see: a host WITHOUT the `cover` member renders no cover
// controls at all, rather than rendering buttons that throw when pressed. That
// is the seam's stated contract ("a host that omits this renders no cover
// controls"), and an optional member is exactly the shape where a type checker
// is satisfied either way.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setEditorHost, getHost, type EditorHost } from "@myne/editor/host";
import {
  catalogField,
  type CatalogRow,
} from "../../src/editor/attachments/catalog";
import {
  COVER_BANNER_TESTID,
  COVER_CHANGE_TESTID,
  COVER_REMOVE_TESTID,
  coverBannerExtension,
} from "../../src/editor/decorations/cover-banner";
import { EditorState as CMEditorState } from "@codemirror/state";
import { noteIdExtension, reconfigureNoteId } from "@myne/editor/note-identity";

const ID = "a".repeat(64);
const DOC = ["---", `cover: "![[att:${ID}|photo.png]]"`, "---", "", "body"].join("\n");

/** Seed the catalog as already loaded and carrying the cover's id, so the
 *  banner resolves rather than sitting in its `loading` state. */
const RESOLVED_CATALOG = catalogField.init(
  () =>
    new Map<string, CatalogRow>([
      [ID, { id: ID, filename: "photo.png", contentType: "image/png", size: 1 } as CatalogRow],
    ]),
);

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

/** Swap the global test host's `cover` member for one test. */
function withCover(cover: EditorHost["cover"]): void {
  const host = getHost();
  setEditorHost({ ...host, cover });
  restores.push(() => setEditorHost(host));
}

function mount(noteId: string | null = null, readOnly = false): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [
        RESOLVED_CATALOG,
        noteIdExtension(noteId),
        CMEditorState.readOnly.of(readOnly),
        ...coverBannerExtension(),
      ],
    }),
  });
  restores.push(() => view.destroy());
  return view;
}

function press(view: EditorView, testId: string): void {
  control(view, testId)?.dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
  );
}

function control(view: EditorView, testId: string): HTMLElement | null {
  return view.dom.querySelector(`[data-testid="${testId}"]`);
}

describe("the cover banner's hover controls", () => {
  it("renders no controls at all when the host has no cover seam", () => {
    withCover(undefined);
    const view = mount();
    // The banner itself still draws: rendering a cover is not the thing the
    // seam gates. Only the controls are.
    expect(control(view, COVER_BANNER_TESTID)).not.toBeNull();
    expect(control(view, COVER_CHANGE_TESTID)).toBeNull();
    expect(control(view, COVER_REMOVE_TESTID)).toBeNull();
  });

  it("renders both controls when the host provides the seam", () => {
    withCover({ openPicker: vi.fn(), remove: vi.fn() });
    const view = mount();
    expect(control(view, COVER_CHANGE_TESTID)).not.toBeNull();
    expect(control(view, COVER_REMOVE_TESTID)).not.toBeNull();
  });

  it("asks the host to open the picker, telling it the note already has a cover", () => {
    const openPicker = vi.fn();
    withCover({ openPicker, remove: vi.fn() });
    const view = mount("note-1");
    press(view, COVER_CHANGE_TESTID);
    // `true` matters: it is what makes the picker offer its own Remove action.
    // The editor is the only side that knows it. The id matters for the other
    // reason (myne-md/myne#520): the host must not have to guess from focus.
    expect(openPicker).toHaveBeenCalledWith(true, "note-1");
  });

  it("removes directly rather than routing through the picker", () => {
    // Two controls that both open the same modal would be two controls doing
    // the same thing. Remove is a one-click intent.
    const openPicker = vi.fn();
    const remove = vi.fn();
    withCover({ openPicker, remove });
    const view = mount("note-1");
    press(view, COVER_REMOVE_TESTID);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(openPicker).not.toHaveBeenCalled();
  });

  it("renders NO controls on a read-only surface, banner and all", () => {
    // myne-md/myne#564's contract, applied to the control that needed it most.
    // These two do not go through the document, so `EditorState.readOnly` does
    // not stop them by itself and the reading companion's `NOOP_ON_CHANGE` never
    // sees them: they call the host, which re-encrypts the note on disk. Unlike
    // the task checkbox, whose read-only write is thrown away, this one lands.
    withCover({ openPicker: vi.fn(), remove: vi.fn() });
    const view = mount("note-a", true);
    // The banner itself still draws. Reading view shows the cover; it just
    // offers no way to change it.
    expect(control(view, COVER_BANNER_TESTID)).not.toBeNull();
    expect(control(view, COVER_CHANGE_TESTID)).toBeNull();
    expect(control(view, COVER_REMOVE_TESTID)).toBeNull();
  });

  // myne-md/myne#520. The banner's controls `preventDefault` on `mousedown`, so
  // pressing one in an unfocused pane never focuses that pane and the shell's
  // idea of the selected note is still the OTHER pane's. Naming the note is the
  // fix, and these three assert the three ways it can be got wrong.
  describe("naming its note (myne-md/myne#520)", () => {
    it("hands Remove the note this view holds, not the focused one", () => {
      const remove = vi.fn();
      withCover({ openPicker: vi.fn(), remove });
      press(mount("note-b"), COVER_REMOVE_TESTID);
      expect(remove).toHaveBeenCalledWith("note-b");
    });

    it("passes null when the host mounted the editor without an identity", () => {
      // The pre-#520 hosts, and the reading-mirror case where no id is wired.
      // `null` is the explicit "you decide", not an accident, and every listener
      // reads it as "the focused note".
      const remove = vi.fn();
      withCover({ openPicker: vi.fn(), remove });
      press(mount(), COVER_REMOVE_TESTID);
      expect(remove).toHaveBeenCalledWith(null);
    });

    it("reads the note LIVE, so a swap through one long-lived view is followed", () => {
      // The desktop shell keeps ONE view per pane and swaps documents through
      // it, and `CoverBannerWidget.eq` compares the resolved URL alone, so two
      // notes sharing a cover keep the same DOM and the same button, wired at
      // the first note's mount. A value captured in that closure would name the
      // note the pane used to hold for the rest of the session.
      const remove = vi.fn();
      withCover({ openPicker: vi.fn(), remove });
      const view = mount("note-first");
      view.dispatch({ effects: reconfigureNoteId("note-second") });
      press(view, COVER_REMOVE_TESTID);
      expect(remove).toHaveBeenCalledWith("note-second");
    });
  });

  // Tap-to-reveal on touch (myne-md/myne#715). The coarse-pointer CSS keeps
  // the controls hidden until the frame carries `cm-cover-revealed`; these
  // assert the frame half of that contract (the CSS half is a stylesheet).
  describe("tap-to-reveal", () => {
    function tap(el: HTMLElement | null): void {
      el?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }

    it("starts hidden and toggles on frame taps", () => {
      withCover({ openPicker: vi.fn(), remove: vi.fn() });
      const view = mount("note-1");
      const frame = control(view, COVER_BANNER_TESTID)!;
      expect(frame.classList.contains("cm-cover-revealed")).toBe(false);
      tap(frame);
      expect(frame.classList.contains("cm-cover-revealed")).toBe(true);
      tap(frame);
      expect(frame.classList.contains("cm-cover-revealed")).toBe(false);
    });

    it("does not toggle when the tap lands on a control", () => {
      withCover({ openPicker: vi.fn(), remove: vi.fn() });
      const view = mount("note-1");
      const frame = control(view, COVER_BANNER_TESTID)!;
      tap(control(view, COVER_CHANGE_TESTID));
      expect(frame.classList.contains("cm-cover-revealed")).toBe(false);
    });
  });
});
