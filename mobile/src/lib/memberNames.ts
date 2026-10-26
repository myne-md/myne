// Mobile member display-name binding (myne-md/myne#851 task 15).
//
// The store is the same `myne-core` codec the desktop writes: `vault.member-names`,
// magic `MYO5`, group-tier sealed and readable on BOTH tail generations
// (`decisions/protocol/0666`, widened by `0730`: a born `NTV7` vault carries the same
// tail), reached
// through this client's own `member-names` plugin shim
// (`mobile/src-tauri/src/plugins/member_names/mod.rs`). One `invoke` per command, the
// desktop module's discipline: the writers can only ever write the CALLER'S OWN row,
// because the backend keys it by the session's own person id and signs it with the
// session's own person key. There is no argument here that could name another member.
//
// ## What is deliberately NOT here
//
// **`clearMyMemberName`.** Post-onboarding name editing is out of task 15's scope by
// its own task body (the desktop row editor is judged enough for phase 2), so a
// binding for it would have no production caller, which is the dead export
// `scripts/check-ipc-binding-callers.mjs` exists to refuse. The command stays
// registered and granted on the Rust side, so adding the editor later needs no
// capability change.
//
// **`member_names_list`.** Its map is keyed by `person_id_hash` and nothing on this
// side can supply the caller's own id; the phone's Members panel reads names through
// `sync_list_roster`, which reports each row already resolved. Same reasoning the
// desktop module states.
//
// The error-key mapping is NOT declared here either: it lives in
// `@myne/client-core/member-name`, because both clients answer that question
// identically and a second copy would drop an arm silently. Re-exported so this
// module is the one path a mobile surface imports from.

import { invoke } from "../platform/core";
import type { MemberNamesMap } from "@myne/client-core/types/member-names-map";

export type { MemberNamesError } from "@myne/client-core/types/member-names-error";
export type { MemberNameEntry, MemberNamesMap } from "@myne/client-core/types/member-names-map";
export { memberNameErrorKey } from "@myne/client-core/member-name";

/** Set the caller's own display name, signed by the caller. Refuses an empty name
 *  and one over the family's byte cap before touching the store, so the onboarding
 *  gate's own emptiness check is an early-out rather than the rule. */
export async function setMyMemberName(name: string): Promise<MemberNamesMap> {
  return invoke<MemberNamesMap>("plugin:member-names|member_names_set_mine", {
    name,
  });
}
