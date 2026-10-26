// @vitest-environment jsdom
//
// The folded band's list drawer (myne-md/myne#918).
//
// The band puts the note at the full width of a 626pt display and the list on
// top of it, so the drawer is the ONE surface where the note is still mounted
// and unreachable at the same time. Two things follow, and both are what this
// spec asserts rather than the slide animation:
//
//   - the way out has to exist in every modality the platform offers (scrim,
//     Escape, a swipe toward the drawer's own edge), because the note behind it
//     cannot be reached;
//   - focus has to come BACK to whatever held it, or a keyboard user is
//     stranded at the document root after closing a list they only glanced at.
//
// The note's own inertness is asserted at the call site (EditorFlow), not here:
// this component is rendered by the band, not by a test double.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ListDrawer } from "../../src/app/flows/editor/sheets/ListDrawer";

// The drawer slides OUT before it hands the parent the unmount (the sheets'
// behaviour), so `onClose` arrives one duration later. Fake timers make that
// deterministic instead of a race against a 0ms macrotask.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Run the exit animation's timer. */
function finishClose() {
  vi.advanceTimersByTime(50);
}

function renderDrawer(onClose = vi.fn()) {
  render(
    <ListDrawer label="Notes and folders" onClose={onClose}>
      <button type="button">A note</button>
    </ListDrawer>,
  );
  return { onClose, panel: screen.getByTestId("notes.list-drawer") };
}

describe("the list drawer's way out", () => {
  it("is announced as a dialog with the name the caller gave it", () => {
    const { panel } = renderDrawer();
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-label")).toBe("Notes and folders");
  });

  it("closes on a scrim tap", () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByTestId("notes.list-drawer-scrim"));
    finishClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(document, { key: "Escape" });
    finishClose();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores every other key", () => {
    const { onClose } = renderDrawer();
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismisses on a long slow drag, not on a short slow one", () => {
    const { onClose, panel } = renderDrawer();
    // LTR: the drawer sits on the left, so the closing direction is negative.
    // Fake time is what makes these two rows mean different things: without it
    // every synthetic drag is a 1ms flick and the distance arm is never the
    // reason anything opens or closes.
    fireEvent.pointerDown(panel, { clientX: 300, pointerId: 1 });
    vi.advanceTimersByTime(300);
    fireEvent.pointerMove(panel, { clientX: 260, pointerId: 1 });
    fireEvent.pointerUp(panel, { clientX: 260, pointerId: 1 });
    finishClose();
    expect(onClose, "a slow 40px drag is not a dismissal").not.toHaveBeenCalled();

    fireEvent.pointerDown(panel, { clientX: 300, pointerId: 1 });
    vi.advanceTimersByTime(400);
    fireEvent.pointerMove(panel, { clientX: 160, pointerId: 1 });
    fireEvent.pointerUp(panel, { clientX: 160, pointerId: 1 });
    finishClose();
    expect(onClose, "a slow 140px drag is").toHaveBeenCalledTimes(1);
  });

  it("dismisses on a short fast flick, because that is a gesture rather than a drag", () => {
    const { onClose, panel } = renderDrawer();
    fireEvent.pointerDown(panel, { clientX: 300, pointerId: 1 });
    vi.advanceTimersByTime(10);
    fireEvent.pointerMove(panel, { clientX: 240, pointerId: 1 });
    fireEvent.pointerUp(panel, { clientX: 240, pointerId: 1 });
    finishClose();
    expect(onClose, "60px in 10ms is 6px/ms").toHaveBeenCalledTimes(1);
  });

  it("does not close on a sub-threshold jitter", () => {
    const { onClose, panel } = renderDrawer();
    fireEvent.pointerDown(panel, { clientX: 300, pointerId: 1 });
    vi.advanceTimersByTime(1);
    fireEvent.pointerMove(panel, { clientX: 288, pointerId: 1 });
    fireEvent.pointerUp(panel, { clientX: 288, pointerId: 1 });
    finishClose();
    expect(onClose, "12px is a jitter even at absurd speed").not.toHaveBeenCalled();
  });

  it("does not close on a drag away from its own edge", () => {
    const { onClose, panel } = renderDrawer();
    // Inward (positive in LTR) is not a gesture; it must not accumulate into a
    // dismissal when the pointer comes back.
    fireEvent.pointerDown(panel, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(panel, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(panel, { clientX: 400, pointerId: 1 });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("the list drawer keeps focus inside itself", () => {
  it("wraps Tab from the last control to the first", () => {
    render(
      <ListDrawer label="Notes and folders" onClose={vi.fn()}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </ListDrawer>,
    );
    const panel = screen.getByTestId("notes.list-drawer");
    const last = screen.getByText("Last");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement, "aria-modal means focus cannot walk out").toBe(screen.getByText("First"));
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    render(
      <ListDrawer label="Notes and folders" onClose={vi.fn()}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </ListDrawer>,
    );
    const first = screen.getByText("First");
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("Last"));
  });
});

describe("the list drawer's press versus drag", () => {
  it("leaves a press that never travels to the control under it", () => {
    // The drawer carries the whole list, so a press on a row must stay a press:
    // taking the pointer on pointerdown retargets the click and the row never
    // fires (the defect this threshold exists for).
    const { onClose, panel } = renderDrawer();
    fireEvent.pointerDown(panel, { clientX: 200, pointerId: 1, button: 0 });
    fireEvent.pointerUp(panel, { clientX: 200, pointerId: 1, button: 0 });
    finishClose();
    expect(onClose).not.toHaveBeenCalled();
    expect(panel.style.transform, "a press does not move the drawer").toBe("translateX(0px)");
  });
});

describe("the list drawer's focus", () => {
  it("takes focus when it opens", () => {
    const { panel } = renderDrawer();
    expect(document.activeElement).toBe(panel);
  });

  it("gives focus back to what had it", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { panel } = renderDrawer();
    expect(document.activeElement).toBe(panel);

    cleanup();
    expect(document.activeElement, "closing the list must not strand the keyboard").toBe(opener);
    opener.remove();
  });
});
