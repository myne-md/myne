// @vitest-environment jsdom
//
// The drag-to-resize handles on a block-drawn image embed (myne-md/myne#604),
// and the `setWidthPx` arm they write through.
//
// # Why this exists when there is an E2E scenario
//
// er1 covers the gesture end to end, and it runs only in the manual pre-release
// lane. Review's deletion test was the argument: replacing
// `appendResizeHandles`' body with `return null` leaves `pnpm test` green, so a
// gesture that WRITES to the note was covered by a claim rather than a check on
// every push. These cases are the check.
//
// jsdom has no layout, so every rect the drag reads is stubbed. That bounds what
// can be asserted here: the arithmetic and the commit shape, not the pixels.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The layout WRITE is what the gesture exists to produce, so it is the thing
// asserted. Mocked rather than driven through a real `EditorView`: `readEmbedLayout`
// parses the note's source to find the embed, and building a document that
// satisfies it would make this a test of the parser.
vi.mock("@myne/editor/attachments/embedLayoutActions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myne/editor/attachments/embedLayoutActions")>();
  return { ...actual, updateEmbedLayout: vi.fn() };
});

import {
  setWidthPx,
  toggleWidthPx,
  updateEmbedLayout,
} from "@myne/editor/attachments/embedLayoutActions";
import { AttachmentImageWidget } from "@myne/editor/attachments/widgets";
import { emptyEmbedLayout } from "@myne/dialect/embedLayout";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("setWidthPx", () => {
  it("states a pixel width and clears the percentage form with it", () => {
    // The two width forms are exclusive: a note carrying both would render one
    // and silently keep the other, so the setter that establishes one has to
    // drop the other in the same object rather than leave it to the caller.
    expect(setWidthPx(320)).toEqual({ widthPx: 320, widthPercent: null });
  });

  it("is the arm `toggleWidthPx` sets with, so the drag and the menu agree", () => {
    // The drag calls `setWidthPx` and the menu calls `toggleWidthPx`. If they
    // disagreed about what "set a width" means, the same 320 would produce two
    // different embeds depending on which affordance the user reached for.
    const applied = toggleWidthPx(320)({ ...emptyEmbedLayout(), widthPercent: 50 });
    expect(applied.widthPx).toBe(320);
    expect(applied.widthPercent).toBeNull();
  });

  it("toggling the width that is already set clears BOTH forms", () => {
    // The drag has no such behaviour on purpose: dragging to the width you are
    // already at must not clear the width. Pinned here so the shared arm cannot
    // grow a toggle that the drag would inherit.
    const cleared = toggleWidthPx(320)({ ...emptyEmbedLayout(), widthPx: 320 });
    expect(cleared.widthPx).toBeNull();
    expect(cleared.widthPercent).toBeNull();
  });
});

// ── the deletion test this file's header promises ─────────────────────────
//
// **It did not exist, and the header said it did.** The file claimed to be the
// check that stops `appendResizeHandles` being replaced with `return null`, and
// then imported only `setWidthPx`, `toggleWidthPx` and `emptyEmbedLayout`. A grep
// for "widgets" in it returned nothing. So the gesture that writes `w` and `h`
// into note bytes had no check on any push, and its only coverage was the manual
// pre-release E2E lane.
//
// jsdom computes no layout, so every rect is stubbed. That bounds what these
// cases can assert to the arithmetic and the commit shape, which is what the
// header already said, and it is enough for the deletion test: with the body
// replaced by `return null` no handle is appended and the first `querySelector`
// returns null.
describe("appendResizeHandles, through the widget that mounts it", () => {
  const ID = "a".repeat(64);
  let view: { contentDOM: HTMLElement };

  beforeEach(() => {
    // Every case mounts into the document and looks a handle up by testid, so a
    // frame left behind by the previous case would be the one found. That is not
    // hygiene: without it the inline-embed case passes on a BLOCK embed's handle
    // and asserts nothing.
    document.body.innerHTML = "";
    vi.mocked(updateEmbedLayout).mockClear();
    const contentDOM = document.createElement("div");
    contentDOM.getBoundingClientRect = () => ({ width: 900 }) as DOMRect;
    view = { contentDOM };
    // A pointer event constructor jsdom does not ship.
    if (!("PointerEvent" in window)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).PointerEvent = MouseEvent;
    }
  });

  function mountBlock(): { frame: HTMLElement; img: HTMLImageElement } {
    const frame = new AttachmentImageWidget(
      ID,
      "p.png",
      emptyEmbedLayout(),
      [],
      true,
    ).toDOM(view as never);
    document.body.appendChild(frame);
    const img = frame.querySelector("img.cm-attachment-img") as HTMLImageElement;
    img.getBoundingClientRect = () => ({ width: 200, height: 100 }) as DOMRect;
    return { frame, img };
  }

  function drag(handleTestId: string, dx: number, dy: number): void {
    const handle = document.querySelector(`[data-testid="${handleTestId}"]`);
    expect(handle, `no ${handleTestId} handle was appended`).not.toBeNull();
    handle!.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }),
    );
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: dx, clientY: dy }));
    window.dispatchEvent(new MouseEvent("pointerup", {}));
  }

  it("the edge handle writes a width and leaves the height alone", () => {
    mountBlock();
    drag("attachment-image.resize-e", 120, 0);

    expect(updateEmbedLayout).toHaveBeenCalledTimes(1);
    const mutate = vi.mocked(updateEmbedLayout).mock.calls[0][3];
    const next = mutate(emptyEmbedLayout());
    // 200 start + 120 travel, inside the 900px content column.
    expect(next.widthPx).toBe(320);
    expect(next.widthPercent).toBeNull();
    expect(next.heightPx).toBeNull();
  });

  it("the corner handle writes both, which is aspect distortion on purpose", () => {
    mountBlock();
    drag("attachment-image.resize-se", 120, 40);

    const mutate = vi.mocked(updateEmbedLayout).mock.calls[0][3];
    const next = mutate(emptyEmbedLayout());
    expect(next.widthPx).toBe(320);
    expect(next.heightPx).toBe(140);
  });

  it("a press that does not move writes nothing, because that is a click", () => {
    mountBlock();
    drag("attachment-image.resize-e", 0, 0);
    expect(updateEmbedLayout).not.toHaveBeenCalled();
  });

  it("an abandoned drag puts the frame's own width cap back", () => {
    // The cap comes off for the duration so the image can grow past the theme's
    // 320px frame limit. On the commit path the rebuilt widget restores it; on a
    // `pointercancel` nothing rebuilds, so without the restore the embed keeps an
    // uncapped frame for the rest of the session.
    const { frame } = mountBlock();
    const before = frame.style.maxWidth;
    const handle = document.querySelector('[data-testid="attachment-image.resize-e"]')!;
    handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
    expect(frame.style.maxWidth).toBe("100%");
    window.dispatchEvent(new MouseEvent("pointercancel", {}));
    expect(frame.style.maxWidth).toBe(before);
    expect(updateEmbedLayout).not.toHaveBeenCalled();
  });

  it("an inline embed gets no handles at all", () => {
    // The other direction, so the cases above cannot pass merely because a
    // handle exists somewhere: `block: false` is the arm that returns early.
    new AttachmentImageWidget(ID, "p.png", emptyEmbedLayout(), [], false).toDOM(view as never);
    expect(document.querySelector('[data-testid="attachment-image.resize-e"]')).toBeNull();
  });
});
