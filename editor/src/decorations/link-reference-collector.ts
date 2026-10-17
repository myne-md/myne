// Shared link-reference definition collector for the Phase 1 editor.
//
// PRD `editor-mvp-ref-and-block-rendering` (MYND-148, and the deferred MYND-149
// / MYND-164 image rider). CommonMark resolves reference LINKS (`[text][ref]`)
// and reference IMAGES (`![alt][ref]`) against the SAME table of link reference
// definitions (`[ref]: url` lines, parsed as `LinkReference` nodes). This module
// is the single source of that table so the reference-link decorator and any
// future reference-image decorator share one doc scan + one resolution rule.
//
// It is a PURE function of editor state (no DOM / no view), factored like the
// `table.ts` helpers so it is unit-testable the moment a JS test runner lands.
// No test runner is wired up yet (no Vitest/Jest) — see the feature's
// `progress.md`; adding one is a minimal-deps dependency decision flagged for
// the user rather than taken here.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateField } from "@codemirror/state";
import { foldLabel } from "./reference-label";

/** A `[ref]: url` definition resolved from a `LinkReference` node. */
export interface LinkReferenceEntry {
  /** The destination URL (the `URL` child's text), trimmed. */
  readonly target: string;
  /** Byte range of the whole definition line(s), for cursor-aware hiding. */
  readonly definitionRange: { readonly from: number; readonly to: number };
}

export type LinkReferenceMap = ReadonlyMap<string, LinkReferenceEntry>;

/**
 * `foldLabel` lives in `./reference-label`, a leaf module with no imports, and
 * is re-exported here so this module's existing importers are unchanged.
 *
 * It moved because this file value-imports `@codemirror/language` and
 * `@codemirror/state` at module scope for the collector below, and
 * `@codemirror/language` depends on `@codemirror/view` — so any caller that
 * wanted only the label fold pulled the whole CodeMirror view stack with it.
 * The desktop dialect emission code did exactly that from the first-load graph.
 * Entry-graph callers import `./reference-label` DIRECTLY; going through this
 * re-export is still the expensive path.
 */
export { foldLabel } from "./reference-label";

/**
 * Walk the whole document for `LinkReference` definition nodes and build a
 * `foldedLabel → { target, definitionRange }` map. When a label is defined more
 * than once, the FIRST definition wins (CommonMark rule), so later duplicates
 * are skipped.
 */
export function collectLinkReferences(state: EditorState): LinkReferenceMap {
  const map = new Map<string, LinkReferenceEntry>();
  const doc = state.doc;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "LinkReference") return undefined;
      let label: string | null = null;
      let target: string | null = null;
      let child = node.node.firstChild;
      while (child !== null) {
        if (child.name === "LinkLabel" && label === null) {
          label = doc.sliceString(child.from, child.to);
        } else if (child.name === "URL" && target === null) {
          target = doc.sliceString(child.from, child.to).trim();
        }
        child = child.nextSibling;
      }
      if (label === null || target === null) return false;
      const folded = foldLabel(label);
      if (folded === "" || map.has(folded)) return false;
      const fromLine = doc.lineAt(node.from);
      const toLine = doc.lineAt(Math.max(node.from, node.to - 1));
      map.set(folded, {
        target,
        definitionRange: { from: fromLine.from, to: toLine.to },
      });
      return false;
    },
  });
  return map;
}

/**
 * Resolve a raw reference label (with or without brackets) against a collected
 * map. Returns the matching definition or `undefined` for a dangling label —
 * the latter is the broken-reference signal the reference-link decorator uses
 * to leave the usage as plain text.
 */
export function resolveReference(
  map: LinkReferenceMap,
  rawLabel: string,
): LinkReferenceEntry | undefined {
  return map.get(foldLabel(rawLabel));
}

/**
 * One whole-document scan of `[ref]: url` definitions, shared by the reference
 * LINK decorator (`reference-link.ts`) AND the reference IMAGE decorator
 * (`image-url.ts`, MYND-149). Lifted here from `reference-link.ts` so both
 * consumers read ONE collected map per doc/parse change — the §264 rider needs
 * the link decorator and the image decorator to agree on which definitions are
 * referenced. Rebuilt only on doc/parse change (a selection/focus tick can't
 * change the definition table). The field dedups by identity when both
 * decorators install it.
 */
export const linkReferencesField = StateField.define<LinkReferenceMap>({
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
