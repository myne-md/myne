// IPC binding for the backend identity resolver (`collab-provenance` task 2).
//
// Maps an Automerge actor (hex) to a closed `{Device, Person, Unknown}` identity.
// The frontend computes no id hash; the resolver is the only client-side computer.
// `""` is the "no actor" (`MY01` / absent) case and resolves to `Unknown`.

import { invoke } from "../platform/core";
import type { ResolvedIdentity } from "../types/resolved-identity";

export async function resolveIdentity(actorHex: string): Promise<ResolvedIdentity> {
  return invoke("plugin:sync|resolve_identity", { actorHex });
}
