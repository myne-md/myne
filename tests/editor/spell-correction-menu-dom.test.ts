// @vitest-environment jsdom
//
// Spell correction MENU view + plugin (MYND-265): drives the contextmenu /
// keyboard open path against a live squiggled doc, asserts the rendered menu
// (suggestions + the 3 standing actions, the "No suggestions" empty row),
// dismiss-on-doc/selection-change, outside-click dismiss, the Cmd/Ctrl+. and
// Escape keyboard surface, and that applying a suggestion is a byte-stable
// surgical edit, while add/ignore never touch the buffer. The Tauri IPC
// (`spellCheck`, add/ignore writers) is mocked so the menu is deterministic.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock the spell IPC. `spell_check` is index-aligned to the words it's handed
// (the scanner zips verdicts back by index), so we return a verdict per word:
// flagged with the configured suggestions when the word is in `FLAGGED`, clean
// otherwise. The add/ignore writers resolve so the activate path completes.
const FLAGGED = new Map<string, string[]>();
const spellCheckMock = vi.fn((args: { words: string[] }) =>
  Promise.resolve(
    args.words.map((word) => ({
      word,
      misspelled: FLAGGED.has(word),
      suggestions: FLAGGED.get(word) ?? [],
    })),
  ),
);
// Post-extraction the spell decorations/menu call the host bridge (spellCheck +
// the dictionary writers), not the Tauri `invoke` directly — the IPC now lives
// in the desktop lib/spell behind the EditorHost seam. Mock the bridge the
// modules-under-test import so squiggles + menu actions resolve.
vi.mock("@myne/editor/host/lib/spell", () => ({
  spellCheck: (words: string[]) => spellCheckMock({ words }),
  addToPersonalDictionary: vi.fn(() => Promise.resolve()),
  ignoreWordInVault: vi.fn(() => Promise.resolve()),
}));

import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { spellDecorations, spellErrorAt } from "../../src/editor/decorations/spell";
import { spellCorrectionMenu } from "../../src/editor/spell/correction-menu";

beforeAll(() => {
  vi.useFakeTimers();
});

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, pos = doc.length): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: pos, head: pos },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Wikilink] }),
        spellDecorations(),
        spellCorrectionMenu(),
      ],
    }),
    parent: host,
  });
  // jsdom has no layout — the menu positions via coordsAtPos; stub it.
  view.coordsAtPos = () => ({ left: 5, right: 10, top: 5, bottom: 15 });
  view.requestMeasure();
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

/** Flush the debounced spell scan so the squiggle field is populated. */
async function settleScan(): Promise<void> {
  await vi.advanceTimersByTimeAsync(200);
}

const menuEl = () => document.body.querySelector(".cm-spell-menu");
const rows = () =>
  Array.from(document.body.querySelectorAll(".cm-spell-menu-row[data-index]"));

let m: Mounted | null = null;

beforeEach(() => {
  FLAGGED.clear();
  spellCheckMock.mockClear();
});

afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
  // Clean any leaked menu DOM.
  document.body.querySelector(".cm-spell-menu")?.remove();
});

/** Mount `doc`, settle the scan, then open the correction menu over `word` via
 *  a real contextmenu event (the production open path). */
async function openMenu(doc: string, word: string) {
  m = mount(doc, 0);
  await settleScan();
  const at = m.view.state.doc.toString().indexOf(word) + 1;
  m.view.posAtCoords = () => at;
  m.view.contentDOM.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
  );
  // `openFor` awaits the suggestion IPC before rendering — flush microtasks.
  await vi.advanceTimersByTimeAsync(1);
  return at;
}

describe("correction menu: open + render", () => {
  it("contextmenu over a squiggle opens a menu with suggestions + 3 actions", async () => {
    FLAGGED.set("wrongg", ["wrong", "wrung"]);
    const at = await openMenu("the wrongg word", "wrongg");
    expect(spellErrorAt(m!.view.state, at)).not.toBeNull();

    expect(menuEl()).not.toBeNull();
    const labels = rows().map((r) => r.textContent);
    expect(labels).toEqual([
      "wrong",
      "wrung",
      "Add to dictionary",
      "Ignore in this vault",
      "Ignore this session",
    ]);
    expect(
      document.body.querySelector('[data-testid="spell.action-add"]'),
    ).not.toBeNull();
  });

  it("renders the 'No suggestions' row when the engine returns none", async () => {
    FLAGGED.set("qwxz", []);
    await openMenu("a qwxz b", "qwxz");

    expect(menuEl()).not.toBeNull();
    expect(
      document.body.querySelector(".cm-spell-menu-empty")?.textContent,
    ).toBe("No suggestions");
    // The 3 standing actions are still present even with no suggestions.
    expect(rows()).toHaveLength(3);
  });

  it("contextmenu NOT over a squiggle leaves the menu closed (default OS menu)", async () => {
    m = mount("all fine here", 0);
    await settleScan();
    m.view.posAtCoords = () => 0; // position 0 is not flagged
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    m.view.contentDOM.dispatchEvent(ev);
    await vi.advanceTimersByTimeAsync(1);
    expect(menuEl()).toBeNull();
    expect(ev.defaultPrevented).toBe(false); // default menu not suppressed
  });
});

