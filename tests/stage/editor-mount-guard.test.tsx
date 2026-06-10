// @vitest-environment jsdom
//
// SM-10 — the Editor mount guard's invalid-state arm (MYND-127 task 6).
//
// Structurally unreachable through real UI driving (reaching `editor`
// Stage requires a real unlock, which populates the Rust slot), so the
// E2E suite cannot exercise it without a forbidden test hook (SYNC-3).
// Ratified downgrade: component-level coverage with the mount probe
// mocked — the ONE seam the guard exists to distrust.
//
// Contract under test (Q5β-1 belt+suspenders, `src/CLAUDE.md`):
// - `vault_is_unlocked` → false while Stage = editor ⇒
//   `<FailClosedError reason="invalid-state" />` in place of the editor
//   body (which never mounts).
// - The "Lock" CTA fires `vault_lock` (idempotent) and THEN the
//   parent's reset callback (App.tsx's `reprobe()` re-route).
// - A rejected probe IPC is treated as invalid state (fail-closed).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const isVaultUnlockedMock = vi.fn<() => Promise<boolean>>();
const lockVaultMock = vi.fn<() => Promise<void>>();

vi.mock("../../src/lib/vault-unlock", () => ({
  isVaultUnlocked: () => isVaultUnlockedMock(),
  lockVault: () => lockVaultMock(),
  reportUserActivity: () => Promise.resolve(),
}));

import { Editor } from "../../src/screens/Editor";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Editor mount guard (SM-10: React stage ↔ Rust slot disagreement)", () => {
  it("renders the invalid-state fail-closed surface when the slot probe returns false", async () => {
    isVaultUnlockedMock.mockResolvedValue(false);
    render(<Editor onDeleteVaultSuccess={() => {}} />);

    const root = await screen.findByTestId("fail-closed.root");
    expect(root.getAttribute("data-reason")).toBe("invalid-state");
    // Single CTA, literal copy; the editor body never mounted.
    expect(screen.getByTestId("fail-closed.cta").textContent).toBe("Lock");
    expect(screen.queryByTestId("editor.root")).toBeNull();
  });

  it("Lock CTA fires the idempotent vault_lock, then the parent reset (reprobe) callback", async () => {
    isVaultUnlockedMock.mockResolvedValue(false);
    lockVaultMock.mockResolvedValue(undefined);
    const onResetRequested = vi.fn();
    render(<Editor onDeleteVaultSuccess={() => {}} onResetRequested={onResetRequested} />);

    fireEvent.click(await screen.findByTestId("fail-closed.cta"));
    await waitFor(() => expect(onResetRequested).toHaveBeenCalledTimes(1));
    expect(lockVaultMock).toHaveBeenCalledTimes(1);
  });

  it("still routes out (reset fires) when vault_lock itself rejects", async () => {
    isVaultUnlockedMock.mockResolvedValue(false);
    lockVaultMock.mockRejectedValue(new Error("ipc down"));
    const onResetRequested = vi.fn();
    render(<Editor onDeleteVaultSuccess={() => {}} onResetRequested={onResetRequested} />);

    fireEvent.click(await screen.findByTestId("fail-closed.cta"));
    await waitFor(() => expect(onResetRequested).toHaveBeenCalledTimes(1));
  });

  it("treats a rejected probe IPC as invalid state (fail-closed)", async () => {
    isVaultUnlockedMock.mockRejectedValue(new Error("ipc down"));
    render(<Editor onDeleteVaultSuccess={() => {}} />);

    const root = await screen.findByTestId("fail-closed.root");
    expect(root.getAttribute("data-reason")).toBe("invalid-state");
  });
});
