// The capability summary derivation (view-manifests, myne-md/myne#922 task 6).
//
// WHY THIS IS DERIVED AND NOT DECLARED. A `.myneview` file that carried its own
// `fields` list would be a second source of truth about one fact, and the failure
// mode is not a mismatch but a LIE: an author could declare less than their view
// reads. Reading capability is what the definition is made of, so it is computed
// from the definition, which makes it unfalsifiable by construction and makes
// "no wildcard" true for free: there is nowhere to write one.
//
// THE READ RULE, and it is closed on purpose. The readable set is the union of
// `columns`, `image` (the cover property), `group_by`, `sort.key`, and every
// `property` key referenced anywhere in the filter AST. The write set is
// `write_fields`, which is a DECLARED and closed list: the entire write authority
// a shared view carries. Do not widen either set here. `write_fields` keys are
// deliberately NOT added to the read set even though the host reads one to apply
// its value-anchored precondition: that read is the host performing a write the
// user approved, not the view reading the vault.
//
// The selection tree is a projection of the same AST, kept structured rather
// than flattened, because flattening `and`/`or` into one bullet list would render
// an OR as if it were an AND. It contains no filter logic: the query engine is
// the only evaluator (`src/notes/queryEngine.ts`), and nothing here decides what
// matches.
//
// `template` is the board's additive key, and it is DISCLOSED rather than treated
// as a capability: it names a note whose body a new card copies, and the note
// itself is resolved by the import path, which is the only layer that can know
// the vault. So it is echoed for the consent surface and read here for nothing
// else.

import type { FilterNode, PropertyOp, SavedView } from "../../lib/prefs";

/** A note-level attribute the filter selects on that is not a frontmatter
 *  property: the note's tags, its folder, or a full-text match. */
export type ViewEnvelopeRef =
  | { readonly kind: "tag"; readonly value: string }
  | { readonly kind: "folder"; readonly value: string }
  | { readonly kind: "search"; readonly value: string };

/** One condition in the selection, as the consent surface states it. A property
 *  condition names a key that also appears in `readsProperties`; it stays in the
 *  tree because it is ALSO what narrows the selection. */
export type ViewCondition =
  | ViewEnvelopeRef
  | {
      readonly kind: "property";
      readonly key: string;
      readonly op: PropertyOp;
      readonly value: string;
    };

/** The filter's boolean structure, preserved. `everyNote` is the degenerate
 *  `{ kind: "all" }` leaf: no condition narrows the selection at all. */
export type ViewSelection =
  | { readonly kind: "everyNote" }
  | { readonly kind: "condition"; readonly condition: ViewCondition }
  | { readonly kind: "and"; readonly children: readonly ViewSelection[] }
  | { readonly kind: "or"; readonly children: readonly ViewSelection[] }
  | { readonly kind: "not"; readonly child: ViewSelection };

export interface ViewCapabilitySummary {
  /** What the view lets the reader see, with the filter's boolean structure. */
  readonly selection: ViewSelection;
  /** Property keys the view reads, deduped, in derivation order: `columns`, the
   *  cover property, the group key, the sort key, then the filter's own keys. */
  readonly readsProperties: readonly string[];
  /** The note attributes the filter references besides properties. */
  readonly readsEnvelopes: readonly ViewEnvelopeRef[];
  /** The property keys the view may write (`write_fields`). Empty means none. */
  readonly writesProperties: readonly string[];
  /** The template note id this definition names, or `null` when it names none.
   *  A note id, not a verdict about the note: resolution belongs to the import
   *  path (see the file header). */
  readonly template: string | null;
}

/** Dedupe while preserving first-mention order. */
function pushUnique(out: string[], value: string | undefined): void {
  if (value === undefined || value === "") return;
  if (!out.includes(value)) out.push(value);
}

/** Project one AST node onto the selection vocabulary, collecting the property
 *  keys it references on the way through. Negation is preserved rather than
 *  swallowed: "notes not tagged x" and "notes tagged x" are different promises,
 *  and a summary that dropped the `not` would describe the opposite view. */
function projectFilter(
  node: FilterNode,
  propertyKeys: string[],
  envelopes: ViewEnvelopeRef[],
): ViewSelection {
  switch (node.kind) {
    case "and":
    case "or": {
      const children = node.children.map((child) =>
        projectFilter(child, propertyKeys, envelopes),
      );
      return node.kind === "and"
        ? { kind: "and", children }
        : { kind: "or", children };
    }
    case "not":
      return { kind: "not", child: projectFilter(node.child, propertyKeys, envelopes) };
    case "hasTag":
      envelopes.push({ kind: "tag", value: node.tag });
      return { kind: "condition", condition: { kind: "tag", value: node.tag } };
    case "inFolder":
      envelopes.push({ kind: "folder", value: node.path });
      return { kind: "condition", condition: { kind: "folder", value: node.path } };
    case "search":
      envelopes.push({ kind: "search", value: node.query });
      return { kind: "condition", condition: { kind: "search", value: node.query } };
    case "property":
      pushUnique(propertyKeys, node.key);
      return {
        kind: "condition",
        condition: { kind: "property", key: node.key, op: node.op, value: node.value },
      };
    case "all":
      return { kind: "everyNote" };
  }
}

/** The one derivation. Pure: no I/O, no prefs read, no query evaluation, so the
 *  consent surface cannot describe a view other than the one it was handed. */
export function viewCapabilitySummary(definition: SavedView): ViewCapabilitySummary {
  const readsProperties: string[] = [];
  // The PRD's order, and it is load-bearing for the test fixture: a filter-only
  // key must appear even though no column names it.
  for (const column of definition.columns ?? []) pushUnique(readsProperties, column);
  pushUnique(readsProperties, definition.image);
  pushUnique(readsProperties, definition.group_by);
  pushUnique(readsProperties, definition.sort?.key);

  const envelopes: ViewEnvelopeRef[] = [];
  const selection = projectFilter(definition.filters, readsProperties, envelopes);

  return {
    selection,
    readsProperties,
    readsEnvelopes: envelopes,
    writesProperties: [...(definition.write_fields ?? [])],
    template: templateOf(definition),
  };
}

/** Read the optional `template` key. Trimmed, and blank reads as absent: a key
 *  carrying only whitespace names no note, and a consent surface must not claim
 *  otherwise. */
function templateOf(definition: SavedView): string | null {
  const raw = definition.template;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}
