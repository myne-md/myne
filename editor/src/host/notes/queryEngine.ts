// Saved Views query engine — the declarative, eval-free filter layer over the
// property index (MYND-272, Saved Views #2). Task 1: the filter AST + the
// recursive boolean evaluator that resolves each leaf to an id-set and combines
// them via `tagFilter.ts`'s `combineTagSets` (AND = intersection, OR = union,
// NOT = complement against the live set).
//
// SYNC-7: the query surface is a CLOSED allow-list — there is NO evaluatable
// expression, no arithmetic, no `list.map`/`reduce`/`filter`. Those shapes are
// not representable in `FilterNode` and the evaluator has no code path for them
// (the `assertNever` exhaustiveness guard). This is the "not a database / no
// formula" commitment (vision.md) expressed in the type system.
//
// Build-B: structural leaves reduce to id-sets via the existing Rust query
// commands (`byTag`, `note_search`) wrapped TS-side; the boolean composition is
// pure TS (`combineTagSets`, reused — never forked). Property-comparison leaves
// (#3) and the `inFolder` leaf (#2) extend `FilterLeaf` in later slices; this
// slice wires `hasTag`, full-text `search`, and the degenerate `all` leaf.
//
// The live-set gate (T3 trash/template exclusion) is enforced in ONE place —
// every leaf result is intersected with `liveIds` here, so no resolver quirk
// can leak a trashed/template note and `not` only ever complements the live set.

import { foldSegment, folderKey } from "@myne/dialect/folderPath";
import type { FolderNode, FolderTree } from "./folderTree";
import { RFC3339_FULL_DATE } from "./propertyTyping";
import { combineTagSets } from "./tagCombine";

/** Comparison operators for a property leaf (the closed allow-list — no
 *  arithmetic, no function calls). `contains` is list-membership (or string
 *  substring); the rest are type-aware scalar comparisons. */
export type PropertyOp = "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains";

/** A coerced scalar value as the property index (#1) publishes it on the wire
 *  (Rust `PropertyScalar`): the §3.6.4 type tag + the canonical normalized
 *  string. */
export type StoredScalar = {
  readonly type: "string" | "number" | "date" | "checkbox";
  readonly value: string;
};

/** A note's typed property as #1 stores + returns it (Rust `PropertyEntry`):
 *  a scalar (`value` set) or a `list` (`elements` set). The engine consumes
 *  this typing and does NO inference of its own (SYNC-2 — #1 is the single
 *  type authority). */
export type StoredProperty = {
  readonly key: string;
  readonly type: "string" | "number" | "date" | "list" | "checkbox";
  readonly value?: string;
  readonly elements?: ReadonlyArray<StoredScalar>;
};

/** A leaf condition that reduces directly to an id-set. */
export type FilterLeaf =
  | { readonly kind: "hasTag"; readonly tag: string }
  | { readonly kind: "inFolder"; readonly path: string }
  | { readonly kind: "search"; readonly query: string }
  | {
      readonly kind: "property";
      readonly key: string;
      readonly op: PropertyOp;
      readonly value: string;
    }
  | { readonly kind: "all" };

/** The recursive filter AST: boolean combinators over leaves. There is
 *  deliberately no arithmetic / map / computed node — the closed allow-list. */
export type FilterNode =
  | { readonly kind: "and"; readonly children: ReadonlyArray<FilterNode> }
  | { readonly kind: "or"; readonly children: ReadonlyArray<FilterNode> }
  | { readonly kind: "not"; readonly child: FilterNode }
  | FilterLeaf;

/** Injected leaf resolvers (pure-evaluator seam — production wires the Rust
 *  query commands; tests inject fakes, so the evaluator needs no IPC). Each
 *  returns a raw id list; the evaluator applies the live-set gate. */
export type LeafResolvers = {
  readonly hasTag: (tag: string) => Promise<ReadonlyArray<string>>;
  readonly inFolder: (path: string) => Promise<ReadonlyArray<string>>;
  readonly search: (query: string) => Promise<ReadonlyArray<string>>;
  /** Every note carrying property `key`, as `[noteId, storedProperty]` — the
   *  #1 by-key accessor (`vault_indices_property_values`). The engine compares
   *  each value type-awarely; it never re-types. */
  readonly propertyValues: (
    key: string,
  ) => Promise<ReadonlyArray<readonly [string, StoredProperty]>>;
};

function assertNever(node: never): never {
  // Unreachable: `FilterNode` is a closed union. If this throws, a node shape
  // outside the allow-list reached the evaluator — the anti-eval invariant.
  throw new Error(
    `query-engine: unsupported filter node ${JSON.stringify(node)}`,
  );
}

