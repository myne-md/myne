// Footnote rendering for the Phase 1 editor.
//
// PRD `editor-mvp-footnotes` (MYND-153). Renders the two footnote constructs the
// dialect parser (`src/dialect/lezer/footnote.ts`) emits:
//
//   - Inline `[^N]` REFERENCE → a small superscript marker. Off-cursor the `[^`
//     and `]` brackets hide and the identifier renders raised (`.cm-footnote-ref`);
//     cursor inside the reference lifts the decoration to reveal raw `[^N]` for
//     editing (cursor-aware, the `link.ts` / `autolink.ts` pattern). The marker
//     is clickable: it jumps the cursor/scroll to the matching definition. An
//     orphan reference (no matching definition) renders a muted error-tinted
//     variant (`.cm-footnote-ref-orphan`) and clicking is a safe no-op.
//
//   - In-source `[^N]:` DEFINITION line → left in place (never moved or deleted,
//     §6 C1), off-cursor de-emphasized (`.cm-footnote-def`), on-cursor revealed
//     at full prominence.
//
//   - A read-only "Footnotes" block widget appended at document END collects
//     every definition into an ordered list (`.cm-footnote-list`). This list is a
//     derived VIEW, not a serialization — the source `[^N]:` lines stay
//     byte-stable in place; no transaction here mutates document text. Block
//     widgets must come from a StateField in CM6 (the `table.ts` precedent), and
//     must rebuild on the async-parse `treeChanged` signal or the widget never
//     appears until a later transaction.
//
// Layers + their CM6 constraints:
//   1. `footnoteModelField` — one whole-doc collection (footnote-collector.ts),
//      shared by every consumer, rebuilt only on doc/parse change.
//   2. Inline marks (reference superscript + bracket hide + definition
//      de-emphasis) — all WITHIN one line → cursor-aware `ViewPlugin`.
//   3. Click-to-jump / back-affordance — `EditorView.domEventHandlers`.
//   4. EOD list — a point block widget at `doc.length` → `StateField`.
//
// Penpot reference: `flow--editor-footnotes (MYND-153)` (states A / B / C / D).

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type Range,
  RangeSetBuilder,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { isCursorLine, isInsideRange } from "./cursor-aware";
import {
  collectFootnotes,
  type FootnoteModel,
} from "./footnote-collector";
import { makeCursorAwareDecorationPlugin } from "./plugin-factory";
import i18n from "@myne/editor/i18n";

// --- 0. Shared model field ------------------------------------------------
//
// One whole-document footnote collection, shared by the inline marks
// (ViewPlugin), the click handler, and the EOD widget (StateField), so the
// collector runs ONCE per doc/parse change instead of once per consumer — and
// is NOT rebuilt on selection/focus-only changes (the model can't have changed).
const footnoteModelField = StateField.define<FootnoteModel>({
  create(state) {
    return collectFootnotes(state);
  },
  update(value, tr) {
    if (!tr.docChanged && syntaxTree(tr.startState) === syntaxTree(tr.state)) {
      return value;
    }
    return collectFootnotes(tr.state);
  },
});

// --- helpers --------------------------------------------------------------

interface ReferenceShape {
  /** Whole `[^id]` range. */
  readonly from: number;
  readonly to: number;
  /** The two bracket marks (`[^` and `]`), hidden off-cursor. */
  readonly marks: ReadonlyArray<readonly [number, number]>;
  /** The identifier label range — the visible superscript glyph. */
  readonly labelFrom: number;
  readonly labelTo: number;
  readonly identifier: string;
}

function readReference(state: EditorState, node: SyntaxNode): ReferenceShape | null {
  const marks: Array<[number, number]> = [];
  let labelFrom: number | null = null;
  let labelTo: number | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "FootnoteMark") marks.push([child.from, child.to]);
    else if (child.name === "FootnoteLabel") {
      labelFrom = child.from;
      labelTo = child.to;
    }
  }
  if (labelFrom === null || labelTo === null) return null;
  return {
    from: node.from,
    to: node.to,
    marks,
    labelFrom,
    labelTo,
    identifier: state.doc.sliceString(labelFrom, labelTo),
  };
}

interface DefinitionMarks {
  /** `[^` bracket range, hidden off-cursor. */
  readonly openMark: readonly [number, number];
  /** identifier range — kept visible as a superscript marker. */
  readonly labelFrom: number;
  readonly labelTo: number;
  /** `]:` range, hidden off-cursor. */
  readonly closeMark: readonly [number, number];
}

/** The marker structure (`[^` + id + `]:`) of a `FootnoteDefinition`, so the
 *  brackets/colon can be hidden while the identifier renders as a superscript.
 *  `null` if the marker children are absent. */
