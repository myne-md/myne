// Search query-language parser (MYND-303 field operators + MYND-307 boolean/
// phrase). Compiles a free-text search string into a `FilterNode` on the Saved
// Views query engine (`queryEngine.ts`) — the SAME closed-allow-list AST the
// saved-view builder emits, so a text query and a saved view share one
// evaluator (`evaluateFilter`) and one set of leaf resolvers. There is NO
// separate query runtime and NO evaluatable expression: the parser can only
// emit nodes already in the `FilterNode` union (SYNC-7 "not a database").
//
// Grammar (Slice A):
//   query   := or
//   or      := and ( "OR" and )*            // "OR" is uppercase-only (Obsidian
//   and     := factor+                      //   convention; lowercase "or" is a
//   factor  := "-" factor                   //   literal term). Implicit AND.
//            | "(" or ")"
//            | term
//   term    := prefix ":" value | phrase | word
//   prefix  ∈ { tag, path, content, file, task }   (unknown prefix → literal text)
//   phrase  := '"' … '"'                     // exactness tightens in Slice B
//
// Slice B (line:/section:/regex, exact-phrase adjacency) is a deferred follow-up
// (see the feature PRD). This parser is total: malformed input (unterminated
// quote/paren, dangling "-", unknown prefix) degrades to literal text and never
// throws — a search box must not reject a keystroke.

import type { FilterNode } from "./queryEngine";

/** Field operators backed by a cheap index/indices leaf (Slice A). An unknown
 *  prefix (`foo:`) is NOT here and parses as literal text. */
const KNOWN_OPERATORS = new Set(["tag", "path", "content", "file", "task"]);

type Token =
  | { readonly t: "lparen" }
  | { readonly t: "rparen" }
  | { readonly t: "or" }
  | { readonly t: "term"; readonly raw: string };

/** Split a query into tokens. Whitespace separates terms; parentheses are their
 *  own tokens; a double-quoted span (possibly unterminated) is consumed whole so
 *  its inner whitespace is preserved (`tag:"my tag"`, `"exact phrase"`). Bare
 *  uppercase `OR` becomes the boolean token; everything else is a `term`. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ t: "lparen" });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ t: "rparen" });
      i += 1;
      continue;
    }
    // Read one term run: until whitespace or a paren, but a '"' opens a quoted
    // span consumed to its closing '"' (or end of input if unterminated).
    let raw = "";
    while (i < n) {
      const ch = input[i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") break;
      if (ch === "(" || ch === ")") break;
      if (ch === '"') {
        raw += '"';
        i += 1;
        while (i < n && input[i] !== '"') {
          raw += input[i];
          i += 1;
        }
        if (i < n) {
          raw += '"'; // closing quote
          i += 1;
        }
        continue;
      }
      raw += ch;
      i += 1;
    }
    tokens.push(raw === "OR" ? { t: "or" } : { t: "term", raw });
  }
  return tokens;
}

/** Strip a leading and/or trailing `"` independently, so both `"exact"` and an
 *  unterminated `"exact` unwrap to `exact`. */
function unquote(s: string): string {
  let r = s;
  if (r.startsWith('"')) r = r.slice(1);
  if (r.endsWith('"')) r = r.slice(0, -1);
  return r;
}

/** A bare/quoted/unknown-prefix term → the full-text `search` leaf, with quotes
 *  stripped. The literal fallback for anything not a recognized operator. */
function literalSearch(raw: string): FilterNode {
  return { kind: "search", query: unquote(raw) };
}

/** Compile one term's raw text (negation already stripped by the caller) into a
 *  leaf. A recognized `prefix:value` maps to its operator leaf; everything else
 *  (no colon, unknown prefix, empty required value) is literal search text. */
function termToNode(raw: string): FilterNode {
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const prefix = raw.slice(0, colon).toLowerCase();
    if (KNOWN_OPERATORS.has(prefix)) {
      const value = unquote(raw.slice(colon + 1));
      switch (prefix) {
        case "task":
          // `task:` with no value = every note with a task item.
          return { kind: "hasTask", query: value === "" ? undefined : value };
        case "tag":
          return value === "" ? literalSearch(raw) : { kind: "hasTag", tag: value };
        case "path":
          return value === "" ? literalSearch(raw) : { kind: "inFolder", path: value };
        case "file":
          return value === "" ? literalSearch(raw) : { kind: "titleMatch", query: value };
        case "content":
          return value === "" ? literalSearch(raw) : { kind: "search", query: value };
      }
    }
    // Unknown prefix (`http://…`, `foo:bar`) → literal, quotes-aware.
  }
  return literalSearch(raw);
}

