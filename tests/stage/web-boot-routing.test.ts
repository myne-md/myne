// Boot routing differs per client, and it differs where getting it wrong
// dead-ends the user (phase3-web-client task 85).
//
// Desktop's mapping is right for desktop and wrong for a browser in two places:
//
//   - **empty** is "no vault yet, make one" on desktop and "this browser has
//     not been told which account to pull" on web. Routing to `welcome` there
//     offers vault CREATION, which the web client does not have — a dead end
//     dressed as a call to action.
//   - **corrupted** routes to the fail-closed surface whose CTA is "restore
//     from a backup". On web that remedy does not exist (backup is an absent
//     capability) while the real one — re-enter the account number and re-sync —
//     is one screen away. `decisions.md` 2026-07-26 is explicit that a web
//     client treats this as re-bootstrap, never as data loss, because every byte
//     is on the server.
//
// Both are asserted from the CAPABILITY answers rather than from a "web" flag,
// because that is what the code branches on: a future client with the same
// capability shape gets the same routing without anyone editing this file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The capabilities the two clients actually declare (mirrors their descriptors). */
const DESKTOP_ABSENT: string[] = [];
const WEB_ABSENT = ["vaultCreation", "phraseRecovery", "backup", "nativeSaveAs", "clipper"];

async function loadStage(absent: string[]) {
  vi.resetModules();
  vi.doMock("../../src/platform/capabilities", () => ({
    has: (cap: string) => !absent.includes(cap),
  }));
  return import("../../src/lib/stage");
}

const EXISTS = { kind: "Exists" } as const;
const CORRUPTED = { kind: "Corrupted" } as const;

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock("../../src/platform/capabilities");
});

describe("boot routing, per client", () => {
  it("desktop: an empty disk is the create-a-vault path", async () => {
    const { initialStageFromProbe } = await loadStage(DESKTOP_ABSENT);
    expect(initialStageFromProbe({ ok: [] }, {})).toEqual({ name: "welcome" });
  });

  it("web: an empty container asks WHICH ACCOUNT, not which vault to create", async () => {
    const { initialStageFromProbe } = await loadStage(WEB_ABSENT);
    expect(initialStageFromProbe({ ok: [] }, {})).toEqual({ name: "account-entry" });
  });

  it("desktop: a corrupted vault is fail-closed, with the backup remedy", async () => {
    const { initialStageFromProbe } = await loadStage(DESKTOP_ABSENT);
    expect(
      initialStageFromProbe({ ok: [{ id: "v1", status: CORRUPTED }] } as never, {}),
    ).toEqual({ name: "unlock", initialStatus: CORRUPTED, vaultId: "v1" });
  });

  it("web: a corrupted container is a re-bootstrap, not a dead end", async () => {
    const { initialStageFromProbe } = await loadStage(WEB_ABSENT);
    // The remedy the desktop surface offers does not exist here, and the one
    // that does is the account-number step.
    expect(
      initialStageFromProbe({ ok: [{ id: "v1", status: CORRUPTED }] } as never, {}),
    ).toEqual({ name: "account-entry" });
  });

  it("a healthy vault unlocks the same way on both", async () => {
    for (const absent of [DESKTOP_ABSENT, WEB_ABSENT]) {
      const { initialStageFromProbe } = await loadStage(absent);
      expect(
        initialStageFromProbe({ ok: [{ id: "v1", status: EXISTS }] } as never, {}),
      ).toEqual({ name: "unlock", initialStatus: EXISTS, vaultId: "v1" });
    }
  });

  it("a live slot still wins over disk state on both", async () => {
    // The slot-priority rule predates this change and must not have moved: an
    // unlocked runtime slot pins the stage regardless of what the container
    // looks like.
    for (const absent of [DESKTOP_ABSENT, WEB_ABSENT]) {
      const { initialStageFromProbe } = await loadStage(absent);
      expect(initialStageFromProbe({ ok: [] }, { v1: "Unlocked" } as never)).toEqual({
        name: "editor",
      });
      expect(initialStageFromProbe({ ok: [] }, { v1: "Recovering" } as never)).toEqual({
        name: "recover",
        subStep: "password-reset",
      });
    }
  });

  it("an IO failure stays fail-closed on both — it is not an empty container", async () => {
    // The distinction that matters: "cannot read the store" and "the store is
    // empty" have opposite recoveries, and routing a read failure to the
    // account-number step would ask the user to re-enrol over a working vault.
    for (const absent of [DESKTOP_ABSENT, WEB_ABSENT]) {
      const { initialStageFromProbe } = await loadStage(absent);
      const stage = initialStageFromProbe(
        { err: { kind: "IoError", detail: { io_error_kind: "PermissionDenied" } } } as never,
        {},
      );
      expect(stage).toEqual({
        name: "unlock",
        initialStatus: { kind: "IoError", ioKind: "PermissionDenied" },
      });
    }
  });
});
