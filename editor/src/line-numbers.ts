// editor-line-numbers (MYND-314): the optional CodeMirror line-number gutter,
// toggled live via a CM6 Compartment reconfigure (SYNC-3 addendum) — NOT a
// CSS-var apply (that fits typography, not a structural gutter) and NOT a
// React-key remount (that would lose cursor/scroll/undo). This is the repo's
// first Compartment-reconfigure-on-pref pattern, modeled on the wikilink
// note-set compartment (`wikilink/note-set.ts`).
//
// `CMEditor` is mounted once, so a plain prop can't add/remove an extension
// after mount. The gutter lives inside a `Compartment` composed into
// `myneExtensions()` (seeded OFF → `[]`); the host dispatches
// `reconfigureLineNumbers(on)` whenever the `editor_line_numbers` pref changes.
// CM6's stock `lineNumbers()` numbers LOGICAL lines (a soft-wrapped line's
// continuation rows stay blank) — exactly the prose-first behavior we want, no
// custom gutter work.

import {
  Compartment,
  Prec,
  type Extension,
  type StateEffect,
} from "@codemirror/state";
import { lineNumbers } from "@codemirror/view";

const lineNumbersCompartment = new Compartment();

/** Compose into `myneExtensions()` — seeds the gutter OFF (the prose-first
 *  default); the host reconfigures it ON post-mount when the pref is set.
 *
 *  `Prec.high` puts the line-number gutter LEFT of the fold gutter (CM6 lays
 *  gutters out in `activeGutters` precedence order; `myneFolding()` composes
 *  earlier, so without this the fold chevron would sit left of the number). The
 *  Obsidian layout — number, then the fold arrow next to the text it folds — is
 *  the intended reading order. The high precedence rides across the compartment
 *  reconfigure, so it holds when the gutter is toggled on. */
export function lineNumbersExtension(): Extension {
  return Prec.high(lineNumbersCompartment.of([]));
}

/** The effect the host dispatches when the line-number pref changes. `on` →
 *  the stock `lineNumbers()` gutter (logical-line numbering); `off` → `[]`
 *  (no gutter). Re-mount-free: cursor / scroll / undo are preserved. */
export function reconfigureLineNumbers(on: boolean): StateEffect<unknown> {
  return lineNumbersCompartment.reconfigure(on ? lineNumbers() : []);
}
