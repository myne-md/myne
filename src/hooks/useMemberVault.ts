import { useEffect, useState } from "react";

import type { VaultId } from "../lib/stage";
import { memberVaultStatus } from "../lib/personAccount";

/**
 * Which account plane the ACTIVE vault speaks for, as far as this device can tell
 * (myne-md/myne):
 *
 * - `owner` — the vault is this person's own, so the account-level surfaces speak
 *   for the vault account: the account-number QR, `Remove device`, the local
 *   reset, and the storage row all mean what they say.
 * - `member` — this person joined the vault, so the same surfaces speak for their
 *   own PERSON account (the backend resolves the same question from the live
 *   session: `core::plugins::sync::devices::account_plane_from_host`). Two
 *   affordances then stop being honest rather than merely useful: `Remove device`
 *   cannot revoke this vault's access (only the vault's owner can), and the local
 *   reset clears the token in the vault directory, which on a member vault is the
 *   membership token the entire vault syncs on, with no UI path back.
 * - `unknown` — not resolved yet, no vault id, or the probe failed.
 *
 * **`unknown` is a third state and not a flavour of `owner`, which is the whole
 * reason this is a union rather than a boolean.** A `false` default renders the
 * owner shape, and the owner shape is the one that re-offers the destructive
 * reset: a member vault would show it on the first paint, and on every mount where
 * the probe rejects or the caller has no id, which is exactly the state this
 * change exists to remove. So the callers gate on the POSITIVE answer they need —
 * `=== "owner"` for the destructive arms, `=== "member"` for the member's own
 * affordances — and `unknown` renders neither.
 *
 * The predicate is the device-local member-key store, read through
 * `sync_member_vault_status` — the same one the unlock surface uses to decide
 * whether to ask for a phrase or a password, so the two cannot disagree.
 */
export type AccountPlane = "owner" | "member" | "unknown";

export function useMemberVault(vaultId?: VaultId): AccountPlane {
  const [plane, setPlane] = useState<AccountPlane>("unknown");
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!vaultId) {
        if (alive) setPlane("unknown");
        return;
      }
      try {
        const member = await memberVaultStatus(vaultId);
        if (alive) setPlane(member === true ? "member" : "owner");
      } catch {
        // A failed read is `unknown`, never `owner`: the destructive arms are what
        // this hides, and a swallowed failure must not hand them back.
        if (alive) setPlane("unknown");
      }
    })();
    return () => {
      alive = false;
    };
  }, [vaultId]);
  return plane;
}
