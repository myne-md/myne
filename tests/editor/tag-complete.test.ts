// Inline #tag autocomplete source (tag-system / MYND-45). Suggests existing tags
// for a `#` prefix; quiet at a bare `#` (heading), mid-word `#`, or no match.

import { describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { CompletionContext } from "@codemirror/autocomplete";

// The completion source reads tags via the host bridge (getHost().notes.tagTree)
// post-extraction, so mock the bridge the module imports, not the desktop index.
vi.mock("@myne/editor/host/notes/vaultIndices", () => ({
  isMediaTarget: () => false,
  tagTree: vi.fn(async () => [
    { key: "editor", display: "Editor", depth: 0, directCount: 2, subtreeCount: 2 },
    { key: "markdown", display: "Markdown", depth: 0, directCount: 1, subtreeCount: 1 },
    { key: "edge-case", display: "edge-case", depth: 0, directCount: 1, subtreeCount: 1 },
  ]),
}));

import { tagCompletionSource } from "../../src/editor/tag-complete";

async function complete(doc: string, pos: number, explicit = false) {
  const state = EditorState.create({ doc });
  return tagCompletionSource(new CompletionContext(state, pos, explicit));
}

describe("tag completion source", () => {
  it("offers matching existing tags for '#ed' and applies the display text", async () => {
    const res = await complete("#ed", 3);
    expect(res).not.toBeNull();
    const labels = res!.options.map((o) => o.label);
    expect(labels).toContain("#Editor");
    expect(labels).toContain("#edge-case"); // substring 'ed' matches too
    expect(labels).not.toContain("#Markdown");
    const editor = res!.options.find((o) => o.label === "#Editor");
    expect(editor!.apply).toBe("#Editor"); // inserts display casing verbatim
    expect(res!.from).toBe(0);
    expect(res!.to).toBe(3);
  });

  it("folds case (Turkish-safe) — '#ED' still matches #Editor", async () => {
    const res = await complete("#ED", 3);
    expect(res!.options.map((o) => o.label)).toContain("#Editor");
  });

  it("is quiet for a bare '#' (non-explicit) — e.g. an ATX heading", async () => {
    expect(await complete("# ", 1)).toBeNull();
  });

  it("is quiet mid-word ('word#frag' is not a tag)", async () => {
    expect(await complete("word#ed", 7)).toBeNull();
  });

  it("returns null when nothing matches", async () => {
    expect(await complete("#zzqqxx", 7)).toBeNull();
  });
});
