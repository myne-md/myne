// @vitest-environment jsdom
//
// Spell decorations: the field-reading helpers + the StateField's own
// transaction handling (MYND-264/265). Covers `spellErrorAt` (field-absent,
// hit, miss), `applySpellCorrection`'s surgical byte-stable edit,
// `ignoreWordThisSession` + `requestSpellRescan` plumbing, the live-config
// accessors, and the field's docChanged range-mapping + selection-rebuild
// (active-word suppression) branches — none of which the IPC scan path exercises
// directly. The squiggle field is populated by mocking the IPC and flushing the
// debounced scan.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const FLAGGED = new Map<string, string[]>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: { words: string[] }) =>
    cmd === "plugin:spell|spell_check"
      ? Promise.resolve(
          args.words.map((word) => ({
            word,
            misspelled: FLAGGED.has(word),
            suggestions: FLAGGED.get(word) ?? [],
          })),
        )
      : Promise.resolve(undefined),
}));

import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  spellDecorations,
  spellErrorAt,
  applySpellCorrection,
  ignoreWordThisSession,
  requestSpellRescan,
  setSpellConfig,
  getActiveSpellLangs,
  buildSpellDecorations,
  type SpellRange,
} from "../../src/editor/decorations/spell";

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
      extensions: [markdown({ base: markdownLanguage }), spellDecorations()],
    }),
    parent: host,
  });
  view.requestMeasure();
  return { view, host };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(200);
}

let m: Mounted | null = null;

beforeEach(() => {
  FLAGGED.clear();
  // Reset the module-level spell config to the en-US default.
  setSpellConfig(true, ["en-US"]);
});

afterEach(() => {
  if (m !== null) {
    m.view.destroy();
    m.host.remove();
  }
  m = null;
});

describe("spellErrorAt", () => {
  it("returns the misspelled range covering a position", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    m = mount("the wrongg word", 0);
    await settle();
    const idx = m.view.state.doc.toString().indexOf("wrongg");
    const r = spellErrorAt(m.view.state, idx + 2);
    expect(r).not.toBeNull();
    expect(r!.word).toBe("wrongg");
    expect(m.view.state.sliceDoc(r!.from, r!.to)).toBe("wrongg");
  });

  it("returns null for a position outside every squiggle", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    m = mount("the wrongg word", 0);
    await settle();
    // Position 0 ("the") is not flagged.
    expect(spellErrorAt(m.view.state, 0)).toBeNull();
  });

  it("returns null when the spell field is absent from the state", () => {
    // A bare state without `spellDecorations()` has no field → null, no throw.
    const bare = EditorState.create({ doc: "anything" });
    expect(spellErrorAt(bare, 2)).toBeNull();
  });
});

describe("applySpellCorrection", () => {
  it("replaces exactly the given range, byte-stable elsewhere", () => {
    m = mount("the wrongg word", 0);
    const from = "the wrongg word".indexOf("wrongg");
    applySpellCorrection(m.view, { from, to: from + "wrongg".length }, "wrong");
    expect(m.view.state.doc.toString()).toBe("the wrong word");
  });
});

describe("session ignore + rescan plumbing", () => {
  it("ignoreWordThisSession clears the squiggle on the next scan", async () => {
    // A word unique to this test — `sessionIgnored` is a module-level set that
    // persists across tests, so an ignored word must never be reused elsewhere.
    FLAGGED.set("ignoreme", ["ignore"]);
    m = mount("the ignoreme word", 0);
    await settle();
    expect(spellErrorAt(m.view.state, "the ignoreme word".indexOf("ignoreme") + 1)).not.toBeNull();

    // Fold the word into the session-ignore set + force a rescan.
    ignoreWordThisSession(m.view, "ignoreme");
    await settle();
    // Still flagged by the engine, but session-ignored → no squiggle.
    expect(spellErrorAt(m.view.state, "the ignoreme word".indexOf("ignoreme") + 1)).toBeNull();
  });

  it("requestSpellRescan re-runs the scan (re-applies engine verdicts)", async () => {
    m = mount("the rescanword here", 0);
    await settle();
    expect(spellErrorAt(m.view.state, 5)).toBeNull(); // not flagged yet

    FLAGGED.set("rescanword", ["rescan"]);
    requestSpellRescan(m.view);
    await settle();
    expect(spellErrorAt(m.view.state, "the rescanword here".indexOf("rescanword") + 1)).not.toBeNull();
  });
});

