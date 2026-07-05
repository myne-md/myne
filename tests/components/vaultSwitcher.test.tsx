// @vitest-environment jsdom
//
// Component tests for `src/components/VaultSwitcher.tsx` — the account-chip
// dropdown. Covers the conditional render gates (hide at zero vaults, chip
// label real-vs-fallback), the dropdown open/list, the active-row no-op vs
// non-active switch (onSwitchVault + per-row "switching…" pending caption), the
// "Create another vault" footer, and Esc-to-dismiss. `listVaults` is the only
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

  it("the chip is disabled while a switch is in flight", async () => {
    renderSwitcher(TWO, { switching: true });
    await waitFor(() => expect(screen.getByTestId("switcher.chip")).toBeTruthy());
    expect((screen.getByTestId("switcher.chip") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
