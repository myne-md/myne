// @vitest-environment jsdom
//
// Unit tests for the focus-trap primitive (MYND-93, task 2). Verifies the four
// guarantees in isolation: initial focus, Tab/Shift-Tab wrap, no escape to the
// background, and focus restore to the pre-activation element on teardown.

import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useRef, useState } from "react";
import { useFocusTrap } from "../../src/hooks/useFocusTrap";

afterEach(() => cleanup());

function Trapped({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { enabled });
  return (
    <div ref={ref}>
      <button data-testid="first">first</button>
      <button data-testid="mid">mid</button>
      <button data-testid="last">last</button>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button data-testid="trigger" onClick={() => setOpen((o) => !o)}>
        toggle
      </button>
      {open && <Trapped />}
    </>
  );
}

describe("useFocusTrap", () => {
  it("moves focus to the first focusable on activation", () => {
    const { getByTestId } = render(<Trapped />);
    expect(document.activeElement).toBe(getByTestId("first"));
  });

  it("wraps Tab from the last focusable back to the first", () => {
    const { getByTestId } = render(<Trapped />);
    const last = getByTestId("last");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(getByTestId("first"));
  });

  it("wraps Shift-Tab from the first focusable to the last", () => {
    const { getByTestId } = render(<Trapped />);
    const first = getByTestId("first");
    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(getByTestId("last"));
  });

  it("never lets Tab move focus to the document body", () => {
    const { getByTestId } = render(<Trapped />);
    const last = getByTestId("last");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).not.toBe(document.body);
    expect(getByTestId("first").parentElement?.contains(document.activeElement)).toBe(
      true,
    );
  });

  it("restores focus to the pre-activation element on teardown", () => {
    const { getByTestId } = render(<Harness />);
    const trigger = getByTestId("trigger");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger); // open → trap mounts, captures trigger, focuses first
    expect(document.activeElement).toBe(getByTestId("first"));

    fireEvent.click(trigger); // close → trap unmounts, restores to trigger
    expect(document.activeElement).toBe(trigger);
  });

  it("is inert when disabled (no focus move)", () => {
    render(<Trapped enabled={false} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe("stacked traps (MYND-567)", () => {
  // Containment is enforced by a DOCUMENT-level `focusin` listener, so two live
  // traps would each yank focus into their own container and ping-pong. Every
  // modal used to be opened by the same owner closing the previous one first;
  // `ThemeInstallDialog` breaks that by opening from an OS deep link, which can
  // arrive over any modal the user already had open.
  function TwoTraps({ innerOpen }: { innerOpen: boolean }) {
    const outer = useRef<HTMLDivElement>(null);
    const inner = useRef<HTMLDivElement>(null);
    useFocusTrap(outer);
    useFocusTrap(inner, { enabled: innerOpen });
    return (
      <>
        <div ref={outer}>
          <button data-testid="outer-btn">outer</button>
        </div>
        {innerOpen && (
          <div ref={inner}>
            <button data-testid="inner-btn">inner</button>
          </div>
        )}
      </>
    );
  }

  it("lets the innermost trap hold focus instead of fighting the outer one", () => {
    const { getByTestId } = render(<TwoTraps innerOpen />);
    const inner = getByTestId("inner-btn");
    expect(document.activeElement).toBe(inner);

    // The outer trap is still installed. If it were still enforcing, this
    // focusin would bounce focus back out of the inner dialog.
    fireEvent.focusIn(inner, { target: inner });
    expect(document.activeElement).toBe(inner);
  });

  it("hands enforcement back to the outer trap when the inner one closes", () => {
    const { getByTestId, rerender } = render(<TwoTraps innerOpen />);
    expect(document.activeElement).toBe(getByTestId("inner-btn"));

    rerender(<TwoTraps innerOpen={false} />);

    const outer = getByTestId("outer-btn");
    expect(document.activeElement).toBe(outer);
    // And the outer trap is enforcing again — an escape attempt is pulled back.
    const stray = document.createElement("button");
    document.body.appendChild(stray);
    stray.focus();
    expect(document.activeElement).toBe(outer);
    stray.remove();
  });
});
