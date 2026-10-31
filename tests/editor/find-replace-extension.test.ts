// @vitest-environment jsdom
//
// In-note find+replace EXTENSION wiring (MYND-302): the real `findExtension()`
// driving @codemirror/search's replaceNext / replaceAll over a live doc. Asserts:
//   - the toggle reveals the replace row inside the docked panel
//   - replace-one replaces the current match and advances to the next
//   - replace-all rewrites all occurrences in a SINGLE undoable transaction
//   - match-case governs replacement (inherited via SearchQuery.caseSensitive)
//   - literal replacement of regex-special characters (no regex interpretation)
//   - the replace string carried on setSearchQuery survives a query edit
//   - Escape closes the bar even when the replace row is expanded
//
// The debounced full-doc scan is advanced with fake timers (mirrors
// find-extension.test.ts).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { getSearchQuery, openSearchPanel, searchPanelOpen } from "@codemirror/search";
import { findExtension } from "../../src/editor/find/find-extension";
import { setFindCaseSensitive } from "../../src/editor/find/find-session";
import {
  DEFAULT_DISPLAY,
  formatCivilDate,
  setDateTimeDisplay,
  __resetDateTimeDisplayForTest,
} from "@myne/editor/host/lib/datetimeFormat";

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
      extensions: [history(), findExtension()],
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

const input = (m: Mounted) =>
  m.host.querySelector(".cm-find-bar-input") as HTMLInputElement;
const byTestId = (m: Mounted, id: string) =>
  m.host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const replaceInput = (m: Mounted) => byTestId(m, "find.replace-input") as HTMLInputElement;
const click = (el: HTMLElement | null) =>
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

/** Type a query into the find input and flush the debounced scan. */
function typeQuery(m: Mounted, q: string): void {
  const el = input(m);
  el.value = q;
  el.dispatchEvent(new Event("input"));
  vi.runAllTimers();
}

/** Expand the replace row, set the replacement, and flush. */
function setReplacement(m: Mounted, value: string): void {
  click(byTestId(m, "find.toggle-replace"));
  const el = replaceInput(m);
  el.value = value;
  el.dispatchEvent(new Event("input"));
  vi.runAllTimers();
}

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
  setFindCaseSensitive(false);
});

/** Is the date-fallback notice SHOWING?
 *
 *  Presence is no longer the signal: the row is attached for the panel's
 *  lifetime and toggled with `hidden`, because a `role="status"` region that
 *  enters the DOM already carrying its text is not reliably announced
 *  (myne-md/myne#609, found in review). These tests asserted `toBeNull()` and
 *  would have gone on passing against a row that was present and silent. */
function fallbackShown(m: Mounted): boolean {
  const row = byTestId(m, "find.date-fallback") as HTMLElement | null;
  return row !== null && !row.hidden;
}

/** What the notice says while it is showing, or `""` while it is not. */
function fallbackText(m: Mounted): string {
  return fallbackShown(m) ? (byTestId(m, "find.date-fallback")?.textContent ?? "") : "";
}

describe("find+replace extension: toggle reveals the replace row", () => {
  it("the toggle in the docked panel expands the replace input", () => {
    m = mount("alpha beta alpha");
    openSearchPanel(m.view);
    // Collapsed the row is mounted but INERT (myne#952: it stays in the DOM so
    // its height can animate, and `inert` is what keeps it out of the tab order
    // and the accessibility tree). Unreachable is the property under test, not
    // absent from the document.
    expect(byTestId(m, "find.replace-input")?.closest("[inert]")).not.toBeNull();
    click(byTestId(m, "find.toggle-replace"));
    expect(byTestId(m, "find.replace-input")).not.toBeNull();
    expect(byTestId(m, "find.replace-input")?.closest("[inert]")).toBeNull();
  });
});

describe("find+replace extension: replace-one", () => {
  it("replaces the current match, leaving the others untouched", () => {
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "OMEGA");

    // Settle the selection onto the first match (Enter from an empty selection).
    input(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    click(byTestId(m, "find.replace-one"));
    // The first "alpha" became "OMEGA"; the others are untouched.
    expect(m.view.state.doc.toString()).toBe("OMEGA beta alpha gamma alpha");
  });

  it("steps through occurrences: replace-one advances to the next match, then replaces it", () => {
    // CodeMirror's replaceNext leaves the selection ON the just-inserted
    // replacement (not a match), so the following click ADVANCES to the next
    // match without replacing; the click after that replaces it. This is the
    // canonical replace/find-next stepping (Obsidian/VS Code behave identically).
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "OMEGA");
    input(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    click(byTestId(m, "find.replace-one")); // replace match 1
    expect(m.view.state.doc.toString()).toBe("OMEGA beta alpha gamma alpha");
    click(byTestId(m, "find.replace-one")); // advance onto match 2 (no replace)
    expect(m.view.state.doc.toString()).toBe("OMEGA beta alpha gamma alpha");
    click(byTestId(m, "find.replace-one")); // replace match 2
    expect(m.view.state.doc.toString()).toBe("OMEGA beta OMEGA gamma alpha");
  });
});

