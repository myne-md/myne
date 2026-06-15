// Unit tests for `src/notes/setNoteCover.ts` — set / clear a note's cover-image
// frontmatter property without opening it. Mirrors `moveNote.test.ts`: route the
// `note_read` → `note_update` IPC pair through a mocked `invoke`, assert the
// patched body, and stub the best-effort reindex.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// The reindex is best-effort fire-and-forget; stub it so the test doesn't depend
// on the live index slice.
const reindexMock = vi.fn(() => Promise.resolve());
vi.mock("../../src/notes/vaultIndices", () => ({
  reindexNoteFromBody: (...args: unknown[]) => reindexMock(...args),
}));

import { setNoteCover } from "../../src/notes/setNoteCover";

beforeEach(() => {
  invokeMock.mockReset();
  reindexMock.mockReset();
  reindexMock.mockReturnValue(Promise.resolve());
});
afterEach(() => invokeMock.mockReset());

function routeReadThenUpdate(read: string): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve(read);
    if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

function lastUpdateBody(): string {
  const call = invokeMock.mock.calls.find(
    ([cmd]) => cmd === "plugin:notes|note_update",
  );
  return (call?.[1] as { plaintext: string }).plaintext;
}

describe("setNoteCover — set", () => {
  it("writes a form-C embed into the cover property and bumps updated:", async () => {
    routeReadThenUpdate("# Hello\nbody\n");
    await setNoteCover("note-1", "cover", { id: "abc123", filename: "pic.png" });

    const body = lastUpdateBody();
    // The cover value is a quoted form-C embed (carries `[`, needs quoting).
    expect(body).toContain('cover: "![[att:abc123|pic.png]]"');
    // `updated:` is stamped (move/cover are modifications).
    expect(body).toMatch(/updated:/);
    // Re-index fired for the same note with the patched body.
    expect(reindexMock).toHaveBeenCalledWith("note-1", body);
  });

  it("writes into an existing FM block, preserving the title", async () => {
    routeReadThenUpdate("---\ntitle: Foo\n---\n\nbody");
    await setNoteCover("n", "cover", { id: "deadbeef", filename: "c.jpg" });
    const body = lastUpdateBody();
    expect(body).toContain("title: Foo");
    expect(body).toContain('cover: "![[att:deadbeef|c.jpg]]"');
  });

  it("uses the given property key (not hard-coded to cover)", async () => {
    routeReadThenUpdate("body");
    await setNoteCover("n", "banner", { id: "id1", filename: "b.png" });
    expect(lastUpdateBody()).toContain('banner: "![[att:id1|b.png]]"');
  });
});

describe("setNoteCover — clear", () => {
  it("deletes the cover property when attachment is null", async () => {
    routeReadThenUpdate("---\ntitle: Foo\ncover: x\n---\n\nbody");
    await setNoteCover("n", "cover", null);
    const body = lastUpdateBody();
    expect(body).not.toContain("cover:");
    expect(body).toContain("title: Foo");
  });
});
