// Search query-language parser tests (MYND-303 field operators + MYND-307
// boolean/phrase). The parser is a PURE `string -> FilterNode` compiler — no
// IPC, no resolvers — so these assert the AST shape directly. The evaluator that
// consumes the AST is covered by `queryEngine.test.ts`; here we pin the grammar,
// operator mapping, precedence, negation, phrase handling, and the total
// (never-throws) degradation of malformed input.

import { describe, expect, it } from "vitest";
import type { FilterNode } from "../../src/notes/queryEngine";
import { parseQuery, queryHasOperators } from "../../src/notes/queryParser";

const search = (query: string): FilterNode => ({ kind: "search", query });

describe("parseQuery — bare terms & implicit AND", () => {
  it("a single bare word is a search leaf", () => {
    expect(parseQuery("rust")).toEqual(search("rust"));
  });

  it("two bare words are AND-ed", () => {
    expect(parseQuery("rust async")).toEqual({
      kind: "and",
      children: [search("rust"), search("async")],
    });
  });

  it("an empty / blank query is the `all` leaf", () => {
    expect(parseQuery("")).toEqual({ kind: "all" });
    expect(parseQuery("   ")).toEqual({ kind: "all" });
  });
});

describe("parseQuery — field operators (MYND-303)", () => {
  it("tag: → hasTag", () => {
    expect(parseQuery("tag:work")).toEqual({ kind: "hasTag", tag: "work" });
  });

  it("path: → inFolder", () => {
    expect(parseQuery("path:projects/")).toEqual({
      kind: "inFolder",
      path: "projects/",
    });
  });

  it("content: → search", () => {
    expect(parseQuery("content:invoice")).toEqual(search("invoice"));
  });

  it("file: → titleMatch", () => {
    expect(parseQuery("file:readme")).toEqual({
      kind: "titleMatch",
      query: "readme",
    });
  });

  it("task: with a value → hasTask carrying the query", () => {
    expect(parseQuery("task:review")).toEqual({
      kind: "hasTask",
      query: "review",
    });
  });

  it("bare task: → hasTask with no query (every note with a task)", () => {
    expect(parseQuery("task:")).toEqual({ kind: "hasTask", query: undefined });
  });

  it("is case-insensitive on the operator prefix", () => {
    expect(parseQuery("TAG:work")).toEqual({ kind: "hasTag", tag: "work" });
  });

  it("an unknown prefix is literal search text (not an operator)", () => {
    expect(parseQuery("foo:bar")).toEqual(search("foo:bar"));
  });

  it("a URL is not mistaken for an operator", () => {
    expect(parseQuery("https://myne.md")).toEqual(search("https://myne.md"));
  });

  it("an operator with an empty value degrades to literal text", () => {
    expect(parseQuery("tag:")).toEqual(search("tag:"));
  });
});

describe("parseQuery — negation (MYND-307)", () => {
  it("-word → not(search)", () => {
    expect(parseQuery("-draft")).toEqual({ kind: "not", child: search("draft") });
  });

  it("-tag:x → not(hasTag)", () => {
    expect(parseQuery("-tag:archive")).toEqual({
      kind: "not",
      child: { kind: "hasTag", tag: "archive" },
    });
  });

  it("combines with AND: rust -draft", () => {
    expect(parseQuery("rust -draft")).toEqual({
      kind: "and",
      children: [search("rust"), { kind: "not", child: search("draft") }],
    });
  });

  it("a bare '-' negates the following group", () => {
    expect(parseQuery("-(tag:a tag:b)")).toEqual({
      kind: "not",
      child: {
        kind: "and",
        children: [
          { kind: "hasTag", tag: "a" },
          { kind: "hasTag", tag: "b" },
        ],
      },
    });
  });
});