/**
 * Recursively evaluate a filter tree to a deduped, **live-only** id-set
 * (insertion-ordered, matching `combineTagSets`). `and`/`or` combine child
 * sets via the reused set algebra; `not` complements against `liveIds` only;
 * every leaf is intersected with `liveIds` (the single trash/template gate).
 * An empty `and`/`or` collapses to `[]` (the `combineTagSets` n=0 identity);
 * a single-child combinator collapses to that child's set (n=1).
 */
export async function evaluateFilter(
  node: FilterNode,
  liveIds: ReadonlySet<string>,
  resolvers: LeafResolvers,
): Promise<string[]> {
  switch (node.kind) {
    case "all":
      return [...liveIds];
    case "hasTag":
      return (await resolvers.hasTag(node.tag)).filter((id) => liveIds.has(id));
    case "inFolder":
      return (await resolvers.inFolder(node.path)).filter((id) =>
        liveIds.has(id),
      );
    case "search":
      return (await resolvers.search(node.query)).filter((id) =>
        liveIds.has(id),
      );
    case "property": {
      const pairs = await resolvers.propertyValues(node.key);
      return pairs
        .filter(
          ([id, stored]) =>
            liveIds.has(id) &&
            comparePropertyValue(stored, node.op, node.value),
        )
        .map(([id]) => id);
    }
    case "and":
    case "or": {
      const sets = await Promise.all(
        node.children.map((child) => evaluateFilter(child, liveIds, resolvers)),
      );
      // `node.kind` is exactly `FilterMode` ("and" | "or").
      return combineTagSets(sets, node.kind);
    }
    case "not": {
      const matched = new Set(
        await evaluateFilter(node.child, liveIds, resolvers),
      );
      return [...liveIds].filter((id) => !matched.has(id));
    }
    default:
      return assertNever(node);
  }
}

// ---- inFolder leaf — subtree-inclusive folder aggregation (task 2) ----------
//
// SYNC-8 / Q2-A: `inFolder(P)` resolves to the notes of folder P PLUS every
// descendant folder — changing folder matching from the exact `FolderNode.noteIds`
// to descendant-aggregating. The query path is folded the same way the tree's
// `key` is (`folderKey` = `foldSegment(normalizeFolderPath(path))`, §3.7.8), so
// query-fold == write-fold (Turkish-safe). `hasTag` is already subtree-inclusive
// via `byTag`; only folders needed this change.

function collectSubtree(node: FolderNode, out: string[]): void {
  out.push(...node.noteIds);
  for (const child of node.children) collectSubtree(child, out);
}

