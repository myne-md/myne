// @vitest-environment jsdom
//
// Component tests for `src/components/VaultSwitcher.tsx` — the account-chip
// dropdown. Covers the conditional render gates (hide at zero vaults, chip
// label real-vs-fallback), the dropdown open/list, the active-row no-op vs
// non-active switch (onSwitchVault + per-row "switching…" pending caption), the
// "Create another vault" footer, the optional "Add this device to an account"
// footer beside it (myne#221), and Esc-to-dismiss. `listVaults` is the only
// IPC boundary mocked; `orderByLastUnlock` keeps its real ordering.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listVaults = vi.fn();

vi.mock("../../src/lib/vault-list", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/vault-list")>(
    "../../src/lib/vault-list",
  );
  return { ...actual, listVaults: (...a: unknown[]) => listVaults(...a) };
});

import { VaultSwitcher } from "../../src/components/VaultSwitcher";
import { VAULT_PREFS_CHANGED_EVENT } from "../../src/lib/prefs";
import type { VaultSummary } from "../../src/types/vault-summary";

function summary(over: Partial<VaultSummary> & { id: string }): VaultSummary {
  return {
    status: { kind: "Exists" },
    label: null,
    icon: null,
    last_unlock: null,
    published: false,
    ...over,
  };
}

beforeEach(() => {
  listVaults.mockReset();
});

afterEach(cleanup);

function renderSwitcher(
  vaults: VaultSummary[],
  over: Partial<Parameters<typeof VaultSwitcher>[0]> = {},
) {
  listVaults.mockResolvedValue({ ok: vaults });
  const props = {
    onSwitchVault: vi.fn(),
    onCreateAnother: vi.fn(),
    switching: false,
    ...over,
  };
  const utils = render(<VaultSwitcher {...props} />);
  return { ...utils, props };
}

describe("VaultSwitcher: the invitations row", () => {
  // The failure these pin: an invitation is addressed to a REGISTERED person
  // account, so a device whose identity is `reserved` or `pending` lists nothing.
  // A purely count-driven row therefore showed nothing at all, and the invitee
  // waited in silence. The owner's invitation existed and no surface said why it
  // could not appear. The row is still one row and one door; it just says which
  // state it is in.

  async function openMenu(over: Partial<Parameters<typeof VaultSwitcher>[0]>) {
    renderSwitcher([summary({ id: "v1", label: "Solo", last_unlock: 2000 })], {
      onInvites: vi.fn(),
      ...over,
    });
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    await waitFor(() => expect(screen.getByTestId("switcher.invites-notice")).toBeTruthy());
  }

  it("shows a count when the identity can list its invitations", async () => {
    await openMenu({ inviteCount: 2 });
    const row = screen.getByTestId("switcher.invites-notice");
    expect(row.getAttribute("data-invites")).toBe("count");
    expect(row.textContent).toBe("2 invitations waiting");
  });

  it("keeps the row for an unregistered identity, and opens the same door", async () => {
    const onInvites = vi.fn();
    await openMenu({ inviteCount: 0, invitesUnavailable: "not-enrolled", onInvites });
    const row = screen.getByTestId("switcher.invites-notice");
    expect(row.getAttribute("data-invites")).toBe("not-enrolled");
    expect(row.textContent).toBe("Register this identity to see invitations");
    fireEvent.click(row);
    expect(onInvites).toHaveBeenCalledTimes(1);
  });

  it("says a pending device is waiting for approval rather than offering a remedy", async () => {
    await openMenu({ inviteCount: 0, invitesUnavailable: "pending" });
    const row = screen.getByTestId("switcher.invites-notice");
    expect(row.getAttribute("data-invites")).toBe("pending");
    expect(row.textContent).toBe("Invitations cannot be listed until this device is approved");
  });

  it("renders no row when there is no identity at all", async () => {
    renderSwitcher([summary({ id: "v1", label: "Solo", last_unlock: 2000 })], {
      inviteCount: 0,
      invitesUnavailable: "no-identity",
      onInvites: vi.fn(),
    });
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    await waitFor(() => expect(screen.getByTestId("switcher.create-cta")).toBeTruthy());
    expect(screen.queryByTestId("switcher.invites-notice")).toBeNull();
  });
});

