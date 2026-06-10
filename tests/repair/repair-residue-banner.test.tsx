// @vitest-environment jsdom
//
// MYND-226 — RepairResidueBanner phase machine + copy literals,
// **downgraded from E2E** per the e2e/CLAUDE.md unreachable-state rule:
// the banner mounts only on Welcome (0 vaults), but the residue state it
// was built for (MYND-159: a partial-fail `vault_delete` leaving files
// next to a deleted `vault.meta`) is no longer reachable through the
// production boot in the multi-vault layout —
//
//   - the eager boot migration (`vault_migration.rs`) consumes ANY
//     legacy `vault/` directory before the UI mounts: artefact-bearing
//     residue is migrated into `vaults/<id>/`, junk-only residue leaves
//     a partial `vaults/<id>/` behind on the verify-fail path;
//   - either way `discover_vaults` then lists a non-well-formed
//     `vaults/<id>/` → Corrupted → the boot routes to the fail-closed
//     surface (sole CTA "Close app"), never to Welcome;
//   - today's `vault_delete` targets `vaults/<id>/` directly, so its
//     partial-fail residue takes the same Corrupted path.
//
// The reachability gap is recorded on the Plane item; this suite pins
// the component's contract (phase transitions, full-literal copy,
// pluralization, IPC discipline) so the banner is ready the day its
// trigger is rehomed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import { RepairResidueBanner } from "../../src/components/RepairResidueBanner";
import type { VaultRepairError } from "../../src/types/vault-repair-error";

const SCAN_CMD = "plugin:vault-repair|vault_residue_scan";
const REPAIR_CMD = "plugin:vault-repair|vault_repair";

/** Mock the scan result (or rejection) and, optionally, the repair
 *  outcome: a number resolves, a VaultRepairError rejects. */
function mockIpc(opts: {
  scan: number | "reject";
  repair?: number | VaultRepairError;
}): void {
  invokeMock.mockImplementation((cmd) => {
    if (cmd === SCAN_CMD) {
      return opts.scan === "reject"
        ? Promise.reject({ kind: "Io", detail: { io_error_kind: "Other" } })
        : Promise.resolve(opts.scan);
    }
    if (cmd === REPAIR_CMD) {
      if (typeof opts.repair === "number") return Promise.resolve(opts.repair);
      if (opts.repair) return Promise.reject(opts.repair);
      return new Promise(() => {}); // unconfigured: hang (sweeping-phase asserts)
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

function repairCalls(): number {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === REPAIR_CMD).length;
}

const banner = () => screen.queryByTestId("repair-residue.banner");

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("mount probe", () => {
  it("renders nothing on a clean device (scan → 0)", async () => {
    mockIpc({ scan: 0 });
    render(<RepairResidueBanner />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(SCAN_CMD, undefined));
    expect(banner()).toBeNull();
  });

  it("renders nothing when the scan rejects (non-fatal probe)", async () => {
    mockIpc({ scan: "reject" });
    render(<RepairResidueBanner />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith(SCAN_CMD, undefined));
    expect(banner()).toBeNull();
  });

  it("surfaces the FOUND copy with the true count (full literal, plural)", async () => {
    mockIpc({ scan: 3 });
    render(<RepairResidueBanner />);
    expect(
      await screen.findByText("Leftover files from an incomplete deletion"),
    ).toBeDefined();
    expect(
      screen.getByText(
        "3 leftover files from a previous deletion that didn't finish. They're already unreadable — you won't lose anything recoverable.",
      ),
    ).toBeDefined();
  });

  it("singular count drops the plural s", async () => {
    mockIpc({ scan: 1 });
    render(<RepairResidueBanner />);
    expect(
      await screen.findByText(
        "1 leftover file from a previous deletion that didn't finish. They're already unreadable — you won't lose anything recoverable.",
      ),
    ).toBeDefined();
  });
});

describe("confirm → sweep happy path", () => {
  it("found → confirming → done, with repair fired exactly once on the explicit confirm", async () => {
    mockIpc({ scan: 2, repair: 2 });
    render(<RepairResidueBanner />);

    // found → confirming (no IPC yet — the first click only asks).
    fireEvent.click(await screen.findByText("Clean up"));
    expect(screen.getByText("Clean up leftover files?")).toBeDefined();
    expect(
      screen.getByText(
        "2 files will be removed. They're already unreadable; nothing recoverable is lost.",
      ),
    ).toBeDefined();
    expect(repairCalls()).toBe(0);

    // confirming → sweeping → done.
    fireEvent.click(screen.getByText("Clean up"));
    expect(await screen.findByText("Cleaned up")).toBeDefined();
    expect(
      screen.getByText("Removed 2 leftover files. You can create a new vault now."),
    ).toBeDefined();
    expect(repairCalls()).toBe(1);
    // Terminal phase: no CTAs remain.
    expect(screen.queryByText("Clean up")).toBeNull();
  });

  it("cancel returns to found without ever firing repair", async () => {
    mockIpc({ scan: 2 });
    render(<RepairResidueBanner />);
    fireEvent.click(await screen.findByText("Clean up"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(
      screen.getByText("Leftover files from an incomplete deletion"),
    ).toBeDefined();
    expect(repairCalls()).toBe(0);
  });

  it("sweeping disables both CTAs while the IPC is in flight", async () => {
    mockIpc({ scan: 2 }); // repair unconfigured → pending forever
    render(<RepairResidueBanner />);
    fireEvent.click(await screen.findByText("Clean up"));
    fireEvent.click(screen.getByText("Clean up"));
    const busy = await screen.findByText("Cleaning up…");
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Cancel") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("failure mapping", () => {
  it("PartialDelete maps to the manual-cleanup copy with the remaining count", async () => {
    mockIpc({
      scan: 4,
      repair: { kind: "PartialDelete", detail: { remaining_count: 3 } },
    });
    render(<RepairResidueBanner />);
    fireEvent.click(await screen.findByText("Clean up"));
    fireEvent.click(screen.getByText("Clean up"));
    expect(await screen.findByText("Some files couldn't be removed")).toBeDefined();
    expect(
      screen.getByText(
        "3 files may be locked by another app (antivirus, file sync, or search indexing). Close the app and try again in a moment, or remove the vault folder manually.",
      ),
    ).toBeDefined();
  });

  it("any other rejection maps to the generic error copy", async () => {
    mockIpc({ scan: 4, repair: { kind: "VaultBusyAuth" } });
    render(<RepairResidueBanner />);
    fireEvent.click(await screen.findByText("Clean up"));
    fireEvent.click(screen.getByText("Clean up"));
    expect(await screen.findByText("Cleanup failed")).toBeDefined();
    expect(
      screen.getByText("Something went wrong. Close the app and try again."),
    ).toBeDefined();
  });
});
