// @vitest-environment jsdom
//
// The fail-closed screen's restore door, per platform (phase3-web-client
// task 70).
//
// Boot routing keeps a web client away from the `corrupted-vault` surface
// entirely — `initialStageFromProbe` sends a corrupt container to
// `account-entry` when `backup` is absent, because on a client whose vault came
// from a server a damaged local container is a re-sync, not data loss. But
// that is only the BOOT door. The other one is a runtime failure: an
// `InvalidVaultMeta` arriving mid-unlock switches `Unlock` to
// `corrupted-after-unlock`, on any platform, and that path rendered "Restore
// from a backup" on a client where every `backup_*` command answers
// `Unsupported`.
//
// An offer the platform cannot honour is precisely what "absent, not disabled"
// forbids (`decisions.md` 2026-07-26) — and it is worse than a disabled control
// here, because the user is already looking at a failure screen and this is the
// only remedy it names.

import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

async function renderWith(absent: string[]) {
  vi.resetModules();
  vi.doMock("../../src/platform/capabilities", () => ({
    has: (cap: string) => !absent.includes(cap),
  }));
  const { FailClosedError } = await import("../../src/components/FailClosedError");
  render(
    <FailClosedError
      reason={{ kind: "corrupted-vault" }}
      onCtaClick={() => {}}
      onRestoreBackup={() => {}}
    />,
  );
}

describe("the corrupted-vault surface", () => {
  it("offers the restore door where backup exists", async () => {
    await renderWith([]);
    expect(screen.queryByTestId("fail-closed.restore-cta")).toBeTruthy();
    cleanup();
  });

  it("omits it where backup is absent, rather than showing a dead button", async () => {
    await renderWith(["backup"]);
    expect(screen.queryByTestId("fail-closed.restore-cta")).toBeNull();
    // The screen itself must still render — the failure is real and the user
    // needs to be told about it; what changes is which remedy it names.
    expect(screen.queryByTestId("fail-closed.root")).toBeTruthy();
    cleanup();
  });
});
