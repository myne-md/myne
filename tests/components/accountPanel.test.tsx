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
const listVaults = vi.fn();

vi.mock("../../src/lib/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/account")>()),
  listAccounts: (...a: unknown[]) => listAccounts(...a),
  renameAccount: (...a: unknown[]) => renameAccount(...a),
}));
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
  },
  {
    id: "v-other",
    status: { kind: "Exists" as const },
    label: null,
    icon: null,
    last_unlock: null,
  },
];

beforeEach(() => {
  listAccounts.mockReset().mockResolvedValue([ACCOUNT]);
  renameAccount.mockReset().mockResolvedValue({ ...ACCOUNT, label: "Personal" });
  listVaults.mockReset().mockResolvedValue({ ok: VAULTS });
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