describe("parseQuery — OR & grouping (MYND-307)", () => {
  it("uppercase OR → or node", () => {
    expect(parseQuery("cats OR dogs")).toEqual({
      kind: "or",
      children: [search("cats"), search("dogs")],
    });
  });

  it("lowercase 'or' is a literal term, NOT the operator", () => {
    expect(parseQuery("cats or dogs")).toEqual({
      kind: "and",
      children: [search("cats"), search("or"), search("dogs")],
    });
  });

  it("AND binds tighter than OR: a OR b c", () => {
    expect(parseQuery("a OR b c")).toEqual({
      kind: "or",
      children: [
        search("a"),
        { kind: "and", children: [search("b"), search("c")] },
      ],
    });
  });

  it("parentheses override precedence: (a OR b) c", () => {
    expect(parseQuery("(a OR b) c")).toEqual({
      kind: "and",
      children: [
        { kind: "or", children: [search("a"), search("b")] },
        search("c"),
      ],
    });
  });

  it("a full mixed query compiles to the expected tree", () => {
    expect(parseQuery('tag:work OR (path:proj/ -draft)')).toEqual({
      kind: "or",
      children: [
        { kind: "hasTag", tag: "work" },
        {
          kind: "and",
          children: [
            { kind: "inFolder", path: "proj/" },
            { kind: "not", child: search("draft") },
          ],
        },
      ],
    });
  });
});

describe("parseQuery — quoted phrases", () => {
  it('"exact phrase" → search with the phrase, quotes stripped', () => {
    expect(parseQuery('"release notes"')).toEqual(search("release notes"));
  });

  it("a quoted operator value keeps its inner whitespace", () => {
    expect(parseQuery('tag:"my tag"')).toEqual({ kind: "hasTag", tag: "my tag" });
  });

  it("a phrase composes under AND with a bare term", () => {
    expect(parseQuery('rust "async runtime"')).toEqual({
      kind: "and",
      children: [search("rust"), search("async runtime")],
    });
  });
});

describe("parseQuery — malformed input never throws", () => {
  it("an unterminated quote degrades to a literal search", () => {
    expect(() => parseQuery('"foo bar')).not.toThrow();
    expect(parseQuery('"foo bar')).toEqual(search("foo bar"));
  });

  it("an unterminated paren still parses its contents", () => {
    expect(() => parseQuery("(tag:a tag:b")).not.toThrow();
    expect(parseQuery("(tag:a tag:b")).toEqual({
      kind: "and",
      children: [
        { kind: "hasTag", tag: "a" },
        { kind: "hasTag", tag: "b" },
      ],
    });
  });

  it("a stray closing paren is ignored", () => {
    expect(() => parseQuery("rust)")).not.toThrow();
    expect(parseQuery("rust)")).toEqual(search("rust"));
  });

  it("a trailing dangling '-' is literal, not a crash", () => {
    expect(() => parseQuery("rust -")).not.toThrow();
    expect(parseQuery("rust -")).toEqual({
      kind: "and",
      children: [search("rust"), search("-")],
    });
  });

  it("pathological paren nesting does not overflow the stack (depth guard)", () => {
    // Thousands of "(" recurse (lparen → parseOr → parseAnd → parseFactor); an
    // unbounded recursive descent throws RangeError on this pasted input. The
    // depth guard drains past MAX_PARSE_DEPTH and returns a node instead — this
    // is exactly the input the "never throws" contract must survive.
    const deep = "(".repeat(5000) + "tag:a" + ")".repeat(5000);
    expect(() => parseQuery(deep)).not.toThrow();
    expect(parseQuery(deep)).toHaveProperty("kind");
  });

  it("a long run of bare '-' does not overflow the stack (depth guard)", () => {
    // Each leading "-" negates the following factor, recursing once per dash.
    expect(() => parseQuery("- ".repeat(5000) + "x")).not.toThrow();
  });
});

describe("queryHasOperators — the palette fast-path probe", () => {
  it("plain queries have no operators (palette keeps the BM25 path)", () => {
    expect(queryHasOperators("rust async runtime")).toBe(false);
    expect(queryHasOperators("")).toBe(false);
    expect(queryHasOperators("cats or dogs")).toBe(false); // lowercase or
  });

  it("field operators, booleans, negation, grouping & phrases are detected", () => {
    expect(queryHasOperators("tag:work")).toBe(true);
    expect(queryHasOperators("file:readme")).toBe(true);
    expect(queryHasOperators("task:")).toBe(true);
    expect(queryHasOperators("cats OR dogs")).toBe(true);
    expect(queryHasOperators("-draft")).toBe(true);
    expect(queryHasOperators("(a b)")).toBe(true);
    expect(queryHasOperators('"exact phrase"')).toBe(true);
  });

  it("an unknown prefix is NOT treated as an operator", () => {
    expect(queryHasOperators("foo:bar")).toBe(false);
    expect(queryHasOperators("https://myne.md")).toBe(false);
  });
});
