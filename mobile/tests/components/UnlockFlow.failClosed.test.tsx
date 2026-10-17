// @vitest-environment jsdom
//
// The corrupted-vault fail-closed surface (audit T6.8).
//
// What is under test is that the screen no longer NAMES a route it does not
// provide: it showed "Restore from a backup to continue." with only a close-app
// CTA. The corrupted case now offers a restore route (to mobile's honest
// placeholder) and says, in the hint, that restore is not on mobile yet; an IO
// error is a transient read failure and keeps no restore route.
//
// Only the corrupted / IoError branches are exercised, so the flow's IPC
// effects early-return (`!HAS_TAURI || kind !== "Exists"`) and nothing is
// mocked beyond i18n.

import "@myne/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { UnlockFlow } from "../../src/app/flows/UnlockFlow";

afterEach(cleanup);

const noop = () => {};

function renderCorrupted(over: Partial<Parameters<typeof UnlockFlow>[0]> = {}) {
  return render(
    <UnlockFlow
      initialStatus={{ kind: "Corrupted" }}
      onUnlocked={noop}
      onStartRecovery={noop}
      onDeleteVaultSuccess={noop}
      {...over}
    />,
  );
}

describe("UnlockFlow fail-closed", () => {
  it("renders the fail-closed surface for a corrupted vault", () => {
    renderCorrupted();
    expect(screen.getByTestId("unlock-fail-closed")).toBeTruthy();
  });

  it("offers the restore route, and it calls onRestoreBackup", () => {
    const onRestoreBackup = vi.fn();
    renderCorrupted({ onRestoreBackup });
    const btn = screen.getByTestId("unlock-restore-backup");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onRestoreBackup).toHaveBeenCalledTimes(1);
  });

  it("shows no restore route when the caller passes none", () => {
    renderCorrupted();
    expect(screen.queryByTestId("unlock-restore-backup")).toBeNull();
  });

  it("keeps the restore route off the IO-error surface", () => {
    render(
      <UnlockFlow
        initialStatus={{ kind: "IoError", ioKind: "Other" }}
        onUnlocked={noop}
        onStartRecovery={noop}
        onRestoreBackup={vi.fn()}
        onDeleteVaultSuccess={noop}
      />,
    );
    expect(screen.getByTestId("unlock-fail-closed")).toBeTruthy();
    expect(screen.queryByTestId("unlock-restore-backup")).toBeNull();
  });
});