describe("find+replace extension: replace-all", () => {
  it("rewrites every occurrence", () => {
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "OMEGA");
    click(byTestId(m, "find.replace-all"));
    expect(m.view.state.doc.toString()).toBe("OMEGA beta OMEGA gamma OMEGA");
  });

  it("applies as a SINGLE undoable transaction (one undo reverts the whole bulk replace)", () => {
    const original = "alpha beta alpha gamma alpha";
    m = mount(original, 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "OMEGA");
    click(byTestId(m, "find.replace-all"));
    expect(m.view.state.doc.toString()).toBe("OMEGA beta OMEGA gamma OMEGA");

    // One undo reverts all three replacements at once → back to the original.
    undo(m.view);
    expect(m.view.state.doc.toString()).toBe(original);
  });
});

describe("find+replace extension: match-case inheritance", () => {
  it("case-insensitive (default) replaces all case variants", () => {
    m = mount("Alpha alpha ALPHA", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "X");
    click(byTestId(m, "find.replace-all"));
    expect(m.view.state.doc.toString()).toBe("X X X");
  });

  it("case-sensitive replace only touches exact-case matches", () => {
    m = mount("Alpha alpha ALPHA", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    // Engage match-case via the toggle.
    click(m.host.querySelector(".cm-find-bar-case") as HTMLButtonElement);
    vi.runAllTimers();
    setReplacement(m, "X");
    click(byTestId(m, "find.replace-all"));
    // Only the exact lowercase "alpha" is replaced.
    expect(m.view.state.doc.toString()).toBe("Alpha X ALPHA");
  });
});

describe("find+replace extension: literal (no regex)", () => {
  it("treats a regex-special query as a literal string", () => {
    m = mount("a.b a.b axb", 0);
    openSearchPanel(m.view);
    typeQuery(m, "a.b");
    setReplacement(m, "Z");
    click(byTestId(m, "find.replace-all"));
    // Literal: "a.b" matches the two dotted forms only, never "axb" (which a
    // regex `.` would have hit).
    expect(m.view.state.doc.toString()).toBe("Z Z axb");
  });
});

describe("find+replace extension: replace string survives a query edit", () => {
  it("editing the query keeps the replacement carried on the query", () => {
    m = mount("alpha alpha beta", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "X");
    // Now change the query to target "beta" — the replacement must stick.
    typeQuery(m, "beta");
    click(byTestId(m, "find.replace-all"));
    expect(m.view.state.doc.toString()).toBe("alpha alpha X");
  });
});

describe("find+replace extension: Escape with the replace row open", () => {
  it("Escape closes the bar even when replace is expanded", () => {
    m = mount("alpha", 0);
    openSearchPanel(m.view);
    click(byTestId(m, "find.toggle-replace"));
    expect(byTestId(m, "find.replace-input")).not.toBeNull();
    input(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(searchPanelOpen(m.view.state)).toBe(false);
  });
});

describe("find+replace extension: the date fallback (myne-md/myne#609)", () => {
  const DOC = "- [ ] pay the rent [due:: 2026-08-01]\n";

  afterEach(() => {
    __resetDateTimeDisplayForTest();
  });

  function withDayFirst(): void {
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "dmy" });
  }

  it("finds the stored date when the reader types the displayed one", () => {
    withDayFirst();
    m = mount(DOC, 0);
    openSearchPanel(m.view);
    // The chip shows this; the document does not contain it anywhere.
    typeQuery(m, "01/08/2026");
    expect(fallbackText(m)).toContain("2026-08-01");
    expect(m.host.querySelector(".cm-find-bar-status")?.textContent).toBe("1/1");
  });

  it("turns Replace OFF while the fallback produced the matches", () => {
    // The reason this gate exists, stated as the test's own scenario: the
    // matched bytes are `2026-08-01`, so a replacement typed as `02/08/2026`
    // would be written over them literally, `parseTaskInstant` would refuse the
    // result, and the task would leave every dated view. Replace All does it to
    // every task in the note at once.
    withDayFirst();
    m = mount(DOC, 0);
    openSearchPanel(m.view);
    typeQuery(m, "01/08/2026");
    click(byTestId(m, "find.toggle-replace"));
    expect((byTestId(m, "find.replace-one") as HTMLButtonElement).disabled).toBe(true);
    expect((byTestId(m, "find.replace-all") as HTMLButtonElement).disabled).toBe(true);
    // And it says why, rather than looking broken.
    // The REASON, asserted where a user can actually reach it. This read
    // `.title` first, which a browser never shows on a disabled control, so the
    // assertion passed on an attribute nobody perceives.
    expect(fallbackText(m)).not.toBe("");
    expect((byTestId(m, "find.replace-all") as HTMLButtonElement).getAttribute("aria-describedby")).toBe(
      (byTestId(m, "find.date-fallback") as HTMLElement).id,
    );
  });

  it("refuses Enter in the replace field, not only the buttons", () => {
    // The defect this pins, which three reviewers found and one reproduced: the
    // gate was `disabled` on the two BUTTONS and nowhere else, while the replace
    // INPUT is never disabled and its Enter handler is documented as "the
    // primary one-handed flow". So the control read as closed and the path most
    // people use was open. Pressing Enter turned `[due:: 2026-08-01]` into
    // `[due:: 02/08/2026]`, which `parseTaskInstant` refuses, killing the field
    // and syncing the rewrite everywhere, while `find.replace-all` cheerfully
    // reported `disabled === true`.
    withDayFirst();
    m = mount(DOC, 0);
    openSearchPanel(m.view);
    typeQuery(m, "01/08/2026");
    setReplacement(m, "02/08/2026");
    // The fallback has to be live at the moment of the keypress: setting the
    // replacement re-dispatches the typed query through `applyQuery`, which
    // clears the fallback, and the debounced scan re-arms it.
    vi.runAllTimers();
    expect(fallbackShown(m)).toBe(true);

    replaceInput(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    replaceInput(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(m.view.state.doc.toString()).toBe(DOC);
  });

  it("leaves Replace ON for an ordinary search that happens to be under the same format", () => {
    withDayFirst();
    m = mount(DOC, 0);
    openSearchPanel(m.view);
    typeQuery(m, "rent");
    click(byTestId(m, "find.toggle-replace"));
    expect((byTestId(m, "find.replace-one") as HTMLButtonElement).disabled).toBe(false);
    expect(fallbackShown(m)).toBe(false);
  });

  it("matches the literal text FIRST, so a date written in prose still wins", () => {
    // The cost of running the fallback first would be silently losing this.
    withDayFirst();
    m = mount("I paid on 01/08/2026 and again later\n", 0);
    openSearchPanel(m.view);
    typeQuery(m, "01/08/2026");
    expect(fallbackShown(m)).toBe(false);
    expect(m.host.querySelector(".cm-find-bar-status")?.textContent).toBe("1/1");
  });

  it("clears the fallback when the query changes to something ordinary", () => {
    withDayFirst();
    m = mount(DOC, 0);
    openSearchPanel(m.view);
    typeQuery(m, "01/08/2026");
    expect(fallbackShown(m)).toBe(true);
    typeQuery(m, "rent");
    expect(fallbackShown(m)).toBe(false);
  });

  it("keeps BOTH passes literal, so replacement never goes through regexp substitution", () => {
    // The load-bearing assertion of this whole design. An alternation would need
    // `literal: false`, and the engine then routes REPLACE through
    // regular-expression substitution, where a replacement containing `$1`,
    // `$&` or `` $` `` expands instead of being inserted. That expansion is a
    // hazard this repository already records, and it is the reason the fallback
    // is a second literal search rather than one cleverer query.
    withDayFirst();
    m = mount(DOC, 0);
    openSearchPanel(m.view);

    typeQuery(m, "rent");
    const plain = getSearchQuery(m.view.state);
    expect(plain.literal).toBe(true);
    expect(plain.regexp).toBe(false);

    typeQuery(m, "01/08/2026");
    const fallen = getSearchQuery(m.view.state);
    expect(fallen.search).toBe("2026-08-01");
    expect(fallen.literal).toBe(true);
    expect(fallen.regexp).toBe(false);
  });

  it("does not fall back on a string the printer never emits", () => {
    // Titled "a format with no reverse reading" first, which stopped being true
    // in the same review round: `dmmmy` IS read back, through the printer. The
    // case still proves something worth pinning, just not what its name said,
    // and it would have gone on passing if `dmmmy` support were deleted whole.
    // What it pins is that a near miss is a miss: English `dmmmy` prints
    // `Aug 1, 2026`, so `1 Aug 2026` is a date nobody's chip is showing and the
    // second pass declines it rather than guessing.
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "dmmmy" });
    m = mount(DOC, 0);
    openSearchPanel(m.view);
    typeQuery(m, "1 Aug 2026");
    expect(fallbackShown(m)).toBe(false);
    expect(m.host.querySelector(".cm-find-bar-status")?.textContent).toBe("No matches");
  });

  it("DOES fall back on an Intl-printed date, which is the default preset", () => {
    // The positive half the case above cannot carry, and the one that matters
    // most: `system` is what a reader who never opened the setting is on, and
    // the first version of this feature excluded it silently. The query is built
    // from the printer rather than typed by hand, so it cannot drift from what
    // the chip actually shows.
    const display = { ...DEFAULT_DISPLAY, dateFormat: "system" as const };
    setDateTimeDisplay(display);
    m = mount(DOC, 0);
    openSearchPanel(m.view);
    typeQuery(m, formatCivilDate("2026-08-01", display));
    expect(fallbackShown(m)).toBe(true);
    expect(fallbackText(m)).toContain("2026-08-01");
  });
});
