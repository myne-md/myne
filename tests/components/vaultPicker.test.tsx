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
    ...over,
  };
}

const TWO: VaultSummary[] = [
  summary({ id: "v1", label: "Work", last_unlock: 2000 }),
  summary({ id: "v2", label: "Home", last_unlock: 1000 }),
];

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
