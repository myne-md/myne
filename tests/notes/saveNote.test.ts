// Unit tests for `src/notes/saveNote.ts`. Mocks the Tauri `invoke`
// shim and asserts the surgery composition: every save fires
// `patchUpdatedField` BEFORE `note_update` per `decisions.md`
// 2026-05-09 + 2026-05-15.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_MS,
  saveNote,
} from "../../src/notes/saveNote";

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  invokeMock.mockReset();
});

describe("saveNote — timing constants", () => {
  it("AUTOSAVE_IDLE_MS = 1000ms per decisions.md 2026-05-15", () => {
    expect(AUTOSAVE_IDLE_MS).toBe(1000);
  });

  it("AUTOSAVE_MAX_MS = 10000ms per decisions.md 2026-05-15", () => {
    expect(AUTOSAVE_MAX_MS).toBe(10000);
  });
});

describe("saveNote — expected-base pass-through (§11.3)", () => {
  it("forwards the base hash into the invoke payload only when provided", async () => {
    invokeMock.mockResolvedValue(undefined);
    await saveNote("note-1", "body", "ab".repeat(32));
    expect(invokeMock).toHaveBeenLastCalledWith(
      "plugin:notes|note_update",
      expect.objectContaining({ expectedBaseHashHex: "ab".repeat(32) }),
    );
    await saveNote("note-1", "body");
    const [, payload] = invokeMock.mock.calls.at(-1) as [string, object];
    expect("expectedBaseHashHex" in payload).toBe(false);
  });
});

describe("saveNote — surgery composition", () => {
  it("calls note_update with body that has `updated:` frontmatter stamped", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await saveNote("note-id-1", "body without frontmatter\n");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0]!;
    expect(cmd).toBe("plugin:notes|note_update");
    expect((args as { noteId: string }).noteId).toBe("note-id-1");
    const stamped = (args as { plaintext: string }).plaintext;
    // State-A prepend: frontmatter block injected before original body.
    expect(stamped).toMatch(/^---\nupdated: \d{4}-\d{2}-\d{2}T/);
    expect(stamped).toContain("body without frontmatter\n");
  });

  it("preserves existing frontmatter and only refreshes `updated:` value", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const input =
      "---\ntitle: Existing\nupdated: 2020-01-01T00:00:00Z\n---\n\nbody\n";
    await saveNote("note-id-2", input);

    const stamped = (
      invokeMock.mock.calls[0]![1] as { plaintext: string }
    ).plaintext;
    expect(stamped).toContain("title: Existing");
    // `updated:` value swapped to current ISO; original 2020 value gone.
    expect(stamped).not.toContain("2020-01-01T00:00:00Z");
    expect(stamped).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
    // Body bytes outside FM remain byte-identical.
    expect(stamped).toContain("\n\nbody\n");
  });

  it("inserts `updated:` into frontmatter block that lacks the key", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const input = "---\ntitle: X\n---\n\nbody\n";
    await saveNote("note-id-3", input);

    const stamped = (
      invokeMock.mock.calls[0]![1] as { plaintext: string }
    ).plaintext;
    expect(stamped).toContain("title: X");
    expect(stamped).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
  });

  it("uses a fresh ISO timestamp on each invocation", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    invokeMock.mockResolvedValueOnce(undefined);

    await saveNote("id", "body\n");
    // Force a measurable gap before the second save so the ISO strings
    // are guaranteed-different (Date.now() resolution is ms, so a tight
    // loop could still collide — the gap removes the flake).
    await new Promise((r) => setTimeout(r, 10));
    await saveNote("id", "body\n");

    const iso1 = (invokeMock.mock.calls[0]![1] as { plaintext: string })
      .plaintext.match(/updated: ([^\n]+)/)?.[1];
    const iso2 = (invokeMock.mock.calls[1]![1] as { plaintext: string })
      .plaintext.match(/updated: ([^\n]+)/)?.[1];
    expect(iso1).toBeDefined();
    expect(iso2).toBeDefined();
    expect(iso1).not.toBe(iso2);
  });
});

describe("saveNote — error propagation", () => {
  it("rejects with the IPC error when `note_update` rejects", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "NoteNotFound" });
    await expect(saveNote("missing-id", "body")).rejects.toMatchObject({
      kind: "NoteNotFound",
    });
  });
});