describe("live spell config", () => {
  it("setSpellConfig drives getActiveSpellLangs and falls back to en-US for an empty list", () => {
    setSpellConfig(true, ["de", "fr"]);
    expect(getActiveSpellLangs()).toEqual(["de", "fr"]);
    setSpellConfig(true, []);
    expect(getActiveSpellLangs()).toEqual(["en-US"]);
  });

  it("disabling spell-check clears all marks on the next scan", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    m = mount("the wrongg word", 0);
    await settle();
    expect(spellErrorAt(m.view.state, "the wrongg word".indexOf("wrongg") + 1)).not.toBeNull();

    setSpellConfig(false, ["en-US"]); // fires the config event → rescan
    await settle();
    expect(spellErrorAt(m.view.state, "the wrongg word".indexOf("wrongg") + 1)).toBeNull();
  });
});

describe("spell field transaction handling", () => {
  it("maps squiggle ranges through a doc edit so the mark stays on the word", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    m = mount("the wrongg word", 0);
    await settle();
    const before = m.view.state.doc.toString().indexOf("wrongg");
    expect(spellErrorAt(m.view.state, before + 1)).not.toBeNull();

    // Insert text BEFORE the flagged word; the mapped range must follow it.
    m.view.dispatch({ changes: { from: 0, insert: "XYZ " } });
    const after = m.view.state.doc.toString().indexOf("wrongg");
    expect(after).toBe(before + 4);
    const r = spellErrorAt(m.view.state, after + 1);
    expect(r).not.toBeNull();
    expect(m.view.state.sliceDoc(r!.from, r!.to)).toBe("wrongg");
  });

  it("a pure cursor move into a flagged word suppresses its mark (SYNC-9)", async () => {
    FLAGGED.set("wrongg", ["wrong"]);
    m = mount("the wrongg word", 0);
    await settle();
    const idx = m.view.state.doc.toString().indexOf("wrongg");

    // With the caret outside the word, the squiggle decoration is present.
    const decoOutside = m.host.querySelectorAll('[data-testid="editor.spell-error"]');
    expect(decoOutside.length).toBe(1);

    // Move the caret INTO the word — a pure selection change rebuilds the field
    // and suppresses the active word's mark.
    m.view.dispatch({ selection: { anchor: idx + 2, head: idx + 2 } });
    m.view.requestMeasure();
    const decoInside = m.host.querySelectorAll('[data-testid="editor.spell-error"]');
    expect(decoInside.length).toBe(0);
  });
});

describe("buildSpellDecorations (multi-selection suppression)", () => {
  it("suppresses a word when ANY selection range sits inside it", () => {
    const doc = "alpha bravo charlie delta";
    const host = document.createElement("div");
    document.body.appendChild(host);
    // Two cursors: one inside "bravo", one inside "delta".
    const bravo = doc.indexOf("bravo") + 1;
    const delta = doc.indexOf("delta") + 1;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.create([
          EditorSelection.cursor(bravo),
          EditorSelection.cursor(delta),
        ]),
        extensions: [EditorState.allowMultipleSelections.of(true)],
      }),
      parent: host,
    });
    const range = (w: string): SpellRange => {
      const from = doc.indexOf(w);
      return { word: w, from, to: from + w.length };
    };
    const deco = buildSpellDecorations(view.state, [
      range("alpha"),
      range("bravo"),
      range("charlie"),
      range("delta"),
    ]);
    // bravo + delta suppressed (a cursor inside each) → alpha + charlie remain.
    expect(deco.size).toBe(2);
    view.destroy();
    host.remove();
  });
});
