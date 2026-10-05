// SPDX-License-Identifier: AGPL-3.0
// The vault member roster (myne-md/myne#698, b2b-identity-substrate task 9).
// Lists the members of the unlocked shared vault from the membership roster
// extension, drives the invite flow, and drives member removal. The invite
// path needs the person identity held backend-side (unlocked in the Sync
// panel's Identity block), so the hook never sends a private seed across IPC.
import { useCallback, useEffect, useState } from "react";
import {
  listRoster,
  listVaultInvites,
  personCreateInvite,
  personLock,
  removeMember,
  type InviteCommandView,
  type RosterMemberView,
  type VaultAuthority,
  type VaultInviteSummary,
} from "../lib/invite";

export type RosterMember = RosterMemberView;

export interface RosterHook {
  members: RosterMember[];
  /** The caller's vault authority. Defaults to `member` (fail-closed: admin
   *  controls stay hidden until the backend confirms owner) and upgrades on load. */
  authority: VaultAuthority;
  /** The current group-key epoch on an `NTV6` vault; `null` for a legacy
   *  roster that has no group tier. */
  groupKeyEpoch: number | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** Person identity lifecycle: lock (the unlock lives in the Sync panel's
   *  Identity block, myne-md/myne#831). */
  lockPerson: typeof personLock;
  inviting: boolean;
  lastInvite: InviteCommandView | null;
  invite: typeof personCreateInvite;
  /** The owner's sent invitations with their claim state (empty for a member). */
  vaultInvites: VaultInviteSummary[];
  /**
   * True when the last sent-invitation fetch failed, so the panel can say
   * "could not load" rather than rendering an empty list as "none sent".
   *
   * **A vault that is not shared yet is NOT a failure** (myne-md/myne#783):
   * `listVaultInvites` answers an empty list for an `NTV5` vault, and the panel
   * reads `shared` to render nothing there instead of an error line. This flag
   * is reserved for a genuine relay/parse failure.
   */
  vaultInvitesFailed: boolean;
  /**
   * Whether this vault has the B2B group tier (`NTV6`). Derived from the roster
   * view's `group_key_epoch`, so no extra IPC: `null` means the vault is still
   * the birth-format `NTV5` and has no roster to share yet (myne-md/myne#783).
   */
  shared: boolean;
  removing: boolean;
  remove: typeof removeMember;
}

export function useRoster(personReady: boolean): RosterHook {
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [authority, setAuthority] = useState<VaultAuthority>("member");
  const [groupKeyEpoch, setGroupKeyEpoch] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [lastInvite, setLastInvite] = useState<InviteCommandView | null>(null);
  const [removing, setRemoving] = useState(false);
  const [vaultInvites, setVaultInvites] = useState<VaultInviteSummary[]>([]);
  const [vaultInvitesFailed, setVaultInvitesFailed] = useState(false);
  const [shared, setShared] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listRoster()
      .then((view) => {
        if (!cancelled) {
          setMembers(view.members);
          setAuthority(view.authority);
          setGroupKeyEpoch(view.group_key_epoch);
          setShared(view.group_key_epoch !== null);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setMembers([]);
          setAuthority("member");
          setGroupKeyEpoch(null);
          setShared(false);
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  // The owner's sent invitations, for the claimed-versus-pending view. Fetch
  // only as the owner (the vault-side list is owner-token authorized) and only
  // on a SHARED vault: an `NTV5` vault has no roster and nothing to list, so
  // asking would manufacture a failure out of a legitimate state
  // (myne-md/myne#783). Re-fetch on the same tick that reloads the roster, so
  // an invite shows up.
  useEffect(() => {
    if (!personReady || authority !== "owner" || !shared) {
      setVaultInvites([]);
      setVaultInvitesFailed(false);
      return;
    }
    let cancelled = false;
    setVaultInvitesFailed(false);
    listVaultInvites()
      .then((rows) => {
        if (!cancelled) setVaultInvites(rows);
      })
      .catch(() => {
        // Distinguish "the fetch failed" from "no invitations sent": a silent
        // empty list reads as the latter and hides a relay outage.
        if (!cancelled) setVaultInvitesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authority, personReady, shared, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const invite = useCallback(
    (async (...args: Parameters<typeof personCreateInvite>): Promise<InviteCommandView> => {
      setInviting(true);
      try {
        const view = await personCreateInvite(...args);
        setLastInvite(view);
        reload();
        return view;
      } finally {
        setInviting(false);
      }
    }) as typeof personCreateInvite,
    [reload],
  );

  const remove = useCallback(
    (async (...args: Parameters<typeof removeMember>): Promise<void> => {
      setRemoving(true);
      try {
        await removeMember(...args);
        reload();
      } finally {
        setRemoving(false);
      }
    }) as typeof removeMember,
    [reload],
  );

  return {
    members,
    authority,
    groupKeyEpoch,
    loading,
    error,
    reload,
    lockPerson: personLock,
    inviting,
    lastInvite,
    invite,
    vaultInvites,
    vaultInvitesFailed,
    shared,
    removing,
    remove,
  };
}
