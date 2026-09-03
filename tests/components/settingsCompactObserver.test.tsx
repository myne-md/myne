// @vitest-environment jsdom
//
// The compact observer ATTACHES — myne-md/myne#556.
//
// # The defect, and why the existing tests could not see it
//
// `tests/components/settings/settingsCompact.test.ts` covers
// `isSettingsCompact`, the pure width→boolean decision, and it was correct the
// whole time. The bug was one layer out, in the hook that feeds it: a
// `RefObject` changing from `null` to an element does not re-render, and
// `SettingsModal` calls the hook on every render INCLUDING the closed ones,
// where it returns `null` before the content div exists. So the effect — keyed
// only on the stable ref object — ran once, found `null`, returned early, and
// no `ResizeObserver` was ever attached.
//
// The responsive restack therefore never fired, at any width, on any client.
// Measured in a real browser before the fix: the content area was 630 px at a
// 900 px window and 230 px at a 500 px one, against a 720 px threshold, with
// zero rows compact throughout and the label cell crushed to 0 px wide — the
// exact overlap `settingsCompact.ts`'s own header describes.
//
// Nothing caught it because the trigger is a window resize. That module's
// header says so plainly: the tauri-driver harness cannot drive one, so the
// decision was unit-tested as a pure function and its WIRING was never
// exercised at all. A pure function tested in isolation is a pure function
// tested in isolation.
//
// # Two layers, deliberately
//
// `e2e-web/settings-restack.e2e.ts` drives a real browser window and is the
// proof. This file is the fast one, and it fails for a different reason: it
// asserts the observer is attached to the element at all, which is the fact the
// browser scenario can only infer from the outcome.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import {
  isSettingsCompact,
  SETTINGS_COMPACT_WIDTH,
  useSettingsCompactObserver,
} from "../../src/components/settings/settingsCompact";

/** Elements this fake observer was asked to watch, in order. */
let observed: Element[] = [];
/** The callbacks, so a test can fire a resize. */
let callbacks: Array<() => void> = [];

class FakeResizeObserver {
  constructor(cb: () => void) {
    callbacks.push(cb);
  }
  observe(el: Element) {
    observed.push(el);
  }
  disconnect() {}
}

afterEach(() => {
  cleanup();
  observed = [];
  callbacks = [];
});

/**
 * A harness mirroring `SettingsModal`'s shape: the hook runs on every render,
 * and the observed element exists only while `open`.
 *
 * That shape IS the bug. A harness that always rendered the div would attach on
 * the first effect and pass against the broken hook.
 */
function Harness({ open, width }: { open: boolean; width: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const compact = useSettingsCompactObserver(ref as RefObject<HTMLElement | null>, open);
  if (!open) return null;
  return (
    <div ref={ref} data-testid="content" data-width={width} data-compact={String(compact)} />
  );
}

describe("useSettingsCompactObserver attaches when the element appears", () => {
  it("observes nothing while the dialog is closed", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    render(<Harness open={false} width={400} />);
    expect(
      observed,
      "an observer was attached while the dialog was closed, so it is watching " +
        "something that is not the content area",
    ).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("observes the content element once the dialog opens", () => {
    // THE regression. Before the fix the effect was keyed only on the ref, so
    // it ran once against `null` and never again — and this assertion is the
    // one that would have said so.
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { rerender } = render(<Harness open={false} width={400} />);
    expect(observed).toEqual([]);
    rerender(<Harness open width={400} />);
    expect(
      observed.length,
      "opening the dialog attached no ResizeObserver. A RefObject filling in does " +
        "not re-render, so an effect keyed only on the ref runs once — against " +
        "`null` — and the responsive restack never fires at any width.",
    ).toBe(1);
    expect((observed[0] as HTMLElement).getAttribute("data-testid")).toBe("content");
    vi.unstubAllGlobals();
  });

  it("re-observes after a close and re-open", () => {
    // The teardown half: `disconnect` on close, a fresh `observe` on the next
    // open. Without it the second opening of Settings in a session would be the
    // broken one, which is worse than always-broken because it looks flaky.
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { rerender } = render(<Harness open width={400} />);
    expect(observed.length).toBe(1);
    rerender(<Harness open={false} width={400} />);
    rerender(<Harness open width={400} />);
    expect(
      observed.length,
      "re-opening the dialog did not re-attach the observer, so the second and " +
        "every later opening in a session has no restack",
    ).toBe(2);
    vi.unstubAllGlobals();
  });

  it("degrades without ResizeObserver rather than throwing", () => {
    // An engine with no `ResizeObserver` gets the non-compact layout, which is
    // the same pre-measurement default `isSettingsCompact` documents.
    vi.stubGlobal("ResizeObserver", undefined);
    expect(() => render(<Harness open width={400} />)).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("the threshold this all feeds is still the documented one", () => {
    // Non-vacuity for the pair of files: if the constant moved, the browser
    // scenario's chosen widths would stop straddling it and would pass while
    // measuring nothing.
    expect(SETTINGS_COMPACT_WIDTH).toBe(720);
    expect(isSettingsCompact(SETTINGS_COMPACT_WIDTH)).toBe(true);
    expect(isSettingsCompact(SETTINGS_COMPACT_WIDTH + 1)).toBe(false);
  });
});
