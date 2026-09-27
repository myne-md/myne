// @vitest-environment jsdom
//
// The name typed on the first step becomes the vault's label (myne-md/myne#468).
//
// This is the whole point of the name step and it is the part that can silently
// not happen. `prefs|vault_set_label` is UNLOCK-GATED: it writes into
// `vault.prefs` under the active vault's `prefs_key`, and during creation there
// is no unlocked slot at all. So the write has to wait for the chained
// `vault_unlock` that runs when the user presses Done on the ready screen — one
// action after the reducer has otherwise reset itself.
//
// Every way this breaks is quiet. Writing at commit time rejects with
// `SlotNotUnlocked` and the flow has already succeeded, so nothing surfaces.
// Letting `COMMIT_OK` reset `vaultName` with the rest of the state leaves an
// empty string, which is a legitimate value meaning "no name". In both cases the
// user names their vault, lands in the editor, and finds it called "Vault 2".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));
vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {} }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: async () => true }));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/app-data",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: async () => {} }));

import { CreateVault } from "../../src/screens/CreateVault";

const PASSWORD = "Tk9#mQ4!wX7&zR2p-cmp";
const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);
const TOKEN = "11111111-2222-4333-8444-555555555555";
const VAULT_ID = "00000000-0000-7000-8000-0000000000aa";
const LABEL_CMD = "plugin:prefs|vault_set_label";
const UNLOCK_CMD = "plugin:vault-unlock|unlock";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd) => {
    switch (cmd) {
      case "plugin:vault-creation|begin":
        // secret-scan:allow — test fixture, not a credential
        return Promise.resolve({
          phrase: PHRASE,
          account_number: "MY-0000-0000-0000-0000-0000",
          session_token: TOKEN,
        });
      case "plugin:vault-creation|commit":
        return Promise.resolve(VAULT_ID);
      default:
        return Promise.resolve(undefined);
    }
  });
});
afterEach(cleanup);

/** Walk the whole flow to the editor, naming the vault `name` on the way. */
async function createVaultNamed(name: string): Promise<void> {
  render(
    <CreateVault
      onBack={() => {}}
      onAutoUnlockSuccess={() => {}}
      onAutoUnlockFailed={() => {}}
    />,
  );
  fireEvent.change(await screen.findByTestId("create.name-input"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByTestId("create.name-continue"));

  fireEvent.change(await screen.findByTestId("create.password-input"), {
    target: { value: PASSWORD },
  });
  fireEvent.change(screen.getByTestId("create.confirm-input"), {
    target: { value: PASSWORD },
  });
  const submit = screen.getByTestId("create.submit") as HTMLButtonElement;
  await waitFor(() => expect(submit.disabled).toBe(false));
  fireEvent.click(submit);

  await screen.findByTestId("create.phrase-grid");
  fireEvent.click(screen.getByTestId("create.phrase-continue"));

  const cells = await screen.findAllByTestId("create.confirm-input");
  for (const cell of cells) {
    const pos = Number(cell.getAttribute("data-index"));
    fireEvent.change(cell, { target: { value: PHRASE[pos - 1] } });
  }
  const commit = screen.getByTestId("create.confirm-continue") as HTMLButtonElement;
  await waitFor(() => expect(commit.disabled).toBe(false));
  fireEvent.click(commit);

  fireEvent.click(await screen.findByTestId("create.ready-done"));
}

function callsTo(cmd: string) {
  return invokeMock.mock.calls.filter((c) => c[0] === cmd);
}

describe("the typed name reaches the vault", () => {
  it("writes it as the label, after the unlock and not before", async () => {
    await createVaultNamed("Research");
    await waitFor(() => expect(callsTo(LABEL_CMD).length).toBe(1));
    expect(callsTo(LABEL_CMD)[0][1]).toEqual({ label: "Research" });

    // Ordering is the load-bearing half: the command is unlock-gated, so the
    // same call one step earlier rejects and nothing tells anybody.
    const order = invokeMock.mock.calls.map((c) => c[0]);
    expect(order.indexOf(LABEL_CMD)).toBeGreaterThan(order.indexOf(UNLOCK_CMD));
  });

  it("survives the flow's own state reset on the way to the ready screen", async () => {
    // `COMMIT_OK` deliberately drops the phrase, the account number and the
    // session token. It must NOT drop the name, which is written one user action
    // later. An empty label is not an error, so the failure is silent.
    await createVaultNamed("Kişisel Kasa");
    await waitFor(() => expect(callsTo(LABEL_CMD).length).toBe(1));
    expect(callsTo(LABEL_CMD)[0][1]).toEqual({ label: "Kişisel Kasa" });
  });

  it("trims the name rather than writing a padded label", async () => {
    await createVaultNamed("  Research  ");
    await waitFor(() => expect(callsTo(LABEL_CMD).length).toBe(1));
    expect(callsTo(LABEL_CMD)[0][1]).toEqual({ label: "Research" });
  });
});

describe("a blank name writes nothing", () => {
  it("skips the label write entirely rather than clearing it", async () => {
    // Blank is a legitimate answer, and the picker's neutral fallback is the
    // right result. Writing `null` would look the same to a user and cost a
    // prefs write on every unnamed vault.
    await createVaultNamed("   ");
    await waitFor(() => expect(callsTo(UNLOCK_CMD).length).toBe(1));
    expect(callsTo(LABEL_CMD)).toEqual([]);
  });
});
