// @vitest-environment jsdom
//
// MYND-125 task 8 — the four structurally-unreachable-from-E2E unlock
// error variants (SYNC-7 error-variant realism split): real-IPC E2E
// covers InvalidCredentialOrVault / InvalidVaultMeta / IoError /
// VaultNotFound; these four cannot be produced through at-rest faults
// on the production binary without a forbidden hook, so they are
// pinned at component level with a mocked `invoke` reject.
//
// - VaultAlreadyUnlocked / UnlockInProgress → banner literals.
// - VaultRecoveryInProgress → the recovery-in-progress MODE (form
//   suppressed, info banner, "Continue" → resume-recovery callback).
// - JoinFailure → generic banner (the previously-untested trigger
//   path named in the Plane item).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: async () => {},
  }),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));

import { Unlock } from "../../src/screens/Unlock";

const PASSWORD = "component-test-password";

function renderUnlock(overrides?: { onResumeRecovery?: () => void }) {
  return render(
    <Unlock
      initialStatus={{ kind: "Exists" }}
      onUnlocked={() => {}}
      onStartRecovery={() => {}}
      onResumeRecovery={overrides?.onResumeRecovery ?? (() => {})}
      onDeleteVaultSuccess={() => {}}
      onRestoreBackup={() => {}}
    />,
  );
}

/**
 * The password form mounts only once `quick_unlock_status` settles (MYND-558 —
 * the screen renders one credential surface at a time, and which one depends on
 * that probe). `invoke` here resolves `undefined` for every non-unlock command,
 * which the status probe treats as "no quick-unlock" → the password form. Hence
 * `find`, not `get`: the first synchronous frame has no form yet.
 */
async function submitPassword(): Promise<void> {
  fireEvent.change(await screen.findByTestId("unlock.password-input"), {
    target: { value: PASSWORD },
  });
  fireEvent.click(screen.getByTestId("unlock.submit"));
}

function rejectUnlockWith(error: unknown): void {
  invokeMock.mockImplementation((cmd) =>
    cmd === "plugin:vault-unlock|unlock" ? Promise.reject(error) : Promise.resolve(undefined),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("unreachable unlock error variants (component-level, mocked reject)", () => {
  it("JoinFailure → generic retry banner; the form stays usable", async () => {
    rejectUnlockWith({ kind: "JoinFailure" });
    renderUnlock();
    await submitPassword();
    const banner = await screen.findByTestId("unlock.error-banner");
    expect(banner.textContent).toBe("Unexpected error. Please try again.");
    expect(
      (screen.getByTestId("unlock.password-input") as HTMLInputElement).disabled,
    ).toBe(false);
  });

  it("VaultAlreadyUnlocked → its dedicated banner literal", async () => {
    rejectUnlockWith({ kind: "VaultAlreadyUnlocked" });
    renderUnlock();
    await submitPassword();
    const banner = await screen.findByTestId("unlock.error-banner");
    expect(banner.textContent).toBe("Vault is already unlocked.");
  });

  it("UnlockInProgress → its dedicated banner literal", async () => {
    rejectUnlockWith({ kind: "UnlockInProgress" });
    renderUnlock();
    await submitPassword();
    const banner = await screen.findByTestId("unlock.error-banner");
    expect(banner.textContent).toBe("Operation in progress.");
  });

  it("VaultRecoveryInProgress → recovery-in-progress mode: form suppressed, Continue resumes", async () => {
    rejectUnlockWith({ kind: "VaultRecoveryInProgress" });
    const onResumeRecovery = vi.fn();
    renderUnlock({ onResumeRecovery });
    await submitPassword();

    // Mode switch: info banner + Continue CTA, password form gone.
    await screen.findByTestId("unlock.recovery-in-progress-banner");
    expect(screen.queryByTestId("unlock.password-input")).toBeNull();
    expect(screen.queryByTestId("unlock.submit")).toBeNull();

    fireEvent.click(screen.getByTestId("unlock.resume-cta"));
    await waitFor(() => expect(onResumeRecovery).toHaveBeenCalledTimes(1));
  });
});
