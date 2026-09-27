// @vitest-environment jsdom
//
// The unlock heading names the vault it is opening (myne-md/myne#773).
//
// You arrive here from a list of named vaults and the screen forgot which one
// you picked: it asked for "your vault", which is the one thing on the page
// that did not say what the page was about.

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
import type { VaultId } from "../../src/lib/stage";

const STATUS_CMD = "plugin:quick-unlock|quick_unlock_status";
const VAULT_LIST_CMD = "plugin:vault-unlock|vault_list";

const A = "00000000-0000-7000-8000-00000000000a";
const B = "00000000-0000-7000-8000-00000000000b";

function renderUnlock(
  vaults: readonly { id: string; label?: string | null }[],
  vaultId?: string,
) {
  invokeMock.mockImplementation((cmd) => {
    if (cmd === STATUS_CMD) {
      return Promise.resolve({ configured: false, method: null, available: false });
    }
    if (cmd === VAULT_LIST_CMD) {
      return Promise.resolve(
        vaults.map((v) => ({ id: v.id, status: "Exists", label: v.label ?? null })),
      );
    }
    return Promise.resolve(undefined);
  });
  return render(
    <Unlock
      initialStatus={{ kind: "Exists" }}
      {...(vaultId === undefined ? {} : { vaultId: vaultId as VaultId })}
      onUnlocked={() => {}}
      onStartRecovery={() => {}}
      onResumeRecovery={() => {}}
      onDeleteVaultSuccess={() => {}}
      onRestoreBackup={() => {}}
      onBack={() => {}}
    />,
  );
}

const heading = () => screen.getByRole("heading", { level: 1 }).textContent ?? "";

beforeEach(() => invokeMock.mockReset());
afterEach(() => cleanup());

describe("the heading says which vault", () => {
  it("uses the vault's own name when it has one", async () => {
    renderUnlock([{ id: A, label: "Work" }, { id: B }], A);
    await screen.findByTestId("unlock.form");
    expect(heading()).toContain("Work");
    // And stops asking for "your vault", which was the generic it replaces.
    expect(heading()).not.toContain("your vault");
  });

  it("uses the SAME neutral fallback the picker uses, which is the usual case", async () => {
    // `VaultSummary.label` is null for a vault this session has not unlocked —
    // the ordinary cold-start state — and null again when "hide vault names"
    // is on, because that option erases the name at the source. So the
    // fallback is what most users read, and it must surface no
    // vault-identifying string.
    renderUnlock([{ id: A }, { id: B }], A);
    await screen.findByTestId("unlock.form");
    // `Vault {{n}}` with a STABLE n. The id is what must not appear.
    expect(heading()).toMatch(/Vault \d+/);
    expect(heading()).not.toContain(A);
  });

  it("keeps the generic title when there is no vault to name", async () => {
    // The sole-vault path reaches this screen with no `vaultId` at all. A
    // screen that invented a number here would be worse than one that does
    // not name the vault.
    renderUnlock([{ id: A }]);
    await screen.findByTestId("unlock.form");
    expect(heading()).toContain("your vault");
    expect(heading()).not.toMatch(/Vault \d+/);
  });

  it("keeps the generic title when the list could not be read", async () => {
    // Same rule, different cause: an id that names nothing in the list is not
    // a vault this screen can name.
    renderUnlock([], A);
    await screen.findByTestId("unlock.form");
    expect(heading()).toContain("your vault");
  });

  it("names the vault the SCREEN is opening, not the first one in the list", async () => {
    // The id is threaded from the picker's choice (SYNC-6 targeting). Reading
    // the list's head instead would name the wrong vault on every screen the
    // user reached by picking the second row — and the two tests above would
    // both still pass.
    renderUnlock([{ id: A, label: "First" }, { id: B, label: "Second" }], B);
    await screen.findByTestId("unlock.form");
    expect(heading()).toContain("Second");
    expect(heading()).not.toContain("First");
  });
});
