// Unit tests for `src/notes/baseMismatch.ts` — the §11.3 local keep-both
// orchestration for a `BaseMismatch` autosave rejection. Deps-injected; no
// Tauri IPC. The load-bearing property: the conflict COPY is created BEFORE
// the pane is re-based, so a copy failure can never lose the buffer.

import { describe, expect, it, vi } from "vitest";
import {
  handleBaseMismatch,
  type BaseMismatchDeps,
} from "../../src/notes/baseMismatch";

function deps(overrides: Partial<BaseMismatchDeps> = {}): {
  deps: BaseMismatchDeps;
  calls: string[];
  adopted: string[];
  refreshed: string[];
} {
  const calls: string[] = [];
  const adopted: string[] = [];
  const refreshed: string[] = [];
  const d: BaseMismatchDeps = {
    createCopy: vi.fn(async (body: string, orig: string) => {
      calls.push(`copy:${orig}:${body}`);
      return "copy-id-1";
    }),
    readNote: vi.fn(async (id: string) => {
      calls.push(`read:${id}`);
      return "pulled disk body";
    }),
    adoptDiskBody: (b) => {
      calls.push("adopt");
      adopted.push(b);
    },
    refreshCopy: (id) => {
      calls.push("refresh");
      refreshed.push(id);
    },
    ...overrides,
  };
  return { deps: d, calls, adopted, refreshed };
}

describe("handleBaseMismatch — keep-both ordering", () => {
  it("copies FIRST, then reloads + adopts the pulled body, then refreshes", async () => {
    const { deps: d, calls, adopted, refreshed } = deps();
    await handleBaseMismatch(
      { noteId: "orig-1", bufferBody: "stale-based keystrokes" },
      d,
    );
    expect(calls).toEqual([
      "copy:orig-1:stale-based keystrokes",
      "read:orig-1",
      "adopt",
      "refresh",
    ]);
    expect(adopted).toEqual(["pulled disk body"]);
    expect(refreshed).toEqual(["copy-id-1"]);
  });

  it("a copy failure throws BEFORE any reload — the buffer is never replaced", async () => {
    const { deps: d, calls, adopted } = deps({
      createCopy: vi.fn(async () => {
        throw new Error("copy failed");
      }),
    });
    await expect(
      handleBaseMismatch({ noteId: "orig-1", bufferBody: "keystrokes" }, d),
    ).rejects.toThrow("copy failed");
    expect(adopted).toEqual([]); // zero keystroke loss: pane untouched
    expect(calls).not.toContain("adopt");
    expect(calls).not.toContain("read:orig-1");
  });

  it("a refresh failure is best-effort — the resolution still succeeds", async () => {
    const { deps: d, adopted } = deps({
      refreshCopy: () => Promise.reject(new Error("sidebar hiccup")),
    });
    await expect(
      handleBaseMismatch({ noteId: "orig-1", bufferBody: "keystrokes" }, d),
    ).resolves.toBeUndefined();
    expect(adopted).toEqual(["pulled disk body"]);
  });
});
