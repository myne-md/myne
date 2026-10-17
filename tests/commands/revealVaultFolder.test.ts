import { describe, expect, it, vi, beforeEach } from "vitest";

// T6.3: the `vault.reveal-folder` palette action must open THIS vault's
// directory, `<app_data_dir>/vaults/<id>/`.
//
// The previous version opened the retired Phase-1 `<app_data_dir>/vault`, which
// after the `vaults/<id>/` layout migration is a path that no longer exists — a
// silent no-op. What a machine can judge here is the RESOLVED PATH (the open
// itself is the OS file manager's job), so `activeVaultId` / the path seam /
// `openPath` are mocked and the assertion is on the argument `openPath` got.
//
// The two branches are the correctness surface: a real id resolves to
// `vaults/<id>`, and `null` (no unlocked vault, the authoritative accessor's
// "do not guess") opens nothing.

const activeVaultId = vi.fn<() => Promise<string | null>>();
const openPath = vi.fn<(p: string) => Promise<void>>();

vi.mock("../../src/lib/vault-list", () => ({
  activeVaultId: () => activeVaultId(),
}));
vi.mock("../../src/platform/path", () => ({
  appDataDir: async () => "/app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("../../src/platform/opener", () => ({
  openPath: (p: string) => openPath(p),
}));

import { COMMAND_ACTIONS } from "../../src/commands";

function reveal() {
  const action = COMMAND_ACTIONS.find((a) => a.id === "vault.reveal-folder");
  if (!action) throw new Error("vault.reveal-folder action is gone");
  return action;
}

/** `run` kicks off a floating async IIFE; drain its microtasks. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  activeVaultId.mockReset();
  openPath.mockReset();
  openPath.mockResolvedValue(undefined);
});

describe("vault.reveal-folder", () => {
  it("opens the active vault's own directory, not the retired single-vault path", async () => {
    activeVaultId.mockResolvedValue("0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000");
    reveal().run({} as never);
    await settle();
    expect(openPath).toHaveBeenCalledTimes(1);
    const opened = openPath.mock.calls[0][0];
    expect(opened).toBe("/app-data/vaults/0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000");
    expect(opened.endsWith("/vault")).toBe(false);
  });

  it("opens nothing when no vault is unlocked (never guess a target)", async () => {
    activeVaultId.mockResolvedValue(null);
    reveal().run({} as never);
    await settle();
    expect(openPath).not.toHaveBeenCalled();
  });
});
