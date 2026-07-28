// The signed-update policy (phase3-web-client task 54; policy: `decisions.md`
// 2026-07-26).
//
// The policy is NORMATIVE — the decision entry says "if implementation shows the
// policy is wrong, the policy is amended first and the code follows, not the
// reverse" — so these tests are the policy restated as executable assertions.
// The failure they exist to prevent is the one the entry names: "an obviously
// fine special case in an update path nobody reviews as a security decision."

import { describe, expect, it, vi } from "vitest";
import {
  decideUpdate,
  type ReleaseKey,
  type UpdateInputs,
} from "../../web/src/sw/update-policy";

const INSTALLED = "sha256:aaaa";
const NEXT = "sha256:bbbb";

const KEY: ReleaseKey = { id: "k1", publicKeyB64: "PUB1" };

function inputs(over: Partial<UpdateInputs> = {}): UpdateInputs {
  return {
    candidate: { bundleHash: NEXT, signatureB64: "SIG", keyId: "k1" },
    installedHash: INSTALLED,
    keys: [KEY],
    record: [{ bundleHash: NEXT }],
    verify: vi.fn(async () => true),
    ...over,
  };
}

describe("signed-update policy", () => {
  it("accepts an update that is BOTH signed and in the record", async () => {
    await expect(decideUpdate(inputs())).resolves.toEqual({ accept: true });
  });

  it("refuses an unsigned update", async () => {
    const v = await decideUpdate(
      inputs({ candidate: { bundleHash: NEXT, signatureB64: null, keyId: null } }),
    );
    expect(v).toEqual({ accept: false, reason: "no-signature" });
  });

  it("refuses a signed update whose hash is NOT in the public record", async () => {
    // The two conditions are independent and this is the half people drop.
    // Signature alone would let whoever holds the key ship a build that was
    // never published — no artifact trail, nothing to compare against.
    const v = await decideUpdate(inputs({ record: [] }));
    expect(v).toEqual({ accept: false, reason: "not-in-record" });
  });

  it("refuses a recorded update whose signature does not verify", async () => {
    // The other half. The record alone would let whoever controls its serving
    // path name a hash nobody signed.
    const v = await decideUpdate(inputs({ verify: vi.fn(async () => false) }));
    expect(v).toEqual({ accept: false, reason: "bad-signature" });
  });

  it("refuses a signature from a key this bundle does not carry", async () => {
    const v = await decideUpdate(
      inputs({ candidate: { bundleHash: NEXT, signatureB64: "SIG", keyId: "k-unknown" } }),
    );
    expect(v).toEqual({ accept: false, reason: "unknown-key" });
  });

  it("refuses a REVOKED key even when its signature would verify", async () => {
    // Revocation cannot travel through the channel it revokes — an attacker
    // holding the key signs a worker that ignores it — so it arrives out of
    // band, in a bundle signed by a still-trusted key. This is the check that
    // makes that arrival mean something.
    const verify = vi.fn(async () => true);
    const v = await decideUpdate(inputs({ keys: [{ ...KEY, revoked: true }], verify }));
    expect(v).toEqual({ accept: false, reason: "revoked-key" });
    expect(verify, "a revoked key must not even be verified against").not.toHaveBeenCalled();
  });

  it("accepts during a rotation window, where two keys are valid", async () => {
    // A rotation is itself a bundle release: clients update to a bundle signed
    // by the OLD key that carries the NEW one, and thereafter accept the new.
    // Skipping that ordering strands every installed client, because a bundle
    // signed by a key no worker knows is indistinguishable from an attack.
    const v = await decideUpdate(
      inputs({
        keys: [KEY, { id: "k2", publicKeyB64: "PUB2" }],
        candidate: { bundleHash: NEXT, signatureB64: "SIG", keyId: "k2" },
      }),
    );
    expect(v).toEqual({ accept: true });
  });

  it("reports 'same bundle' rather than a refusal for the ordinary no-op", async () => {
    // The common case by far. Reporting it as a refusal would make every idle
    // check look like a rejected attack in whatever surface shows refusals — and
    // a surface crying wolf is one nobody reads when it matters.
    const v = await decideUpdate(
      inputs({ candidate: { bundleHash: INSTALLED, signatureB64: "SIG", keyId: "k1" } }),
    );
    expect(v).toEqual({ accept: false, reason: "same-bundle" });
  });

  it("fails closed when the verifier THROWS", async () => {
    // A verification that could not complete is not a verification that passed.
    // Every path out of the decision is a verdict, so no caller can mistake an
    // exception for an update it should apply.
    const v = await decideUpdate(
      inputs({
        verify: vi.fn(async () => {
          throw new Error("WebCrypto unavailable");
        }),
      }),
    );
    expect(v).toEqual({ accept: false, reason: "bad-signature" });
  });

  it("checks the cheap local conditions before the cryptographic one", async () => {
    // Not an optimisation: it keeps the refusal REASON from depending on how far
    // verification happened to get. An unknown key cannot be made acceptable by
    // a signature, so spending the verification on it would be work whose only
    // effect is to make the answer less specific.
    const verify = vi.fn(async () => true);
    await decideUpdate(
      inputs({ candidate: { bundleHash: NEXT, signatureB64: "SIG", keyId: "nope" }, verify }),
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it("gives every refusal a bounded reason, so none of them is silent", async () => {
    // Criterion 3. A refusal that produced only a boolean would leave a stuck
    // client with nothing to say — and "the update was refused" is exactly the
    // thing a user reporting a problem needs to be able to tell someone.
    const cases: Array<[Partial<UpdateInputs>, string]> = [
      [{ candidate: { bundleHash: NEXT, signatureB64: null, keyId: null } }, "no-signature"],
      [{ record: [] }, "not-in-record"],
      [{ verify: vi.fn(async () => false) }, "bad-signature"],
      [{ keys: [{ ...KEY, revoked: true }] }, "revoked-key"],
    ];
    for (const [over, reason] of cases) {
      const v = await decideUpdate(inputs(over));
      expect(v).toEqual({ accept: false, reason });
    }
  });
});
