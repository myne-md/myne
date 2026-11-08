// Spell-check squiggle decorations (spell-checker epic, MYND-264 t3-t5).
//
// A CM6 ViewPlugin that, debounced, extracts the viewport's spell-checkable
// words (the shared skip-helper, SYNC-3), batches them to the Rust engine over
// IPC (SYNC-1/8), and renders a wavy red `.cm-spell-error` Decoration.mark on
// each misspelled word — never mutating the buffer (decorations are overlays).
// The mark on the word the cursor is inside is suppressed (SYNC-9). Results land
// via a StateEffect → StateField (the math.ts loader pattern); a ~120ms debounce
// matches the find bar (SYNC-8). The whole layer is gated on `spell_enabled`
// (SYNC-9) — composed only when on.
//
// Pure cores (`extractSpellableWords`, `buildSpellDecorations`) are unit-tested;
// the ViewPlugin glues them to the debounced IPC.

import {
  type EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { isSpellable } from "./spell-skip";
import { spellCheck } from "@myne/editor/host/lib/spell";
import { prefsRead } from "@myne/editor/host/lib/prefs";
import { foldSegment } from "@myne/dialect/folderPath";

/** Debounce for the spell scan — matches the find bar's `SCAN_DEBOUNCE_MS`. */
export const SPELL_DEBOUNCE_MS = 120;

/** A spell-checkable word located in the document. */
export type SpellRange = { word: string; from: number; to: number };

/** Runs of letters/numbers — the JS mirror of the Rust `split_nfc` boundary
 * (`!is_alphanumeric` split). Includes apostrophes inside words (don't, isn't)
 * so contractions check as one token, matching typical Hunspell dictionaries. */
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

/**
 * Extract the spell-checkable words in `[from, to)`: every alphanumeric run
 * whose start position `isSpellable` (not code / frontmatter / wikilink-target /
 * URL / `#tag`). Returns document-coordinate ranges + the raw word text (the
 * engine normalizes internally; raw offsets keep the marks valid).
 */
export function extractSpellableWords(
  state: EditorState,
  from: number,
  to: number,
): SpellRange[] {
  const text = state.sliceDoc(from, to);
  const out: SpellRange[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const start = from + (m.index ?? 0);
    const end = start + m[0].length;
    // Skip pure-number tokens (no letters) — never "misspelled".
    if (!/\p{L}/u.test(m[0])) continue;
    if (isSpellable(state, start)) {
      out.push({ word: m[0], from: start, to: end });
    }
  }
  return out;
}

/**
 * Build the squiggle decoration set from the misspelled ranges, suppressing the
 * mark on the word the cursor is currently inside (SYNC-9). Ranges must be
 * sorted by `from` (the caller passes them in document order).
 */
export function buildSpellDecorations(
  state: EditorState,
  misspelled: SpellRange[],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const mark = Decoration.mark({
    class: "cm-spell-error",
    attributes: { "data-testid": "editor.spell-error" },
  });
  for (const r of misspelled) {
    if (cursorInside(state, r.from, r.to)) continue; // suppress active word
    builder.add(r.from, r.to, mark);
  }
  return builder.finish();
}

/** True if any selection range's head/anchor sits within `[from, to]`. */
function cursorInside(state: EditorState, from: number, to: number): boolean {
  for (const sel of state.selection.ranges) {
    if (sel.head >= from && sel.head <= to) return true;
    if (sel.anchor >= from && sel.anchor <= to) return true;
  }
  return false;
}

/** Fresh ranges from the async IPC result. */
export const setSpellErrors = StateEffect.define<SpellRange[]>();

/** Forces an immediate re-scan (after add-to-dictionary / ignore, which change
 * the engine's verdicts without changing the doc). The scanner listens for it. */
const triggerSpellRescan = StateEffect.define<null>();

/** Client-side "ignore this session" set (SYNC-13): folded words suppressed for
 * this editor session only — never persisted (the vault-wide set is the persisted
 * path, via `ignoreWordInVault`), folded with the shared `foldSegment` — the same
 * case-fold the engine's
 * `default_lower` mirrors; good enough for the RAM-only session set. */
const sessionIgnored = new Set<string>();

/** Add a word to the session-ignore set (SYNC-13) and request a re-scan so its
 * squiggle clears immediately. */
export function ignoreWordThisSession(view: EditorView, word: string): void {
  sessionIgnored.add(foldSegment(word));
  requestSpellRescan(view);
}

/** Clear the session-ignore set. Called on a vault SWITCH so "ignore this
 *  session" words from one vault don't suppress squiggles in another — the set
 *  is module-level and would otherwise outlive the vault that populated it. */
export function resetSessionIgnored(): void {
  sessionIgnored.clear();
}

/** Dispatch a re-scan request (used after add-to-dictionary / ignore). */
export function requestSpellRescan(view: EditorView): void {
  view.dispatch({ effects: triggerSpellRescan.of(null) });
}

/** Live spell config (the `spell_enabled` gate + active language set, SYNC-9/11).
 * Set from the persisted prefs on editor mount and on a settings change. A
 * module-level value (the editor + settings modal are separate React trees; the
 * window event below bridges a live change to the running editor). */
let spellConfig: { enabled: boolean; langs: string[] } = {
  enabled: true, // default-on (SYNC-15) until prefs load
  langs: ["en-US"],
};

/** Window event the settings UI fires when the spell config changes so a live
 * editor re-scans (the two React trees share no state otherwise). */
export const SPELL_CONFIG_EVENT = "myne:spell-config-changed";

/** Update the live spell config (called by the editor on mount + by the settings
 * UI on toggle/language change) and notify any open editor to re-scan. */
export function setSpellConfig(enabled: boolean, langs: string[]): void {
  spellConfig = { enabled, langs: langs.length > 0 ? langs : ["en-US"] };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SPELL_CONFIG_EVENT));
  }
}

