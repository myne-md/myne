// SPDX-License-Identifier: AGPL-3.0
//
// The add-this-device refusal mapper both clients answer with
// (myne-md/myne#932).
//
// The defect this pins: the phone's join mapped two kinds and collapsed the rest
// into "That did not add this phone. Check the words and try again", so a server
// refusal (an invite-code gate, a device cap, a frozen account, an unapproved
// device) read as a wrong phrase. Every arm returns a plausible string, so the
// loss is silent and only an assertion can see it.

import { describe, expect, it } from "vitest";
import { personJoinErrorKey } from "../../client-core/src/person-join";

const keyOf = (kind: string): string => personJoinErrorKey({ kind, detail: null });

describe("personJoinErrorKey", () => {
  it("names the words-vs-code disagreement separately", () => {
    expect(keyOf("PersonMismatch")).toBe("identityFlow.personJoin.mismatch");
  });

  it("gives each server refusal its own sentence", () => {
    // Grouped as a table because the point is that no two collide: collapsing any
    // pair is the defect, and a per-assertion list would not show that they differ.
    const pairs: Array<[string, string]> = [
      ["InviteCodeRequired", "identityFlow.personJoin.error.inviteRequired"],
      ["InviteCodeInvalid", "identityFlow.personJoin.error.inviteInvalid"],
      ["DeviceLimitReached", "identityFlow.personJoin.error.deviceLimit"],
      ["AlreadyInstalled", "identityFlow.personJoin.error.alreadyInstalled"],
      ["AwaitingApproval", "identityFlow.personJoin.error.awaitingApproval"],
      ["AccountFrozen", "identityFlow.personJoin.error.accountFrozen"],
      ["NotConfigured", "identityFlow.personJoin.error.notConfigured"],
      ["Transport", "identityFlow.personJoin.error.transport"],
      ["TlsFailure", "sync.endpoint.tlsFailure"],
    ];
    for (const [kind, key] of pairs) {
      expect(keyOf(kind)).toBe(key);
    }
    expect(new Set(pairs.map(([, key]) => key)).size).toBe(pairs.length);
  });

  it("reads an identity this device cannot seal as the held-identity state", () => {
    // `BadRequest` is what `person_recover_identity_from_host` answers when the
    // sealed frame on this device belongs to another phrase; the remedy is to
    // forget it first, which the sentence says.
    expect(keyOf("AlreadyHeldIdentity")).toBe("identityFlow.personJoin.error.held");
    expect(keyOf("BadRequest")).toBe("identityFlow.personJoin.error.held");
  });

  it("falls back to the generic sentence for a kind it does not know", () => {
    // The default arm is the one whose absence is silent: a new refusal kind would
    // otherwise render whichever case happened to be last in the switch.
    expect(keyOf("SomeKindAddedLater")).toBe("identityFlow.personJoin.failed");
    expect(personJoinErrorKey(undefined)).toBe("identityFlow.personJoin.failed");
    expect(personJoinErrorKey("a bare string")).toBe("identityFlow.personJoin.failed");
  });
});
