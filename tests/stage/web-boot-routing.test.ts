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

  // ── awaiting approval (MYND-635) ──────────────────────────────────────────
  //
  // The reported bug: enrol on `app.myne.md`, see "Waiting for approval",
  // refresh, get asked for the password, and land in an EMPTY vault with the
  // approval screen unreachable.
  //
  // The trap is that nothing about the disk looks wrong. `sync_join_account`
  // fetches the account's real `vault.meta` and writes it BEFORE running the
  // enrolment that comes back pending, so the container is genuine and the
  // password genuinely opens it. It is empty because a pending device holds no
  // token and can pull nothing — the emptiness was the honest content of a
  // state the UI had lost track of, not corruption.

  it("a pending device returns to the wait instead of being offered unlock", async () => {
    const { initialStageFromProbe } = await loadStage(WEB_ABSENT);
    expect(
      initialStageFromProbe({ ok: [{ id: "v1", status: EXISTS }] } as never, {}, true),
    ).toEqual({ name: "pending-approval" });
  });

  it("DESKTOP never routes to the wait, even when it is pending", async () => {
    // Desktop can be pending too — enrol from Settings, quit before another
    // device approves. Sending it to the wait would lock the user out of a
    // vault that opens perfectly well: awaiting sync approval does not block
    // local use there, and the wait already has a home in the Settings panel.
    //
    // This was a real regression, shipped and caught by re-reading rather than
    // by a test: the branch went in ungated, and the desktop E2E suite could not
    // see it because its vaults have sync unconfigured, which never derives
    // `pending` at all.
    const { initialStageFromProbe } = await loadStage(DESKTOP_ABSENT);
    expect(
      initialStageFromProbe({ ok: [{ id: "v1", status: EXISTS }] } as never, {}, true),
    ).toEqual({ name: "unlock", initialStatus: EXISTS, vaultId: "v1" });
  });

  it("the same probe without the pending fact still routes to unlock", async () => {
    // The pair that makes the assertion above mean something. Identical inputs
    // apart from the third probe — so a fix that routed EVERY healthy vault to
    // the wait would pass the test above and fail this one.
    const { initialStageFromProbe } = await loadStage(WEB_ABSENT);
    const healthy = { ok: [{ id: "v1", status: EXISTS }] } as never;
    expect(initialStageFromProbe(healthy, {}, false)).toEqual({
      name: "unlock",
      initialStatus: EXISTS,
      vaultId: "v1",
    });
    // And omitting the argument entirely — every desktop call site — is the
    // same as passing `false`. Desktop is untouched by construction.
    expect(initialStageFromProbe(healthy, {})).toEqual({
      name: "unlock",
      initialStatus: EXISTS,
      vaultId: "v1",
    });
  });

  it("an open vault is never evicted by the pending fact", async () => {
    // Slot-priority outranks enrolment. A user inside an unlocked vault must
    // not be thrown back to a wait screen by a status read — whatever the
    // enrolment says, the vault is open and the keys are in memory.
    const { initialStageFromProbe } = await loadStage(WEB_ABSENT);
    expect(
      initialStageFromProbe(
        { ok: [{ id: "v1", status: EXISTS }] } as never,
        { v1: "Unlocked" } as never,
        true,
      ),
    ).toEqual({ name: "editor" });
  });

  it("a corrupted container is still a re-bootstrap, even while pending", async () => {
    // Waiting for approval on a vault that cannot be opened at all is a longer
    // dead end than the one being fixed. Corruption wins.
    const { initialStageFromProbe } = await loadStage(WEB_ABSENT);
    expect(
      initialStageFromProbe({ ok: [{ id: "v1", status: CORRUPTED }] } as never, {}, true),
    ).toEqual({ name: "account-entry" });
  });

  it("the pending stage accepts no transitions — approval is not an action", async () => {
    // Approval is granted on ANOTHER device and observed by polling. An
    // action-driven exit would mean this client deciding it is approved, which
    // is the shape of the bug: a state believed rather than read.
    const { transition } = await loadStage(WEB_ABSENT);
    const pending = { name: "pending-approval" } as const;
    for (const action of [
      { type: "editor.lock" },
      { type: "unlock.success" },
      { type: "welcome.restore-backup" },
    ] as never[]) {
      expect(transition(pending, action)).toEqual(pending);
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
