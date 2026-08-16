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

function mount(): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [RESOLVED_CATALOG, ...coverBannerExtension()],
    }),
  });
  restores.push(() => view.destroy());
  return view;
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
    const view = mount();
    control(view, COVER_CHANGE_TESTID)?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    // `true` matters: it is what makes the picker offer its own Remove action.
    // The editor is the only side that knows it.
    expect(openPicker).toHaveBeenCalledWith(true);
  });

  it("removes directly rather than routing through the picker", () => {
    // Two controls that both open the same modal would be two controls doing
    // the same thing. Remove is a one-click intent.
    const openPicker = vi.fn();
    const remove = vi.fn();
    withCover({ openPicker, remove });
    const view = mount();
    control(view, COVER_REMOVE_TESTID)?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(remove).toHaveBeenCalledTimes(1);
    expect(openPicker).not.toHaveBeenCalled();
  });
});
