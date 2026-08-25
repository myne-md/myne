// @vitest-environment jsdom
//
// `awaitingApprovalVerdict` (myne-md/myne#535): the post-unlock read that
// decides whether this device owes the awaiting-approval wait.
//
// The question used to be asked at boot, from disk: identity present + token
// absent = pending. On the web client that is not an answer, because
// `design-notes/clients/0363` makes the token session-scoped, so an approved
// device reads exactly the same way one reload later. Routing on it produced a
// deadlock: the wait screen asks for no password, and the only exit from pending
// is a token claim that needs `root_key`.
//
// What tells the two apart is whether this device has ever adopted a head, which
// `sync-protocol.md` §6.2 names as THE discriminator: "the baseline that decides
// 'has a persisted baseline or not' is the `MYH1` device-local head-state".
//
// # The answer this module must never try to get
//
// An earlier version forced a `sync_now` and read a `pending` result as "the
// server refused approval". It is not one. `try_claim_token` collapses a
// transport that will not build, a handshake that never reached the server, and
// a genuine refusal into one `None`, which becomes `NotReady`, which `sync_now`
// maps through `not_ready_reason`: a local disk read. So an offline approved
// device answered `pending` and was routed to a wait screen it could not leave.
//
// A test asserting the `error` answer would have hidden that, because the core
// cannot emit it on this path. The cases here mock only values the core really
// produces, and the offline case is asserted by the ABSENCE of a cycle.

import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<(cmd: string) => Promise<unknown>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => invokeMock(cmd),
}));

/**
 * Re-import the module with a substituted capability set, the pattern
 * `tests/stage/web-boot-routing.test.ts` uses, for the same reason: the rule is
 * per-capability, so it is driven per capability rather than per "client" flag.
 *
 * Every case loads through here rather than importing statically, because the
 * verdict's FIRST act is a capability check: a static import resolves the real
 * desktop descriptor, where the honest answer is always `false` and every case
 * below would pass for the wrong reason.
 */
async function loadVerdict(absent: string[]) {
  vi.resetModules();
  vi.doMock("../../src/platform/capabilities", () => ({
    has: (cap: string) => !absent.includes(cap),
  }));
  return import("../../src/lib/pending-approval");
}

/** The client this rule exists for: a vault here is never the only copy. */
const WEB = ["localOnlyVault"];

/** `head` is the adopted-head baseline; `status` is the enrolment state. */
function wire(head: string | null, status: string): void {
  invokeMock.mockImplementation(async (cmd) => {
    if (cmd === "plugin:sync|sync_head_fingerprint") return head;
    if (cmd === "plugin:sync|sync_status") return { state: status };
    return null;
  });
}

afterEach(() => {
  invokeMock.mockReset();
  vi.doUnmock("../../src/platform/capabilities");
  vi.resetModules();
});

