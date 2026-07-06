// Footnote collection / ordering / resolution model for the Phase 1 editor.
//
// PRD `editor-mvp-footnotes` (MYND-153), task 3. A PURE function of editor state
// (no DOM / no view), factored like `link-reference-collector.ts` /
// `table.ts`'s `buildTableModel` so it is unit-testable and shared by the EOD
// list widget (task 4) and the click-to-jump resolution + orphan-reference
// detection (task 6).
//
// Walks the syntax tree (FootnoteReference + FootnoteDefinition nodes from
// `src/dialect/lezer/footnote.ts`) and builds:
//   - `entries`: the EOD-ordered list of DEFINITIONS, each collected exactly
//     once (keyed by identifier — first definition wins on a duplicate id).
//     Ordering = order of first REFERENCE appearance in the document, then
//     definition-only ("unreferenced") entries appended in source order.
//   - `resolution`: identifier → definition source offset, for click-to-jump.
//
// A reference whose identifier is NOT a key of `resolution` is an ORPHAN
// reference (story 7) — the model invents no empty entry for it. A definition
// with no reference is collected and flagged `unreferenced` (story 8).

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/** One collected `[^id]: text` definition. */
export interface FootnoteDefinitionEntry {
  readonly identifier: string;
  /** The definition text slice (`FootnoteContent`), `""` for a bare `[^id]:`. */
  readonly text: string;
  /** Document offset of the `FootnoteDefinition` node start (click-to-jump target). */
  readonly definitionFrom: number;
  readonly definitionTo: number;
  /** True when no reference in the document points at this definition. */
  readonly unreferenced: boolean;
}

export interface FootnoteModel {
  /** EOD-ordered definition entries: first-reference-appearance order, then
   *  unreferenced definitions in source order. Each identifier appears once. */
  readonly entries: readonly FootnoteDefinitionEntry[];
  /** identifier → definition source offset (`definitionFrom`). A reference id
   *  absent here is an orphan reference. */
  readonly resolution: ReadonlyMap<string, number>;
  /** identifier → source offset of its FIRST reference, for the EOD-entry
   *  back-affordance (↩). Absent for a definition that is never referenced. */
  readonly referenceFirst: ReadonlyMap<string, number>;
}

/** Text of the `FootnoteLabel` child (the identifier), or `null` if absent. */
function labelText(state: EditorState, node: SyntaxNode): string | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "FootnoteLabel") {
      return state.doc.sliceString(child.from, child.to);
    }
  }
  return null;
}

/**
 * Document offset where the definition BODY begins — just after the closing
 * `]:` marker (the last `FootnoteMark` child). The body is composite block
 * content (possibly multi-line: continuation paragraphs, fenced code, …), so
 * the displayable text is the source slice from here to the node end with
 * whitespace runs (including newlines + continuation indentation) collapsed.
 * Returns `null` if the marker children are absent.
 */
function bodyStart(node: SyntaxNode): number | null {
  let lastMark: number | null = null;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "FootnoteMark") lastMark = child.to;
  }
  return lastMark;
}

interface CollectedDefinition {
  readonly identifier: string;
  readonly text: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Build the immutable footnote model from the current syntax tree. Stable
 * across re-renders: ordering is derived purely from document positions, so the
 * same document always produces the same entry order.
 */
export function collectFootnotes(state: EditorState): FootnoteModel {
  const doc = state.doc;
  // Insertion order == source order (tree iteration is document order).
  const definitions = new Map<string, CollectedDefinition>();
  const referencedOrder: string[] = []; // first-appearance order of referenced ids
  const seenReference = new Set<string>();
  const referenceFirst = new Map<string, number>();

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === "FootnoteReference") {
        const id = labelText(state, node.node);
        if (id !== null) {
          if (!seenReference.has(id)) {
            seenReference.add(id);
            referencedOrder.push(id);
            referenceFirst.set(id, node.from);
          }
        }
        return false; // children are marks/label — nothing to descend for
      }
      if (node.name === "FootnoteDefinition") {
        const id = labelText(state, node.node);
        if (id !== null && !definitions.has(id)) {
          const start = bodyStart(node.node);
          const text =
            start !== null
              ? doc.sliceString(start, node.to).replace(/\s+/g, " ").trim()
              : "";
          definitions.set(id, {
            identifier: id,
            text,
            from: node.from,
            to: node.to,
          });
        }
        return false;
      }
      return undefined;
    },
  });

  const resolution = new Map<string, number>();
  for (const def of definitions.values()) resolution.set(def.identifier, def.from);

  const entries: FootnoteDefinitionEntry[] = [];

  // `referencedOrder` is already deduped (first-appearance order), and
  // `seenReference` is the authority on whether a definition is referenced —
  // so the two passes never overlap and need no extra "added" set.
  // 1. Referenced definitions, ordered by first reference appearance.
  for (const id of referencedOrder) {
    const def = definitions.get(id);
    if (def !== undefined) {
      entries.push({
        identifier: def.identifier,
        text: def.text,
        definitionFrom: def.from,
        definitionTo: def.to,
        unreferenced: false,
      });
    }
  }
  // 2. Definition-only ("unreferenced") entries, in source order.
  for (const def of definitions.values()) {
    if (!seenReference.has(def.identifier)) {
      entries.push({
        identifier: def.identifier,
        text: def.text,
        definitionFrom: def.from,
        definitionTo: def.to,
        unreferenced: true,
      });
    }
  }

  return { entries, resolution, referenceFirst };
}
