import { describe, expect, it } from "vitest";
import {
  SEARCH_OPERATORS,
  completeOperator,
  completeValue,
  searchOperatorSuggestions,
  searchValueSuggestions,
  trailingToken,
} from "../../src/notes/searchSuggest";
import { KNOWN_OPERATORS } from "../../src/notes/queryParser";

describe("searchSuggest — trailingToken", () => {
  it("returns the trailing run of non-space, non-paren chars", () => {
    expect(trailingToken("tag")).toBe("tag");
    expect(trailingToken("rele tag")).toBe("tag");
    expect(trailingToken("tag:wo")).toBe("tag:wo");
  });
  it("is empty on a blank / whitespace- / paren-terminated query", () => {
    expect(trailingToken("")).toBe("");
    expect(trailingToken("hello ")).toBe("");
    expect(trailingToken("(")).toBe("");
  });
});

describe("searchSuggest — searchOperatorSuggestions", () => {
  it("suggests every operator whose name starts with the partial token", () => {
    expect(searchOperatorSuggestions("ta").map((o) => o.op)).toEqual(["tag", "task"]);
    expect(searchOperatorSuggestions("p").map((o) => o.op)).toEqual(["path"]);
    expect(searchOperatorSuggestions("c").map((o) => o.op)).toEqual(["content"]);
  });
  it("suggests the exact operator so it can still be Tab-completed to `op:`", () => {
    expect(searchOperatorSuggestions("tag").map((o) => o.op)).toEqual(["tag"]);
  });
  it("suggests nothing once a colon is present (operator already chosen)", () => {
    expect(searchOperatorSuggestions("tag:")).toEqual([]);
    expect(searchOperatorSuggestions("tag:work")).toEqual([]);
  });
  it("suggests nothing for a plain word or a blank/space-terminated query", () => {
    expect(searchOperatorSuggestions("release")).toEqual([]);
    expect(searchOperatorSuggestions("")).toEqual([]);
    expect(searchOperatorSuggestions("hello ")).toEqual([]);
  });
  it("only offers operators the parser actually routes (no dead completion)", () => {
    for (const o of SEARCH_OPERATORS) {
      expect(KNOWN_OPERATORS.has(o.op)).toBe(true);
    }
  });
});

describe("searchSuggest — completeOperator", () => {
  it("completes the trailing partial to `<op>:`, preserving the head", () => {
    expect(completeOperator("ta", "tag")).toBe("tag:");
    expect(completeOperator("ta", "task")).toBe("task:");
    expect(completeOperator("rele tag", "tag")).toBe("rele tag:");
  });
});

const SOURCES = {
  tags: ["work", "personal", "work-log"],
  folders: ["Inbox/", "Projects/Myne/"],
};

describe("searchSuggest — searchValueSuggestions", () => {
  it("suggests tags matching the partial after `tag:`", () => {
    expect(searchValueSuggestions("tag:wo", SOURCES)?.values).toEqual([
      "work",
      "work-log",
    ]);
  });
  it("suggests folders after `path:` (substring, case-insensitive)", () => {
    expect(searchValueSuggestions("path:myne", SOURCES)?.values).toEqual([
      "Projects/Myne/",
    ]);
  });
  it("offers no value dropdown for free-text operators", () => {
    expect(searchValueSuggestions("content:foo", SOURCES)).toBeNull();
    expect(searchValueSuggestions("task:foo", SOURCES)).toBeNull();
    expect(searchValueSuggestions("file:foo", SOURCES)).toBeNull();
  });
  it("returns null when nothing matches or no colon is present", () => {
    expect(searchValueSuggestions("tag:zzz", SOURCES)).toBeNull();
    expect(searchValueSuggestions("tag", SOURCES)).toBeNull();
  });
});

describe("searchSuggest — completeValue", () => {
  it("completes `<op>:<partial>` to the chosen value, quoting spaces", () => {
    expect(completeValue("tag:wo", "tag", "work")).toBe("tag:work");
    expect(completeValue("rele tag:", "tag", "my tag")).toBe('rele tag:"my tag"');
  });
});
