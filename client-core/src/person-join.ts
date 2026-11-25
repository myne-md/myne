// SPDX-License-Identifier: AGPL-3.0-only
//
// The add-this-device DECISION both clients answer: which sentence a refused
// `sync_person_join_device` earns (myne-md/myne#932).
//
// **Why it is here.** The phone's join step mapped two kinds and collapsed the
// rest into "That did not add this phone. Check the words and try again", so a
// server refusal read as a wrong phrase. That is the same defect
// `accept-invite.ts` exists to prevent one command over: a mapping kept per client
// is a second place that can silently lose a distinction, and losing one is
// invisible because every arm returns a plausible string.
//
// The mapper names the arms the JOIN can actually produce, from the mirror of
// `core/src/plugins/sync/devices.rs::SyncDeviceError` (`#[serde(tag = "kind")]`).
// Anything else, including a shape that is not this enum at all, falls back to the
// generic sentence rather than inventing a cause.
//
// Two arms deserve their own sentence because their remedy is different in kind
// rather than in degree:
//
// * `InviteCodeRequired` / `InviteCodeInvalid`: the phrase was never the problem;
//   the server admits new accounts only with an operator's code.
// * `AwaitingApproval`: nothing is wrong; an existing device has to approve this
//   one, and the join screen's own pending step is where that finishes.

/**
 * Which `identityFlow.personJoin.error.*` key a refused join should render.
 *
 * Takes `unknown` on purpose: the invoke rejects with whatever crossed IPC, and a
 * mapper that assumed a shape would throw inside its own error path.
 */
export function personJoinErrorKey(error: unknown): string {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  switch (kind) {
    // The words are well-formed; they name a different person than the code.
    case "PersonMismatch":
      return "identityFlow.personJoin.mismatch";
    // The identity is sealed on this device under another phrase, so this one
    // cannot open or re-seal it. The remedy is to forget it first.
    case "AlreadyHeldIdentity":
    case "BadRequest":
      return "identityFlow.personJoin.error.held";
    case "InviteCodeRequired":
      return "identityFlow.personJoin.error.inviteRequired";
    case "InviteCodeInvalid":
      return "identityFlow.personJoin.error.inviteInvalid";
    case "DeviceLimitReached":
      return "identityFlow.personJoin.error.deviceLimit";
    case "AlreadyInstalled":
      return "identityFlow.personJoin.error.alreadyInstalled";
    case "AwaitingApproval":
      return "identityFlow.personJoin.error.awaitingApproval";
    case "AccountFrozen":
      return "identityFlow.personJoin.error.accountFrozen";
    case "NotConfigured":
      return "identityFlow.personJoin.error.notConfigured";
    case "TlsFailure":
      return "sync.endpoint.tlsFailure";
    case "Transport":
      return "identityFlow.personJoin.error.transport";
    default:
      return "identityFlow.personJoin.failed";
  }
}
