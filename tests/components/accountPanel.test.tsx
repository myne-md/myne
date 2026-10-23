// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AccountPanel.tsx` — the
// account-level panel, and only that: the device-local grouping of vaults, its
// name, and the vaults in it. The vault's own controls (label, icon, change
// password, danger zone) live in `settings/VaultPanel.tsx` and are tested in
// `tests/components/vaultPanel.test.tsx`.
//
// The three states the panel can be in are all driven here, because the
// difference between them is the whole point of the panel: a vault WITH an
// account, a standalone vault (no account record, which is a real state and not
// an error), and a grouping the device could not read (which must NOT be
// rendered as standalone, since that would claim the vault has no account when
// the truth is unknown).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// ── Mock the IPC-boundary lib wrappers, keeping the pure helpers real ──────
const listAccounts = vi.fn();
const renameAccount = vi.fn();
const splitVault = vi.fn();
const moveVault = vi.fn();
const listVaults = vi.fn();
const personAccountNumber = vi.fn();

vi.mock("../../src/lib/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/account")>()),
  listAccounts: (...a: unknown[]) => listAccounts(...a),
  renameAccount: (...a: unknown[]) => renameAccount(...a),
  splitVault: (...a: unknown[]) => splitVault(...a),
  moveVault: (...a: unknown[]) => moveVault(...a),
}));
vi.mock("../../src/lib/personAccount", () => ({
  personAccountNumber: (...a: unknown[]) => personAccountNumber(...a),
  // The register block is not exercised in this suite; the panel imports the
  // module for the number read and must not reach the real IPC layer.
  personRegister: vi.fn(),
  readSyncEndpoint: vi.fn(),
  writeSyncEndpoint: vi.fn(),
}));
vi.mock("../../src/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../../src/platform/clipboardManager", () => ({ writeText: vi.fn() }));
vi.mock("../../src/components/toast/toastStore", () => ({ toast: vi.fn() }));
vi.mock("../../src/lib/vault-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/vault-list")>()),
  listVaults: (...a: unknown[]) => listVaults(...a),
}));
vi.mock("../../src/platform/capabilities", () => ({
  has: () => true,
}));
// The paired-extensions block does its own IPC on mount; it has its own suite
// (`tests/components/connectedExtensions.test.tsx`), so it is a marker here.
vi.mock("../../src/components/settings/ConnectedExtensions", () => ({
  ConnectedExtensions: () => <div data-testid="ce" />,
}));

import { AccountPanel } from "../../src/components/settings/AccountPanel";

const ACCOUNT = {
  id: "acct-1",
  label: "Work",
  vaults: ["v-active", "v-other"],
};
const VAULTS = [
  {
    id: "v-active",
    status: { kind: "Exists" as const },
    label: "Active vault",
    icon: null,
    last_unlock: null,
    published: false,
  },
  {
    id: "v-other",
    status: { kind: "Exists" as const },
    label: null,
    icon: null,
    last_unlock: null,
    published: false,
  },
];

beforeEach(() => {
  listAccounts.mockReset().mockResolvedValue([ACCOUNT]);
  renameAccount.mockReset().mockResolvedValue({ ...ACCOUNT, label: "Personal" });
  listVaults.mockReset().mockResolvedValue({ ok: VAULTS });
  splitVault.mockReset().mockResolvedValue([ACCOUNT]);
  moveVault.mockReset().mockResolvedValue([ACCOUNT]);
  personAccountNumber.mockReset().mockResolvedValue(null);
});

afterEach(cleanup);

function renderPanel(overrides: Partial<Parameters<typeof AccountPanel>[0]> = {}) {
  const props = { vaultId: "v-active" as string | null, ...overrides };
  render(<AccountPanel {...props} />);
  return props;
}

describe("AccountPanel — the account this vault belongs to", () => {
  it("shows the account name and the vaults grouped under it", async () => {
    renderPanel();
    await waitFor(() =>
      expect((screen.getByTestId("settings.account-name-input") as HTMLInputElement).value).toBe(
        "Work",
      ),
    );
    const rows = screen.getAllByTestId("settings.account-vault-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Active vault");
    // The unlabelled vault falls back to its stable number rather than
    // exposing nothing, and never to an id.
    expect(rows[1]!.textContent).toContain("Vault 2");
  });

  it("marks the open vault and only the open vault", async () => {
    renderPanel();
    await screen.findByTestId("settings.account-vaults");
    const rows = screen.getAllByTestId("settings.account-vault-row");
    expect(rows[0]!.getAttribute("data-current")).toBe("true");
    expect(rows[1]!.getAttribute("data-current")).toBe("false");
  });

  it("renders the paired-extensions block, which is account-level", () => {
    renderPanel();
    expect(screen.getByTestId("ce")).toBeTruthy();
  });
});

