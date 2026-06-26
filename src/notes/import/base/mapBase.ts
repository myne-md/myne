// `.base` → canonical view-model mapping adapter (Saved Views #6, MYND-276,
// task 2) — the SUPPORTED path only.
//
// Maps a parsed `.base` view (from task 1's `parseBase.ts`) onto the canonical
// `SavedView` / `FilterNode` schema owned by #3 (`src/lib/prefs.ts`). Supported
// leaves: `<prop> <op> <value>`, `<prop>.contains(<v>)`, `file.hasTag(...)`
// (multi-value → OR), and `file.inFolder("path")` (task 3 — subtree-inclusive,
// matching Obsidian's recursive `inFolder`, SYNC-8). The full drop/warn tally +
// clause-drop semantics is task 4.
//
// The clause parser is deliberately TOTAL: any leaf string it can't recognize
// becomes a placeholder `{kind:"all"}` plus a structured `BaseImportWarning`,
// so a malformed/exotic `.base` clause never throws and never silently
// disappears (the warning is the audit trail tasks 4/5 consume).

import type {
  BaseFilterClause,
  BaseFilterGroup,
  BaseGroupBy,
  BaseView,
  ParsedBase,
} from "./parseBase";
import type {
  FilterNode,
  PropertyOp,
  SavedView,
  ViewSort,
  ViewType,
} from "../../../lib/prefs";
import i18n from "../../../i18n";

/** A minimal, structured import warning. Tasks 4/5 extend (more `kind`s) and
 *  consume (surface counts to the user) it — kept small + forward-compatible:
 *  a `kind` discriminator plus a free-form `detail` (the raw clause / value the
 *  warning is about). */
export interface BaseImportWarning {
  readonly kind: string;
  readonly detail: string;
}

/** Comparison operators, longest-first so the two-char forms (`>=`, `<=`, `==`,
 *  `!=`) are matched BEFORE the single-char `>` / `<` — otherwise `rating >= 4`
 *  would split on the `>` and leave a dangling `= 4`. Order is load-bearing. */
const COMPARISON_OPS: readonly PropertyOp[] = [">=", "<=", "==", "!=", ">", "<"];

/** Map a `.base` property ref to the canonical key. Obsidian frontmatter props
 *  are written `note.<key>`; strip that prefix to the bare key. `file.*` refs
 *  (`file.name`, `file.mtime`, …) are kept verbatim — the property index won't
 *  resolve most of them today and they render nothing, which is acceptable for
 *  now (`file.name` handling is task 4's concern). Exported for unit testing. */
export function normalizeRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith("note.")) {
    return trimmed.slice("note.".length);
  }
  return trimmed;
}

/** Strip one layer of matching surrounding quotes (single or double) from a
 *  literal, then trim. A bare/unquoted value is returned trimmed as-is. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' || first === "'") && last === first) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function isGroup(clause: BaseFilterClause): clause is BaseFilterGroup {
  return typeof clause === "object" && clause !== null;
}

/** Try to parse `<prop>.contains(<value>)`. Returns the property leaf or null. */
function parseContains(clause: string): FilterNode | null {
  // e.g. `title.contains("draft")` — capture the receiver and the single arg.
  const m = /^(.+?)\.contains\((.*)\)$/s.exec(clause.trim());
  if (!m) return null;
  const [, prop, arg] = m;
  return {
    kind: "property",
    key: normalizeRef(prop!),
    op: "contains",
    value: unquote(arg!),
  };
}

/** Scan `s` left→right tracking paren depth + quote state; at each TOP-LEVEL
 *  position (depth 0, outside quotes) invoke `at(i)` — returning `true` stops
 *  the scan and yields `i`. Returns -1 if `at` never matched. The single source
 *  of the depth/quote semantics shared by the comma splitter + the operator
 *  finder (so a `(`/`"` inside a literal or call is never mistaken for syntax). */
function scanTopLevel(s: string, at: (i: number) => boolean): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && at(i)) return i;
  }
  return -1;
}

/** Split a function arg list on TOP-LEVEL commas (outside quotes/parens), so
 *  `"a", "b"` → [`"a"`, `"b"`] but a comma inside a quoted literal stays put. */
