// @vitest-environment jsdom
//
// Unit tests for the focus-trap primitive (MYND-93, task 2). Verifies the four
// guarantees in isolation: initial focus, Tab/Shift-Tab wrap, no escape to the
// background, and focus restore to the pre-activation element on teardown.

import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useRef, useState } from "react";
import { useFocusTrap } from "../../src/hooks/useFocusTrap";
import { trapFocus } from "../../src/lib/imperative-focus-trap";

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

describe("stacked traps — release order and staleness (MYND-567)", () => {
  it("survives OUT-OF-ORDER release: closing the outer trap first", () => {
    // Traps are removed by identity, not popped, so an outer modal closing
    // while an inner one is still open must leave the inner one enforcing.
    const outer = document.createElement("div");
    const outerBtn = document.createElement("button");
    outer.appendChild(outerBtn);
    const inner = document.createElement("div");
    const innerBtn = document.createElement("button");
    inner.appendChild(innerBtn);
    document.body.append(outer, inner);

    const releaseOuter = trapFocus(outer);
    const releaseInner = trapFocus(inner);
    expect(document.activeElement).toBe(innerBtn);

    releaseOuter(); // out of order — the inner trap is still open

    const stray = document.createElement("button");
    document.body.appendChild(stray);
    stray.focus();
    expect(document.activeElement).toBe(innerBtn);

    releaseInner();
    stray.remove();
    outer.remove();
    inner.remove();
  });

  it("ignores a trap whose container left the DOM", () => {
    // A stale entry sitting on top would otherwise make every LIVE trap inert —
    // a worse failure than the ping-pong the stack exists to prevent.
    const live = document.createElement("div");
    const liveBtn = document.createElement("button");
    live.appendChild(liveBtn);
    document.body.appendChild(live);
    const releaseLive = trapFocus(live);

    const orphan = document.createElement("div");
    orphan.appendChild(document.createElement("button"));
    document.body.appendChild(orphan);
    trapFocus(orphan);
    orphan.remove(); // detached WITHOUT releasing

    const stray = document.createElement("button");
    document.body.appendChild(stray);
    stray.focus();
    expect(document.activeElement).toBe(liveBtn);

    releaseLive();
    stray.remove();
    live.remove();
  });
});

describe("portalled surfaces opened by a trapped dialog (#182)", () => {
  // A menu/popover a trapped dialog opens is rendered under <body> to escape
  // the dialog's overflow, so `container.contains()` calls it an escape and the
  // containment listener yanks focus back the instant the surface focuses
  // anything of its own. That is not cosmetic: the surface becomes untypable.
  // Shipped exactly that way — the Settings language picker's search box could
  // not take a single keystroke, and the E2E scenario failed on send-keys with
  // "Element is not focusable".
  function portalledSurface(marked: boolean): {
    surface: HTMLDivElement;
    input: HTMLInputElement;
  } {
    const surface = document.createElement("div");
    if (marked) surface.setAttribute("data-focus-trap-portal", "");
    const input = document.createElement("input");
    surface.appendChild(input);
    document.body.appendChild(surface);
    return { surface, input };
  }

  it("keeps focus in a marked portal instead of pulling it back", () => {
    const dialog = document.createElement("div");
    const dialogBtn = document.createElement("button");
    dialog.appendChild(dialogBtn);
    document.body.appendChild(dialog);
    const release = trapFocus(dialog);
    expect(document.activeElement).toBe(dialogBtn);

    const { surface, input } = portalledSurface(true);
    input.focus();
    expect(document.activeElement).toBe(input);

    release();
    surface.remove();
    dialog.remove();
  });

  it("still pulls focus back from an UNMARKED node outside the dialog", () => {
    // The marker is opt-in: containment is unchanged for everything else.
    const dialog = document.createElement("div");
    const dialogBtn = document.createElement("button");
    dialog.appendChild(dialogBtn);
    document.body.appendChild(dialog);
    const release = trapFocus(dialog);

    const { surface, input } = portalledSurface(false);
    input.focus();
    expect(document.activeElement).toBe(dialogBtn);

    release();
    surface.remove();
    dialog.remove();
  });

  it("covers a descendant of the marked surface, not just its root", () => {
    const dialog = document.createElement("div");
    dialog.appendChild(document.createElement("button"));
    document.body.appendChild(dialog);
    const release = trapFocus(dialog);

    const { surface } = portalledSurface(true);
    const nested = document.createElement("div");
    const deepInput = document.createElement("input");
    nested.appendChild(deepInput);
    surface.appendChild(nested);

    deepInput.focus();
    expect(document.activeElement).toBe(deepInput);

    release();
    surface.remove();
    dialog.remove();
  });
});
