// @vitest-environment jsdom
//
// The close order every dual-use surface owes: pop `inert` BEFORE restoring
// focus. Chrome refuses `.focus()` on an inert subtree, so a restore that runs
// first leaves focus on <body> — the web quick-picker Esc assertion (and KN-4).
// Declaration order is the order React runs layout cleanups on this fiber, so
// `useOverlayInert` must be called above `useFocusTrap` in every component that
// uses both. Shape matches ModalShell: opener outside the dialog, dialog DOM
// removed on close.

import { afterEach, describe, expect, it } from "vitest";
import { useRef } from "react";
import { cleanup, render, screen, act } from "@testing-library/react";
import { useOverlayInert } from "../../src/hooks/useOverlayInert";
import { useFocusTrap } from "../../src/hooks/useFocusTrap";
import { isInertByOverlay, openOverlayCount, resetOverlayInert } from "../../src/lib/overlay-inert";

afterEach(() => {
  cleanup();
  resetOverlayInert();
});

function Dialog({ open }: { open: boolean }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
  useFocusTrap(modalRef, { enabled: open });
  if (!open) return null;
  return (
    <div ref={backdropRef} data-testid="backdrop">
      <div ref={modalRef} role="dialog" aria-modal="true">
        <button type="button">inside</button>
      </div>
    </div>
  );
}

function WithOpener({ open }: { open: boolean }) {
  return (
    <div>
      <button type="button">opener</button>
      <Dialog open={open} />
    </div>
  );
}

describe("overlay inert pops before focus restore", () => {
  it("restores focus to the opener, not body", () => {
    const { rerender } = render(<WithOpener open={false} />);
    const opener = screen.getByText("opener") as HTMLButtonElement;
    act(() => {
      opener.focus();
    });
    expect(document.activeElement).toBe(opener);

    rerender(<WithOpener open={true} />);
    const inside = screen.getByText("inside") as HTMLButtonElement;
    expect(document.activeElement).toBe(inside);
    expect(openOverlayCount()).toBeGreaterThan(0);
    // The opener is a background sibling of the overlay, so it is the element
    // that must be inert while open (body itself is never marked).
    expect(isInertByOverlay(opener)).toBe(true);

    rerender(<WithOpener open={false} />);
    expect(screen.queryByText("inside")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(openOverlayCount()).toBe(0);
    expect(isInertByOverlay(opener)).toBe(false);
  });
});
