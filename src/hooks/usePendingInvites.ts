// SPDX-License-Identifier: AGPL-3.0
// The invitations this device can act on, for the two surfaces that are NOT the
// identity home (myne-md/myne#911 follow-up).
//
// # Why this exists at all
//
// `IdentityHome` is the only place that lists invitations, and `App.tsx` renders
// it only at ZERO vaults. So a device that already held a vault could not accept
// an invitation at all: the list, the accept wizard and the join wizard were all
// one screen away and that screen was unreachable. This hook is what lets the
// vault picker and the in-editor vault switcher say "there is an invitation
// waiting" without a second implementation of the list.
//
// # Why it degrades to nothing rather than to an error
//
// An invitation is addressed to a PERSON, so it can only exist once this
// device's identity is registered with a server: `sync_person_accept_invite`
// refuses with `NotEnrolled` without a device token, and the relay has nothing
// to address before that. A `reserved` identity therefore has no invitations to
// miss, and surfacing an error for it would turn a normal first-run state into a
// fault. `unavailable` carries the reason for a caller that wants to explain it;
// the notification row renders only when there is an actual count.
import { useCallback, useEffect, useState } from "react";
import { has as hasCapability } from "../platform/capabilities";
import {
  personListInvites,
  personStatus,
  type InviteSummary,
  type InvitesUnavailable,
} from "../lib/personAccount";

export type { InvitesUnavailable } from "../lib/personAccount";

export interface PendingInvites {
  /** Every invitation addressed to this identity, claimed rows included. */
  invites: InviteSummary[];
  /** True while the status/list round trip is in flight. */
  loading: boolean;
  /** `null` when the list is real, including the real answer "none". */
  unavailable: InvitesUnavailable | null;
  /** Re-run the probe. Called on an error banner and after an accept. */
  reload: () => void;
}

/**
 * Read the recipient-scoped invitation list.
 *
 * `enabled` is the caller's gate and defaults to true, because both call sites
 * are surfaces a person without an identity can also reach: the vault picker and
 * the editor. Where the capability is absent (the web client has no person
 * identity carrier) this does nothing at all rather than invoking a command the
 * dispatcher refuses.
 */
export function usePendingInvites(enabled = true): PendingInvites {
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState<InvitesUnavailable | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled || !hasCapability("personIdentity")) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        // The lifecycle first: an invitation cannot exist for an identity the
        // server has never seen, and `sync_person_list_invites` would answer
        // `NotEnrolled` rather than an empty list. Asking the device-local probe
        // first turns that into a state the caller can render honestly.
        const status = await personStatus();
        if (!alive) return;
        if (status.state === null) {
          setInvites([]);
          setUnavailable("no-identity");
          return;
        }
        if (status.state !== "enrolled") {
          setInvites([]);
          setUnavailable(status.state === "pending" ? "pending" : "not-enrolled");
          return;
        }
        const list = await personListInvites();
        if (!alive) return;
        setInvites(list);
        setUnavailable(null);
      } catch {
        if (!alive) return;
        // A failed read is not "no invitations": keep the previous list rather
        // than making an invitation disappear because one request failed.
        setUnavailable("error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [enabled, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // A read taken once at boot would go stale in a session left open for days,
  // and polling the relay from a LOCKED screen is the wrong trade: it is a
  // request every few seconds in exchange for a notice the user is not looking
  // at. Window focus is the cheap middle. The user is back, so one re-read is
  // worth one request, and the cost of being wrong is that the notice appears on
  // the next focus instead of the moment it arrived.
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => setNonce((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled]);

  return { invites, loading, unavailable, reload };
}

/** The unclaimed invitations, which are the ones that are still pending. */
export function unclaimedInvites(invites: InviteSummary[]): InviteSummary[] {
  return invites.filter((invite) => !invite.claimed);
}
