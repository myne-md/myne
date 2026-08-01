// @vitest-environment jsdom
//
// The checkbox actually materializes a recurring task (myne#198).
//
// This file exists because of HOW the bug it covers shipped. The recurrence
// functions were complete, unit-tested and green — and had no production caller,
// so ticking a recurring task did nothing. Tests that call
// `completeRecurringTask` directly (`taskRecurrence.test.ts`) cannot see that,
// by construction: they ARE the caller.
//
// So every assertion here goes through the rendered checkbox — find the widget
// in the DOM, dispatch a real mouse event at it, read the document. Nothing
// imports the recurrence module. If the wiring is removed again, this file goes
// red and the other two stay green.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { undo } from "@codemirror/commands";
import { mount, type Mounted, query, teardown } from "./_conformance";

let m: Mounted | null = null;

beforeEach(() => {
  // The widget reads the system clock (it takes no clock parameter — that is
  // the point of testing the production path), so the date is pinned here.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 28, 12, 0, 0)); // 2026-07-28, local
});

afterEach(() => {
  vi.useRealTimers();
  if (m !== null) teardown(m);
  m = null;
});

function checkbox(): HTMLElement {
  const el = query(m!, ".cm-task-checkbox");
  if (el === null) throw new Error("no checkbox rendered");
  return el as HTMLElement;
}

function click(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
}

describe("ticking a recurring task through its checkbox", () => {
  it("flips the marker AND inserts the next occurrence", () => {
    m = mount("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    click(checkbox());

    const lines = m.view.state.doc.toString().split("\n");
    expect(lines[0]).toContain("[x]");
    expect(lines[0]).toContain("[due:: 2026-07-01]"); // the completed one keeps its date
    expect(lines[1]).toContain("[ ]");
    expect(lines[1]).toContain("[due:: 2026-08-01]");
  });

  it("rides ONE transaction, so a single undo restores the document", () => {
    const source = "- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n";
    m = mount(source);

    let dispatches = 0;
    const original = m.view.dispatch.bind(m.view);
    m.view.dispatch = ((...args: Parameters<typeof original>) => {
      dispatches++;
      return original(...args);
    }) as typeof original;

    click(checkbox());
    expect(dispatches).toBe(1);

    undo(m.view);
    expect(m.view.state.doc.toString()).toBe(source);
  });

  it("does not duplicate on a second click — the document is the idempotency key", () => {
    m = mount("- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n");
    click(checkbox());
    const afterFirst = m.view.state.doc.toString();

    // The widget is rebuilt after the change, so re-query rather than reusing
    // the old element.
    click(checkbox());
    const afterSecond = m.view.state.doc.toString();

    // The second click reads a ticked marker: it un-ticks, and because the
    // orphan is still an exact match it takes the occurrence away with it.
    expect(afterSecond).not.toBe(afterFirst);
    expect(afterSecond.split("\n").filter((l) => l.includes("[due::")).length).toBe(1);
  });

  it("leaves a non-recurring task on the plain flip", () => {
    m = mount("- [ ] one-off [due:: 2026-07-01]\n");
    click(checkbox());
    expect(m.view.state.doc.toString()).toBe("- [x] one-off [due:: 2026-07-01]\n");
  });

  it("materializes nothing for a rule Myne cannot read", () => {
    // Inventing a default here would repeat a task the user never asked to
    // repeat. The marker still flips — declining to recur is not declining to
    // complete.
    m = mount("- [ ] x [due:: 2026-07-01] [repeat:: every fortnight]\n");
    click(checkbox());
    expect(m.view.state.doc.toString()).toBe(
      "- [x] x [due:: 2026-07-01] [repeat:: every fortnight]\n",
    );
  });
});

describe("un-ticking a recurring task through its checkbox", () => {
  const COMPLETED = "- [x] pay rent [due:: 2026-07-01] [repeat:: every month]";
  const ORPHAN = "- [ ] pay rent [due:: 2026-08-01] [repeat:: every month]";

  it("removes the occurrence it materialized, in the same transaction", () => {
    m = mount(`${COMPLETED}\n${ORPHAN}\n`);

    let dispatches = 0;
    const original = m.view.dispatch.bind(m.view);
    m.view.dispatch = ((...args: Parameters<typeof original>) => {
      dispatches++;
      return original(...args);
    }) as typeof original;

    click(checkbox());
    expect(dispatches).toBe(1);
    expect(m.view.state.doc.toString()).toBe(
      "- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n",
    );
  });

  it("leaves a successor the user edited alone", () => {
    // A line we cannot positively identify is user content, and deleting it
    // would be unrecoverable.
    const edited = `${ORPHAN} [priority:: high]`;
    m = mount(`${COMPLETED}\n${edited}\n`);
    click(checkbox());

    const doc = m.view.state.doc.toString();
    expect(doc).toContain(edited);
    expect(doc.split("\n")[0]).toContain("[ ]");
  });

  it("keyboard activation takes the same path", () => {
    m = mount(`${COMPLETED}\n${ORPHAN}\n`);
    checkbox().dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(m.view.state.doc.toString()).toBe(
      "- [ ] pay rent [due:: 2026-07-01] [repeat:: every month]\n",
    );
  });
});
