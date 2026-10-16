// @vitest-environment jsdom
//
// The long-copy affordance (myne-md/myne#885, task 2).
//
// The failure this file exists for is a HOVER-ONLY surface: a question mark that
// opens a paragraph when a pointer rests on it and does nothing for anyone
// using a keyboard or a screen reader. Every assertion below is one of the four
// things that shape gets wrong:
//
//   1. the critical sentence renders INLINE, in the row's own helper slot;
//   2. the long copy is not visible until the affordance is opened, which is the
//      whole point of moving it;
//   3. the long copy is ASSOCIATED WITH THE SETTING while collapsed, through the
//      control's `aria-describedby`. This is the one a hover-only implementation
//      fails, and it fails silently: the popover looks right to everyone who
//      opens it with a mouse;
//   4. it opens on hover, on focus AND on press, closes on Escape and on blur,
//      and Escape does not also dismiss the Settings dialog behind it.
//
// The tests are written against `SettingRow` rather than the primitive alone,
// because the row is where the association is made: `HelperDisclosure` renders
// the copy, and `SettingRow` hands its id to the control. A test of the
// primitive by itself would pass with the row wiring removed.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SettingRow } from "../../src/components/settings/SettingRow";

const HELPER = "Every vault shows a placeholder such as Vault 2 instead of its name.";
const P1 = "Turning it on destroys the keys that make the names stored here readable.";
const P2 = "It cannot reach a copy taken earlier: a full-system backup carries both.";

/**
 * `undefined` here means the prop is OMITTED, which is a different case from an
 * empty array and is asserted separately. The default lives in the wrapper
 * below rather than in this signature, because a JS default parameter applies
 * on `undefined` and would silently swallow that case.
 */
function mountRow(explanation?: readonly string[]) {
  return render(
    <SettingRow
      label="Hide vault names on the lock screen"
      helper={HELPER}
      explanation={explanation}
      testId="settings.example"
      anchorId="example"
      control={(helperId, explanationId) => (
        <input
          type="checkbox"
          data-testid="settings.example-toggle"
          aria-describedby={
            explanationId === undefined ? helperId : `${helperId} ${explanationId}`
          }
        />
      )}
    />,
  );
}

/** The row with the moved copy on it, which is the shape under test. */
const mountWithCopy = () => mountRow([P1, P2]);

const explanationEl = () =>
  screen.getByTestId("settings.example-explanation") as HTMLElement;

/** `display` as the browser would resolve it, which is how "not shown" is read. */
const isShown = (el: HTMLElement) => window.getComputedStyle(el).display !== "none";

afterEach(cleanup);

describe("the critical sentence stays inline and the rest does not", () => {
  it("renders the helper in the row, in the row's own helper slot", () => {
    const { container } = mountWithCopy();
    const helper = screen.getByText(HELPER);
    expect(helper).toBeTruthy();
    // In the row, not in the popover: the row's helper paragraph is a direct
    // child of the row block, which the popover's copy is not.
    expect(helper.parentElement?.getAttribute("data-setting-row")).toBe("true");
    expect(container.querySelectorAll("[data-testid$='-explanation']").length).toBe(1);
  });

  it("does not paint the long copy until the affordance is opened", () => {
    mountWithCopy();
    expect(isShown(explanationEl())).toBe(false);
    fireEvent.mouseEnter(screen.getByTestId("settings.example-explain"));
    expect(isShown(explanationEl())).toBe(true);
  });

  it("floats while open, so a scrolling ancestor cannot clip it", () => {
    // The popover opens inside the panel's scroll container, which is
    // `overflow: auto`, so an `absolute` one would be cut at the column's edge.
    // `fixed` escapes that (the same reason `Select`'s menu and `Tooltip`'s
    // bubble are fixed), and jsdom CAN see the declaration even though it
    // computes no layout, which makes this the half of the decision that is
    // testable here. The other half, whether an ancestor clips it anyway, is
    // the manual item on the roster.
    mountWithCopy();
    const el = explanationEl();
    fireEvent.focus(screen.getByTestId("settings.example-explain"));
    expect(el.style.position).toBe("fixed");
    // And it stays in the document while collapsed rather than unmounting: a
    // `display: none` node is still the description source.
    fireEvent.blur(screen.getByTestId("settings.example-explain"));
    expect(isShown(el)).toBe(false);
    expect(el.isConnected).toBe(true);
  });

  it("keeps the moved copy in the document while collapsed, so nothing is lost", () => {
    mountWithCopy();
    const el = explanationEl();
    // The node exists and carries the paragraphs verbatim. A `display: none`
    // node is still the description source (the accname spec includes a node
    // DIRECTLY referenced by `aria-describedby` whatever its visibility), which
    // is what makes the collapsed state announce the full copy.
    expect(el.textContent).toContain(P1);
    expect(el.textContent).toContain(P2);
  });
});

