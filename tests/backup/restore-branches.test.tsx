// @vitest-environment jsdom
//
// RestoreBackup's five non-happy steps (test-audit #3).
//
// WHAT WAS UNCOVERED. `RestoreBackup` is a six-step state machine and only the
// happy path had a test anywhere — not here, not in the desktop E2E suite, not
// in the web one. The five that had nothing are collision, damaged, salvage,
// summary and error, and two of them are LOSSY:
//
//   - `replace-existing` destroys the vault already on this device;
//   - `salvage` restores a backup the engine has declared damaged, i.e. accepts
//     whatever survived and drops the rest.
//
// A user reaches both only from a recovery flow, which is exactly the moment
// there is no second copy to fall back on.
//
// WHAT IS ACTUALLY PINNED, and it is not "the buttons render". The thing that
// can go wrong silently is the WIRING: which intent each button sends. Swap the
// two collision handlers and every screen still looks right, every label still
// reads right, and a user who chose "keep both" loses the vault they were
// protecting. No compiler, lint or type sees that — both branches take the same
// `CollisionIntent` union — so it is pinned here by asserting the exact options
// object each button hands the backend.
//
// The error branch matters for a different reason: `DamagedBackup` maps to the
// damaged step ONLY when salvage was not already requested. Without that guard
// a failing salvage would loop the user back to the same offer forever, and the
// real failure would never be shown. That condition is asserted directly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/** Every call the screen makes into the backup engine, recorded. */
const restoreCalls: Array<{ source: string; options: unknown }> = [];
/** What the next `restoreBackup` does: resolve, or throw this. */
let nextFailure: { kind: string; detail?: Record<string, unknown> } | null = null;

vi.mock("../../src/lib/vault-backup", () => ({
  restoreBackup: async (source: string, options?: unknown) => {
    restoreCalls.push({ source, options: options ?? null });
    if (nextFailure !== null) {
      const err = nextFailure;
      nextFailure = null;
      throw err;
    }
    // The real `RestoreOutcome` shape — the screen reads all four, and a
    // wrong shape here makes the component throw rather than fail an
    // assertion, which is how the first draft of this file was caught.
    return { notes: 3, snapshots: 2, attachments: 1, skipped: [] };
  },
  onBackupProgress: async () => () => {},
  backupCancel: async () => {},
}));

/** The picker is a native dialog; hand the screen a path without one. */
const PICKED = "/tmp/fixture.myne-backup";
vi.mock("../../src/platform/dialog", () => ({
  open: async () => PICKED,
}));

const { RestoreBackup } = await import("../../src/screens/RestoreBackup");

/** Drive the flow from the start: click "choose a file", which resolves to
 *  PICKED and runs the restore that `nextFailure` decides the fate of. */
async function pickAndRun(): Promise<void> {
  render(<RestoreBackup entry="settings" onExit={() => {}} />);
  const pick = await waitFor(() => screen.getByTestId("restore.pick-file"));
  pick.click();
}

beforeEach(() => {
  restoreCalls.length = 0;
  nextFailure = null;
});
afterEach(cleanup);

describe("RestoreBackup branches (test-audit #3)", () => {
  it("a clean restore lands on the summary", async () => {
    await pickAndRun();
    await waitFor(() => expect(screen.getByTestId("restore.summary")).toBeTruthy());
    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]?.options, "the first attempt carries no intent").toBeNull();
  });

  it("an existing vault raises the collision step, offering BOTH ways out", async () => {
    nextFailure = { kind: "VaultAlreadyExists", detail: { vault_id: "v-existing" } };
    await pickAndRun();
    await waitFor(() => expect(screen.getByTestId("restore.collision")).toBeTruthy());
    expect(screen.queryByTestId("restore.keep-both")).toBeTruthy();
    expect(screen.queryByTestId("restore.replace-existing")).toBeTruthy();
  });

  it("keep-both sends keep-both, and NOT the destructive intent", async () => {
    nextFailure = { kind: "VaultAlreadyExists", detail: { vault_id: "v-existing" } };
    await pickAndRun();
    (await waitFor(() => screen.getByTestId("restore.keep-both"))).click();
    await waitFor(() => expect(restoreCalls).toHaveLength(2));
    expect(
      restoreCalls[1]?.options,
      "a user who chose to keep both must not have the existing vault replaced",
    ).toEqual({ on_collision: "keep-both" });
  });

  it("replace-existing sends replace-existing, and only when chosen", async () => {
    nextFailure = { kind: "VaultAlreadyExists", detail: { vault_id: "v-existing" } };
    await pickAndRun();
    (await waitFor(() => screen.getByTestId("restore.replace-existing"))).click();
    await waitFor(() => expect(restoreCalls).toHaveLength(2));
    expect(restoreCalls[1]?.options).toEqual({ on_collision: "replace-existing" });
  });

  it("a damaged backup raises the damaged step with the salvage offer", async () => {
    nextFailure = { kind: "DamagedBackup" };
    await pickAndRun();
    await waitFor(() => expect(screen.getByTestId("restore.damaged")).toBeTruthy());
    expect(screen.queryByTestId("restore.salvage")).toBeTruthy();
  });

  it("salvage re-runs with salvage set", async () => {
    nextFailure = { kind: "DamagedBackup" };
    await pickAndRun();
    (await waitFor(() => screen.getByTestId("restore.salvage"))).click();
    await waitFor(() => expect(restoreCalls).toHaveLength(2));
    expect(restoreCalls[1]?.options).toEqual({ salvage: true });
  });

  it("a salvage that ALSO fails shows the error, not the same offer again", async () => {
    // The `&& !options?.salvage` guard. Without it the user is returned to the
    // salvage button they just pressed, forever, and never sees why it failed.
    nextFailure = { kind: "DamagedBackup" };
    await pickAndRun();
    (await waitFor(() => screen.getByTestId("restore.salvage"))).click();
    await waitFor(() => expect(restoreCalls).toHaveLength(2));
    // The second attempt was told to salvage and the mock resolves, so this
    // reaches the summary. Re-run the same flow with the salvage attempt ALSO
    // failing to exercise the guard itself.
    cleanup();
    restoreCalls.length = 0;
    nextFailure = { kind: "DamagedBackup" };
    await pickAndRun();
    (await waitFor(() => screen.getByTestId("restore.damaged")), null);
    nextFailure = { kind: "DamagedBackup" };
    (await waitFor(() => screen.getByTestId("restore.salvage"))).click();
    await waitFor(() => expect(screen.queryByTestId("restore.error")).toBeTruthy());
    expect(
      screen.queryByTestId("restore.damaged"),
      "a failed salvage must not loop back to the offer that just failed",
    ).toBeNull();
  });

  it("any other failure reaches the error step rather than a dead screen", async () => {
    // A real `BackupRestoreError` kind that is neither collision nor
    // damaged — the "everything else" arm.
    nextFailure = { kind: "NotABackupFile" };
    await pickAndRun();
    await waitFor(() => expect(screen.getByTestId("restore.error")).toBeTruthy());
  });
});
