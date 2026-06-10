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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("App boot probe (story 12: the IPC pair fires exactly once)", () => {
  it("StrictMode double-effect collapses to one vault_list + one vault_slot_kind", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:vault-unlock|vault_list") return [];
      if (cmd === "plugin:vault-unlock|vault_slot_kind") return "Empty";
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
  });
});
