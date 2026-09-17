// SPDX-License-Identifier: AGPL-3.0
// The vault member roster (myne-md/myne#698, b2b-identity-substrate task 9).
// Lists the members of the unlocked shared vault from the membership roster
// extension, drives the invite flow, and drives member removal. The invite
// path needs the person identity held backend-side (`personUnlock`), so the
// hook never sends a private seed across IPC.
import { useCallback, useEffect, useState } from "react";
import {
  inviteMember,
  listRoster,
  personLock,
  personUnlock,
  removeMember,
  type InviteCommandView,
  type RosterMemberView,
} from "../lib/invite";

export type RosterMember = RosterMemberView;

export interface RosterHook {
  members: RosterMember[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** Person identity lifecycle: unlock from the phrase (once per process). */
  unlockPerson: typeof personUnlock;
  lockPerson: typeof personLock;
  inviting: boolean;
  lastInvite: InviteCommandView | null;
  invite: typeof inviteMember;
  removing: boolean;
  remove: typeof removeMember;
}

export function useRoster(): RosterHook {
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [lastInvite, setLastInvite] = useState<InviteCommandView | null>(null);
  const [removing, setRemoving] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listRoster()
      .then((rows) => {
        if (!cancelled) {
          setMembers(rows);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setMembers([]);
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

  const reload = useCallback(() => setTick((t) => t + 1), []);

  const invite = useCallback(
    (async (...args: Parameters<typeof inviteMember>): Promise<InviteCommandView> => {
      setInviting(true);
      try {
        const view = await inviteMember(...args);
        setLastInvite(view);
        reload();
        return view;
      } finally {
        setInviting(false);
      }
    }) as typeof inviteMember,
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
    loading,
    error,
    reload,
    unlockPerson: personUnlock,
    lockPerson: personLock,
    inviting,
    lastInvite,
    invite,
    removing,
    remove,
  };
}
