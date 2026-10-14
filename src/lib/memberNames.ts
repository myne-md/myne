// SPDX-License-Identifier: AGPL-3.0
//
// The member display-name bindings (`vault.member-names`, magic `MYO5`;
// myne-md/myne#851, `decisions/protocol/0666`). One `invoke` per command.
//
// The store is group-tier sealed and `NTV6`-only, and the two writers can only
// ever write the CALLER'S OWN row: the backend keys that row by the session's
// own person id and signs it with the session's own person key, so there is no
// argument here that could name another member. That is why the member list
// renders an edit affordance on the caller's row and nowhere else: the
// restriction is in the key, not in this file.
//
// **`member_names_list` is deliberately NOT wrapped here.** It returns its map
// keyed by `person_id_hash`, and nothing on this side can supply the caller's own
// person id: the roster view reports a row's `fingerprint_hex` and its resolved
// display name instead, so the editor prefills from the row it is editing. A
// binding nothing can call is the dead export
// `scripts/check-ipc-binding-callers.mjs` exists to refuse.

import { invoke } from "../platform/core";
import type { MemberNamesError } from "@myne/client-core/types/member-names-error";
// The map mirror moved to `@myne/client-core` when the phone needed the same
// return type for its own writer (myne-md/myne#851 task 15): one mirror of a Rust
// wire shape rather than two. Re-exported so this module's surface is unchanged.
import type { MemberNamesMap } from "@myne/client-core/types/member-names-map";

export type { MemberNamesError };
export type { MemberNameEntry, MemberNamesMap } from "@myne/client-core/types/member-names-map";

/** Set the caller's own display name, signed by the caller. Refuses an empty
 *  name and one over the family's byte cap before touching the store. */
export async function setMyMemberName(name: string): Promise<MemberNamesMap> {
  return invoke<MemberNamesMap>("plugin:member-names|member_names_set_mine", {
    name,
  });
}

/** Clear the caller's own name by writing a self-signed tombstone, which wins
 *  over a concurrent rename at equal version so a stale copy cannot resurrect
 *  it. Distinct from {@link setMyMemberName}: an empty name is a refusal. */
export async function clearMyMemberName(): Promise<MemberNamesMap> {
  return invoke<MemberNamesMap>("plugin:member-names|member_names_clear_mine");
}

/**
 * The i18n key for a name-writer failure. Shared by the Members-list row editor
 * and the post-accept name gate, which write the same row through the same
 * command.
 *
 * The mapping itself now lives in `@myne/client-core/member-name`, because the
 * phone collects a name too (myne-md/myne#851 task 15) and two copies of a
 * six-arm switch over a closed enum is two places an arm can be dropped, silently:
 * a forgotten arm falls through to the generic message, which still renders a
 * plausible sentence. Kept exported under this name so this module's readers are
 * unchanged. The binding stays here, because `invoke` is host.
 */
export { memberNameErrorKey } from "@myne/client-core/member-name";