function readDefinitionMarks(node: SyntaxNode): DefinitionMarks | null {
  const marks: Array<[number, number]> = [];
  let labelFrom: number | null = null;
  let labelTo: number | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "FootnoteMark") marks.push([child.from, child.to]);
    else if (child.name === "FootnoteLabel") {
      labelFrom = child.from;
      labelTo = child.to;
    }
    if (marks.length === 2 && labelFrom !== null) break;
  }
  if (marks.length < 2 || labelFrom === null || labelTo === null) return null;
  return { openMark: marks[0]!, labelFrom, labelTo, closeMark: marks[1]! };
}

// --- 1. Inline marks (ViewPlugin): reference superscript + definition de-emphasis

function buildFootnoteInlineDecorations(view: EditorView): DecorationSet {
  const model = view.state.field(footnoteModelField);
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "FootnoteReference") {
          const shape = readReference(view.state, node.node);
          if (shape === null) return false;
          // Cursor inside the reference → reveal raw `[^N]` (emit nothing).
          if (isInsideRange(view, shape.from, shape.to)) return false;
          const orphan = !model.resolution.has(shape.identifier);
          decorations.push(
            Decoration.mark({
              class: orphan
                ? "cm-footnote-ref cm-footnote-ref-orphan"
                : "cm-footnote-ref",
              attributes: { "data-cm-footnote-ref": shape.identifier },
            }).range(shape.labelFrom, shape.labelTo),
          );
          for (const [f, t] of shape.marks) {
            decorations.push(Decoration.replace({}).range(f, t));
          }
          return false; // children handled
        }

        if (node.name === "FootnoteDefinition") {
          // Off-cursor: render like markdown — hide the `[^` and `]:` brackets
          // but KEEP the identifier as a small superscript marker (so you can
          // tell which definition is which), then de-emphasize the body. On-cursor
          // (cursor on any line of the definition): reveal raw source for editing.
          // The marker sits on the first line, so the bracket hides are within-line
          // replaces (ViewPlugin-safe); the body mark may span continuation lines.
          if (!isCursorLine(view, node.from, node.to)) {
            const marks = readDefinitionMarks(node.node);
            if (marks !== null) {
              decorations.push(
                Decoration.replace({}).range(marks.openMark[0], marks.openMark[1]),
              );
              decorations.push(
                Decoration.mark({ class: "cm-footnote-def-marker" }).range(
                  marks.labelFrom,
                  marks.labelTo,
                ),
              );
              decorations.push(
                Decoration.replace({}).range(marks.closeMark[0], marks.closeMark[1]),
              );
              if (node.to > marks.closeMark[1]) {
                decorations.push(
                  Decoration.mark({ class: "cm-footnote-def" }).range(
                    marks.closeMark[1],
                    node.to,
                  ),
                );
              }
            } else if (node.to > node.from) {
              // Defensive: no locatable marker — just de-emphasize the whole node.
              decorations.push(
                Decoration.mark({ class: "cm-footnote-def" }).range(node.from, node.to),
              );
            }
          }
          return false;
        }

        return undefined;
      },
    });
  }

  decorations.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.to !== b.to) return a.to - b.to;
    return (a.value.spec.side ?? 0) - (b.value.spec.side ?? 0);
  });
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

// --- 2. Click-to-jump + back-affordance + orphan no-op --------------------

/** Move the cursor to `offset` and scroll it into view, then focus the editor. */
function jumpTo(view: EditorView, offset: number): void {
  view.dispatch({
    selection: { anchor: offset },
    effects: EditorView.scrollIntoView(offset, { y: "center" }),
    userEvent: "select",
  });
  view.focus();
}

const footnoteClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    const target = event.target as Element | null;

    // EOD back-affordance (↩): jump to the first reference of this id.
    const backEl = target?.closest?.("[data-cm-footnote-backref]") ?? null;
    if (backEl !== null) {
      const id = backEl.getAttribute("data-cm-footnote-backref");
      const model = view.state.field(footnoteModelField);
      const offset = id !== null ? model.referenceFirst.get(id) : undefined;
      event.preventDefault();
      if (offset !== undefined) jumpTo(view, offset);
      return true; // handled (no-op if the reference vanished)
    }

    // Reference marker → jump to its definition; orphan ref → safe no-op.
    const refEl = target?.closest?.("[data-cm-footnote-ref]") ?? null;
    if (refEl !== null) {
      const id = refEl.getAttribute("data-cm-footnote-ref");
      const model = view.state.field(footnoteModelField);
      const offset = id !== null ? model.resolution.get(id) : undefined;
      event.preventDefault(); // swallow the click either way (no cursor jump)
      if (offset !== undefined) jumpTo(view, offset);
      // Orphan reference (offset === undefined): no-op — never throws.
      return true;
    }

    return false;
  },
});

