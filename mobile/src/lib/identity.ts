// IPC binding for the backend identity resolver (myne-md/myne#849 task 7).
//
// Maps an Automerge actor (hex) to a closed `{Device, Person, Unknown}` identity.
// The frontend computes no id hash; the resolver is the only client-side computer.
// `""` is the "no actor" (`MY01` / absent) case and resolves to `Unknown`.
//
// The desktop twin is `src/lib/identity.ts`, and the two files differ only in the
// import paths: the command is the same shared-core one, and the returned type is
// the same wire mirror (`@myne/resolved-identity`, aliased rather than retyped).
// That sameness is the point. A presence label is a LABEL and never a proof of
// authorship (`decisions/protocol/0669`), so the rule that turns an actor into a
// name has exactly one implementation on the client: this command, consumed by the
// shared `resolvePeerLabels` loop, rendered through the shared `identityLabelText`.
//
// Before this file, mobile registered neither the command nor its ACL grant, so
// `resolvePeerLabels` had nothing to call here and every peer on this client
// rendered the degraded device form. Nothing reported it: the call is asynchronous
// and best-effort by design, so a rejected resolve leaves the peer un-attributed and
// the roster still renders.

import { invoke } from "../platform/core";
import type { ResolvedIdentity } from "@myne/resolved-identity";

export async function resolveIdentity(actorHex: string): Promise<ResolvedIdentity> {
  return invoke("plugin:sync|resolve_identity", { actorHex });
}