function splitTopLevelArgs(args: string): string[] {
  const out: string[] = [];
  let start = 0;
  scanTopLevel(args, (i) => {
    if (args[i] === ",") {
      out.push(args.slice(start, i));
      start = i + 1;
    }
    return false; // never stop — scan the whole string
  });
  out.push(args.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Normalize one tag literal: unquote + strip a leading `#`. */
function normalizeTag(raw: string): string {
  const t = unquote(raw);
  return t.startsWith("#") ? t.slice(1) : t;
}

/** Try to parse `file.hasTag("a", "b", …)` or `hasTag("a")`. Obsidian's
 *  `hasTag` is "true if the file has ANY of the tags" (multi-value OR; nested
 *  tags included — which Myne's `byTag` resolver already matches subtree-wise,
 *  SYNC-8). A single value → a `hasTag` leaf; multiple → an `or` of `hasTag`
 *  leaves. Returns null if not a hasTag call. */
function parseHasTag(clause: string): FilterNode | null {
  const m = /^(?:file\.)?hasTag\((.*)\)$/s.exec(clause.trim());
  if (!m) return null;
  const tags = splitTopLevelArgs(m[1]!).map(normalizeTag).filter((t) => t.length > 0);
  if (tags.length === 0) return { kind: "all" };
  if (tags.length === 1) return { kind: "hasTag", tag: tags[0]! };
  return {
    kind: "or",
    children: tags.map((tag) => ({ kind: "hasTag", tag })),
  };
}

/** Try to parse `file.inFolder("path")`. Obsidian's `file.inFolder(folder)` is
 *  RECURSIVE — primary source (help.obsidian.md/bases/functions, verified
 *  2026-06-15): "Returns true if the file is in the specified folder or one of
 *  its sub-folders." Myne's `inFolder` engine leaf is ALSO subtree-inclusive
 *  (queryEngine `folderSubtreeNoteIds`), so the mapping is DIRECT — no
 *  recursion-semantics mismatch, no warning (SYNC-8). */
function parseInFolder(clause: string): FilterNode | null {
  const m = /^file\.inFolder\((.*)\)$/s.exec(clause.trim());
  if (!m) return null;
  return { kind: "inFolder", path: unquote(m[1]!) };
}

/** Find the first index of `op` in `clause` that is OUTSIDE any parentheses and
 *  outside a quoted string. Returns -1 if none. This keeps operators that live
 *  inside a function call (`list.map(x => x)`) or inside a quoted literal from
 *  being mistaken for a top-level comparison. */
function indexOfTopLevel(clause: string, op: string): number {
  return scanTopLevel(clause, (i) => clause.startsWith(op, i));
}

/** Try to parse `<prop> <op> <value>` for a supported comparison operator.
 *  Operators are tried longest-first (see {@link COMPARISON_OPS}) and matched
 *  only at the top level (not inside parens/quotes). Returns the property leaf,
 *  or null if no top-level operator is present. */
function parseComparison(clause: string): FilterNode | null {
  for (const op of COMPARISON_OPS) {
    const idx = indexOfTopLevel(clause, op);
    if (idx <= 0) continue; // need a non-empty left-hand side
    const left = clause.slice(0, idx);
    const right = clause.slice(idx + op.length);
    return {
      kind: "property",
      key: normalizeRef(left),
      op,
      value: unquote(right),
    };
  }
  return null;
}

/** A `file.*` comparison leaf references file metadata Myne's property index does
 *  NOT expose as a query source (`file.name`, `file.size`, and notably
 *  `file.mtime` / other date sources — SYNC-9: there is no `file.mtime` query
 *  leaf, no approximate-mtime mode). Such a clause is DROPPED. */
function isFileMetaProperty(node: FilterNode): boolean {
  return node.kind === "property" && node.key.startsWith("file.");
}

/** Map one raw leaf clause string (task 4 drop semantics). Recognizes the
 *  SUPPORTED forms (hasTag, inFolder, contains, comparison); a `file.*`
 *  comparison or anything unrecognized (`file.hasLink(...)`, `list.map(...)`,
 *  arithmetic, bare identifiers) is DROPPED — `node: null` plus an
 *  `unsupported-clause` warning. The parent group omits a dropped clause; it
 *  never throws and never silently survives. */
function mapLeaf(clause: string): {
  node: FilterNode | null;
  warnings: BaseImportWarning[];
} {
  // hasTag before the generic function-call shape so it isn't mis-parsed.
  const hasTag = parseHasTag(clause);
  if (hasTag) return { node: hasTag, warnings: [] };

  // inFolder → the subtree-inclusive `inFolder` leaf (direct map, SYNC-8).
  const inFolder = parseInFolder(clause);
  if (inFolder) return { node: inFolder, warnings: [] };

  const contains = parseContains(clause);
  if (contains && !isFileMetaProperty(contains)) {
    return { node: contains, warnings: [] };
  }

  const comparison = parseComparison(clause);
  if (comparison && !isFileMetaProperty(comparison)) {
    return { node: comparison, warnings: [] };
  }

  // Unsupported / file-meta clause → drop it (omitted from the parent group).
  return {
    node: null,
    warnings: [{ kind: "unsupported-clause", detail: clause }],
  };
}

/** Map a `.base` filter tree (group or leaf string, or absent) to a canonical
 *  `FilterNode`, collecting leaf warnings (task 4 drop semantics). The node is
 *  `null` ONLY when the (sub)tree had content but every clause DROPPED — the
 *  caller treats a top-level `null` as "skip this view" (SYNC-12). Absent /
 *  genuinely-empty group → `{kind:"all"}` (unfiltered, NOT a drop). A combinator
 *  with a single surviving child collapses to that child. */
export function mapBaseFilter(clause: BaseFilterClause | undefined): {
  node: FilterNode | null;
  warnings: BaseImportWarning[];
} {
  if (clause === undefined) {
    return { node: { kind: "all" }, warnings: [] };
  }

  if (typeof clause === "string") {
    return mapLeaf(clause);
  }

  if (!isGroup(clause)) {
    // Defensive: a non-string non-group leaf (shouldn't occur from the parser).
    return {
      node: null,
      warnings: [{ kind: "unsupported-clause", detail: String(clause) }],
    };
  }

  const warnings: BaseImportWarning[] = [];

  /** Map a clause array → only the SURVIVING children (dropped ones omitted). */
  const survivors = (clauses: ReadonlyArray<BaseFilterClause>): FilterNode[] => {
    const out: FilterNode[] = [];
    for (const c of clauses) {
      const r = mapBaseFilter(c);
      warnings.push(...r.warnings);
      if (r.node !== null) out.push(r.node);
    }
    return out;
  };

  /** Collapse a combinator over its surviving children: empty original group →
   *  unfiltered `{kind:"all"}`; non-empty but all-dropped → `null`; one
   *  survivor → that survivor; many → the combinator node. */
  const collapse = (
    original: ReadonlyArray<BaseFilterClause>,
    kind: "and" | "or",
  ): FilterNode | null => {
    if (original.length === 0) return { kind: "all" };
    const children = survivors(original);
    if (children.length === 0) return null; // every clause dropped
    if (children.length === 1) return children[0]!;
    return { kind, children };
  };

  if (clause.and !== undefined) {
    return { node: collapse(clause.and, "and"), warnings };
  }

  if (clause.or !== undefined) {
    return { node: collapse(clause.or, "or"), warnings };
  }

  if (clause.not !== undefined) {
    const not: BaseFilterClause | ReadonlyArray<BaseFilterClause> = clause.not;
    const inner = Array.isArray(not)
      ? collapse(not as ReadonlyArray<BaseFilterClause>, "and")
      : (() => {
          const r = mapBaseFilter(not as BaseFilterClause);
          warnings.push(...r.warnings);
          return r.node;
        })();
    // A `not` whose body fully dropped → drop the `not` too.
    return { node: inner === null ? null : { kind: "not", child: inner }, warnings };
  }

  // An empty group object (no and/or/not key) → unfiltered.
  return { node: { kind: "all" }, warnings };
}

/** Narrow a raw `.base` view `type` string to a canonical `ViewType`. */
function asViewType(type: string): ViewType | null {
  if (type === "cards" || type === "table" || type === "list") return type;
  return null;
}

/** Pull the `{property, direction}` out of a `BaseGroupBy` into a normalized
 *  property name plus an optional sort. */
function mapGroupBy(
  groupBy: BaseGroupBy,
): { groupKey: string; sort?: ViewSort } {
  if (typeof groupBy === "string") {
    return { groupKey: normalizeRef(groupBy) };
  }
  const groupKey = normalizeRef(groupBy.property);
  const dir = groupBy.direction?.trim().toLowerCase();
  if (dir === "asc" || dir === "desc") {
    // The `.base` groupBy direction is the order of the GROUPS. The canonical
    // schema has no group-order field, so the closest representable semantic is
    // a within-group `sort` on the same key — it preserves the user's asc/desc
    // intent even though it sorts rows, not group headers. (Documented choice.)
    return { groupKey, sort: { key: groupKey, direction: dir } };
  }
  return { groupKey };
}

/** Coerce an `imageAspectRatio` (number or string) to its canonical STRING
 *  form, or null if absent / non-finite. */
function aspectRatioString(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // A numeric string must be finite (reject "NaN", "Infinity", garbage).
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  return trimmed;
}

/**
 * Map one `.base` view onto a canonical {@link SavedView}, or `null` (with a
 * warning) when the view type isn't representable (`map` needs a Maps plugin,
 * SYNC-5; any unknown type is likewise skipped). `makeId` is injected — tests
 * pass a deterministic stub; production passes `crypto.randomUUID`.
 */
export function mapBaseView(
  view: BaseView,
  makeId: () => string,
): { view: SavedView | null; warnings: BaseImportWarning[] } {
  const viewType = asViewType(view.type);
  if (viewType === null) {
    return {
      view: null,
      warnings: [{ kind: "unsupported-view-type", detail: view.type }],
    };
  }

  const warnings: BaseImportWarning[] = [];
  const name = view.name ?? i18n.t("notes.import.base.untitledView");

  const filter = mapBaseFilter(view.filters);
  warnings.push(...filter.warnings);

  // SYNC-12: if the view HAD a filter but every clause dropped, the view would
  // silently widen to "all notes" — skip it instead, with a per-view warning.
  if (view.filters !== undefined && filter.node === null) {
    return {
      view: null,
      warnings: [...warnings, { kind: "view-skipped-empty-filter", detail: name }],
    };
  }

  const saved: SavedView = {
    id: makeId(),
    name,
    view_type: viewType,
    // A dropped/absent filter (node null only reachable when view.filters was
    // undefined, already handled above) → unfiltered `{kind:"all"}`.
    filters: filter.node ?? { kind: "all" },
  };

  // groupBy → group_by (+ a derived sort when a direction is present).
  if (view.groupBy !== undefined) {
    const { groupKey, sort } = mapGroupBy(view.groupBy);
    saved.group_by = groupKey;
    if (sort) saved.sort = sort;
  }

  // order → columns (each normalized); omit when empty.
  if (view.order !== undefined && view.order.length > 0) {
    saved.columns = view.order.map(normalizeRef);
  }

  // cardSize → card_size, only for a finite positive integer.
  if (
    typeof view.cardSize === "number" &&
    Number.isInteger(view.cardSize) &&
    view.cardSize > 0
  ) {
    saved.card_size = view.cardSize;
  }

  // image → normalizeRef(image); omit if absent.
  if (typeof view.image === "string" && view.image.trim() !== "") {
    saved.image = normalizeRef(view.image);
  }

  // imageAspectRatio → its STRING form; omit if absent / non-finite.
  const ar = aspectRatioString(view.imageAspectRatio);
  if (ar !== null) {
    saved.image_aspect_ratio = ar;
  }

  return { view: saved, warnings };
}

/**
 * Map a whole parsed `.base` (task 4 orchestration) → the surviving canonical
 * views + the full warning set. Per-view drop/skip warnings come from
 * {@link mapBaseView}; this layer additionally DROPS + counts the top-level
 * `formulas` / `summaries` / `properties`-display sections (SYNC-5 — Myne has no
 * formula/summary engine; property display names are cosmetic). Nothing throws;
 * every drop is a structured warning the import summary (task 5) tallies.
 */
export function mapParsedBase(
  parsed: ParsedBase,
  makeId: () => string,
): { views: SavedView[]; warnings: BaseImportWarning[] } {
  const views: SavedView[] = [];
  const warnings: BaseImportWarning[] = [];

  for (const view of parsed.views) {
    const r = mapBaseView(view, makeId);
    warnings.push(...r.warnings);
    if (r.view !== null) views.push(r.view);
  }

  const countDrop = (
    block: Record<string, unknown> | undefined,
    kind: string,
  ): void => {
    const n = block ? Object.keys(block).length : 0;
    if (n > 0) warnings.push({ kind, detail: String(n) });
  };
  countDrop(parsed.formulas, "dropped-formulas");
  countDrop(parsed.summaries, "dropped-summaries");
  countDrop(parsed.properties, "dropped-properties-display");

  return { views, warnings };
}
