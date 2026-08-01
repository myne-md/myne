// Command-palette search autocomplete (#207/#208 discoverability). The search
// field operators (`tag:`/`path:`/`file:`/`task:`/`content:`) already work, but
// they are INVISIBLE — no hint, no completion — so a user can't find them ("I
// couldn't use the prefixes at all"). This suggests an operator as you type a
// partial one, so the grammar is discoverable and completable without having to
// memorise the syntax.
//
// Pure + i18n-free: it returns operator ids + i18n KEYS; the palette resolves
// the labels (a language switch relabels). The offered set MUST stay in step
// with `KNOWN_OPERATORS` in `editor/src/host/notes/queryParser.ts` — the
// suggester must never offer an operator the parser does not route, or Tab would
// complete to a prefix that silently falls back to literal text.

export interface SearchOperator {
  /** The operator prefix, WITHOUT the colon (e.g. `"tag"`). */
  readonly op: string;
  /** i18n key for the one-line description shown beside it. */
  readonly hintKey: string;
}

/** The offerable operators, in display order (most useful first). Kept in step
 *  with `queryParser.KNOWN_OPERATORS` — see the module note. */
export const SEARCH_OPERATORS: readonly SearchOperator[] = [
  { op: "tag", hintKey: "commandPalette.operators.tag" },
  { op: "path", hintKey: "commandPalette.operators.path" },
  { op: "file", hintKey: "commandPalette.operators.file" },
  { op: "section", hintKey: "commandPalette.operators.section" },
  { op: "task", hintKey: "commandPalette.operators.task" },
  { op: "content", hintKey: "commandPalette.operators.content" },
];

/** The trailing token being typed: the run of non-space, non-paren characters at
 *  the end of the query. `""` when the query is empty or ends in whitespace or a
 *  paren. Mirrors the tokenizer's term boundary (whitespace / `(` / `)`). */
export function trailingToken(query: string): string {
  const m = /[^\s()]*$/.exec(query);
  return m ? m[0] : "";
}

/**
 * Operator suggestions for the current query: the operators whose name starts
 * with the trailing token, when that token is a NON-EMPTY partial with no colon
 * yet (once `tag:` is typed the operator is already chosen). Empty otherwise, so
 * a plain text query is never cluttered. Case-insensitive.
 */
export function searchOperatorSuggestions(query: string): SearchOperator[] {
  const token = trailingToken(query);
  if (token === "" || token.includes(":")) return [];
  const lower = token.toLowerCase();
  return SEARCH_OPERATORS.filter((o) => o.op.startsWith(lower));
}

/**
 * Complete the trailing partial operator to `<op>:`, preserving everything
 * before it: `tag` → `tag:`; `rele tag` → `rele tag:`. The caller sets the input
 * value to this and leaves the caret at the end so the user types the value next.
 */
export function completeOperator(query: string, op: string): string {
  const token = trailingToken(query);
  const head = query.slice(0, query.length - token.length);
  return `${head}${op}:`;
}

/** Operators whose values are a finite, cheap-to-enumerate set (tags, folders) —
 *  the ones a value dropdown can offer. `content:`/`task:`/`file:` take free
 *  text, so they get no value suggestions. */
const VALUE_OPERATORS = new Set(["tag", "path"]);

/** Matching values (tag names / folder paths) for a `<op>:<partial>` token, or
 *  `null` when the trailing token is not a value-suggestible `<op>:`. */
export interface ValueSuggestions {
  readonly op: string;
  readonly values: readonly string[];
}

function unquoteValue(s: string): string {
  let r = s;
  if (r.startsWith('"')) r = r.slice(1);
  if (r.endsWith('"')) r = r.slice(0, -1);
  return r;
}

/**
 * Value suggestions for a `<op>:<partial>` trailing token: the tags (for `tag:`)
 * or folders (for `path:`) matching `partial` (case-insensitive substring),
 * capped at `limit`. `null` when the token is not a value-suggestible operator,
 * or nothing matches. This is what lets the user pick `tag:work` without knowing
 * the tag exists.
 */
export function searchValueSuggestions(
  query: string,
  sources: { readonly tags: readonly string[]; readonly folders: readonly string[] },
  limit = 8,
): ValueSuggestions | null {
  const token = trailingToken(query);
  const colon = token.indexOf(":");
  if (colon <= 0) return null;
  const op = token.slice(0, colon).toLowerCase();
  if (!VALUE_OPERATORS.has(op)) return null;
  const partial = unquoteValue(token.slice(colon + 1)).toLowerCase();
  const pool = op === "tag" ? sources.tags : sources.folders;
  const values = pool.filter((v) => v.toLowerCase().includes(partial)).slice(0, limit);
  return values.length > 0 ? { op, values } : null;
}

/**
 * Complete `<op>:<partial>` to `<op>:<value>`, preserving the head and quoting a
 * value that contains whitespace (`tag:"my tag"`) so the tokenizer keeps it
 * whole.
 */
export function completeValue(query: string, op: string, value: string): string {
  const token = trailingToken(query);
  const head = query.slice(0, query.length - token.length);
  const v = /\s/.test(value) ? `"${value}"` : value;
  return `${head}${op}:${v}`;
}
