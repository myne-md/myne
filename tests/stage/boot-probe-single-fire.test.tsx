// @vitest-environment jsdom
//
// Boot-probe single-fire (MYND-127 task 6 — the SM-9 replacement,
// story 12).
//
// SM-9 (StrictMode double-probe) was dropped from E2E: the production
// bundle exposes NO post-hoc probe counter (WebKitGTK records no
// resource-timing entry for the `ipc://` scheme — container-verified —
// and the binary initializes no tracing subscriber), and adding one
// would be a test hook (SYNC-3). The single-fire contract is therefore
// pinned HERE, at the seam that owns it: App.tsx's `probed` ref must
// collapse StrictMode's double-effect into exactly one boot-probe IPC
// pair.

import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { cleanup, render, screen } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

import App from "../../src/App";
import {
  getPersonIdentityState,
  resetPersonIdentityState,
} from "../../src/components/sync/personIdentityState";

afterEach(() => {
  cleanup();
  resetPersonIdentityState();
  vi.clearAllMocks();
});

describe("App boot probe (story 12: the IPC pair fires exactly once)", () => {
  it("StrictMode double-effect collapses to one vault_list + one vault_slot_kind", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:vault-unlock|vault_list") return [];
      if (cmd === "plugin:vault-unlock|vault_slot_kind") return "Empty";
      // The vault-less identity probe (myne-md/myne#711): a fresh device holds
      // no person account, so the welcome arm renders.
      if (cmd === "plugin:sync|sync_person_status") {
        return {
          enrolled: false,
          state: null,
          identity_unlocked: false,
          person_id_hex: null,
          identity_code: null,
          sealed_keypair_present: false,
        };
      }
      return undefined;
    });

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );

    // Probe resolved: 0 vaults + all-Empty slots → welcome.
    await screen.findByTestId("welcome.root");

    const probeCalls = invokeMock.mock.calls.map(([cmd]) => cmd);
    expect(probeCalls.filter((c) => c === "plugin:vault-unlock|vault_list")).toHaveLength(1);
    expect(probeCalls.filter((c) => c === "plugin:vault-unlock|vault_slot_kind")).toHaveLength(1);
    // The third boot probe shares the same `probed` guard, so it too must fire
    // exactly once: without this the guard could be moved off it silently.
    expect(probeCalls.filter((c) => c === "plugin:sync|sync_person_status")).toHaveLength(1);
  });

  it("hydrates person readiness from the runtime status probe", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:vault-unlock|vault_list") return [];
      if (cmd === "plugin:vault-unlock|vault_slot_kind") return "Empty";
      if (cmd === "plugin:sync|sync_person_status") {
        return {
          enrolled: true,
          state: "enrolled",
          identity_unlocked: true,
          person_id_hex: "11".repeat(16),
          identity_code: "MYNE-PERSON-1:runtime",
          sealed_keypair_present: true,
        };
      }
      if (cmd === "plugin:sync|sync_person_list_invites") return [];
      return undefined;
    });

    render(<App />);
    await screen.findByTestId("identity-home.root");

    expect(getPersonIdentityState()).toEqual({
      ready: true,
      ownerCode: "MYNE-PERSON-1:runtime",
    });
  });

  it("routes a RESERVED identity to the identity home, not the welcome screen", async () => {
    // myne-md/myne#911's zero-vault acceptance line. A `reserved` identity has
    // no token by definition, so the old `enrolled` gate sent it to Welcome,
    // where "Create an identity" is guaranteed to fail (the device already holds
    // a sealed frame it did not write).
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:vault-unlock|vault_list") return [];
      if (cmd === "plugin:vault-unlock|vault_slot_kind") return "Empty";
      if (cmd === "plugin:sync|sync_person_status") {
        return {
          enrolled: false,
          state: "reserved",
          identity_unlocked: true,
          person_id_hex: "22".repeat(16),
          identity_code: "MYNE-PERSON-1:reserved",
          sealed_keypair_present: true,
        };
      }
      if (cmd === "plugin:sync|sync_person_list_invites") return [];
      return undefined;
    });

    render(<App />);
    await screen.findByTestId("identity-home.root");
    expect(screen.queryByTestId("welcome.root")).toBeNull();
  });
});