describe("AccountPanel — rename", () => {
  it("saves through account_rename and re-seeds from the backend's answer", async () => {
    renderPanel();
    const input = await screen.findByTestId("settings.account-name-input");
    fireEvent.change(input, { target: { value: "Personal" } });
    fireEvent.click(screen.getByTestId("settings.account-name-save"));
    await waitFor(() =>
      expect(renameAccount).toHaveBeenCalledWith("v-active", "Personal"),
    );
    // The panel takes the label the backend returned, not the draft.
    await waitFor(() =>
      expect((input as HTMLInputElement).value).toBe("Personal"),
    );
  });

  it("disables Save until the name actually changes", async () => {
    renderPanel();
    const save = await screen.findByTestId("settings.account-name-save");
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
    fireEvent.change(screen.getByTestId("settings.account-name-input"), {
      target: { value: "Home" },
    });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    // Clearing the field is not a rename: an account with no name is what
    // "standalone" already looks like in the picker.
    fireEvent.change(screen.getByTestId("settings.account-name-input"), {
      target: { value: "   " },
    });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the reason a rename failed and keeps the draft", async () => {
    renameAccount.mockRejectedValue({ kind: "Hidden" });
    renderPanel();
    const input = await screen.findByTestId("settings.account-name-input");
    fireEvent.change(input, { target: { value: "Secret" } });
    fireEvent.click(screen.getByTestId("settings.account-name-save"));
    const banner = await screen.findByTestId("settings.account-name-error");
    expect(banner.textContent).not.toBe("");
    // The draft survives, so a retry does not start from scratch.
    expect((input as HTMLInputElement).value).toBe("Secret");
  });
});

describe("AccountPanel — states that are not 'an account'", () => {
  it("a standalone vault says so instead of rendering an empty name field", async () => {
    listAccounts.mockResolvedValue([]);
    renderPanel();
    await screen.findByTestId("settings.account-standalone");
    expect(screen.queryByTestId("settings.account-name-input")).toBeNull();
  });

  it("an unreadable grouping is an ERROR, never the standalone state", async () => {
    // The distinction is the whole reason the load error is separate state:
    // "this vault has no account" is a claim the panel cannot make when the
    // record could not be read.
    listAccounts.mockRejectedValue({ kind: "RecordUnreadable" });
    renderPanel();
    await screen.findByTestId("settings.account-error");
    expect(screen.queryByTestId("settings.account-standalone")).toBeNull();
    expect(screen.queryByTestId("settings.account-name-input")).toBeNull();
  });

  it("an unresolved vault id states that rather than guessing", async () => {
    renderPanel({ vaultId: null });
    await screen.findByTestId("settings.account-unresolved");
    expect(screen.queryByTestId("settings.account-name-input")).toBeNull();
  });

  it("a vault list failure costs the row names and not the panel", async () => {
    listVaults.mockResolvedValue({
      err: { kind: "IoError", detail: { io_error_kind: "NotFound" } },
    });
    renderPanel();
    await screen.findByTestId("settings.account-vaults");
    const rows = screen.getAllByTestId("settings.account-vault-row");
    expect(rows).toHaveLength(2);
    // Both rows still render, and neither invents a name from the id.
    for (const row of rows) expect(row.textContent).toContain("Another vault");
  });
});