describe("VaultSwitcher — render gates", () => {
  it("renders nothing once the probe returns zero vaults", async () => {
    renderSwitcher([]);
    await waitFor(() => expect(listVaults).toHaveBeenCalled());
    // Empty list → component returns null; the chip never appears.
    await waitFor(() => expect(screen.queryByTestId("switcher.chip")).toBeNull());
  });

  it("renders at exactly one vault (the create-another affordance stays reachable)", async () => {
    renderSwitcher([summary({ id: "v1", label: "Solo" })]);
    await waitFor(() =>
      expect(screen.getByTestId("switcher.chip").textContent).toContain("Solo"),
    );
  });

  it("shows the active vault's real label in the chip", async () => {
    renderSwitcher([
      summary({ id: "v1", label: "Work", last_unlock: 2000 }),
      summary({ id: "v2", label: "Home", last_unlock: 1000 }),
    ]);
    // Top of last-unlock ordering (v1) is the active chip label.
    await waitFor(() =>
      expect(screen.getByTestId("switcher.chip").textContent).toContain("Work"),
    );
  });

  it("falls back to 'Vault 1' when the active vault has no label", async () => {
    renderSwitcher([
      summary({ id: "v1", label: null, last_unlock: 2000 }),
      summary({ id: "v2", label: null, last_unlock: 1000 }),
    ]);
    await waitFor(() =>
      expect(screen.getByTestId("switcher.chip").textContent).toContain(
        "Vault 1",
      ),
    );
  });

  it("renders the active vault's icon glyph in the chip mark", async () => {
    renderSwitcher([
      summary({ id: "v1", label: "Work", icon: "book", last_unlock: 2000 }),
    ]);
    await waitFor(() =>
      expect(
        screen.getByTestId("switcher.chip-mark").getAttribute("data-icon"),
      ).toBe("book"),
    );
  });

  it("falls back to the wordmark when the active vault has no icon", async () => {
    renderSwitcher([summary({ id: "v1", label: "Work", last_unlock: 2000 })]);
    await waitFor(() =>
      expect(
        screen.getByTestId("switcher.chip-mark").getAttribute("data-icon"),
      ).toBe("wordmark"),
    );
  });

  it("falls back to the wordmark for an unknown/stale glyph name", async () => {
    renderSwitcher([
      summary({
        id: "v1",
        label: "Work",
        icon: "not-a-real-glyph",
        last_unlock: 2000,
      }),
    ]);
    await waitFor(() =>
      expect(
        screen.getByTestId("switcher.chip-mark").getAttribute("data-icon"),
      ).toBe("wordmark"),
    );
  });

  it("live-refreshes the chip when a vault-prefs-changed event fires", async () => {
    // Mount with no icon → wordmark. A prefs write elsewhere (Settings) fires
    // VAULT_PREFS_CHANGED_EVENT; the switcher re-probes and picks up the glyph
    // without the dropdown ever being opened.
    renderSwitcher([summary({ id: "v1", label: "Work", last_unlock: 2000 })]);
    await waitFor(() =>
      expect(
        screen.getByTestId("switcher.chip-mark").getAttribute("data-icon"),
      ).toBe("wordmark"),
    );

    // Backend now reports the vault carrying the "book" icon.
    listVaults.mockResolvedValue({
      ok: [summary({ id: "v1", label: "Work", icon: "book", last_unlock: 2000 })],
    });
    fireEvent(window, new CustomEvent(VAULT_PREFS_CHANGED_EVENT));

    await waitFor(() =>
      expect(
        screen.getByTestId("switcher.chip-mark").getAttribute("data-icon"),
      ).toBe("book"),
    );
  });
});