/** Recursion bound for {@link Parser.parseFactor}. Past this nesting depth the
 *  parser stops recursing and matches everything, rather than overflowing the JS
 *  stack on a pasted query (thousands of `(` or `-`). Real queries nest a handful
 *  deep; 64 is far above any legitimate use and far below the stack limit — it is
 *  what keeps parseQuery's "never throws" contract actually true. */
const MAX_PARSE_DEPTH = 64;

/** Recursive-descent parser over the token stream. Stateful cursor; every
 *  production tolerates a missing/misplaced token rather than throwing. */
class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token | undefined {
    return this.tokens[this.pos++];
  }

  /** or := and ( "OR" and )* */
  parseOr(): FilterNode {
    const parts: FilterNode[] = [this.parseAnd()];
    while (this.peek()?.t === "or") {
      this.next(); // consume OR
      parts.push(this.parseAnd());
    }
    return parts.length === 1 ? parts[0] : { kind: "or", children: parts };
  }

  /** and := factor+  (implicit AND of adjacent factors). Stops at OR / ) / eof.
   *  An empty run collapses to `all` (the query-engine n=0 identity). */
  private parseAnd(): FilterNode {
    const parts: FilterNode[] = [];
    for (;;) {
      const tok = this.peek();
      if (!tok || tok.t === "or" || tok.t === "rparen") break;
      parts.push(this.parseFactor());
    }
    if (parts.length === 0) return { kind: "all" };
    return parts.length === 1 ? parts[0] : { kind: "and", children: parts };
  }

  /** factor := "-" factor | "(" or ")" | term */
  private parseFactor(): FilterNode {
    // Pathological-nesting guard: `(` recurses (lparen → parseOr → parseAnd →
    // parseFactor) and a bare `-` recurses (→ parseFactor), so thousands of
    // either would overflow the JS stack and throw `RangeError` — which breaks
    // the "never throws" contract AND escapes synchronously past the palette's
    // `.catch`. Past MAX_PARSE_DEPTH, stop recursing: drain the remaining tokens
    // so the ascending loops terminate, and match everything (the n=0 identity).
    if (this.depth >= MAX_PARSE_DEPTH) {
      this.pos = this.tokens.length;
      return { kind: "all" };
    }
    this.depth++;
    try {
      const tok = this.next();
      if (!tok) return { kind: "all" }; // defensive; parseAnd guards the caller
      if (tok.t === "lparen") {
        const inner = this.parseOr();
        if (this.peek()?.t === "rparen") this.next(); // tolerate a missing ")"
        return inner;
      }
      if (tok.t === "rparen" || tok.t === "or") {
        // A stray ")" or "OR" in factor position — treat as empty (no-op).
        return { kind: "all" };
      }
      // term
      const raw = tok.raw;
      if (raw === "-") {
        // A bare "-" negates the FOLLOWING factor (handles `-(group)`, `- word`).
        const nxt = this.peek();
        if (!nxt || nxt.t === "or" || nxt.t === "rparen") {
          return literalSearch("-"); // nothing to negate → literal
        }
        return { kind: "not", child: this.parseFactor() };
      }
      if (raw.startsWith("-") && raw.length > 1) {
        return { kind: "not", child: termToNode(raw.slice(1)) };
      }
      return termToNode(raw);
    } finally {
      this.depth--;
    }
  }
}

/**
 * Parse a search string into a `FilterNode`. Total — never throws; malformed
 * input degrades to literal text. An empty/blank query yields the `all` leaf
 * (the palette handles the empty-query browse list separately).
 */
export function parseQuery(input: string): FilterNode {
  return new Parser(tokenize(input)).parseOr();
}

/**
 * Fast probe: does the query use any operator/boolean/phrase syntax? The command
 * palette keeps the exact BM25 `note_search` path for operator-free queries (no
 * regression for the common case) and only routes through {@link parseQuery} +
 * the filter engine when this is true.
 */
export function queryHasOperators(input: string): boolean {
  for (const tok of tokenize(input)) {
    if (tok.t !== "term") return true; // OR / ( / )
    const { raw } = tok;
    if (raw.startsWith("-")) return true; // negation
    if (raw.includes('"')) return true; // phrase
    const colon = raw.indexOf(":");
    if (colon > 0 && KNOWN_OPERATORS.has(raw.slice(0, colon).toLowerCase())) {
      return true; // field operator
    }
  }
  return false;
}
