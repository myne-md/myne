// Unit tests for `src/notes/loadNoteBatch.ts`. Mocks the Tauri `invoke`
// shim so tests run under Node without the desktop runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  NOTE_TITLES_BATCH_CAP,
  loadNoteBatch,
} from "../../src/notes/loadNoteBatch";

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  invokeMock.mockReset();
});

describe("loadNoteBatch — empty input", () => {
  it("returns [] without invoking the backend", async () => {
    const result = await loadNoteBatch([]);
    expect(result).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("loadNoteBatch — chunking + parallel dispatch", () => {
  it("sends a single chunk when ids.length <= cap", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        Ok: {
          note_uuid: "00000000-0000-7000-8000-000000000001",
          frontmatter_bytes: null,
          first_h1_line: null,
        },
      },
    ]);
    const ids = ["00000000-0000-7000-8000-000000000001"];
    await loadNoteBatch(ids);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:notes|note_titles_batch",
      { ids },
    );
  });

  it("splits >cap input into multiple parallel invokes preserving order", async () => {
    const totalCount = NOTE_TITLES_BATCH_CAP + 5; // 105
    const ids = Array.from(
      { length: totalCount },
      (_, i) => `00000000-0000-7000-8000-${i.toString().padStart(12, "0")}`,
    );

    // Each chunk returns a per-item Ok with the matching note_uuid.
    invokeMock.mockImplementation(
      (_cmd: string, args: { ids: string[] }) =>
        Promise.resolve(
          args.ids.map((id) => ({
            Ok: { note_uuid: id, frontmatter_bytes: null, first_h1_line: null },
          })),
        ),
    );

    const out = await loadNoteBatch(ids);

    // Two chunks: 100 + 5.
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(totalCount);
    out.forEach((rec, i) => {
      expect(rec.noteUuid).toBe(ids[i]);
    });
  });
});

describe("loadNoteBatch — title derivation (frontmatter `title:` only)", () => {
  it("derives the title from the frontmatter `title:` field", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        Ok: {
          note_uuid: "id-1",
          frontmatter_bytes: "title: FM Title\n",
          first_h1_line: "# H1 Ignored",
        },
      },
    ]);
    const [rec] = await loadNoteBatch(["id-1"]);
    expect(rec.title).toBe("FM Title");
  });

  it("yields null when frontmatter has no title field (no H1 fallback)", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        Ok: {
          note_uuid: "id-2",
          frontmatter_bytes: "tags: [a, b]\n",
          first_h1_line: "# H1 Title",
        },
      },
    ]);
    const [rec] = await loadNoteBatch(["id-2"]);
    expect(rec.title).toBeNull();
  });

  it("yields null when no frontmatter present (no H1 fallback)", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        Ok: {
          note_uuid: "id-3",
          frontmatter_bytes: null,
          first_h1_line: "# H1 Title",
        },
      },
    ]);
    const [rec] = await loadNoteBatch(["id-3"]);
    expect(rec.title).toBeNull();
  });

  it("treats malformed YAML frontmatter as no title", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        Ok: {
          note_uuid: "id-4",
          frontmatter_bytes: "title: : invalid yaml::\n",
          first_h1_line: "# H1 Ignored",
        },
      },
    ]);
    const [rec] = await loadNoteBatch(["id-4"]);
    // Malformed YAML → js-yaml throws → parseFrontmatterSlice returns {} →
    // no title (and no H1 fallback).
    expect(rec.title).toBeNull();
  });
});

describe("loadNoteBatch — updated_at derivation", () => {
  it("parses RFC 3339 `updated:` to a Date", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        Ok: {
          note_uuid: "id-u1",
          frontmatter_bytes: "updated: 2026-05-10T12:00:00Z\n",
          first_h1_line: null,
        },
      },
    ]);
    const [rec] = await loadNoteBatch(["id-u1"]);
    expect(rec.updatedAt).toBeInstanceOf(Date);
    expect(rec.updatedAt?.toISOString()).toBe("2026-05-10T12:00:00.000Z");
  });

  it("returns null when frontmatter has no `updated:` field", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        Ok: {
          note_uuid: "id-u2",
          frontmatter_bytes: "title: T\n",
          first_h1_line: null,
        },
      },
    ]);
    const [rec] = await loadNoteBatch(["id-u2"]);
    expect(rec.updatedAt).toBeNull();
  });

  it("returns null when `updated:` value is unparseable", async () => {
    invokeMock.mockResolvedValueOnce([
      {
        Ok: {
          note_uuid: "id-u3",
          frontmatter_bytes: "updated: not-a-date\n",
          first_h1_line: null,
        },
      },
    ]);
    const [rec] = await loadNoteBatch(["id-u3"]);
    // js-yaml may parse "not-a-date" as a string; Date.parse on it
    // yields NaN; our derivation returns null.
    expect(rec.updatedAt).toBeNull();
  });
});

describe("loadNoteBatch — per-item error pass-through", () => {
  it("surfaces per-item Err as TitleRecord with error + null title", async () => {
    invokeMock.mockResolvedValueOnce([
      { Err: { kind: "CannotDecrypt" } },
      {
        Ok: {
          note_uuid: "id-ok",
          frontmatter_bytes: "title: OK\n",
          first_h1_line: null,
        },
      },
      { Err: { kind: "NoteNotFound" } },
    ]);
    const ids = ["id-bad", "id-ok", "id-deleted"];
    const out = await loadNoteBatch(ids);

    expect(out).toHaveLength(3);
    expect(out[0]?.title).toBeNull();
    expect(out[0]?.error).toEqual({ kind: "CannotDecrypt" });
    expect(out[0]?.noteUuid).toBe("id-bad");

    expect(out[1]?.title).toBe("OK");
    expect(out[1]?.error).toBeUndefined();

    expect(out[2]?.error).toEqual({ kind: "NoteNotFound" });
    expect(out[2]?.noteUuid).toBe("id-deleted");
  });
});

describe("loadNoteBatch — outer batch error propagation", () => {
  it("rejects when the underlying invoke rejects (BatchTooLarge etc.)", async () => {
    invokeMock.mockRejectedValueOnce({
      kind: "BatchTooLarge",
      detail: { cap: 100 },
    });
    await expect(loadNoteBatch(["id-x"])).rejects.toMatchObject({
      kind: "BatchTooLarge",
    });
  });
});
