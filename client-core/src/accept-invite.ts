// SPDX-License-Identifier: AGPL-3.0-only
//
// The accept-an-invite DECISION both clients answer, in one place: which of the
// desktop's `identityHome.acceptError*` messages a refused
// `sync_person_accept_invite` earns.
//
// **Why it is here rather than in the desktop screen it came from.** The form
// that collects an accept is per-client by design (`decisions/clients/0488`
// is explicit that the screens differ: desktop opens an inline form inside the
// invite row, mobile is a full-screen step), but the QUESTION a failure answers
// is not per-client. It came from one place for a reason worth keeping: every
// failure used to collapse into a single sentence, and a real failure on a
// member device was indistinguishable from a wrong owner code
// (myne-md/myne#794 manual-testing finding). A copy of the mapping on the phone
// would be a second place that can lose that distinction, and the loss is silent
// on both sides: the union's arms are strings, and a `default` arm rendering a
// plausible sentence type-checks.
//
// Entry criterion for this package, satisfied: both clients answer the same
// question, and the module touches no host at all (`seam: null`, no
// `@tauri-apps/*`, not even the runtime global in a comment).
//
// The mirror it reads is `core/src/plugins/sync/devices.rs::SyncDeviceError`,
// `#[serde(tag = "kind")]`. Only the arms the accept path can actually produce
// are named below; anything else, including a shape that is not this enum at
// all, falls back to the generic sentence rather than inventing a cause.

/**
 * Which `identityHome.acceptError*` key a refused accept should render.
 *
 * Takes `unknown` on purpose: the invoke rejects with whatever crossed IPC, and
 * a mapper that assumed a shape would throw inside its own error path. A
 * non-object, a missing `kind`, or a kind this union does not carry all land on
 * the generic message.
 */
export function acceptInviteErrorKey(error: unknown): string {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  switch (kind) {
    case "BadRequest":
      return "identityHome.acceptErrorBadRequest";
    case "DeviceNotFound":
      return "identityHome.acceptErrorNotFound";
    case "NotEnrolled":
      return "identityHome.acceptErrorNotEnrolled";
    case "Unauthenticated":
      return "identityHome.acceptErrorUnauthenticated";
    case "Transport":
      return "identityHome.acceptErrorTransport";
    default:
      return "identityHome.acceptError";
  }
}
