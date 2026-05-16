// Unit tests for `src/notes/renameNote.ts`. Verifies the β mirror-
// existing decision tree end-to-end (FM-title / H1-only / neither /
// both-exist) and that `updated:` always refreshes after rename.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { renameNote } from "../../src/notes/renameNote";

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  invokeMock.mockReset();
});

function lastUpdateBody(): string {
  const [, args] = invokeMock.mock.calls[0] ?? [];
  return (args as { plaintext: string }).plaintext;
}

describe("renameNote — FM-title source-of-truth", () => {
  it("updates FM `title:` when frontmatter has the field", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const input =
      "---\ntitle: Old Title\ntags: [a]\n---\n\nbody content\n";
    await renameNote("id-1", input, "New Title");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const body = lastUpdateBody();
    expect(body).toContain("title: New Title");
    expect(body).toContain("tags: [a]");
    expect(body).toContain("\nbody content\n");
    expect(body).not.toContain("Old Title");
  });

  it("both-exist edge: prefers FM `title:` over body `# H1` (Q7 rule)", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const input =
      "---\ntitle: Old FM\n---\n\n# Old H1\nbody\n";
    await renameNote("id-2", input, "New Title");

    const body = lastUpdateBody();
    expect(body).toContain("title: New Title");
    // Body H1 left intact (static per Q7 both-exist edge rule).
    expect(body).toContain("# Old H1");
  });
});

describe("renameNote — H1-only source-of-truth", () => {
  it("updates body `# H1` when no FM `title:` is present", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const input = "# Old Heading\nbody text\n";
    await renameNote("id-3", input, "New Heading");

    const body = lastUpdateBody();
    expect(body).toContain("# New Heading");
    expect(body).toContain("body text\n");
    expect(body).not.toContain("# Old Heading");
  });

  it("updates body `# H1` when FM exists but lacks `title:` key", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const input = "---\ntags: [a]\n---\n\n# Old H1\nbody\n";
    await renameNote("id-4", input, "New H1");

    const body = lastUpdateBody();
    expect(body).toContain("# New H1");
    // FM block left untouched (no `title:` injection).
    expect(body).toContain("tags: [a]");
    expect(body).not.toMatch(/title:/);
  });
});

describe("renameNote — neither source-of-truth (state-A inject)", () => {
  it("prepends FM with `title:` when neither FM-title nor body H1 exist", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const input = "just body content\nno headings\n";
    await renameNote("id-5", input, "New Note");

    const body = lastUpdateBody();
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain("title: New Note");
    expect(body).toContain("just body content");
  });
});

describe("renameNote — updated: side-effect", () => {
  it("always refreshes `updated:` after the rename surgery", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const input =
      "---\ntitle: T\nupdated: 2020-01-01T00:00:00Z\n---\n\nbody\n";
    await renameNote("id-6", input, "Renamed");

    const body = lastUpdateBody();
    expect(body).toContain("title: Renamed");
    expect(body).not.toContain("2020-01-01T00:00:00Z");
    expect(body).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
  });

  it("injects `updated:` even when no FM previously existed", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const input = "# Old\nbody\n";
    await renameNote("id-7", input, "Renamed");

    const body = lastUpdateBody();
    expect(body).toContain("# Renamed");
    // FM block injected by patchUpdatedField (state-A).
    expect(body).toMatch(/^---\nupdated: \d{4}-\d{2}-\d{2}T/);
  });
});

describe("renameNote — error propagation", () => {
  it("rejects with the IPC error when `note_update` rejects", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "VaultNotUnlocked" });
    await expect(renameNote("id-x", "# H1\n", "New")).rejects.toMatchObject({
      kind: "VaultNotUnlocked",
    });
  });
});
