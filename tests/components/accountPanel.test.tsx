// @vitest-environment jsdom
//
// Component tests for `src/components/settings/AccountPanel.tsx` — the
// account-level panel, and only that: the device-local grouping of vaults, the
// person account number that now opens it, and the vaults in it. An account has
// no name to rename (`docs/decisions/ui/0728`). The vault's own controls (label, icon, change
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
const listVaults = vi.fn();
const personAccountNumber = vi.fn();

vi.mock("../../src/lib/account", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/account")>()),
  listAccounts: (...a: unknown[]) => listAccounts(...a),
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
  {
    id: "v-third",
    status: { kind: "Exists" as const },
    label: "Home vault",
    icon: null,
    last_unlock: null,
    published: false,
  },
];

beforeEach(() => {
  listAccounts.mockReset().mockResolvedValue([ACCOUNT]);
  listVaults.mockReset().mockResolvedValue({ ok: VAULTS });
  personAccountNumber.mockReset().mockResolvedValue(null);
});

afterEach(cleanup);

function renderPanel(overrides: Partial<Parameters<typeof AccountPanel>[0]> = {}) {
  const props = { vaultId: "v-active" as string | null, ...overrides };
  render(<AccountPanel {...props} />);
  return props;
}

describe("AccountPanel — the account this vault belongs to", () => {
  it("shows the vaults grouped under the account", async () => {
    renderPanel();
    await screen.findByTestId("settings.account-vaults");
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

// `docs/decisions/ui/0728`: the account name is gone, and the person account
// number took the block it used to open the panel with. Both halves are pinned
// here, because "the number moved up" is a layout claim that no type can make.
describe("AccountPanel — the number took the name's place", () => {
  it("opens with the account number and offers no way to name the account", async () => {
    personAccountNumber.mockResolvedValue("XX95H84N8WE46C6KXRN2");
    renderPanel();
    const number = await screen.findByTestId("settings.account-number-row");
    // Nothing that could set a name survives anywhere on the panel.
    expect(document.querySelector(".account-name-input")).toBeNull();
    expect(screen.queryByTestId("settings.account-name-row")).toBeNull();
    // The number is the FIRST block of the grouping section, ahead of the
    // roster: an ordering a reader sees and a test has to pin, or the block
    // drifts back under the list on the next edit.
    const roster = await screen.findByTestId("settings.account-vaults-row");
    expect(
      number.compareDocumentPosition(roster) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("AccountPanel — states that are not 'an account'", () => {
  it("a standalone vault says so instead of rendering the grouping", async () => {
    listAccounts.mockResolvedValue([]);
    renderPanel();
    await screen.findByTestId("settings.account-standalone");
    expect(screen.queryByTestId("settings.account-number-row")).toBeNull();
    expect(screen.queryByTestId("settings.account-vaults")).toBeNull();
  });

  it("a grouping that cannot be read is an ERROR, never the standalone state", async () => {
    // The distinction is the whole reason the load error is separate state:
    // "this vault has no account" is a claim the panel cannot make when the
    // record could not be read.
    listAccounts.mockRejectedValue({ kind: "Io", io_error_kind: "PermissionDenied" });
    renderPanel();
    await screen.findByTestId("settings.account-error");
    expect(screen.queryByTestId("settings.account-standalone")).toBeNull();
    expect(screen.queryByTestId("settings.account-number-row")).toBeNull();
  });

  it("an unresolved vault id states that rather than guessing", async () => {
    renderPanel({ vaultId: null });
    await screen.findByTestId("settings.account-unresolved");
    expect(screen.queryByTestId("settings.account-number-row")).toBeNull();
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

  it("is a read-out: the roster offers no actions at all", async () => {
    // myne-md/myne#937 removed the move/split pair, and with it the row menu.
    // A two-account record is still RENDERED (it can exist on a device that
    // split before the removal) but nothing about it can be rearranged, so the
    // control that opened the menu must not come back as a bare button.
    const other = { id: "acct-2", vaults: ["v-third"] };
    listAccounts.mockResolvedValue([ACCOUNT, other]);
    renderPanel();
    await screen.findByTestId("settings.account-vaults");
    expect(screen.getAllByTestId("settings.account-vault-row")).toHaveLength(2);
    expect(screen.queryAllByTestId("settings.account-vault-actions")).toHaveLength(0);
    expect(screen.queryByTestId("settings.account-vault-menu")).toBeNull();
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

  // 2026-10-25 owner report: "the Open Sync button there is not needed either".
  // `decisions/ui/0725` item 5 asked for a door INSTEAD of the sentence, and the
  // panel shipped both, over a rail that is on screen the whole time. The sentence
  // stays and the button goes, so this asserts the absence of the second control
  // rather than a click on it.
  it("points at Sync in one sentence and offers no second door", async () => {
    renderPanel();
    const note = await screen.findByTestId("settings.account-devices-note");
    expect(note.textContent).toContain("managed in Sync");
    expect(screen.queryByTestId("settings.account-open-sync")).toBeNull();
  });
});

// 2026-10-23 review: the three arms the roster grew and did not pin.
describe("AccountPanel — the roster's careful arms", () => {
  it("does not claim a state for a vault the list could not read", async () => {
    // The list failure folds to [], so every id in the record is a vault this
    // device did not enumerate. "Device only" would be a claim from no data.
    listVaults.mockResolvedValue({ ok: [] });
    renderPanel();
    await screen.findByTestId("settings.account-vaults");
    const rows = screen.getAllByTestId("settings.account-vault-row");
    expect(rows[0]!.textContent).toContain("Not read on this device");
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
