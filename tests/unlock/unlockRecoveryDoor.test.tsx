// @vitest-environment jsdom
//
// The unlock screen offers a phrase only where one exists (myne-md/myne#938,
// `decisions/protocol/0758`; PRD story 28).
//
// The probe that decides this has three answers and the third is absence. Before
// the tri-state, `NTV8` collapsed into `false` and the screen offered "unlock
// with your recovery phrase" on a vault that has none: 24 correct words typed
// into a flow whose AEAD cannot succeed, answered with the non-distinguishing
// "that phrase is wrong", forever. The same bit drove the Settings row, which
// offered to retire a phrase the vault never had.
//
// Three cases, one per answer, and the third is the one that cannot be a driver
// claim: no e2e scenario walks a vault with nothing to recover, because creating
// one and forgetting its password is the only way to be there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
import i18n from "../../src/i18n";

const STATUS_CMD = "plugin:quick-unlock|quick_unlock_status";
const VAULT_LIST_CMD = "plugin:vault-unlock|vault_list";
const PROBE_CMD = "plugin:vault-unlock|vault_is_person_wrapped";

function renderUnlock(answer: boolean | null) {
  invokeMock.mockImplementation((cmd) => {
    if (cmd === STATUS_CMD) {
      return Promise.resolve({ configured: false, method: null, available: false });
    }
    if (cmd === VAULT_LIST_CMD) return Promise.resolve([]);
    if (cmd === PROBE_CMD) return Promise.resolve(answer);
    return Promise.resolve(undefined);
  });
  return render(
    <Unlock
      initialStatus={{ kind: "Exists" }}
      onUnlocked={() => {}}
      onStartRecovery={() => {}}
      onResumeRecovery={() => {}}
      onDeleteVaultSuccess={() => {}}
      onRestoreBackup={() => {}}
      onBack={() => {}}
    />,
  );
}

beforeEach(() => invokeMock.mockReset());
afterEach(() => cleanup());

describe("the unlock screen's recovery door", () => {
  it("offers the identity phrase on an NTV7 vault", async () => {
    renderUnlock(true);
    await screen.findByTestId("unlock.form");

    const link = await screen.findByTestId("unlock.recovery-link");
    expect(link.textContent).toBe(i18n.t("unlock.identityPhraseLink"));
    expect(screen.queryByTestId("unlock.password-only-note")).toBeNull();
  });

  it("offers the vault phrase on a vault that still carries one", async () => {
    renderUnlock(false);
    await screen.findByTestId("unlock.form");

    const link = await screen.findByTestId("unlock.recovery-link");
    expect(link.textContent).toBe(i18n.t("unlock.recoveryLink"));
    expect(screen.queryByTestId("unlock.password-only-note")).toBeNull();
  });

  it("offers NO phrase at all on an NTV8 vault, and says why", async () => {
    renderUnlock(null);
    await screen.findByTestId("unlock.form");

    // The absence is the assertion. A link here is a control that can only fail.
    await screen.findByTestId("unlock.password-only-note");
    expect(screen.queryByTestId("unlock.recovery-link")).toBeNull();
    // And it is stated rather than implied: the user is told the password is the
    // only way in, so nobody goes looking for a door that was removed.
    expect(screen.getByTestId("unlock.password-only-note").textContent).toBe(
      i18n.t("unlock.passwordOnlyNote"),
    );
  });
});
