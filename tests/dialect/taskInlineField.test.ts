// Inline task-field recognizer — parser-level node-emission tests (MYND-611, task 1).
//
// The recognizer emits nodes only; it never types a value (that is task 2) and never
// writes bytes (task 3). What is asserted here is exactly that boundary: the bracketed
// Dataview-style form and the Obsidian emoji form both produce a locatable `TaskField`
// with key and value children, and nothing that merely *looks* like one does.
//
// The exclusion cases are the load-bearing half. `[key:: value]` collides with CommonMark
// link syntax, so the config is registered `before: "Link"` (the footnote/wikilink
// precedent) — and a recognizer that outranks link parsing has to be proven not to fire
// inside code, wikilink interiors, HTML, or frontmatter, where the source is verbatim.

import { describe, expect, it } from "vitest";
import { parser } from "../../src/dialect/lezer/parser";
import { parse } from "../../src/dialect/parse";

interface NodeRec {
  name: string;
  from: number;
  to: number;
  text: string;
}

function nodes(source: string): NodeRec[] {
  const tree = parser.parse(source);
  const out: NodeRec[] = [];
  tree.iterate({
    enter: (n) => {
      out.push({ name: n.name, from: n.from, to: n.to, text: source.slice(n.from, n.to) });
    },
  });
  return out;
}

function taskFields(source: string): NodeRec[] {
  return nodes(source).filter((n) => n.name === "TaskField");
}

/** Key/value pairs of every TaskField in `source`, in document order. */
function fields(source: string): { key: string; value: string }[] {
  const tree = parser.parse(source);
  const out: { key: string; value: string }[] = [];
  tree.iterate({
    enter: (n) => {
      if (n.name !== "TaskField") return;
      let key = "";
      let value = "";
      for (let c = n.node.firstChild; c; c = c.nextSibling) {
        if (c.name === "TaskFieldKey") key = source.slice(c.from, c.to);
        if (c.name === "TaskFieldValue") value = source.slice(c.from, c.to);
      }
      out.push({ key, value });
    },
  });
  return out;
}

describe("bracketed Dataview-style form", () => {
  it("parses [due:: 2026-08-01] as a field node with key and value children", () => {
    const src = "- [ ] pay rent [due:: 2026-08-01]";
    expect(fields(src)).toEqual([{ key: "due", value: "2026-08-01" }]);
  });

  it("locates the field node over exactly the bracketed span", () => {
    const src = "- [ ] pay rent [due:: 2026-08-01]";
    const f = taskFields(src);
    expect(f).toHaveLength(1);
    expect(f[0].text).toBe("[due:: 2026-08-01]");
  });

  it("parses every written field key", () => {
    const src =
      "- [ ] x [due:: 2026-08-01] [repeat:: every week] [done:: 2026-07-30] [priority:: high] [remind:: 2026-07-29 09:00]";
    expect(fields(src)).toEqual([
      { key: "due", value: "2026-08-01" },
      { key: "repeat", value: "every week" },
      { key: "done", value: "2026-07-30" },
      { key: "priority", value: "high" },
      { key: "remind", value: "2026-07-29 09:00" },
    ]);
  });

  it("recognizes unsupported-but-preserved keys as fields too (typing is task 2's job)", () => {
    const src = "- [ ] x [scheduled:: 2026-08-05] [id:: abc123]";
    expect(fields(src)).toEqual([
      { key: "scheduled", value: "2026-08-05" },
      { key: "id", value: "abc123" },
    ]);
  });

  it("tolerates absent and extra spacing around the separator", () => {
    expect(fields("- [ ] x [due::2026-08-01]")).toEqual([{ key: "due", value: "2026-08-01" }]);
    expect(fields("- [ ] x [due::   2026-08-01]")).toEqual([{ key: "due", value: "2026-08-01" }]);
  });

  it("does not produce an empty-key or unterminated field", () => {
    expect(taskFields("- [ ] x [:: 2026-08-01]")).toHaveLength(0);
    expect(taskFields("- [ ] x [due:: 2026-08-01")).toHaveLength(0);
  });
});

describe("emoji form", () => {
  it("parses the due emoji marker as a field node", () => {
    const src = "- [ ] pay rent 📅 2026-08-01";
    expect(fields(src)).toEqual([{ key: "📅", value: "2026-08-01" }]);
  });

  it("parses a recurrence emoji whose value is prose", () => {
    const src = "- [ ] water plants 🔁 every 3 days";
    expect(fields(src)).toEqual([{ key: "🔁", value: "every 3 days" }]);
  });

  it("splits consecutive emoji markers into separate fields", () => {
    const src = "- [ ] x 🔁 every day 📅 2026-08-01 ✅ 2026-07-27";
    expect(fields(src)).toEqual([
      { key: "🔁", value: "every day" },
      { key: "📅", value: "2026-08-01" },
      { key: "✅", value: "2026-07-27" },
    ]);
  });

  it("parses a valueless priority emoji as a field with an empty value", () => {
    const src = "- [ ] urgent thing ⏫";
    expect(fields(src)).toEqual([{ key: "⏫", value: "" }]);
  });

  it("recognizes both forms on one line", () => {
    const src = "- [ ] x 📅 2026-08-01 [priority:: high]";
    expect(fields(src)).toEqual([
      { key: "📅", value: "2026-08-01" },
      { key: "priority", value: "high" },
    ]);
  });
});

