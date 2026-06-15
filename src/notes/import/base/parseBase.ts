// `.base` reader + shape validation (Saved Views #6, MYND-276, task 1).
//
// The thin end-to-end slice that turns `.base` bytes into a typed, validated
// parsed object. It reads the source via the SHIPPED importer file seam
// (`import_read_file` / `validate_within_root` — the WebView never gets general
// `fs:read`), parses with `js-yaml` 4.1.1 (already vendored — the same parser
// `src/dialect/visitors/frontmatter.ts` uses, NO new dependency), and validates
// the top-level `.base` shape (the five optional root sections: `filters`,
// `formulas`, `properties`, `summaries`, `views`).
//
// Bytes are handled in RAM only — no temp/scratch file (PS-1). Malformed YAML or
// a non-`.base` shape → a closed `BaseParseError`; no partial output. This slice
// STOPS at a validated parsed `.base` — the view-model mapping is task 2.

import { load as parseYaml, YAMLException } from "js-yaml";
import { importReadFile } from "../ports";

/** A `.base` filter clause: either a raw expression string (e.g.
 *  `file.inFolder("x")`, `status == "done"`) or a nested boolean group. The
 *  string clauses are parsed by the adapter (tasks 2-4); this slice preserves
 *  them verbatim. */
export type BaseFilterClause = string | BaseFilterGroup;

/** A nested boolean group in a `.base` filter tree. Obsidian uses `and`/`or` as
 *  arrays and `not` as a single clause or array. */
export interface BaseFilterGroup {
  readonly and?: ReadonlyArray<BaseFilterClause>;
  readonly or?: ReadonlyArray<BaseFilterClause>;
  readonly not?: BaseFilterClause | ReadonlyArray<BaseFilterClause>;
}

/** A `.base` `groupBy` — either a bare property name or `{property, direction}`. */
export type BaseGroupBy = string | { readonly property: string; readonly direction?: string };

/** One `.base` view, preserved with its known optional fields (the adapter
 *  narrows + validates each in task 2). Unknown keys are tolerated (kept in the
 *  index signature) so a future `.base` field doesn't fail the parse. */
export interface BaseView {
  readonly type: string;
  readonly name?: string;
  readonly filters?: BaseFilterClause;
  readonly order?: ReadonlyArray<string>;
  readonly groupBy?: BaseGroupBy;
  readonly cardSize?: number;
  readonly image?: string;
  /** YAML may type this as a float; preserved as-is and stringified by the
   *  adapter (the canonical schema stores it as a STRING — float-ban). */
  readonly imageAspectRatio?: number | string;
  readonly [key: string]: unknown;
}

/** A parsed, shape-validated `.base`. `views` is normalized to `[]` when absent
 *  so consumers never branch on undefined. The other sections are preserved
 *  opaquely (the adapter drops `formulas`/`summaries`/`properties`-display and
 *  counts them in task 4/5). */
export interface ParsedBase {
  readonly filters?: BaseFilterClause;
  readonly formulas?: Record<string, unknown>;
  readonly properties?: Record<string, unknown>;
  readonly summaries?: Record<string, unknown>;
  readonly views: ReadonlyArray<BaseView>;
}

/** Closed error for a malformed / non-`.base` source. Carries no partial state. */
export class BaseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaseParseError";
  }
}

/** The known `.base` root sections — a value with NONE of these is not a `.base`. */
const ROOT_SECTIONS = [
  "filters",
  "formulas",
  "properties",
  "summaries",
  "views",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse + shape-validate `.base` source bytes (pure — no IPC, so unit-testable).
 * Throws {@link BaseParseError} on malformed YAML or a non-`.base` shape; returns
 * a typed {@link ParsedBase} with `views` normalized to `[]` otherwise.
 */
export function parseBaseSource(source: string): ParsedBase {
  let doc: unknown;
  try {
    doc = parseYaml(source);
  } catch (e) {
    const detail = e instanceof YAMLException ? e.reason : String(e);
    throw new BaseParseError(`malformed .base YAML: ${detail}`);
  }

  // An empty document (whitespace/comments only) parses to undefined/null.
  if (doc === undefined || doc === null) {
    throw new BaseParseError("empty .base document");
  }
  if (!isPlainObject(doc)) {
    throw new BaseParseError("a .base must be a YAML mapping at the top level");
  }
  if (!ROOT_SECTIONS.some((k) => k in doc)) {
    throw new BaseParseError(
      "not a .base: none of filters/formulas/properties/summaries/views present",
    );
  }

  // `views`, if present, must be an array of view mappings each carrying a
  // string `type`. Absent → an empty list (a filters-only `.base` is legal).
  const rawViews = doc["views"];
  if (rawViews !== undefined && !Array.isArray(rawViews)) {
    throw new BaseParseError(".base `views` must be a list");
  }
  const views: BaseView[] = [];
  for (const v of (rawViews as unknown[] | undefined) ?? []) {
    if (!isPlainObject(v) || typeof v["type"] !== "string") {
      throw new BaseParseError(
        "each .base view must be a mapping with a string `type`",
      );
    }
    views.push(v as BaseView);
  }

  return {
    filters: doc["filters"] as BaseFilterClause | undefined,
    formulas: isPlainObject(doc["formulas"]) ? doc["formulas"] : undefined,
    properties: isPlainObject(doc["properties"]) ? doc["properties"] : undefined,
    summaries: isPlainObject(doc["summaries"]) ? doc["summaries"] : undefined,
    views,
  };
}

/**
 * Read a `.base` file through the shipped importer seam (`import_read_file`,
 * root-confined by `validate_within_root`) and parse it. Bytes live in RAM only
 * — the read returns a string, never a scratch file (PS-1). Errors (read failure
 * or parse failure) surface as a closed {@link BaseParseError}; no partial state.
 */
export async function readAndParseBase(
  root: string,
  path: string,
): Promise<ParsedBase> {
  let source: string;
  try {
    source = await importReadFile(root, path);
  } catch (e) {
    throw new BaseParseError(`could not read .base file: ${String(e)}`);
  }
  return parseBaseSource(source);
}