/** Apply a correction as a surgical, byte-stable range edit (SYNC-14): replace
 * exactly `[from, to)` with `replacement`, tagged `spell.correct` so the scanner
 * re-checks the edited region. */
export function applySpellCorrection(
  view: EditorView,
  range: { from: number; to: number },
  replacement: string,
): void {
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: replacement },
    userEvent: "spell.correct",
  });
}

/** The misspelled range covering `pos`, or `null` — the contextmenu/keyboard
 * hit-test for the correction menu (MYND-265). Reads the live spell field. */
export function spellErrorAt(state: EditorState, pos: number): SpellRange | null {
  const value = state.field(spellField, false);
  if (!value) return null;
  for (const r of value.ranges) {
    if (pos >= r.from && pos <= r.to) return r;
  }
  return null;
}

/** Field value: the last misspelled ranges + the built marks. Keeping the
 * ranges lets a pure selection change rebuild the active-word suppression
 * (SYNC-9) without re-running the IPC. */
type SpellFieldValue = { ranges: SpellRange[]; deco: DecorationSet };

export const spellField = StateField.define<SpellFieldValue>({
  create: () => ({ ranges: [], deco: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSpellErrors)) {
        // Clamp (2026-11-03): a range past the end throws out of the NEXT mapPos.
        const limit = tr.state.doc.length;
        const clamped = e.value
          .map((r) => ({
            word: r.word,
            from: Math.min(r.from, limit),
            to: Math.min(r.to, limit),
          }))
          .filter((r) => r.to > r.from);
        return { ranges: clamped, deco: buildSpellDecorations(tr.state, clamped) };
      }
    }
    if (tr.docChanged) {
      // Map through the edit + rebuild; the re-scan refreshes shortly.
      const startLimit = tr.startState.doc.length;
      const mapped = value.ranges
        .map((r) => ({
          word: r.word,
          from: tr.changes.mapPos(Math.min(r.from, startLimit)),
          to: tr.changes.mapPos(Math.min(r.to, startLimit)),
        }))
        .filter((r) => r.to > r.from);
      return { ranges: mapped, deco: buildSpellDecorations(tr.state, mapped) };
    }
    if (tr.selection) {
      // Pure cursor move: rebuild to (un)suppress the active word (SYNC-9).
      return { ranges: value.ranges, deco: buildSpellDecorations(tr.state, value.ranges) };
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** The active languages for the current scan (the settings-driven set, SYNC-11).
 * Exported so other editor modules (the correction menu) fetch suggestions
 * against the SAME set the scanner flagged the word with — one source of truth,
 * never a second hard-coded list. */
export function getActiveSpellLangs(): string[] {
  return spellConfig.langs;
}

/** Internal alias kept for the scan call site below. */
const activeLangs = getActiveSpellLangs;

/** The debounced scanner ViewPlugin: on doc/viewport change, extract viewport
 * words, IPC-check them, and dispatch the misspelled ranges. */
const spellScanPlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private gen = 0;

    private readonly onConfig = () => this.schedule(this.view);

    constructor(readonly view: EditorView) {
      // Respect the persisted spell prefs at mount (default-on until loaded);
      // setSpellConfig fires the window event → onConfig → a scan.
      void prefsRead()
        .then((p) => setSpellConfig(p.spell_enabled ?? true, p.spell_languages))
        .catch(() => {
          /* locked / no vault — keep the default-on en-US config */
        });
      if (typeof window !== "undefined") {
        window.addEventListener(SPELL_CONFIG_EVENT, this.onConfig);
      }
      this.schedule(view);
    }

    update(u: ViewUpdate) {
      const rescanRequested = u.transactions.some((t) =>
        t.effects.some((e) => e.is(triggerSpellRescan)),
      );
      if (u.docChanged || u.viewportChanged || rescanRequested) this.schedule(u.view);
    }

    destroy() {
      if (this.timer !== null) clearTimeout(this.timer);
      if (typeof window !== "undefined") {
        window.removeEventListener(SPELL_CONFIG_EVENT, this.onConfig);
      }
    }

    private schedule(view: EditorView) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.scan(view), SPELL_DEBOUNCE_MS);
    }

    private async scan(view: EditorView) {
      const myGen = ++this.gen;
      // The spell_enabled gate (SYNC-9): when off, clear any marks and stop.
      if (!spellConfig.enabled) {
        view.dispatch({ effects: setSpellErrors.of([]) });
        return;
      }
      const { from, to } = view.viewport;
      const words = extractSpellableWords(view.state, from, to);
      if (words.length === 0) {
        view.dispatch({ effects: setSpellErrors.of([]) });
        return;
      }
      let verdicts;
      try {
        verdicts = await spellCheck(
          words.map((w) => w.word),
          activeLangs(),
        );
      } catch {
        return; // engine unavailable / locked — leave prior marks
      }
      if (myGen !== this.gen) return; // a newer scan superseded this one
      const misspelled: SpellRange[] = [];
      verdicts.forEach((v, i) => {
        const w = words[i];
        // Drop session-ignored words (SYNC-13, client RAM-only).
        if (v.misspelled && w && !sessionIgnored.has(foldSegment(w.word))) {
          misspelled.push(w);
        }
      });
      view.dispatch({ effects: setSpellErrors.of(misspelled) });
    }
  },
);

/** The composed spell-check decoration extension (field + scanner). Compose
 * only when `spell_enabled` is on (MYND-267 gate). */
export function spellDecorations(): readonly Extension[] {
  return [spellField, spellScanPlugin];
}
