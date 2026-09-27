// @vitest-environment jsdom
//
// MYND-558 — the Unlock screen asks for ONE credential at a time.
//
// Before this, a configured quick-unlock rendered the PIN field AND the
// password form together, so a user who had just set a PIN was shown two
// prompts and no indication of which one the app wanted. The screen now picks a
// primary surface from `quick_unlock_status` and puts the other behind a link.
//
// The E2E companion (`e2e/quick-unlock.e2e.ts` qu3) drives the same story
// through the production binary with a real PIN credential on disk; this suite
// pins the branch matrix cheaply, including the two states a real vault cannot
// be pushed into from the UI — a probe that rejects, and a biometric method on
// a machine with no Touch ID.

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
import type { QuickUnlockStatus } from "../../src/lib/quick-unlock";

const PASSWORD = "component-test-password";
const STATUS_CMD = "plugin:quick-unlock|quick_unlock_status";
const UNLOCK_CMD = "plugin:vault-unlock|unlock";
const VAULT_LIST_CMD = "plugin:vault-unlock|vault_list";

/**
 * The tail every mock in this file ends with: what an IPC this case does not
 * care about should resolve to.
 *
 * `undefined` is the right answer for a command whose result the screen
 * ignores, but NOT for one it destructures. The screen probes `vault_list` on
 * mount to decide whether to offer the back-to-picker link, and `listVaults`
 * wraps whatever `invoke` resolves as `{ ok }` — so `undefined` yields
 * `{ ok: undefined }`, which satisfies the `"ok" in res` discriminant and then
 * throws on `.ok.length`. It throws after the assertions have already passed,
 * so it surfaces as an unhandled error, not a failing test: green tests, red
 * run — and only in CI, where the whole suite's errors are tallied.
 *
 * An empty list is the honest fixture: these cases pin the credential surface,
 * not the multi-vault link.
 */
function otherIpc(cmd: string): Promise<unknown> {
  if (cmd === VAULT_LIST_CMD) return Promise.resolve([]);
  return Promise.resolve(undefined);
}

/**
 * Back the screen with a given quick-unlock status; every other IPC resolves.
 * Typed against the real `QuickUnlockStatus` mirror so a Rust-side field change
 * breaks these fixtures instead of letting them pin a stale contract.
 */
function withStatus(status: QuickUnlockStatus): void {
  invokeMock.mockImplementation((cmd) =>
    cmd === STATUS_CMD ? Promise.resolve(status) : otherIpc(cmd),
  );
}

