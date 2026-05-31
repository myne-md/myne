// Reference-style link decoration for the Phase 1 editor.
//
// PRD `editor-mvp-ref-and-block-rendering` (MYND-148). Renders reference-style
// link USAGES (`[text][ref]`, collapsed `[text][]`, shortcut `[ref]`) by
// resolving them against the shared link-reference collector, and hides the
// resolved `[ref]: url` DEFINITION lines off-cursor. Unresolved references are
// left completely untouched (broken-ref UX — plain text, no crash).
//
// IMPORTANT — why the collector, not the parser: @lezer/markdown emits a `Link`
// node for a broken FULL reference (`[text][missing]`) even with no matching
// definition, so the parse tree alone can't distinguish resolved from dangling.
// The collector (link-reference-collector.ts) is the resolution authority.
// (Shortcut/collapsed forms only become `Link` nodes when already resolved.)
//
// Two extensions, because the two halves have different CM6 constraints:
//   1. Usage marks — `.cm-link` on the visible text + hiding the `][ref]`
//      brackets, all WITHIN one line → cursor-aware `ViewPlugin` (reveal via
//      `isInsideRange`, so two refs on one line reveal independently).
//   2. Definition-line hiding — collapses a whole `[ref]: url` line, which
//      crosses a line break → `StateField` (CM6 forbids that from a plugin),
//      reveal gated on the shared `editorFocusField` + per-line selection.
//
// Penpot reference: `flow--editor-ref-and-block` Section E — reference-links row.

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
} from "@codemirror/view";
import { collapseLineRange, isInsideRange, linesRevealed } from "./cursor-aware";
import {
  collectLinkReferences,
  type LinkReferenceEntry,
  type LinkReferenceMap,
  resolveReference,
} from "./link-reference-collector";
import {
  makeCursorAwareDecorationPlugin,
  makeCursorAwareStateField,
} from "./plugin-factory";

// One whole-document scan of `[ref]: url` definitions, shared by the usage marks
// (ViewPlugin) and the definition-line hiding (StateField) so the collector
// runs ONCE per doc/parse change instead of once per consumer per update — and
// is NOT rebuilt on selection/focus-only changes (the map can't have changed).
const linkReferencesField = StateField.define<LinkReferenceMap>({
  create(state) {
    return collectLinkReferences(state);
  },
  update(value, tr) {
    if (!tr.docChanged && syntaxTree(tr.startState) === syntaxTree(tr.state)) {
      return value;
    }
    return collectLinkReferences(tr.state);
  },
});

/** Reference-style `Link` shape extracted from the parse tree. `null` when the
 *  node is an inline `[text](url)` link (has a `URL` child — `link.ts` owns it)
 *  or is malformed. */
interface RefLinkShape {
  /** Visible link-text range (between the first `[` and its matching `]`). */
  readonly textFrom: number;
  readonly textTo: number;
  /** The opening `[` mark range, hidden off-cursor. */
  readonly openMark: readonly [number, number];
  /** Range to hide off-cursor after the text: `]` + optional `[ref]` label. */
  readonly tailFrom: number;
  readonly tailTo: number;
  /** Folded-label resolution key (label for full form, visible text otherwise). */
  readonly label: string;
}

function readRefLink(
  state: EditorState,
  node: import("@lezer/common").SyntaxNode,
): RefLinkShape | null {
  const marks: Array<[number, number]> = [];
  let linkLabel: { from: number; to: number } | null = null;
  let hasUrl = false;

  let child = node.firstChild;
  while (child !== null) {
    if (child.name === "LinkMark") marks.push([child.from, child.to]);
    else if (child.name === "LinkLabel") linkLabel = { from: child.from, to: child.to };
    else if (child.name === "URL") hasUrl = true;
    child = child.nextSibling;
  }

  // Inline link (`[text](url)`) — handled by link.ts. Skip.
  if (hasUrl) return null;
  // Need at least the `[` and `]` of the visible text.
  if (marks.length < 2) return null;

  const openMark = marks[0]!;
  const closeMark = marks[1]!;
  const textFrom = openMark[1];
  const textTo = closeMark[0];

  // Label resolution key: a non-empty `[ref]` label (full form) resolves by its
  // inner text; a shortcut `[ref]` or collapsed `[text][]` resolves by the
  // visible text (`[]` is empty → length 2).
  const hasExplicitLabel = linkLabel !== null && linkLabel.to - linkLabel.from > 2;
  const label = hasExplicitLabel
    ? state.doc.sliceString(linkLabel!.from + 1, linkLabel!.to - 1)
    : state.doc.sliceString(textFrom, textTo);

  const tailFrom = closeMark[0];
  const tailTo = linkLabel !== null ? linkLabel.to : closeMark[1];

  return { textFrom, textTo, openMark, tailFrom, tailTo, label };
}

