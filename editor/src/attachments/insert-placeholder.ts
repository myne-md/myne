// Optimistic in-editor progress placeholder for attachment import (epic
// MYND-164, editor-side dogfooding polish, fix #4).
//
// The paste/drop pipeline inserts the form-C embed only AFTER `attachment_import`
// resolves — so during the import (read bytes → IPC → encrypt → store) there is
// no in-editor feedback at the cursor. This adds a transient, DECORATION-ONLY
// placeholder that shows a clean progress chip ("Importing…") at the insert
// position while the import is in flight, then is cleared when the real embed
// (or nothing, on failure) lands.
//
// CRITICAL: the placeholder is a widget decoration, NOT document text. Note
// bytes are never mutated by the placeholder, so the optimistic feedback can
// never be persisted to disk (autosave mirrors the doc string, which stays
// clean). It is positioned via a CM6 mapped position so concurrent edits move
// it correctly; cleared by a matching effect.

import {
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { makeProgressChip, type ProgressKind } from "./progress";

/** A live placeholder: a stable token id + the document position it sits at. */
interface Placeholder {
  readonly token: number;
  readonly pos: number;
  readonly kind: ProgressKind;
}

/** Add an optimistic progress placeholder at `pos` under `token`. */
const addPlaceholder = StateEffect.define<Placeholder>();
/** Remove the placeholder identified by `token` (import resolved/failed). */
const removePlaceholder = StateEffect.define<number>();

/** Atomic widget that renders the clean import progress chip. */
class InsertPlaceholderWidget extends WidgetType {
  constructor(private readonly kind: ProgressKind) {
    super();
  }
  eq(other: InsertPlaceholderWidget): boolean {
    return other.kind === this.kind;
  }
  toDOM(): HTMLElement {
    return makeProgressChip(this.kind);
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** The set of live placeholders, mapped across edits + driven by effects. */
const placeholderField = StateField.define<readonly Placeholder[]>({
  create() {
    return [];
  },
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      // Keep placeholders pinned to their (moving) document position.
      next = next.map((p) => ({ ...p, pos: tr.changes.mapPos(p.pos) }));
    }
    for (const effect of tr.effects) {
      if (effect.is(addPlaceholder)) {
        next = [...next, effect.value];
      } else if (effect.is(removePlaceholder)) {
        next = next.filter((p) => p.token !== effect.value);
      }
    }
    return next;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (placeholders) => {
      const ranges: Array<Range<Decoration>> = placeholders
        .slice()
        .sort((a, b) => a.pos - b.pos)
        .map((p) =>
          Decoration.widget({
            widget: new InsertPlaceholderWidget(p.kind),
            side: 1,
          }).range(p.pos),
        );
      return Decoration.set(ranges, true);
    }),
});

let nextToken = 1;

/**
 * Show an optimistic progress placeholder at `pos`. Returns a `token` to pass
 * to {@link clearInsertPlaceholder} once the import resolves. No-op-safe: if the
 * field isn't installed the dispatch is simply ignored by CM.
 */
export function showInsertPlaceholder(
  view: EditorView,
  pos: number,
  kind: ProgressKind = "importing",
): number {
  const token = nextToken++;
  const at = Math.min(pos, view.state.doc.length);
  view.dispatch({ effects: addPlaceholder.of({ token, pos: at, kind }) });
  return token;
}

/** Remove the placeholder created under `token` (import success or failure). */
export function clearInsertPlaceholder(view: EditorView, token: number): void {
  view.dispatch({ effects: removePlaceholder.of(token) });
}

/** The placeholder's CURRENT (change-mapped) document position for `token`, or
 *  null if it's gone. Callers insert the real embed here rather than at the
 *  stale absolute position captured when the import began — concurrent edits
 *  during the async import move the placeholder, but a raw offset does not. */
export function insertPlaceholderPos(view: EditorView, token: number): number | null {
  const found = view.state
    .field(placeholderField, false)
    ?.find((p) => p.token === token);
  return found?.pos ?? null;
}

/** The extension bundle: the placeholder field (decorations included). */
export function attachmentInsertPlaceholderExtension(): Extension {
  return placeholderField;
}