describe("awaitingApprovalVerdict", () => {
  it("says yes for an enrolled device that has adopted no head", async () => {
    // The device this screen exists for: enrolled, never approved, nothing
    // pulled. When the approval lands, the cycle it enables is this device's
    // first head adoption, and `sync-protocol.md` §6.2 requires the §6.3 compare
    // to cover it. The wait screen is where that compare runs.
    wire(null, "pending");
    const { awaitingApprovalVerdict } = await loadVerdict(WEB);
    expect(await awaitingApprovalVerdict()).toBe(true);
  });

  it("says yes even when a token is already held, while no head is adopted", async () => {
    // A held token with no head is a device whose FIRST adoption has not
    // happened yet, so the compare is still owed. Reading the status as "we are
    // fine" here is the shortcut §6.2 names as forbidden.
    wire(null, "idle");
    const { awaitingApprovalVerdict } = await loadVerdict(WEB);
    expect(await awaitingApprovalVerdict()).toBe(true);
  });

  it("says no once a head has been adopted: the reload case", async () => {
    // The common path, and the one the old boot probe got wrong on every single
    // reload. A baseline means this device synced, so it was approved, and its
    // vault holds what it pulled. `design-notes/clients/0363`: the password is
    // needed again and it is "not accompanied by a re-approval prompt".
    wire("AAAA-BBBB", "pending");
    const { awaitingApprovalVerdict } = await loadVerdict(WEB);
    expect(await awaitingApprovalVerdict()).toBe(false);
  });

  it("reads the baseline BEFORE the status, and stops there when it finds one", async () => {
    // Ordering is a correctness property. The scheduler arms its own cycle on
    // the locked-to-unlocked edge, so a status read that ran first could find
    // the token already claimed, return early, and skip the baseline entirely,
    // adopting a first head with no compare shown.
    const seen: string[] = [];
    invokeMock.mockImplementation(async (cmd) => {
      seen.push(cmd);
      if (cmd === "plugin:sync|sync_head_fingerprint") return "AAAA-BBBB";
      if (cmd === "plugin:sync|sync_status") return { state: "pending" };
      return null;
    });
    const { awaitingApprovalVerdict } = await loadVerdict(WEB);
    expect(await awaitingApprovalVerdict()).toBe(false);
    expect(seen[0]).toBe("plugin:sync|sync_head_fingerprint");
    expect(seen).not.toContain("plugin:sync|sync_status");
  });

  it("asks the network nothing, so an offline device cannot be misread", async () => {
    // The regression this shape exists to prevent. `sync_now` is the only
    // command here that reaches a server, and a cycle's failure is
    // indistinguishable from a refusal on this path, so the verdict must not
    // issue one. Asserted as an absence rather than by mocking a value the core
    // cannot produce.
    wire("AAAA-BBBB", "pending");
    const { awaitingApprovalVerdict } = await loadVerdict(WEB);
    await awaitingApprovalVerdict();
    expect(
      invokeMock.mock.calls.map(([cmd]) => cmd),
      "a verdict that runs a cycle cannot tell a refusal from an unreachable server",
    ).not.toContain("plugin:sync|sync_now");
  });

  it("says no for a container that is not enrolled at all", async () => {
    // `sync_reset_local` leaves exactly this state: a vault on disk with the
    // enrolment cleared. It is not waiting for anything, and an approval wait
    // would re-ask a question the user answered by un-enrolling.
    wire(null, "not_enrolled");
    const { awaitingApprovalVerdict } = await loadVerdict(WEB);
    expect(await awaitingApprovalVerdict()).toBe(false);
  });

  it("says no when sync is not configured at all", async () => {
    wire(null, "disabled");
    const { awaitingApprovalVerdict } = await loadVerdict(WEB);
    expect(await awaitingApprovalVerdict()).toBe(false);
  });

  it("says yes when the baseline cannot be read, failing toward the compare", async () => {
    // The compare is what `threat-model.md` §7 records as the only mitigation
    // for the TOFU bootstrap. A device sent to the wait with a head already
    // adopted sees its code and confirms it; a bootstrapping device that skips
    // the wait loses the mitigation outright. So an unreadable baseline takes
    // the same branch as an absent one.
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "plugin:sync|sync_head_fingerprint") throw new Error("unreadable");
      if (cmd === "plugin:sync|sync_status") return { state: "pending" };
      return null;
    });
    const { awaitingApprovalVerdict } = await loadVerdict(WEB);
    expect(await awaitingApprovalVerdict()).toBe(true);
  });

  it("says no when the STATUS read throws", async () => {
    // With nothing readable there is no evidence the user belongs on a wait
    // screen, and the editor still reports the real state through its own sync
    // surfaces.
    invokeMock.mockImplementation(async (cmd) => {
      if (cmd === "plugin:sync|sync_head_fingerprint") return null;
      throw new Error("worker gone");
    });
    const { awaitingApprovalVerdict } = await loadVerdict(WEB);
    expect(await awaitingApprovalVerdict()).toBe(false);
  });

  it("says no on a client whose vault may be the only copy, whatever the disk says", async () => {
    // The desktop guard, and it was a real regression once: the arm this rule
    // replaces shipped ungated, and sending a pending DESKTOP device to a wait
    // screen locks the user out of a vault that opens perfectly well. Awaiting
    // sync approval does not block local use there.
    //
    // It also asks nothing: a client that cannot be in this state must not pay a
    // read on every entry to the editor.
    const { awaitingApprovalVerdict: desktopVerdict } = await loadVerdict([]);
    wire(null, "pending");
    expect(await desktopVerdict()).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("…and yes on a client whose vault came from a server", async () => {
    // The pair that gives the case above its meaning. Identical inputs, one
    // capability apart, so a gate that refused everywhere would satisfy the
    // test above and break the only client that needs this.
    const { awaitingApprovalVerdict: webVerdict } = await loadVerdict(WEB);
    wire(null, "pending");
    expect(await webVerdict()).toBe(true);
  });
});