// --- 1. Usage marks (ViewPlugin) -----------------------------------------

function buildReferenceLinkUsages(view: EditorView): DecorationSet {
  const map = view.state.field(linkReferencesField);
  const decorations: Array<Range<Decoration>> = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "Link") return undefined;
        const shape = readRefLink(view.state, node.node);
        if (shape === null) return undefined;
        if (resolveReference(map, shape.label) === undefined) {
          // Dangling reference — leave entirely as plain text.
          return undefined;
        }
        // Resolved: style the visible text as a link (kept even on-cursor, like
        // the inline-link precedent); hide the bracket machinery off-cursor.
        decorations.push(
          Decoration.mark({ class: "cm-link" }).range(shape.textFrom, shape.textTo),
        );
        if (!isInsideRange(view, node.from, node.to)) {
          decorations.push(
            Decoration.replace({}).range(shape.openMark[0], shape.openMark[1]),
          );
          decorations.push(
            Decoration.replace({}).range(shape.tailFrom, shape.tailTo),
          );
        }
        return undefined;
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  decorations.sort((a, b) => {
    if (a.from !== b.from) return a.from - b.from;
    if (a.to !== b.to) return a.to - b.to;
    return (a.value.spec.side ?? 0) - (b.value.spec.side ?? 0);
  });
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

// --- 2. Definition-line hiding (StateField) ------------------------------

/** Collect the definition ranges referenced by at least one RESOLVED reference
 *  usage. A definition referenced only by an image stays visible until the
 *  reference-image rider lands (MYND-149 → deferred to MYND-164). */
function referencedDefinitions(
  state: EditorState,
  map: LinkReferenceMap,
): LinkReferenceEntry[] {
  const seen = new Set<number>();
  const out: LinkReferenceEntry[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Link") return undefined;
      const shape = readRefLink(state, node.node);
      if (shape === null) return undefined;
      const entry = resolveReference(map, shape.label);
      if (entry === undefined) return undefined;
      if (!seen.has(entry.definitionRange.from)) {
        seen.add(entry.definitionRange.from);
        out.push(entry);
      }
      return undefined;
    },
  });
  return out;
}

function buildReferenceDefinitionHiding(state: EditorState): DecorationSet {
  const map = state.field(linkReferencesField);
  const entries = referencedDefinitions(state, map);
  const decorations: Array<Range<Decoration>> = [];

  for (const { definitionRange } of entries) {
    const fromLine = state.doc.lineAt(definitionRange.from);
    const toLine = state.doc.lineAt(definitionRange.to);
    if (linesRevealed(state, fromLine.number, toLine.number)) continue;
    const { from, to } = collapseLineRange(state, fromLine.number, toLine.number);
    decorations.push(Decoration.replace({}).range(from, to));
  }

  decorations.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decorations) builder.add(d.from, d.to, d.value);
  return builder.finish();
}

export function referenceLinkDecorations(): Extension {
  // `linkReferencesField` first so both consumers read the shared map. The
  // StateField factory bundles the focus field/tracker (deduped by identity).
  return [
    linkReferencesField,
    makeCursorAwareStateField(buildReferenceDefinitionHiding),
    makeCursorAwareDecorationPlugin(buildReferenceLinkUsages),
  ];
}
