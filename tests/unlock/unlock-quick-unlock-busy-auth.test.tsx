// @vitest-environment jsdom
//
// myne#378 — a busy-auth rejection is not a rejected credential.
//
// The quick-unlock redeem now takes the capacity-1 `auth_permits` semaphore, so
// it can answer `VaultBusyAuth` when another auth op holds it. Before the arm
// this spec pins, that fell to the `default:` branch and rendered "Quick unlock
// failed. Use your password." — which tells the user their PIN was rejected,
// when in fact nothing was tried, no attempt was burned, and the credential is
// intact.
//
// Unreachable from this surface in practice (the UI single-flights), which is
// exactly why it is worth pinning here: the guard lives in the backend because
// page context is not trusted, so the copy has to be right for a path no manual
// test will ever walk.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: async () => {} }),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));

import { Unlock } from "../../src/screens/Unlock";

const STATUS_CMD = "plugin:quick-unlock|quick_unlock_status";
const PIN_CMD = "plugin:quick-unlock|quick_unlock_with_pin";
const VAULT_LIST_CMD = "plugin:vault-unlock|vault_list";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a busy-auth rejection from the redeem path", () => {
  it("says operation in progress and keeps the PIN field", async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === STATUS_CMD) {
        return Promise.resolve({ configured: true, method: "pin", available: true });
      }
      if (cmd === PIN_CMD) return Promise.reject({ kind: "VaultBusyAuth" });
      // An empty list: these cases pin the credential surface, not the
      // multi-vault link, and `listVaults` destructures whatever this resolves.
      if (cmd === VAULT_LIST_CMD) return Promise.resolve([]);
      return Promise.resolve(undefined);
    });

    render(
      <Unlock
        initialStatus={{ kind: "Exists" }}
        onUnlocked={() => {}}
        onStartRecovery={() => {}}
        onResumeRecovery={() => {}}
        onDeleteVaultSuccess={() => {}}
        onRestoreBackup={() => {}}
      />,
    );

    const input = await screen.findByTestId("unlock.quick-pin-input");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.submit(input.closest("form") ?? input);

    // The literal English copy: `tests/setup-i18n.ts` initialises the real
    // catalog, so this compares against what ships. The `default:` arm reads
    // "Quick unlock failed. Use your password." — a different sentence, and the
    // wrong one.
    await waitFor(() =>
      expect(screen.getByTestId("unlock.quick-note").textContent).toBe(
        "Operation in progress.",
      ),
    );
    // Still offered: the credential was not tried, let alone rejected.
    expect(screen.queryByTestId("unlock.quick-pin-input")).not.toBeNull();
  });
});
