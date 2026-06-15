// Unit tests for the `.base` reader + shape validation (Saved Views #6,
// MYND-276, task 1). The parse is pure (no IPC) so it's fully unit-testable;
// `readAndParseBase` wires the shipped `import_read_file` seam around it.

import { describe, expect, it } from "vitest";
import {
  BaseParseError,
  parseBaseSource,
  type ParsedBase,
} from "../../../src/notes/import/base/parseBase";

// A representative `.base` (shape from a real Obsidian Bases file): a cards view
// with a nested `and` filter, order/groupBy, cardSize, image, and a float
// imageAspectRatio, plus a `properties` display section.
const SAMPLE_BASE = `
properties:
  file.tags:
    displayName: Tags
views:
  - type: cards
    name: Books
    filters:
      and:
        - file.inFolder("2-AREAS/Content/Books")
        - file.name != "Watch List"
    groupBy:
      property: status
      direction: ASC
    order:
      - file.name
      - author
    cardSize: 300
    image: note.image
    imageAspectRatio: 1.65
`;

describe("parseBaseSource", () => {
  it("parses a representative .base to the expected typed object", () => {
    const parsed: ParsedBase = parseBaseSource(SAMPLE_BASE);
    expect(parsed.views).toHaveLength(1);
    const v = parsed.views[0]!;
    expect(v.type).toBe("cards");
    expect(v.name).toBe("Books");
    expect(v.cardSize).toBe(300);
    expect(v.image).toBe("note.image");
    expect(v.imageAspectRatio).toBe(1.65); // float preserved; stringified by the adapter
    expect(v.order).toEqual(["file.name", "author"]);
    expect(v.groupBy).toEqual({ property: "status", direction: "ASC" });
    // Nested boolean filter group preserved verbatim (parsed by the adapter).
    expect(v.filters).toEqual({
      and: ['file.inFolder("2-AREAS/Content/Books")', 'file.name != "Watch List"'],
    });
    // The `properties` display section is preserved opaquely.
    expect(parsed.properties).toBeDefined();
  });

  it("normalizes an absent `views` to an empty list (filters-only .base is legal)", () => {
    const parsed = parseBaseSource('filters:\n  and:\n    - status == "done"\n');
    expect(parsed.views).toEqual([]);
    expect(parsed.filters).toEqual({ and: ['status == "done"'] });
  });

  it("throws a closed BaseParseError on malformed YAML (no partial output)", () => {
    expect(() => parseBaseSource("views: [unclosed\n  - bad")).toThrow(
      BaseParseError,
    );
  });

  it("rejects a non-.base shape (none of the root sections)", () => {
    expect(() => parseBaseSource("title: just a note\nbody: hello\n")).toThrow(
      BaseParseError,
    );
  });

  it("rejects an empty document", () => {
    expect(() => parseBaseSource("# only a comment\n")).toThrow(BaseParseError);
  });

  it("rejects a non-mapping top level", () => {
    expect(() => parseBaseSource('"just a string"')).toThrow(BaseParseError);
  });

  it("rejects `views` that is not a list", () => {
    expect(() => parseBaseSource("views:\n  type: cards\n")).toThrow(
      BaseParseError,
    );
  });

  it("rejects a view without a string `type`", () => {
    expect(() => parseBaseSource("views:\n  - name: NoType\n")).toThrow(
      BaseParseError,
    );
  });
});