function renderUnlock(overrides?: { onUnlocked?: () => void }) {
  return render(
    <Unlock
      initialStatus={{ kind: "Exists" }}
      onUnlocked={overrides?.onUnlocked ?? (() => {})}
      onStartRecovery={() => {}}
      onResumeRecovery={() => {}}
      onDeleteVaultSuccess={() => {}}
      onRestoreBackup={() => {}}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MYND-558 unlock screen shows one credential surface at a time", () => {
  it("PIN configured and redeemable → PIN only; the password form is not rendered", async () => {
    withStatus({ configured: true, method: "pin", available: true });
    renderUnlock();

    await screen.findByTestId("unlock.quick-pin-input");
    expect(screen.queryByTestId("unlock.password-input")).toBeNull();
    expect(screen.queryByTestId("unlock.form")).toBeNull();
    // The reveal affordance names the alternative in plain words.
    expect(screen.getByTestId("unlock.use-password-link").textContent).toBe(
      "Use password instead",
    );
  });

  it("the reveal swaps PIN for the password form, and the password still unlocks", async () => {
    const onUnlocked = vi.fn();
    withStatus({ configured: true, method: "pin", available: true });
    renderUnlock({ onUnlocked });

    fireEvent.click(await screen.findByTestId("unlock.use-password-link"));

    // Swapped, not stacked: the PIN surface is gone, not merely pushed down.
    const input = await screen.findByTestId("unlock.password-input");
    expect(screen.queryByTestId("unlock.quick-pin-input")).toBeNull();
    expect(screen.queryByTestId("unlock.quick-unlock")).toBeNull();

    fireEvent.change(input, { target: { value: PASSWORD } });
    fireEvent.click(screen.getByTestId("unlock.submit"));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(invokeMock).toHaveBeenCalledWith(UNLOCK_CMD, {
      vaultId: undefined,
      password: PASSWORD,
    });
  });

  it("the password surface offers a way back to the PIN — neither side is a cul-de-sac", async () => {
    withStatus({ configured: true, method: "pin", available: true });
    renderUnlock();

    fireEvent.click(await screen.findByTestId("unlock.use-password-link"));
    const back = await screen.findByTestId("unlock.use-quick-unlock-link");
    expect(back.textContent).toBe("Unlock with PIN instead");

    fireEvent.click(back);
    await screen.findByTestId("unlock.quick-pin-input");
    expect(screen.queryByTestId("unlock.password-input")).toBeNull();
  });

  it("a biometric credential names itself on the way back", async () => {
    withStatus({ configured: true, method: "biometric", available: true });
    renderUnlock();

    await screen.findByTestId("unlock.quick-touchid");
    fireEvent.click(screen.getByTestId("unlock.use-password-link"));

    const back = await screen.findByTestId("unlock.use-quick-unlock-link");
    expect(back.textContent).toBe("Use Touch ID instead");
  });

  it("no quick-unlock configured → the password form is the only surface, as before", async () => {
    withStatus({ configured: false, method: null, available: false });
    renderUnlock();

    await screen.findByTestId("unlock.password-input");
    expect(screen.queryByTestId("unlock.quick-unlock")).toBeNull();
    // Nothing to trade away, so no reveal link and no way-back link.
    expect(screen.queryByTestId("unlock.use-password-link")).toBeNull();
    expect(screen.queryByTestId("unlock.use-quick-unlock-link")).toBeNull();
  });

  it("configured but not redeemable this session (cold start) → password form", async () => {
    // The spring-loaded gate: the credential is on disk but no full-password
    // unlock has happened in this process, so redeeming it would fail.
    withStatus({ configured: true, method: "pin", available: false });
    renderUnlock();

    await screen.findByTestId("unlock.password-input");
    expect(screen.queryByTestId("unlock.quick-pin-input")).toBeNull();
    expect(screen.queryByTestId("unlock.use-password-link")).toBeNull();
  });

  it("a rejected status probe falls back to the password form, not a dead card", async () => {
    invokeMock.mockImplementation((cmd) =>
      cmd === STATUS_CMD
        ? Promise.reject(new Error("probe failed"))
        : otherIpc(cmd),
    );
    renderUnlock();

    await screen.findByTestId("unlock.password-input");
    expect(screen.queryByTestId("unlock.quick-unlock")).toBeNull();
  });

  it("redeeming a PIN reports the wait the same way the password path does", async () => {
    // The PIN runs the vault's own Argon2id parameters — the same multi-second
    // wait. Hold the redeem open and pin that the screen says so instead of
    // going quiet.
    //
    // WHERE it says so moved with the deboxed row (myne-md/myne#773): the
    // submit is an icon button, so the report is the button's accessible NAME
    // plus the spinner that replaces its arrow. That makes the accessible name
    // load-bearing rather than decorative — it is the only channel a
    // screen-reader user has on a screen whose normal case is several seconds
    // of nothing happening.
    let releaseRedeem: () => void = () => {};
    invokeMock.mockImplementation((cmd) => {
      if (cmd === STATUS_CMD) {
        return Promise.resolve({ configured: true, method: "pin", available: true });
      }
      if (cmd === "plugin:quick-unlock|quick_unlock_with_pin") {
        return new Promise<undefined>((resolve) => {
          releaseRedeem = () => resolve(undefined);
        });
      }
      return otherIpc(cmd);
    });
    renderUnlock();

    fireEvent.change(await screen.findByTestId("unlock.quick-pin-input"), {
      target: { value: "135790" },
    });
    const submit = screen.getByTestId("unlock.quick-pin-submit");
    fireEvent.click(submit);

    await waitFor(() => expect(submit.getAttribute("aria-label")).toBe("Decrypting…"));
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    // The row still says it is busy — the field reads that to lock itself and
    // to drop the resting rule's focus treatment.
    const row = submit.parentElement as HTMLElement;
    expect(row.getAttribute("data-busy")).toBe("true");
    // And there is exactly ONE indicator for the wait, in the button. The rule
    // used to sweep as well (`docs/decisions/ui/0626` withdrew it): two
    // indicators for one wait, and the one that went read as a page loading
    // rather than as a key turning. `data-motion` went with it — nothing on
    // this row carries state through motion any more, so a reduced-motion
    // exemption here would be an exemption for nothing.
    expect(row.getAttribute("data-motion")).toBe(null);
    expect(submit.querySelector(".myne-spinner, [class*=spinner]") ?? submit.firstElementChild)
      .not.toBeNull();
    // The field is locked too, so a second PIN cannot race the in-flight derive.
    expect((screen.getByTestId("unlock.quick-pin-input") as HTMLInputElement).disabled).toBe(
      true,
    );

    releaseRedeem();
  });

  it("exhausting the PIN attempts surfaces the password form with no way back", async () => {
    invokeMock.mockImplementation((cmd) => {
      if (cmd === STATUS_CMD) {
        return Promise.resolve({ configured: true, method: "pin", available: true });
      }
      if (cmd === "plugin:quick-unlock|quick_unlock_with_pin") {
        return Promise.reject({ kind: "AttemptsExhausted" });
      }
      return otherIpc(cmd);
    });
    renderUnlock();

    fireEvent.change(await screen.findByTestId("unlock.quick-pin-input"), {
      target: { value: "135790" },
    });
    fireEvent.click(screen.getByTestId("unlock.quick-pin-submit"));

    // The child folds itself away; the parent must notice and take over.
    await screen.findByTestId("unlock.password-input");
    expect(screen.queryByTestId("unlock.quick-pin-input")).toBeNull();
    expect(screen.queryByTestId("unlock.use-quick-unlock-link")).toBeNull();
  });
});