// --- 3. EOD "Footnotes" block widget (StateField) -------------------------

class FootnoteListWidget extends WidgetType {
  constructor(private readonly model: FootnoteModel) {
    super();
  }

  // Equal when the entry list matches field-for-field, so the widget DOM is
  // rebuilt only when a definition's id / text / unreferenced flag actually
  // changes, not on every doc/parse tick.
  eq(other: FootnoteListWidget): boolean {
    const a = this.model.entries;
    const b = other.model.entries;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (
        a[i]!.identifier !== b[i]!.identifier ||
        a[i]!.text !== b[i]!.text ||
        a[i]!.unreferenced !== b[i]!.unreferenced
      ) {
        return false;
      }
    }
    return true;
  }

  toDOM(): HTMLElement {
    const root = document.createElement("div");
    root.className = "cm-footnote-list";
    // Block widgets receive pointer events directly; the click handler reads the
    // data attributes below, but the widget owns its own region.

    const rule = document.createElement("div");
    rule.className = "cm-footnote-list-rule";
    root.appendChild(rule);

    const heading = document.createElement("div");
    heading.className = "cm-footnote-list-heading";
    heading.textContent = i18n.t("editor.footnote.heading"); // textContent — never innerHTML (TB2)
    root.appendChild(heading);

    const list = document.createElement("ol");
    list.className = "cm-footnote-list-items";
    for (const entry of this.model.entries) {
      const item = document.createElement("li");
      item.className = entry.unreferenced
        ? "cm-footnote-item cm-footnote-item-unreferenced"
        : "cm-footnote-item";

      // Grid columns (set on the list): col 1 = marker (shared `max-content`
      // width so every entry's body starts at the same x regardless of id
      // length), col 2 = body. `.cm-footnote-item` is `display: contents` so the
      // marker + body become the grid cells directly.
      const marker = document.createElement("span");
      marker.className = "cm-footnote-item-marker";
      marker.textContent = entry.identifier; // id glyph keeps ref↔entry parity
      item.appendChild(marker);

      const body = document.createElement("div");
      body.className = "cm-footnote-item-body";

      const text = document.createElement("span");
      text.className = "cm-footnote-item-text";
      text.textContent = entry.text;
      body.appendChild(text);

      if (entry.unreferenced) {
        const badge = document.createElement("span");
        badge.className = "cm-footnote-item-badge";
        badge.textContent = i18n.t("editor.footnote.unreferenced");
        body.appendChild(badge);
      } else if (this.model.referenceFirst.has(entry.identifier)) {
        // Back-affordance (↩) to the originating reference. The click handler
        // resolves `data-cm-footnote-backref` to the first reference offset.
        const back = document.createElement("span");
        back.className = "cm-footnote-item-backref";
        back.textContent = "↩";
        back.setAttribute("data-cm-footnote-backref", entry.identifier);
        body.appendChild(back);
      }

      item.appendChild(body);
      list.appendChild(item);
    }
    root.appendChild(list);

    // Pointer events on the list region bubble to the shared domEventHandler,
    // which acts only on the explicit `[data-cm-footnote-backref]` affordance.
    return root;
  }

  // The widget renders read-only derived content; CM should not try to map
  // editing into it.
  ignoreEvent(): boolean {
    return false; // let mousedown bubble to the domEventHandler for back-refs
  }
}

function buildFootnoteListDecorations(state: EditorState): DecorationSet {
  const model = state.field(footnoteModelField);
  if (model.entries.length === 0) return Decoration.none;
  const widget = new FootnoteListWidget(model);
  const builder = new RangeSetBuilder<Decoration>();
  // A point block widget appended AFTER the last line (side: 1) — never replaces
  // any source range, so the document bytes are untouched.
  builder.add(
    state.doc.length,
    state.doc.length,
    Decoration.widget({ widget, block: true, side: 1 }),
  );
  return builder.finish();
}

const footnoteListField = StateField.define<DecorationSet>({
  create(state) {
    return buildFootnoteListDecorations(state);
  },
  update(value, tr) {
    // Rebuild on doc OR async-parse (treeChanged) so the widget appears on
    // initial load — the `tableField` lesson. Selection/focus don't affect it.
    if (!tr.docChanged && syntaxTree(tr.startState) === syntaxTree(tr.state)) {
      return value;
    }
    return buildFootnoteListDecorations(tr.state);
  },
  provide(f) {
    return EditorView.decorations.from(f);
  },
});

export function footnoteDecorations(): readonly Extension[] {
  // Model field first so the inline plugin, click handler, and EOD widget all
  // read the same single collection.
  return [
    footnoteModelField,
    footnoteListField,
    makeCursorAwareDecorationPlugin(buildFootnoteInlineDecorations),
    footnoteClickHandler,
  ];
}
