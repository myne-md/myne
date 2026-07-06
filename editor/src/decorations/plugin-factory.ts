// Shared CM6 ViewPlugin factory for decoration extensions.
//
// All decoration files in this directory follow the same scaffold: a pure
// `build(view) -> DecorationSet` builder + a ViewPlugin that calls it on
// the relevant update signals. Extract the scaffold so each decoration
// file only owns its own builder.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  StateField,
} from "@codemirror/state";
import {
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  editorFocusChanged,
  editorFocusField,
  editorFocusTracker,
} from "./cursor-aware";

/** True when background parsing advanced the tree between the two states —
 *  the tree is reference-stable, so inequality means a reparse landed. Without
 *  this, syntax-driven decorations go stale on notes longer than the viewport:
 *  the rebuild on `docChanged` can run before the incremental parser re-covers
 *  the edited region, so e.g. a toggled task checkbox renders as raw text until
 *  the next interaction. (CM6 "Decorating Syntax" recipe.) */
export const treeChanged = (update: ViewUpdate): boolean =>
  syntaxTree(update.startState) !== syntaxTree(update.state);

/** Default update trigger: doc / viewport / selection / focus / parse changes —
 *  used by every cursor-aware decoration (emphasis, link, inline-code,
 *  heading, blockquote, hr, frontmatter). */
const cursorAwareUpdate = (update: ViewUpdate): boolean =>
  update.docChanged ||
  update.viewportChanged ||
  update.selectionSet ||
  update.focusChanged ||
  treeChanged(update);

/** Update trigger for decorations that don't depend on cursor position —
 *  e.g. task-list (checkbox is always rendered). */
const docOnlyUpdate = (update: ViewUpdate): boolean =>
  update.docChanged || update.viewportChanged || treeChanged(update);

export function makeCursorAwareDecorationPlugin(
  build: (view: EditorView) => DecorationSet,
): Extension {
  return makeDecorationPlugin(build, cursorAwareUpdate);
}

export function makeDocOnlyDecorationPlugin(
  build: (view: EditorView) => DecorationSet,
): Extension {
  return makeDecorationPlugin(build, docOnlyUpdate);
}

/**
 * StateField analog of `makeCursorAwareDecorationPlugin`, for decorations that
 * CM6 forbids from a ViewPlugin — block-replace or any replace crossing a line
 * break (setext underline collapse, reference-definition-line collapse, the
 * table widget). Owns the recompute gate (doc / selection / focus / parse), the
 * `provide`, and — crucially — bundles the shared `editorFocusField` + tracker
 * BEFORE the decoration field so `linesRevealed`/focus reads are current. Pass a
 * pure `build(state) -> DecorationSet`. Returns the extension trio (the focus
 * field/tracker dedup by identity when several decorators include them).
 */
export function makeCursorAwareStateField(
  build: (state: EditorState) => DecorationSet,
): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return build(state);
    },
    update(decorations, tr) {
      const selectionChanged = !tr.startState.selection.eq(tr.state.selection);
      const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
      if (
        !tr.docChanged &&
        !selectionChanged &&
        !editorFocusChanged(tr) &&
        !treeChanged
      ) {
        return decorations;
      }
      return build(tr.state);
    },
    provide(f) {
      return EditorView.decorations.from(f);
    },
  });
  return [editorFocusField, editorFocusTracker, field];
}

function makeDecorationPlugin(
  build: (view: EditorView) => DecorationSet,
  shouldUpdate: (update: ViewUpdate) => boolean,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (shouldUpdate(update)) {
          this.decorations = build(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