function findFolderNode(
  nodes: ReadonlyArray<FolderNode>,
  key: string,
): FolderNode | null {
  for (const node of nodes) {
    if (node.key === key) return node;
    const found = findFolderNode(node.children, key);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Pure subtree aggregation: every note id under folder `path` (the folder
 * itself + all descendants), or `[]` if the path is the vault root / not a
 * folder in the tree. The testable core of the `inFolder` leaf; production
 * wires `resolvers.inFolder = (p) => folderSubtreeNoteIds(currentTree, p)`.
 */
export function folderSubtreeNoteIds(tree: FolderTree, path: string): string[] {
  const targetKey = folderKey(path);
  if (targetKey === "") return []; // root / unfiled is not an inFolder target
  const node = findFolderNode(tree.roots, targetKey);
  if (node === null) return [];
  const out: string[] = [];
  collectSubtree(node, out);
  return out;
}

// ---- typed property comparison (task 3) -------------------------------------
//
// SYNC-2: #1 is the single type authority. The engine reads the stored type tag
// and compares accordingly — it performs NO inference of its own; the query
// operand string is coerced to the STORED value's type. SYNC-9: date comparison
// runs only on frontmatter `date` properties (there is no `file.mtime` leaf —
// it is not a query source). String compares fold both sides TS-side (§3.7.8).

/** RFC 3339 → epoch ms: a `full-date` is anchored to 00:00:00Z (SYNC-9 — a
 *  date-only value compares as start-of-day UTC); a `date-time` parses as-is.
 *  `null` on an unparseable operand (→ the comparison yields no match). Reuses
 *  `propertyTyping`'s full-date shape (the §3.6.4 type authority owns it). */
function parseDateMs(s: string): number | null {
  const t = s.trim();
  const iso = RFC3339_FULL_DATE.test(t) ? `${t}T00:00:00Z` : t;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Three-way compare of two typed scalars — the SINGLE comparison authority
 * shared by the property-comparison leaves (task 3) and the sort (task 5).
 * number/date compare numerically (date by instant, SYNC-9); everything else
 * (string / checkbox / mixed-type) compares on the case-folded string (§3.7.8).
 * Returns -1 / 0 / 1, or `null` when incomparable (an unparseable number/date)
 * — callers treat `null` as "no order / no match". Never throws.
 */
function compareScalars(a: StoredScalar, b: StoredScalar): number | null {
  if (a.type === "number" && b.type === "number") {
    const an = Number.parseFloat(a.value);
    const bn = Number.parseFloat(b.value);
    if (Number.isNaN(an) || Number.isNaN(bn)) return null;
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  if (a.type === "date" && b.type === "date") {
    const am = parseDateMs(a.value);
    const bm = parseDateMs(b.value);
    if (am === null || bm === null) return null;
    return am < bm ? -1 : am > bm ? 1 : 0;
  }
  const af = foldSegment(a.value);
  const bf = foldSegment(b.value);
  return af < bf ? -1 : af > bf ? 1 : 0;
}

/** Map a three-way comparison to the boolean an ordering/equality op wants.
 *  `null` (incomparable) → `false`; `contains` is not an ordering op → `false`. */
function orderingToBool(cmp: number | null, op: PropertyOp): boolean {
  if (cmp === null) return false;
  switch (op) {
    case "==":
      return cmp === 0;
    case "!=":
      return cmp !== 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case "contains":
      return false;
  }
}

/**
 * Type-aware comparison of a stored property against a query operand (task 3),
 * via the one [`compareScalars`] authority + [`orderingToBool`]. `list`
 * supports only `contains` (membership — any element equals the operand by its
 * own type); a scalar comparison on a list is `false`. The operand is coerced
 * to the STORED value's type (#1 is the type authority — SYNC-2, no inference).
 * `contains` is folded substring for a string and `false` for other scalars;
 * checkbox supports `==`/`!=` only (ordering undefined). Unparseable
 * number/date operand → no match. Never throws.
 */
export function comparePropertyValue(
  stored: StoredProperty,
  op: PropertyOp,
  query: string,
): boolean {
  if (stored.type === "list") {
    if (op !== "contains") return false;
    return (stored.elements ?? []).some(
      (el) => compareScalars(el, { type: el.type, value: query }) === 0,
    );
  }
  const self: StoredScalar = { type: stored.type, value: stored.value ?? "" };
  if (op === "contains") {
    return stored.type === "string"
      ? foldSegment(self.value).includes(foldSegment(query))
      : false;
  }
  if (stored.type === "checkbox" && op !== "==" && op !== "!=") {
    return false; // ordering undefined for a boolean
  }
  return orderingToBool(compareScalars(self, { type: stored.type, value: query }), op);
}

// ---- groupBy with list-property fan-out (task 4) ----------------------------
//
// Q1: a scalar property buckets each note into ONE group; a list-valued
// property FANS the note OUT into every matching group (rows can duplicate —
// total grouped rows may exceed the note count). A note with no value for the
// groupBy key (absent property, or an empty list) lands in the implicit
// no-value group (key ""). Group + within-group order is first-seen. The group
// key carries the typed value #5 renders as the heading.

/** One group of the grouped-view output. `type` is the group VALUE's §3.6.4
 *  type (`"none"` for the no-value bucket); `key` is its normalized string. */
export type ViewGroup = {
  readonly key: string;
  readonly type: StoredScalar["type"] | "none";
  readonly ids: string[];
};

/**
 * Group `ids` by the value of a property (looked up per id). Scalars bucket
 * once; lists fan out into every element's group; missing/empty → the no-value
 * group (key `""`). De-duped within a group (a list `["a","a"]` adds the note
 * to group `a` once). Pure — `propertyForId` is injected (production builds it
 * from the #1 `property_values(key)` accessor). The ungrouped view (one
 * implicit group of every match) is the caller's (`run_view`) concern, not this.
 */
export function groupByProperty(
  ids: ReadonlyArray<string>,
  propertyForId: (id: string) => StoredProperty | undefined,
): ViewGroup[] {
  const groups = new Map<string, ViewGroup>();
  const members = new Map<string, Set<string>>();
  const add = (key: string, type: ViewGroup["type"], id: string): void => {
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, type, ids: [] };
      groups.set(key, group);
      members.set(key, new Set());
    }
    const seen = members.get(key)!;
    if (!seen.has(id)) {
      seen.add(id);
      group.ids.push(id);
    }
  };
  for (const id of ids) {
    const prop = propertyForId(id);
    if (prop === undefined) {
      add("", "none", id);
      continue;
    }
    if (prop.type === "list") {
      const els = prop.elements ?? [];
      if (els.length === 0) {
        add("", "none", id);
        continue;
      }
      for (const el of els) add(el.value, el.type, id);
    } else {
      add(prop.value ?? "", prop.type, id);
    }
  }
  return [...groups.values()];
}

// ---- sort with list single-representative (task 5) --------------------------
//
// Order rows within a group by a sort key, ascending/descending, type-aware per
// #1. A list-valued sort property uses a SINGLE representative (the first
// element) — fan-out is incoherent for a linear order (Q1). Date sort uses
// frontmatter date properties only (SYNC-9). Notes missing the sort value sort
// last (both directions). With no sort key the order falls back to the
// canonical recency (`sortBatchIds`, injected). An explicit sort always
// reorders, so it overrides any incoming BM25 order from a search leaf.

export type SortDirection = "asc" | "desc";

function sortRepresentative(
  prop: StoredProperty | undefined,
): StoredScalar | null {
  if (prop === undefined) return null;
  if (prop.type === "list") {
    const els = prop.elements ?? [];
    return els.length > 0 ? els[0] : null; // first element = the representative
  }
  return { type: prop.type, value: prop.value ?? "" };
}

/**
 * Sort `ids` by property `sortKey` (type-aware, list→first-element
 * representative; missing→last), ascending or descending. With `sortKey ===
 * null` the order falls back to `recencyFallback` (the injected
 * `sortBatchIds`). Stable on ties. Pure — `propertyForId` + `recencyFallback`
 * are injected.
 */
export function sortGroupIds(
  ids: ReadonlyArray<string>,
  propertyForId: (id: string) => StoredProperty | undefined,
  sortKey: string | null,
  direction: SortDirection,
  recencyFallback: (ids: ReadonlyArray<string>) => string[],
): string[] {
  if (sortKey === null) return recencyFallback(ids);
  const decorated = ids.map((id, index) => ({
    id,
    index,
    rep: sortRepresentative(propertyForId(id)),
  }));
  decorated.sort((x, y) => {
    if (x.rep === null && y.rep === null) return x.index - y.index;
    if (x.rep === null) return 1; // missing sorts last (both directions)
    if (y.rep === null) return -1;
    const cmp = compareScalars(x.rep, y.rep) ?? 0;
    if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
    return x.index - y.index; // stable tie-break
  });
  return decorated.map((d) => d.id);
}

// ---- run_view: the deep-module entry #5 consumes (task 6) --------------------
//
// Threads filter (tasks 1–3) → groupBy (task 4) → sort (task 5) into the
// canonical grouped-row contract (SYNC-5). The engine reads ONLY these
// #3-owned definition fields (filter / groupBy / sort / columns); it invents
// none. A locked vault yields an empty grouped result, never an error (every
// consumed index command is Slot::Unlocked-gated; a thrown SlotNotUnlocked
// collapses to `{ groups: [] }`). Nothing is written to disk — the engine is
// RAM-resident over #1's encrypted index (PS-1).

/** The view definition the engine consumes. #3 (view-model-and-storage) owns
 *  the persisted schema + `.base` mapping; this is the subset the engine reads.
 *  `groupBy`/`sort` absent → one implicit group, recency order. */
export type ViewDefinition = {
  readonly filter: FilterNode;
  readonly groupBy?: string;
  readonly sort?: { readonly key: string; readonly direction: SortDirection };
  readonly columns?: ReadonlyArray<string>;
};

/** One rendered row — the title-record-like shape #5 renders (the Obsidian
 *  `entry.getValue` parallel). `values` carries the displayed columns' typed
 *  property values (absent column → `undefined`). */
export type ViewRow = {
  readonly noteId: string;
  readonly title: string | null;
  readonly folder: string | null;
  readonly values: Readonly<Record<string, StoredProperty | undefined>>;
};

/** A rendered group: the typed group key/value + its ordered rows. */
export type ViewResultGroup = {
  readonly key: string;
  readonly type: ViewGroup["type"];
  readonly rows: ViewRow[];
};

/** The grouped-row output #5 renders. */
export type ViewResult = { readonly groups: ViewResultGroup[] };

/** Injected runtime context (the impure seam; production builds it from the
 *  Rust query commands + the sidebar caches, tests inject fakes). */
export type RunViewContext = {
  readonly liveIds: ReadonlySet<string>;
  readonly resolvers: LeafResolvers;
  readonly rowFor: (id: string) => {
    readonly title: string | null;
    readonly folder: string | null;
  };
  readonly recencyFallback: (ids: ReadonlyArray<string>) => string[];
};

/**
 * Run a saved view to its grouped rows. Filter → group → sort → rows. Locked
 * vault / index error → `{ groups: [] }` (never throws). Deterministic: the
 * same `(def, ctx)` yields a value-equal result (see [`sameViewResult`]).
 */
export async function runView(
  def: ViewDefinition,
  ctx: RunViewContext,
): Promise<ViewResult> {
  try {
    const ids = await evaluateFilter(def.filter, ctx.liveIds, ctx.resolvers);

    // Fetch the property maps the groupBy / sort / columns need (one accessor
    // call per distinct key; built into id→value maps for O(1) lookup).
    const neededKeys = new Set<string>();
    if (def.groupBy !== undefined) neededKeys.add(def.groupBy);
    if (def.sort !== undefined) neededKeys.add(def.sort.key);
    for (const col of def.columns ?? []) neededKeys.add(col);
    const propMaps = new Map<string, Map<string, StoredProperty>>();
    await Promise.all(
      [...neededKeys].map(async (key) => {
        const pairs = await ctx.resolvers.propertyValues(key);
        propMaps.set(key, new Map(pairs.map(([id, sp]) => [id, sp])));
      }),
    );
    const lookup =
      (key: string) =>
      (id: string): StoredProperty | undefined =>
        propMaps.get(key)?.get(id);

    const rawGroups: ViewGroup[] =
      def.groupBy !== undefined
        ? groupByProperty(ids, lookup(def.groupBy))
        : [{ key: "", type: "none", ids }];

    const groups: ViewResultGroup[] = rawGroups.map((group) => {
      const orderedIds = sortGroupIds(
        group.ids,
        def.sort !== undefined ? lookup(def.sort.key) : () => undefined,
        def.sort?.key ?? null,
        def.sort?.direction ?? "asc",
        ctx.recencyFallback,
      );
      const rows: ViewRow[] = orderedIds.map((id) => {
        const meta = ctx.rowFor(id);
        const values: Record<string, StoredProperty | undefined> = {};
        for (const col of def.columns ?? []) values[col] = propMaps.get(col)?.get(id);
        return { noteId: id, title: meta.title, folder: meta.folder, values };
      });
      return { key: group.key, type: group.type, rows };
    });

    return { groups };
  } catch {
    // Locked vault (Slot::Unlocked-gated commands throw) / index hiccup →
    // empty grouped result; the surface renders an empty view, not an error.
    return { groups: [] };
  }
}

/** Value-equality of two view results (groups in order; rows by noteId + order;
 *  group key/type). Pure — the consumer (#5) holds the previous-result ref and
 *  bails the render on a reference-equal outcome (mirrors `stabilizeResult`). */
/** Structural equality of one displayed property cell (type + scalar value +
 *  list elements). `undefined` cells (absent column) compare equal. */
function sameStoredProperty(
  a: StoredProperty | undefined,
  b: StoredProperty | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (a.type !== b.type || a.value !== b.value) return false;
  const ea = a.elements;
  const eb = b.elements;
  if (ea === eb) return true;
  if (ea === undefined || eb === undefined || ea.length !== eb.length) return false;
  for (let i = 0; i < ea.length; i++) if (ea[i] !== eb[i]) return false;
  return true;
}

/** Whether two rows render identically — same note AND same displayed column
 *  values. The values comparison is load-bearing: a property edit (e.g. setting
 *  a card cover, which adds a `cover` column value to the SAME note-set) must
 *  invalidate the stabilised result, or the cards would keep the stale,
 *  cover-less rows and never paint the new cover. */
function sameRow(a: ViewRow, b: ViewRow): boolean {
  if (a.noteId !== b.noteId) return false;
  const ka = Object.keys(a.values);
  const kb = Object.keys(b.values);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!sameStoredProperty(a.values[k], b.values[k])) return false;
  }
  return true;
}

export function sameViewResult(a: ViewResult, b: ViewResult): boolean {
  if (a === b) return true;
  if (a.groups.length !== b.groups.length) return false;
  for (let i = 0; i < a.groups.length; i++) {
    const ga = a.groups[i];
    const gb = b.groups[i];
    if (ga.key !== gb.key || ga.type !== gb.type) return false;
    if (ga.rows.length !== gb.rows.length) return false;
    for (let j = 0; j < ga.rows.length; j++) {
      if (!sameRow(ga.rows[j], gb.rows[j])) return false;
    }
  }
  return true;
}

/** Return `prev` when value-equal to `next` (so a re-run bails the React
 *  render), else `next`. The `stabilizeResult` parallel for view results. */
export function stabilizeViewResult(
  prev: ViewResult | null,
  next: ViewResult,
): ViewResult {
  return prev !== null && sameViewResult(prev, next) ? prev : next;
}
