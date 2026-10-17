// myne#277 — `lockVault()` must drop the task-list cache alongside the index it
// describes.
//
// `taskIndex` is the ONE nonce consumer that answers from module state instead
// of refetching in its own mount effect, so unlike `BacklinksTab`, `OutlineTab`,
// `TagBrowser` and `GraphView` it does not self-heal on remount. The backend
// wipes `VaultIndicesState` on lock, the WebView is NOT reloaded by the manual
// Lock button, and `cachedNonce` therefore survived into the next session —
// which is why Tasks was the surface that visibly broke.
//
// `resetTaskIndexCache`'s docstring already claimed a lock-teardown caller. It
// had none: the only caller was its own test file.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const { lockVault } = await import("../../src/lib/vault-unlock");
const { fetchVaultTasks, peekVaultTasks, resetTaskIndexCache } = await import(
  "../../src/notes/taskIndex"
);

const ROW = {
  noteId: "n1",
  noteTitle: "Alpha",
  noteFolder: null,
  lineIndex: 3,
  rawLine: "- [ ] pay the rent [due:: 2026-08-01]",
  completed: false,
  oversized: false,
  due: "2026-08-01",
};

beforeEach(() => {
  invokeMock.mockReset();
  resetTaskIndexCache();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:vault-indices|vault_indices_tasks") return [ROW];
    return undefined;
  });
});

describe("lockVault drops the task-index cache", () => {
  it("empties the shared list, so the next session cannot read a pre-lock snapshot", async () => {
    await fetchVaultTasks(1);
    expect(peekVaultTasks()).toHaveLength(1);

    await lockVault();

    expect(peekVaultTasks()).toHaveLength(0);
  });

  it("clears the cached nonce, so a re-read at the SAME nonce refetches", async () => {
    await fetchVaultTasks(1);
    invokeMock.mockClear();

    // Without the reset, `cachedNonce === 1` short-circuits this call and the
    // pane renders the previous session's tasks.
    await fetchVaultTasks(1);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "plugin:vault-indices|vault_indices_tasks"),
    ).toHaveLength(0);

    await lockVault();
    invokeMock.mockClear();
    await fetchVaultTasks(1);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "plugin:vault-indices|vault_indices_tasks"),
    ).toHaveLength(1);
  });

});