describe("VaultSwitcher — dropdown", () => {
  const TWO = [
    summary({ id: "v1", label: "Work", last_unlock: 2000 }),
    summary({ id: "v2", label: "Home", last_unlock: 1000 }),
  ];

  it("clicking the chip lists every vault as a menu row", async () => {
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const rows = await screen.findAllByTestId("switcher.vault-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-vault-id")).toBe("v1");
    expect(rows[0].getAttribute("data-active")).toBe("true");
    expect(rows[1].getAttribute("data-active")).toBe("false");
  });

  it("selecting the active row is a no-op (no onSwitchVault), just closes", async () => {
    const { props } = renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const rows = await screen.findAllByTestId("switcher.vault-row");
    fireEvent.click(rows[0]); // active vault
    expect(props.onSwitchVault).not.toHaveBeenCalled();
  });

  it("selecting a non-active row fires onSwitchVault with that id", async () => {
    const { props } = renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const rows = await screen.findAllByTestId("switcher.vault-row");
    fireEvent.click(rows[1]); // Home
    expect(props.onSwitchVault).toHaveBeenCalledWith("v2");
  });

  it("the just-selected row shows the 'switching…' caption while switching", async () => {
    // Re-render with switching=true after selecting drives the pending caption,
    // but the pendingId is set on click; assert the caption appears on rerender.
    const { rerender, props } = renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const rows = await screen.findAllByTestId("switcher.vault-row");
    fireEvent.click(rows[1]);
    expect(props.onSwitchVault).toHaveBeenCalledWith("v2");
    // App flips `switching` true; re-open the menu to inspect the pending row.
    rerender(
      <VaultSwitcher
        onSwitchVault={props.onSwitchVault}
        onCreateAnother={props.onCreateAnother}
        switching
      />,
    );
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const reopened = await screen.findAllByTestId("switcher.vault-row");
    const homeRow = reopened.find((r) => r.getAttribute("data-vault-id") === "v2")!;
    expect(homeRow.textContent).toContain("switching…");
  });

  it("the create-another footer fires onCreateAnother and closes", async () => {
    const { props } = renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const cta = await screen.findByTestId("switcher.create-cta");
    fireEvent.click(cta);
    expect(props.onCreateAnother).toHaveBeenCalledTimes(1);
  });

  // myne#221's join-device footer is GONE (`decisions/sync/0767`). Asserted as
  // an absence rather than deleted silently: a second way into a vault is
  // exactly what came back the last time this block was tidied, and the
  // invitations row above is the one door that installs a vault now.
  it("offers no join-device footer", async () => {
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    await screen.findByTestId("switcher.create-cta");
    expect(screen.queryByTestId("switcher.join-cta")).toBeNull();
  });

  // Absent, not disabled: a client that cannot hold a second vault container
  // gets no callback from App.tsx, and must lose the ROW — not the switcher.
  it("omits the join row when no callback is wired, keeping create reachable", async () => {
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    await screen.findByTestId("switcher.create-cta");
    expect(screen.queryByTestId("switcher.join-cta")).toBeNull();
  });

  it("Escape closes the open dropdown", async () => {
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    await screen.findAllByTestId("switcher.vault-row");
    fireEvent.keyDown(window, { key: "Escape" });
    // After Esc the menu unmounts (allowing for the close transition timeout).
    await waitFor(
      () => expect(screen.queryByTestId("switcher.create-cta")).toBeNull(),
      { timeout: 1000 },
    );
  });

  // ── keyboard operability (myne-md/myne#728, task 8) ─────────────────────
  //
  // The menu was a DEAD END: the chip is a button, so a keyboard user could
  // open it, and then reach nothing at all. Focus stayed on the chip and the
  // rows carried no key handling, so the only exits were Escape and the mouse.

  it("moves focus into the menu when it opens", async () => {
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const rows = await screen.findAllByTestId("switcher.vault-row");
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
  });

  it("opens from the chip on Down, which is the menu-button pattern", async () => {
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.keyDown(screen.getByTestId("switcher.chip"), { key: "ArrowDown" });
    const rows = await screen.findAllByTestId("switcher.vault-row");
    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
  });

  it("cycles the rows with the arrows, wrapping at both ends", async () => {
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const menu = await screen.findByRole("menu");
    const items = (): HTMLElement[] =>
      Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    await waitFor(() => expect(document.activeElement).toBe(items()[0]));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items().at(-1));
    // A menu wraps, unlike the sidebar tree: it is short and the user cannot
    // lose their place in it.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items()[0]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items().at(-1));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items()[0]);
  });

  it("names the menu, so it is not an unlabelled group of rows", async () => {
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const menu = await screen.findByRole("menu");
    expect(menu.getAttribute("aria-label")).toBeTruthy();
  });

  it("Tab closes the menu instead of trapping the user in it", async () => {
    // A menu is not a dialog. Trapping Tab here would leave a keyboard user
    // inside a popover with no visible way out, which is worse than the dead
    // end being fixed.
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Tab" });
    await waitFor(
      () => expect(screen.queryByTestId("switcher.create-cta")).toBeNull(),
      { timeout: 1000 },
    );
  });

  it("returns focus to the chip when Escape closes the menu", async () => {
    // Without this, Escape leaves focus on `<body>` and the next Tab starts
    // from the top of the document rather than from where the user was.
    renderSwitcher(TWO);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    await screen.findAllByTestId("switcher.vault-row");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(
      () => expect(document.activeElement).toBe(screen.getByTestId("switcher.chip")),
      { timeout: 1000 },
    );
  });

  it("the chip is disabled while a switch is in flight", async () => {
    renderSwitcher(TWO, { switching: true });
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    expect((screen.getByTestId("switcher.chip") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

// Whether the vault in the row exists anywhere but this machine
// (myne-md/myne#911 task 8). The switcher is how a user moves between vaults
// mid-session, so it is a place the fact has to be readable; both directions are
// asserted because a marker that never clears reads as "nothing is published".
describe("VaultSwitcher: the publish state", () => {
  it("marks only the rows that exist on this device alone", async () => {
    renderSwitcher([
      summary({ id: "v1", label: "Work" }),
      summary({ id: "v2", label: "Home", published: true }),
    ]);
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    fireEvent.click(screen.getByTestId("switcher.chip"));
    const rows = await screen.findAllByTestId("switcher.vault-row");
    const row = (id: string) => {
      const found = rows.find((r) => r.getAttribute("data-vault-id") === id);
      if (found === undefined) throw new Error(`no row for ${id}`);
      return found;
    };
    // The state itself, not only its wording: a copy edit must not be able to
    // make this test pass while the marker disappears.
    expect(row("v1").getAttribute("data-publish")).toBe("device-only");
    expect(row("v1").textContent).toContain("Device only");
    expect(row("v2").getAttribute("data-publish")).toBe("published");
    expect(row("v2").textContent).not.toContain("Device only");
  });
});