describe("things that must not become fields", () => {
  it("leaves a dangling [label] with no matching definition alone", () => {
    const src = "see [label] for details";
    expect(taskFields(src)).toHaveLength(0);
  });

  it("leaves an ordinary link alone", () => {
    const src = "see [the docs](https://example.com) for details";
    expect(taskFields(src)).toHaveLength(0);
  });

  it("does not disturb #tag parsing", () => {
    const src = "- [ ] x #chores [due:: 2026-08-01]";
    const names = nodes(src).map((n) => n.name);
    expect(names).toContain("InlineTag");
    expect(fields(src)).toEqual([{ key: "due", value: "2026-08-01" }]);
  });

  it("does not fire inside a code span", () => {
    expect(taskFields("- [ ] x `[due:: 2026-08-01]`")).toHaveLength(0);
    expect(taskFields("- [ ] x `📅 2026-08-01`")).toHaveLength(0);
  });

  it("does not fire inside a fenced code block", () => {
    const src = "```\n- [ ] x [due:: 2026-08-01] 📅 2026-08-02\n```\n";
    expect(taskFields(src)).toHaveLength(0);
  });

  it("does not fire inside a wikilink interior", () => {
    expect(taskFields("- [ ] see [[note [due:: 2026-08-01]]]")).toHaveLength(0);
  });

  it("leaves a trailing #tag out of an emoji field's value", () => {
    const src = "- [ ] x 📅 2026-08-01 #chores";
    expect(fields(src)).toEqual([{ key: "📅", value: "2026-08-01" }]);
    expect(nodes(src).map((n) => n.name)).toContain("InlineTag");
  });

  it("does not fire inside an HTML block", () => {
    const src = "<div>\n[due:: 2026-08-01] 📅 2026-08-02\n</div>\n";
    expect(taskFields(src)).toHaveLength(0);
  });

  it("does not turn the :calendar: emoji shortcode into a field", () => {
    const src = "- [ ] x :calendar: 2026-08-01";
    expect(taskFields(src)).toHaveLength(0);
  });
});

describe("scope of recognition — a deliberate limit the consumers must honour", () => {
  // The recognizer has no view of the enclosing block: `parseInline` runs inside a
  // task-list item's content, and the `- [ ]` marker is outside that inline scope.
  // So an emoji marker is recognized on ANY line, exactly as `#tag` and wikilinks
  // are. Restricting fields to line-tasks is therefore the *consumer's* job —
  // task 2 when it builds the index record, task 4 before it renders a chip.
  // Written down as a test rather than left as a surprise: without it, prose like
  // "shipped it ✅ today" would grow a chip in the editor.
  it("recognizes an emoji marker outside a task line too", () => {
    expect(fields("shipped it ✅ 2026-07-27")).toEqual([{ key: "✅", value: "2026-07-27" }]);
  });

  it("recognizes a bracketed field outside a task line too", () => {
    expect(fields("a note [due:: 2026-08-01]")).toEqual([{ key: "due", value: "2026-08-01" }]);
  });
});

describe("frontmatter", () => {
  // Lezer has no Frontmatter node — its body parser sees the YAML lines as
  // paragraphs / Setext headings, so every inline recognizer fires in there and
  // the exclusion happens one layer up, in `parse()`'s `filterOutsideFrontmatter`
  // (see the comment at dialect/src/parse.ts:23). Headings, wikilinks, inline
  // tags and media refs all work this way. A task field is no different, and
  // pretending otherwise here would mean inventing a second, divergent mechanism.
  it("emits inside frontmatter exactly like every other inline node does", () => {
    const src = "---\nsummary: [due:: 2026-08-01] #tag\n---\n\nbody\n";
    const names = nodes(src).map((n) => n.name);
    expect(names).toContain("InlineTag"); // the established precedent
    expect(names).toContain("TaskField"); // the new node behaves identically
  });

  it("is filtered out of the aggregator's result for the precedent nodes", () => {
    const src = "---\nsummary: [due:: 2026-08-01] #tag\n---\n\nbody\n";
    // The existing filter already keeps frontmatter tags out of `parse()`.
    // Task 2 (indexing) must route task fields through the same filter.
    expect(parse(src).inlineTags).toHaveLength(0);
  });
});

describe("recognizer discipline", () => {
  it("never mutates source bytes", () => {
    const sources = [
      "- [ ] pay rent [due:: 2026-08-01]",
      "- [ ] water plants 🔁 every 3 days 📅 2026-08-01",
      "see [label] for details",
      "```\n[due:: 2026-08-01]\n```\n",
    ];
    for (const src of sources) {
      const tree = parser.parse(src);
      expect(tree.length).toBe(src.length);
    }
  });
});