// 2026-10-23: the roster stopped being a read-out. A count that said "1 vaults",
// rows with no glyph or state, no way to act, and a closing sentence pointing at
// a panel the user had to find by hand.
describe("AccountPanel — the vault roster", () => {
  it("uses the singular for one vault", async () => {
    listAccounts.mockResolvedValue([{ ...ACCOUNT, vaults: ["v-active"] }]);
    renderPanel();
    const count = await screen.findByTestId("settings.account-vaults-count");
    expect(count.textContent).toBe("1 vault");
  });

  it("keeps the plural for several", async () => {
    renderPanel();
    const count = await screen.findByTestId("settings.account-vaults-count");
    expect(count.textContent).toBe("2 vaults");
  });

  it("offers the grouping actions the picker already performs", async () => {
    // Two accounts, so a move DESTINATION exists: the backend takes a target
    // vault id, so a destination can only be an account that already holds one.
    const other = { id: "acct-2", label: "Home", vaults: ["v-third"] };
    listAccounts.mockResolvedValue([ACCOUNT, other]);
    splitVault.mockResolvedValue([
      { ...ACCOUNT, vaults: ["v-other"] },
      { id: "acct-3", label: "", vaults: ["v-active"] },
    ]);
    renderPanel();
    const actions = await screen.findAllByTestId("settings.account-vault-actions");
    fireEvent.click(actions[0]!);
    fireEvent.click(await screen.findByTestId("settings.account-vault-split"));
    await waitFor(() => expect(splitVault).toHaveBeenCalledWith("v-active"));

    // The panel stays on the account it was SHOWING rather than following the
    // open vault into the account the split just created: swapping the panel's
    // subject mid-edit is the failure this anchors against (2026-10-23 review).
    await waitFor(() => expect(splitVault).toHaveBeenCalled());
    expect(
      (screen.getByTestId("settings.account-name-input") as HTMLInputElement).value,
    ).toBe("Work");
  });

  it("moves a vault into another account by that account's first vault", async () => {
    const other = { id: "acct-2", label: "Home", vaults: ["v-third"] };
    listAccounts.mockResolvedValue([ACCOUNT, other]);
    renderPanel();
    const actions = await screen.findAllByTestId("settings.account-vault-actions");
    fireEvent.click(actions[0]!);
    const destinations = await screen.findAllByTestId("settings.account-vault-move");
    fireEvent.click(destinations[0]!);
    await waitFor(() => expect(moveVault).toHaveBeenCalledWith("v-active", "v-third"));
  });

  it("offers only 'move to a new account' when there is no destination yet", async () => {
    // With one vault there is nowhere to move it TO (the backend needs a target
    // vault id), so the menu keeps the split and drops the empty heading.
    listAccounts.mockResolvedValue([{ ...ACCOUNT, vaults: ["v-active"] }]);
    renderPanel();
    const actions = await screen.findAllByTestId("settings.account-vault-actions");
    expect(actions).toHaveLength(1);
    fireEvent.click(actions[0]!);
    expect(await screen.findByTestId("settings.account-vault-split")).toBeTruthy();
    expect(screen.queryByTestId("settings.account-vault-move")).toBeNull();
  });

  it("shows the person account number, and only when the device has one", async () => {
    personAccountNumber.mockResolvedValue("XX95H84N8WE46C6KXRN2");
    renderPanel();
    const box = await screen.findByTestId("settings.account-number");
    expect((box as HTMLInputElement).value).toBe("MY-XX95-H84N-8WE4-6C6K-XRN2");
    expect(screen.getByTestId("settings.account-number-copy")).toBeTruthy();
  });

  it("states that there is no identity instead of hiding the number row", async () => {
    // The settings-search entry for the number is not runtime-gated, so the row
    // has to exist in every grouping state: a hit that lands on an absent anchor
    // degrades to a silent panel switch (2026-10-23 review).
    personAccountNumber.mockResolvedValue(null);
    renderPanel();
    await screen.findByTestId("settings.account-number-empty");
    expect(screen.queryByTestId("settings.account-number")).toBeNull();
    expect(screen.queryByTestId("settings.account-number-copy")).toBeNull();
  });

  it("opens the Sync panel instead of pointing at it", async () => {
    const onOpenPanel = vi.fn();
    renderPanel({ onOpenPanel });
    fireEvent.click(await screen.findByTestId("settings.account-open-sync"));
    expect(onOpenPanel).toHaveBeenCalledWith("sync");
  });
});

// 2026-10-23 review: the three arms the roster grew and did not pin.
describe("AccountPanel — the roster's careful arms", () => {
  it("asks before splitting the account's only vault, and cancelling writes nothing", async () => {
    listAccounts.mockResolvedValue([{ ...ACCOUNT, vaults: ["v-active"] }]);
    renderPanel();
    fireEvent.click((await screen.findAllByTestId("settings.account-vault-actions"))[0]!);
    fireEvent.click(await screen.findByTestId("settings.account-vault-split"));
    // The split deletes the account's id AND its name, which the menu's own
    // wording cannot say, so it is a second step rather than a click.
    expect(splitVault).not.toHaveBeenCalled();
    expect(await screen.findByTestId("settings.account-vault-confirm-run")).toBeTruthy();
    fireEvent.click(screen.getByTestId("settings.account-vault-confirm-cancel"));
    expect(splitVault).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("settings.account-vault-split"));
    fireEvent.click(await screen.findByTestId("settings.account-vault-confirm-run"));
    await waitFor(() => expect(splitVault).toHaveBeenCalledWith("v-active"));
  });

  it("does not claim a state for a vault the list could not read", async () => {
    // The list failure folds to [], so every id in the record is a vault this
    // device did not enumerate. "Device only" would be a claim from no data.
    listVaults.mockResolvedValue({ ok: [] });
    renderPanel();
    await screen.findByTestId("settings.account-vaults");
    const rows = screen.getAllByTestId("settings.account-vault-row");
    expect(rows[0]!.textContent).toContain("Not read on this device");
    expect(screen.queryAllByTestId("settings.account-vault-actions")).toHaveLength(0);
  });

  it("copies the number and reports both outcomes", async () => {
    const { copyText } = await import("../../src/lib/clipboard");
    const copyMock = vi.mocked(copyText);
    copyMock.mockClear();
    personAccountNumber.mockResolvedValue("XX95H84N8WE46C6KXRN2");
    renderPanel();
    fireEvent.click(await screen.findByTestId("settings.account-number-copy"));
    expect(copyMock).toHaveBeenCalled();
    const value = copyMock.mock.calls[0]![1];
    expect(value).toBe("MY-XX95-H84N-8WE4-6C6K-XRN2");
    // Both arms are wired; a failure must not read as a success.
    const options = copyMock.mock.calls[0]![2] as {
      onSuccess: { kind: string };
      onFailure: { kind: string };
    };
    expect(options.onSuccess.kind).toBe("toast");
    expect(options.onFailure.kind).toBe("toast");
  });
});