describe("the long copy is associated with the setting while collapsed", () => {
  it("names the description element from the control's aria-describedby", () => {
    mountWithCopy();
    const control = screen.getByTestId("settings.example-toggle");
    const describedBy = control.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const ids = describedBy!.split(/\s+/);
    // Two descriptions: the one-sentence helper, and the moved copy.
    expect(ids.length).toBe(2);
    const target = document.getElementById(ids[1]!);
    expect(target).not.toBeNull();
    expect(target!.textContent).toContain(P1);
    expect(target!.textContent).toContain(P2);
    // …and it is the same node the popover shows, not a second hidden copy.
    expect(target).toBe(explanationEl());
  });

  it("gives the trigger an accessible name of its own", () => {
    mountWithCopy();
    const trigger = screen.getByTestId("settings.example-explain");
    expect(trigger.getAttribute("aria-label")).toBe("More about this setting");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("it is reachable without a pointer", () => {
  it("opens on keyboard focus and closes on blur", () => {
    mountWithCopy();
    const trigger = screen.getByTestId("settings.example-explain");
    expect(isShown(explanationEl())).toBe(false);
    fireEvent.focus(trigger);
    expect(isShown(explanationEl())).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    fireEvent.blur(trigger);
    expect(isShown(explanationEl())).toBe(false);
  });

  it("opens on press, which is the only path a touch device has", () => {
    mountWithCopy();
    const trigger = screen.getByTestId("settings.example-explain");
    // A tap: the pointer arrives first, so the focus it causes must NOT be read
    // as a keyboard focus, or the press that follows would close what the focus
    // opened and the control would do nothing at all.
    fireEvent.pointerDown(trigger);
    fireEvent.focus(trigger);
    expect(isShown(explanationEl())).toBe(false);
    fireEvent.click(trigger);
    expect(isShown(explanationEl())).toBe(true);
    fireEvent.click(trigger);
    expect(isShown(explanationEl())).toBe(false);
  });

  it("a press while HOVERING still closes it", () => {
    // The pointer has already opened it through hover, so a press that only
    // cleared the pinned flag would leave it open and the button would read as
    // inert. Found by the end-to-end scenario, which failed this step three
    // runs out of three before the press was made to drop the hover peek too.
    mountWithCopy();
    const trigger = screen.getByTestId("settings.example-explain");
    fireEvent.mouseEnter(trigger);
    expect(isShown(explanationEl())).toBe(true);
    // First press pins it (no visible change), second closes it.
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    expect(isShown(explanationEl())).toBe(true);
    fireEvent.click(trigger);
    expect(isShown(explanationEl())).toBe(false);
    // …and it does not reopen while the pointer rests there.
    expect(isShown(explanationEl())).toBe(false);
  });

  it("closes on Escape and keeps focus on the trigger", () => {
    mountWithCopy();
    const trigger = screen.getByTestId("settings.example-explain");
    fireEvent.focus(trigger);
    expect(isShown(explanationEl())).toBe(true);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(isShown(explanationEl())).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it("stops Escape at the disclosure so it does not also close the dialog", () => {
    mountWithCopy();
    const trigger = screen.getByTestId("settings.example-explain");
    fireEvent.focus(trigger);
    const seen: string[] = [];
    // A stand-in for `SettingsModal.tsx`'s own `window` listener: it must never
    // see this keydown, or an Escape aimed at the explanation would dismiss the
    // whole Settings dialog instead.
    const onWindow = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", onWindow);
    try {
      fireEvent.keyDown(trigger, { key: "Escape" });
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
    expect(seen).toEqual([]);
  });
});

describe("a row with no explanation is the row it was before", () => {
  it("renders no trigger and hands the control only the helper's id", () => {
    mountRow(undefined);
    expect(screen.queryByTestId("settings.example-explain")).toBeNull();
    expect(screen.queryByTestId("settings.example-explanation")).toBeNull();
    const control = screen.getByTestId("settings.example-toggle");
    expect(control.getAttribute("aria-describedby")?.split(/\s+/).length).toBe(1);
  });

  it("treats an empty array as no explanation rather than an empty popover", () => {
    mountRow([]);
    expect(screen.queryByTestId("settings.example-explain")).toBeNull();
  });
});

describe("the row's existing slots are untouched", () => {
  it("still renders the helper id, the error slot and the anchor", () => {
    const { container } = render(
      <SettingRow
        label="Example"
        helper={HELPER}
        explanation={[P1]}
        error="Couldn't save that."
        anchorId="example.anchor"
        testId="settings.example2"
        control={() => <input type="checkbox" data-testid="settings.example2-toggle" />}
      />,
    );
    const root = container.querySelector("[data-testid='settings.example2']")!;
    expect(root.getAttribute("data-setting-anchor")).toBe("example.anchor");
    expect(screen.getByRole("alert").textContent).toBe("Couldn't save that.");
    const helper = screen.getByText(HELPER);
    expect(helper.getAttribute("id")).toBeTruthy();
  });
});
