// May this client replace the bundle it is pinned to? (phase3-web-client task 54)
//
// # Why the decision is a pure function, separate from the worker
//
// `decisions.md` 2026-07-26 makes this policy **normative** and says so in as
// many words: "if implementation shows the policy is wrong, the policy is
// amended first and the code follows — not the reverse." A policy that lives
// inside a service worker's `install` handler can only be exercised by
// installing a service worker, which means it is tested rarely, in a context
// that is hard to arrange, and by people who are usually debugging something
// else. That is how "an obviously fine special case in an update path nobody
// reviews as a security decision" gets added — the exact failure the policy
// exists to prevent.
//
// So the decision is here, takes its inputs, returns a verdict, and knows
// nothing about caches or fetch events. The worker's job is to gather the inputs
// and obey.
//
// # The two independent conditions
//
// An update is accepted only when BOTH hold:
//
//   1. its hash is **signed** by a release key this client carries; and
//   2. its hash is **present in the append-only record** of released bundles.
//      "Public" is the intent and not the state: that record is in a private
//      repository today (docs/threat-model.md §5, docs/decisions/security/0534),
//      which matters for the property below, since a record only a first party
//      can read gives a third party nothing to compare against.
//
// Neither implies the other, and dropping either one loses a distinct property.
// Signature alone would let whoever holds the key ship a build that was never
// published — no artifact trail, nothing for a third party to compare against.
// The record alone would let whoever controls the record's serving path name a
// hash nobody signed. Requiring both means a substitution has to defeat two
// parties, and leaves evidence either way.
//
// # What this deliberately does NOT claim
//
// It does not make the FIRST load safe. Nothing available to a page can: the
// browser fetches the service-worker script itself from the network rather than
// from the worker's own cache, so an operator controlling the origin can serve a
// replacement worker that omits all of this. That limit is recorded in
// `threat-model.md` (A15/TB11) and in the decision entry; any copy describing
// this as "the web client verifies its own code" is wrong. What it buys is
// precise: **every load after the first is pinned, which is a property desktop
// gets for free by being an installed file.** This comment said "as strong as
// desktop's TB7" until 2026-08-25, which reads as a signature comparison and is
// not one in either direction: no desktop artifact carries a signature any OS
// checks (docs/threat-model.md TB7, A9), so the two channels are alike in
// persistence rather than in verification.

/** A release public key this client trusts, as it appears in the bundle. */
export interface ReleaseKey {
  /** Stable identifier, so a signature can name which key made it. */
  readonly id: string;
  /** Raw public key bytes (Ed25519), base64. */
  readonly publicKeyB64: string;
  /**
   * When set, the key is REVOKED and must be refused even for a signature that
   * verifies. Revocation cannot travel through the update channel it revokes —
   * an attacker holding the key would sign a worker that ignores it — so this
   * arrives out of band, in a bundle signed by a still-trusted key.
   */
  readonly revoked?: boolean;
}

/** One entry in the append-only record of released bundle hashes. */
export interface RecordEntry {
  /** `sha256:<hex>` of the released bundle. */
  readonly bundleHash: string;
}

/** A candidate replacement, as the worker gathered it. */
export interface UpdateCandidate {
  /** `sha256:<hex>` of the bundle being offered. */
  readonly bundleHash: string;
  /** Detached signature over `bundleHash`, base64. */
  readonly signatureB64: string | null;
  /** Which key the signature claims to be from. */
  readonly keyId: string | null;
}

/** Why an update was refused. Bounded — this reaches a UI and a console. */
export type RefusalReason =
  | "no-signature"
  | "unknown-key"
  | "revoked-key"
  | "bad-signature"
  | "not-in-record"
  | "same-bundle";

export type UpdateVerdict =
  | { accept: true }
  | { accept: false; reason: RefusalReason };

/**
 * Verify a detached signature. Injected rather than imported so the policy is
 * testable without WebCrypto and so the worker supplies the real one.
 */
export type VerifySignature = (
  publicKeyB64: string,
  signatureB64: string,
  message: string,
) => Promise<boolean>;

export interface UpdateInputs {
  readonly candidate: UpdateCandidate;
  /** The bundle this client is currently pinned to. */
  readonly installedHash: string;
  /** Keys this bundle carries. More than one during a rotation window. */
  readonly keys: readonly ReleaseKey[];
  /** The record of released hashes, as fetched. */
  readonly record: readonly RecordEntry[];
  readonly verify: VerifySignature;
}

/**
 * Decide whether to accept a candidate bundle.
 *
 * **Order matters and is part of the policy.** The cheap, local checks run
 * before the cryptographic one: a candidate naming an unknown or revoked key
 * cannot be made acceptable by a signature, so verifying first would spend work
 * on an answer already determined — and, worse, would make the refusal REASON
 * depend on how far the verification got.
 *
 * Fails closed on every path, including an exception from `verify`: a
 * verification that could not complete is not a verification that passed.
 */
export async function decideUpdate(inputs: UpdateInputs): Promise<UpdateVerdict> {
  const { candidate, installedHash, keys, record, verify } = inputs;

  // Not an update. Answered first because it is not a refusal in any meaningful
  // sense, and reporting it as one would make the ordinary no-op case look like
  // a rejected attack in whatever surface shows refusals.
  if (candidate.bundleHash === installedHash) {
    return { accept: false, reason: "same-bundle" };
  }
  if (candidate.signatureB64 === null || candidate.keyId === null) {
    return { accept: false, reason: "no-signature" };
  }
  const key = keys.find((k) => k.id === candidate.keyId);
  if (key === undefined) {
    return { accept: false, reason: "unknown-key" };
  }
  if (key.revoked === true) {
    return { accept: false, reason: "revoked-key" };
  }
  // The record check runs before the signature for the same reason the key
  // checks do — it is local and cheap — but it is NOT a substitute for it, and
  // the comment says so because the order invites that reading.
  if (!record.some((e) => e.bundleHash === candidate.bundleHash)) {
    return { accept: false, reason: "not-in-record" };
  }
  let ok = false;
  try {
    ok = await verify(key.publicKeyB64, candidate.signatureB64, candidate.bundleHash);
  } catch {
    // A verifier that threw did not verify. Swallowed to a `false` rather than
    // propagated so no caller can mistake an exception for an update it should
    // apply — every path out of this function is a verdict.
    ok = false;
  }
  return ok ? { accept: true } : { accept: false, reason: "bad-signature" };
}
