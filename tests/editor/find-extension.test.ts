// @vitest-environment jsdom
//
// In-note find EXTENSION wiring (MYND-175, Task 2-7): the real `findExtension()`
// composed over a live doc. Drives the @codemirror/search engine through the
// Myne-styled panel and asserts the READ-ONLY "k/N" projection, the no-match /
// idle states, next/prev + wrap, the case toggle, Enter/Shift+Enter, and
// Escape-close. The debounced full-doc scan is advanced with fake timers.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  openSearchPanel,
  closeSearchPanel,
  searchPanelOpen,
} from "@codemirror/search";
import { findExtension } from "../../src/editor/find/find-extension";
import { setFindCaseSensitive } from "../../src/editor/find/find-session";

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
  vi.useFakeTimers();
});

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, pos = 0): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: pos, head: pos },
      extensions: [findExtension()],
    }),
    parent: host,
  });
  view.requestMeasure();
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

const bar = (m: Mounted) =>
  m.host.querySelector(".cm-find-bar") as HTMLElement | null;
const input = (m: Mounted) =>
  m.host.querySelector(".cm-find-bar-input") as HTMLInputElement;
const statusText = (m: Mounted) =>
  (m.host.querySelector(".cm-find-bar-status") as HTMLElement).textContent;

/** Type a query into the bar input and flush the debounced scan. */
function typeQuery(m: Mounted, q: string): void {
  const el = input(m);
  el.value = q;
  el.dispatchEvent(new Event("input"));
  vi.runAllTimers(); // flush the 120ms debounced full-doc scan
}

let m: Mounted | null = null;

afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
  setFindCaseSensitive(false); // session singleton — reset between tests
});

describe("find extension: panel open + count projection", () => {
  it("opens the Myne find bar (not the stock panel) on openSearchPanel", () => {
    m = mount("alpha beta alpha");
    openSearchPanel(m.view);
    expect(bar(m)).not.toBeNull();
    expect(searchPanelOpen(m.view.state)).toBe(true);
  });

  it("empty query is idle: no count rendered", () => {
    m = mount("alpha beta alpha");
    openSearchPanel(m.view);
    typeQuery(m, "");
    expect(statusText(m)).toBe("");
  });

  it("a query with hits shows the ordered 'k/N' total", () => {
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    // 3 occurrences of "alpha"; cursor at 0 sits on the first → "1/3".
    expect(statusText(m)).toBe("1/3");
  });

  it("a query with no hits shows 'No matches'", () => {
    m = mount("alpha beta gamma");
    openSearchPanel(m.view);
    typeQuery(m, "zzz");
    expect(statusText(m)).toBe("No matches");
  });

  it("emptying a non-empty query resets straight to idle without a stale count", () => {
    m = mount("alpha alpha");
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    expect(statusText(m)).toBe("1/2");
    typeQuery(m, "");
    expect(statusText(m)).toBe("");
  });
});

describe("find extension: navigation + wrap", () => {
  const enter = (mm: Mounted, shift = false) =>
    input(mm).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: shift, bubbles: true }),
    );

  it("Enter steps through the matches and advances the ordinal", () => {
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    expect(statusText(m)).toBe("1/3");

    // From an empty selection, the first Enter lands ON the first match (ordinal
    // unchanged); subsequent Enters advance.
    enter(m);
    expect(statusText(m)).toBe("1/3");
    enter(m);
    expect(statusText(m)).toBe("2/3");
    enter(m);
    expect(statusText(m)).toBe("3/3");
  });

  it("Enter wraps forward from the last match to the first", () => {
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    enter(m); // → 1/3
    enter(m); // → 2/3
    enter(m); // → 3/3
    expect(statusText(m)).toBe("3/3");
    enter(m); // wrap → 1/3
    expect(statusText(m)).toBe("1/3");
  });

  it("Shift+Enter steps backward and wraps from the first match to the last", () => {
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    enter(m); // settle onto match 1 → 1/3
    expect(statusText(m)).toBe("1/3");
    enter(m, true); // previous from match 1 wraps to the last → 3/3
    expect(statusText(m)).toBe("3/3");
    enter(m, true); // step back → 2/3
    expect(statusText(m)).toBe("2/3");
  });
});

describe("find extension: case sensitivity", () => {
  it("case-insensitive (default) matches both cases", () => {
    m = mount("Alpha alpha ALPHA");
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    expect(statusText(m)).toBe("1/3");
  });

  it("the case toggle re-scans and narrows to exact-case matches", () => {
    m = mount("Alpha alpha ALPHA");
    openSearchPanel(m.view);
    // A mixed-case query the doc contains in NO case-exact form.
    typeQuery(m, "alPHa");
    expect(statusText(m)).toBe("1/3"); // case-insensitive: all three

    const caseBtn = m.host.querySelector(".cm-find-bar-case") as HTMLButtonElement;
    caseBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    vi.runAllTimers(); // the toggle re-applies the query → debounced rescan
    // Case-sensitive: "alPHa" appears literally nowhere.
    expect(statusText(m)).toBe("No matches");
    expect(caseBtn.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("find extension: Escape close", () => {
  it("Escape on the input closes the search panel", () => {
    m = mount("alpha");
    openSearchPanel(m.view);
    expect(searchPanelOpen(m.view.state)).toBe(true);
    input(m).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(searchPanelOpen(m.view.state)).toBe(false);
  });

  it("closeSearchPanel tears down the Myne bar DOM", () => {
    m = mount("alpha");
    openSearchPanel(m.view);
    expect(bar(m)).not.toBeNull();
    closeSearchPanel(m.view);
    m.view.requestMeasure();
    expect(bar(m)).toBeNull();
  });
});
