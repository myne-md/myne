// Tests for the curated code-language registry + alias resolver (MYND-154 task 1).
// Pure resolver tests — `load()` (dynamic import of the lang packs) is never
// invoked here, so these run fast in the node env.

import { describe, it, expect } from "vitest";
import { CODE_LANGUAGES, resolveCodeLanguage } from "../../src/editor/code-languages";

describe("resolveCodeLanguage — baseline languages", () => {
  it("resolves all ten baseline languages by canonical name", () => {
    for (const name of [
      "javascript",
      "typescript",
      "rust",
      "python",
      "bash",
      "json",
      "yaml",
      "html",
      "css",
      "diff",
    ]) {
      expect(resolveCodeLanguage(name)?.name).toBe(name);
    }
  });

  it("registers TS/JSX/TSX as descriptors (all backed by lang-javascript)", () => {
    const names = new Set(CODE_LANGUAGES.map((l) => l.name));
    expect(names.has("typescript")).toBe(true);
    expect(names.has("jsx")).toBe(true);
    expect(names.has("tsx")).toBe(true);
  });
});

describe("resolveCodeLanguage — aliases + case", () => {
  it.each([
    ["js", "javascript"],
    ["node", "javascript"],
    ["JS", "javascript"],
    ["ts", "typescript"],
    ["tsx", "tsx"],
    ["jsx", "jsx"],
    ["rs", "rust"],
    ["py", "python"],
    ["python3", "python"],
    ["yml", "yaml"],
    ["sh", "bash"],
    ["shell", "bash"],
    ["zsh", "bash"],
    ["htm", "html"],
    ["patch", "diff"],
  ])("maps %s -> %s", (tag, expected) => {
    expect(resolveCodeLanguage(tag)?.name).toBe(expected);
  });

  it("is case-insensitive across the board", () => {
    expect(resolveCodeLanguage("Rust")?.name).toBe("rust");
    expect(resolveCodeLanguage("PYTHON")?.name).toBe("python");
    expect(resolveCodeLanguage("YmL")?.name).toBe("yaml");
  });

  it("matches only the first whitespace-delimited token of the info string", () => {
    expect(resolveCodeLanguage("bash   install step")?.name).toBe("bash");
    expect(resolveCodeLanguage("  rust ")?.name).toBe("rust");
  });
});

describe("resolveCodeLanguage — no fallback guess", () => {
  it.each(["foober", "rsut", "c++17", "brainfuck", "", "   "])(
    "returns null for unknown/empty tag %j",
    (tag) => {
      expect(resolveCodeLanguage(tag)).toBeNull();
    },
  );
});