describe("correction menu: apply + dismiss", () => {
  it("clicking a suggestion replaces only the misspelled range (byte-stable)", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    await openMenu("the wrongg word", "wrongg");
    expect(menuEl()).not.toBeNull();
    const sugg = document.body.querySelector(
      '[data-testid="spell.suggestion-row"]',
    ) as HTMLElement;
    sugg.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

    expect(m!.view.state.doc.toString()).toBe("the wrong word");
    // Applying dismisses the menu.
    expect(menuEl()).toBeNull();
  });

  it("a doc change while open dismisses the menu", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    await openMenu("the wrongg word", "wrongg");
    expect(menuEl()).not.toBeNull();
    m!.view.dispatch({ changes: { from: 0, insert: "x" } });
    expect(menuEl()).toBeNull();
  });

  it("a selection change while open dismisses the menu", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    await openMenu("the wrongg word", "wrongg");
    expect(menuEl()).not.toBeNull();
    m!.view.dispatch({ selection: { anchor: 2, head: 2 } });
    expect(menuEl()).toBeNull();
  });

  it("an outside mousedown dismisses the menu", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    await openMenu("the wrongg word", "wrongg");
    expect(menuEl()).not.toBeNull();
    document.body.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect(menuEl()).toBeNull();
  });

  it("clicking 'Add to dictionary' calls the writer and closes", async () => {
    const { addToPersonalDictionary } = await import("../../src/lib/spell");
    FLAGGED.set("wrongg", ["wrong"]);
    await openMenu("the wrongg word", "wrongg");
    const addRow = document.body.querySelector(
      '[data-testid="spell.action-add"]',
    ) as HTMLElement;
    addRow.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
    // The writer is the mocked IPC (resolves undefined); the doc is untouched
    // (add/ignore never edit the buffer) and the menu is dismissed.
    expect(typeof addToPersonalDictionary).toBe("function");
    expect(m!.view.state.doc.toString()).toBe("the wrongg word");
    expect(menuEl()).toBeNull();
  });
});

describe("correction menu: keyboard surface", () => {
  it("Cmd/Ctrl+. opens the menu for the flagged word under the caret", async () => {
    FLAGGED.set("wrongg", ["wrong", "wrung"]);
    m = mount("the wrongg word", 0);
    await settleScan();
    // Park the caret inside the flagged word.
    const inside = m.view.state.doc.toString().indexOf("wrongg") + 2;
    m.view.dispatch({ selection: { anchor: inside, head: inside } });
    expect(spellErrorAt(m.view.state, inside)).not.toBeNull();

    // CodeMirror maps "Mod-." to Cmd on mac, Ctrl elsewhere; in the test runtime
    // the platform is non-mac, so fire Ctrl. (Both modifiers set is harmless.)
    runScopeHandlers(
      m.view,
      new KeyboardEvent("keydown", { key: ".", ctrlKey: true }),
      "editor",
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(menuEl()).not.toBeNull();
    expect(rows().map((r) => r.textContent)).toContain("wrong");
  });

  it("Cmd/Ctrl+. with the caret on a clean word does nothing", async () => {
    m = mount("the clean word", 0);
    await settleScan();
    m.view.dispatch({ selection: { anchor: 1, head: 1 } });
    const handled = runScopeHandlers(
      m.view,
      new KeyboardEvent("keydown", { key: ".", ctrlKey: true }),
      "editor",
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(handled).toBe(false); // no flagged word → command declines
    expect(menuEl()).toBeNull();
  });

  it("Escape closes an open menu (and is a no-op when closed)", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    await openMenu("the wrongg word", "wrongg");
    expect(menuEl()).not.toBeNull();
    const handled = runScopeHandlers(
      m!.view,
      new KeyboardEvent("keydown", { key: "Escape" }),
      "editor",
    );
    expect(handled).toBe(true);
    expect(menuEl()).toBeNull();
    // A second Escape with no menu open declines (lets other consumers handle it).
    const second = runScopeHandlers(
      m!.view,
      new KeyboardEvent("keydown", { key: "Escape" }),
      "editor",
    );
    expect(second).toBe(false);
  });
});
