// @vitest-environment jsdom
//
// Component tests for `src/screens/VaultPicker.tsx` — the ≥2-vault startup
// surface. Scoped to the action block below the vault list: myne#221 added an
// "Add this device to an account" affordance there, and the regression it
// guards is a routing one, not a rendering one. Boot routing produces `welcome`
// only at ZERO vaults, and the join modal used to be mounted on that screen
// alone — so the first vault a user created closed the join door, and this
// screen (which appears only once a second one exists) was one of the two
// places that had no way back to it.
//
// The list state is asserted alongside it because the actions render in TWO
// places: the loaded surface, and the defensive empty/failed one. A join door
// present on only one of them is the same bug in a narrower form.
//
// `listVaults` is the only IPC boundary mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const listVaults = vi.fn();

vi.mock("../../src/lib/vault-list", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/vault-list")>(
    "../../src/lib/vault-list",
  );
  return { ...actual, listVaults: (...a: unknown[]) => listVaults(...a) };
});

import { VaultPicker } from "../../src/screens/VaultPicker";
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

const TWO: VaultSummary[] = [
  summary({ id: "v1", label: "Work", last_unlock: 2000 }),
  summary({ id: "v2", label: "Home", last_unlock: 1000 }),
];

// Three unnamed vaults, i.e. what every row looks like once the device-wide
// hide-vault-names option is on. Ids sort a < b < c; the unlock times run the
// other way, so the old positional fallback and the stable one disagree on
// every row.
const A = "0197c0de-0000-7000-8000-00000000000a";
const B = "0197c0de-0000-7000-8000-00000000000b";
const C = "0197c0de-0000-7000-8000-00000000000c";

function unnamed(id: string, last_unlock: number): VaultSummary {
  return summary({ id, last_unlock });
}

/** The rendered text of the row for `id`. */
function rowText(id: string): string {
  const row = screen
    .getAllByTestId("picker.vault-row")
    .find((el) => el.getAttribute("data-vault-id") === id);
  if (row === undefined) throw new Error(`no row for ${id}`);
  return row.textContent ?? "";
}

beforeEach(() => {
  listVaults.mockReset();
});

afterEach(cleanup);

function renderPicker(list: { ok: VaultSummary[] } | { err: unknown }) {
  listVaults.mockResolvedValue(list);
  const props = {
    onSelect: vi.fn(),
    onCreateAnother: vi.fn(),
    onRestoreBackup: vi.fn(),
    onJoinDevice: vi.fn(),
  };
  const utils = render(<VaultPicker {...props} />);
  return { ...utils, props };
}

describe("VaultPicker — the action block", () => {
  it("offers joining an existing account beside creating another vault", async () => {
    renderPicker({ ok: TWO });
    await screen.findByTestId("picker.create-cta");
    expect(screen.getByTestId("picker.join-cta")).toBeTruthy();
    expect(screen.getByTestId("picker.restore-cta")).toBeTruthy();
  });

  it("the join affordance fires onJoinDevice", async () => {
    const { props } = renderPicker({ ok: TWO });
    fireEvent.click(await screen.findByTestId("picker.join-cta"));
    expect(props.onJoinDevice).toHaveBeenCalledTimes(1);
    // The join door is not a vault selection — the picker must not also route.
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("keeps the join affordance on the defensive empty/failed surface", async () => {
    // The picker is reached only at ≥2 vaults, so an empty list here is an
    // exotic transient — and exactly when a user needs a door out. The
    // affordances render from one shared block precisely so it cannot go
    // missing on the surface that has no rows to fall back on.
    renderPicker({ err: { detail: { io_error_kind: "Other" } } });
    await waitFor(() => expect(screen.getByTestId("picker.join-cta")).toBeTruthy());
    expect(screen.queryAllByTestId("picker.vault-row")).toHaveLength(0);
  });
});

// The "Vault N" fallback, end to end through the screen (myne-md/myne#411).
//
// The unit-level rule lives in `tests/lib/stableVaultNumber.test.ts`; what this
// block adds is that the SCREEN uses it, over the list it actually renders,
// which is the half a passing helper test cannot show.
describe("VaultPicker: the fallback number", () => {
  it("gives a vault the same number across two runs with a different unlock order in between", async () => {
    // Run one: A was opened last.
    renderPicker({
      ok: [unnamed(A, 300), unnamed(B, 200), unnamed(C, 100)],
    });
    await screen.findAllByTestId("picker.vault-row");
    const first = [A, B, C].map(rowText);
    cleanup();

    // Run two: the user opened C in between, so the list comes back in a
    // different order. Every row's number must be what it was.
    renderPicker({
      ok: [unnamed(C, 900), unnamed(A, 300), unnamed(B, 200)],
    });
    await screen.findAllByTestId("picker.vault-row");
    expect([A, B, C].map(rowText)).toEqual(first);
  });

  it("numbers the rows by vault, not by their position on screen", async () => {
    // The concrete rendering, so the assertion above cannot pass by both runs
    // being equally wrong. C is the TOP row here and is Vault 3.
    renderPicker({
      ok: [unnamed(C, 900), unnamed(A, 300), unnamed(B, 200)],
    });
    const rows = await screen.findAllByTestId("picker.vault-row");
    expect(rows.map((el) => el.getAttribute("data-vault-id"))).toEqual([C, A, B]);
    expect(rowText(A)).toContain("Vault 1");
    expect(rowText(B)).toContain("Vault 2");
    expect(rowText(C)).toContain("Vault 3");
  });

  it("never shows two rows the same number", async () => {
    renderPicker({
      ok: [unnamed(C, 900), unnamed(A, 300), unnamed(B, 200)],
    });
    await screen.findAllByTestId("picker.vault-row");
    const numbers = [A, B, C].map(rowText);
    expect(new Set(numbers).size).toBe(3);
  });

  it("still prefers a real name over any number", async () => {
    renderPicker({ ok: TWO });
    await screen.findAllByTestId("picker.vault-row");
    expect(rowText("v1")).toContain("Work");
    expect(rowText("v1")).not.toContain("Vault");
  });
});

// The device-only marker (myne-md/myne#911 task 8).
//
// "Where does this vault actually live" is the one fact this screen can answer
// that the vault itself cannot: a vault that exists only on this machine has no
// copy anywhere else, and before this the fact lived only inside the Sync panel
// of a vault the user had already unlocked. Both directions are asserted, because
// a marker that never clears would read as "nothing is ever published" and one
// that never appears would read as "everything is".
describe("VaultPicker: the publish state", () => {
  it("marks a vault that exists only on this device", async () => {
    renderPicker({
      ok: [
        summary({ id: "v1", label: "Work" }),
        summary({ id: "v2", label: "Home", published: true }),
      ],
    });
    await screen.findAllByTestId("picker.vault-row");
    const markers = () =>
      screen
        .getAllByTestId("picker.vault-row")
        .map((row) => [
          row.getAttribute("data-vault-id"),
          row.querySelector('[data-testid="picker.vault-row-publish"]')?.textContent ?? "",
        ]);
    expect(markers()).toEqual([
      ["v1", "Device only"],
      ["v2", ""],
    ]);
  });
});
