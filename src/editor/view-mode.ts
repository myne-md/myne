// Editor view modes (reading-source-modes, MYND-299).
//
// Three per-tab surfaces over the SAME document buffer (§6 C1: switching modes
// never mutates bytes):
//   - "live"    — today's live-preview (cursor-aware hide/render decorations on,
//                 editable). The default.
//   - "reading" — fully-rendered, READ-ONLY: decorations stay on (a non-editable
//                 view never holds the text cursor, so cursor-aware reveal stays
//                 off and everything renders), and editing is disabled. Typing is
//                 a no-op (strict read-only, grill D4).
//   - "source"  — raw markdown: the live-preview hide/render decoration stack is
//                 emptied so all markup shows verbatim. Syntax highlighting
//                 (lang-markdown + code-highlight) is SEPARATE and stays on, so
//                 source mode is colored raw text, editable. (Obsidian parity.)
//
// Both axes live in CM6 Compartments so the host can switch mode live
// (remount-free, cursor/scroll/undo preserved), exactly like the line-number
// gutter (line-numbers.ts). The decoration stack (`myneDecorations()`) is the
// ONLY thing toggled for source mode; it does not include syntax highlighting.

import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { myneDecorations } from "./decorations";
import { readingModeFacet } from "./decorations/cursor-aware";

export type ViewMode = "live" | "reading" | "source";

/** Coerce a stored `editor_default_view_mode` pref (string | null | undefined)
 *  to a `ViewMode`, mapping any unknown/absent value to the `live` default. The
 *  single home for the "unknown → live" rule (shared by the editor + settings). */
export function asViewMode(v: string | null | undefined): ViewMode {
  return v === "reading" || v === "source" ? v : "live";
}

/** Compartment wrapping the live-preview hide/render decoration stack. Emptied
 *  in source mode, full otherwise. */
export const viewModeDecorationsCompartment = new Compartment();
/** Compartment wrapping editability. Non-editable in reading mode (or when the
 *  host forces `readOnly`, e.g. the side-by-side preview companion). */
export const viewModeEditableCompartment = new Compartment();

function decorationsFor(mode: ViewMode): Extension {
  return mode === "source" ? [] : [...myneDecorations()];
}

function editableFor(mode: ViewMode, readOnly: boolean): Extension {
  // Reading view is read-only; an explicit `readOnly` (companion mirror) also
  // forces it. Live + source are editable. Reading mode also provides the
  // reading-mode facet so cursor-aware reveal is hard-off (never lifts source).
  return [
    EditorView.editable.of(!(readOnly || mode === "reading")),
    readingModeFacet.of(mode === "reading"),
  ];
}

/** The two seeded compartments, in decoration-stack position. Call from
 *  `myneExtensions()` with the tab's initial mode + readOnly. */
export function viewModeExtension(mode: ViewMode, readOnly: boolean): Extension {
  return [
    viewModeDecorationsCompartment.of(decorationsFor(mode)),
    viewModeEditableCompartment.of(editableFor(mode, readOnly)),
  ];
}

/** Reconfigure effects for a live mode switch (remount-free). */
export function reconfigureViewMode(mode: ViewMode, readOnly: boolean) {
  return [
    viewModeDecorationsCompartment.reconfigure(decorationsFor(mode)),
    viewModeEditableCompartment.reconfigure(editableFor(mode, readOnly)),
  ];
}
