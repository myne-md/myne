// The sync status as one honest sentence, in ONE place, for every client.
//
// "Every client" is about the MAPPING, and it holds: desktop, web and phone all import this
// module. What the browser does not yet do is publish `uploads_blocked`, because its Worker
// carries no live overlay, so on web the blocked arm is reachable only from a manual `sync_now`
// answer. `decisions/sync/0787` records that residual; the mapping being shared is what makes
// fixing it a one-line writer rather than a fourth copy.
//
// # Why this module exists
//
// The mapping from `SyncRuntimeStatus` to a dot colour and a label was written three times:
// here on desktop (`SyncStatusIndicator`'s `present`), in `mobile/src/lib/sync-status-view.ts`,
// and, for one state, nowhere, because a cycle that ran without uploading reported `Idle`
// and `Idle` renders as "Synced".
//
// The three copies had already drifted in the way that matters: `idle` said "Synced" on a
// computer and "On" on a phone, and the phone's copy had no `device_key_missing` arm at all, so
// the one state that says "the signing key this device published is not here" would have read
// as a generic error there even after the core started reporting it (myne-md/myne#1027).
//
// Two sentences for one state is not a wording difference. It is the reason a user cannot trust
// the surface: whichever screen they look at, they are reading a different claim.
//
// # Two rules the switch keeps
//
// **State, never a wall-clock** (AS6/AS15), with one deliberate exception: `uploads_blocked`
// carries the upload clock, because "your work has not left this machine, and the last time it
// did was three hours ago" is the sentence that state exists for. Every other arm stays clockless.
//
// **A detail this build does not know is not evidence of a failure.** A newer core may send a
// cause with no copy here; that renders the generic line rather than inventing a diagnosis.

import type { TFunction } from "i18next";

/** The runtime sync status (mirrors the Rust `SyncRuntimeStatus`). */
export type SyncStatus =
  | { state: "disabled" }
  | { state: "not_enrolled" }
  | { state: "pending" }
  | { state: "idle" }
  | { state: "syncing" }
  | {
      state: "error";
      detail: string;
      /**
       * Epoch ms of the last cycle that completed on this device (myne#583), absent when none
       * ever has. Carried only on `error`, matching the Rust side: how long sync has been
       * broken is a question that only exists while it is broken. Feed it to `isSyncStale`,
       * never to a date format, see `src/lib/sync-staleness.ts` for why.
       */
      last_success_at?: number;
    }
  | {
      state: "uploads_blocked";
      /**
       * Bounded cause token, from the same vocabulary `error` uses: `device_key_missing` and
       * `identity_locked` are the two a user action repairs, `uploads_blocked` is the rest.
       */
      detail: string;
      /**
       * Epoch ms of the last cycle that uploaded anything, absent when this device never has.
       * Coarse by construction (an hourly stamp, see `SyncState::last_upload_at_ms`), and
       * carried ONLY here: a healthy device shows no clock.
       *
       * No arm below formats it yet. Rendering "last upload: three hours ago" needs a coarsening
       * formatter and a translated string, so it is a named residual (`decisions/sync/0787`)
       * rather than a number smuggled into a sentence; feed it to a formatter or leave it.
       */
      last_upload_at?: number;
    }
  | { state: "conflicts"; count: number };

/**
 * The repair a state offers, when one is a user action.
 *
 * Named rather than implied because the caller owns the control: desktop renders a button in the
 * indicator. What this module decides is WHETHER the action applies, which is the part that was
 * duplicated and drifted. **The phone reads no action at all today**, because its editor stage has
 * no person-identity entry to route to: `personUnlock` is reachable only from `IdentityFlow`, and
 * that flow renders on the zero-vault stage alone. So a blocked phone says what is wrong and
 * offers no control, which is honest, and closing that is a navigation change in `mobile/`, not a
 * sentence in this module (myne-md/myne#1027 review, recorded as a residual there).
 */
export type SyncStatusAction = "unlock_identity" | "repair_device";

/** One status, as the dot, the sentence and the one action it offers. */
export interface SyncStatusView {
  /** CSS colour for the status dot, from the shared token sheet. */
  dotColor: string;
  label: string;
  /**
   * The repair to offer, or `null`. `repair_device` is the same phrase entry as
   * `unlock_identity` with a different label, because the states differ in what is missing, not
   * in what fixes them (myne-md/myne#983, #1027).
   */
  action: SyncStatusAction | null;
  /**
   * Whether "Sync now" can keep its promise in this state.
   *
   * False where a cycle would return before any network call (`disabled`, `not_enrolled`,
   * `pending`), false while uploads are blocked (the button would upload nothing and then flash
   * a success), and false where only another act helps (`identity_locked`,
   * `device_key_missing`): the identity action is the honest control there.
   *
   * True for every other failure, including the ones a user CAN clear beside the button: a freed
   * disk (`storage_full`), a repaired certificate (`tls_failure`), an unfrozen account
   * (`frozen`), a freed quota (`quota_exceeded`) and a device the owner re-added
   * (`device_revoked`). Those five were `false` in this module's first version, which silently
   * removed the retry control from the states where retrying is exactly what a user wants to do
   * after fixing the cause (myne-md/myne#1027 review).
   */
  syncNowUseful: boolean;
}

/** Map one status to its sentence. Pure: no hooks, no reads, no timers. */
export function syncStatusView(
  status: SyncStatus | null,
  t: TFunction,
  options: {
    /**
     * Whether the held identity was minted offline and never registered. It only re-labels
     * `not_enrolled`, which cannot tell "never added" from "never registered" on its own; the
     * panel that knows says which.
     */
    notRegistered?: boolean;
  } = {},
): SyncStatusView {
  if (!status) {
    return {
      dotColor: "var(--fg-3)",
      label: t("sync.status.loading"),
      action: null,
      syncNowUseful: false,
    };
  }
  switch (status.state) {
    case "disabled":
      return {
        dotColor: "var(--fg-3)",
        label: t("sync.status.off"),
        action: null,
        syncNowUseful: false,
      };
    case "not_enrolled":
      // The state is DERIVED (no token), so it covers two different facts and the caller is the
      // only one that can tell them apart. "Not enrolled" names no act; on a `reserved` identity
      // the act is Register, which the Identity row offers by name (2026-10-25 owner report).
      return {
        dotColor: "var(--fg-3)",
        label: t(options.notRegistered ? "sync.status.notRegistered" : "sync.status.notEnrolled"),
        action: null,
        syncNowUseful: false,
      };
    case "pending":
      return {
        dotColor: "var(--accent)",
        label: t("sync.status.awaitingApproval"),
        action: null,
        syncNowUseful: false,
      };
    case "idle":
      // "Synced", and this arm is only reachable when the last cycle could in fact upload,
      // because a cycle that could not reports `uploads_blocked` (myne-md/myne#1027). That is
      // the whole reason the new state exists: this line was reachable for a device that had
      // uploaded nothing for a day.
      return {
        dotColor: "var(--success)",
        label: t("sync.status.synced"),
        action: null,
        syncNowUseful: true,
      };
    case "syncing":
      return {
        dotColor: "var(--accent)",
        label: t("sync.status.syncing"),
        action: null,
        syncNowUseful: false,
      };
    case "uploads_blocked": {
      // Not `error`: nothing failed, the pull works. Not `idle`: nothing has left this machine.
      // The two causes a user can act on keep their own sentences, because "unlock your
      // identity" and "the key this device published is not here" send a reader to different
      // places even though the same phrase entry fixes both.
      if (status.detail === "device_key_missing") {
        return {
          dotColor: "var(--warning)",
          label: t("sync.status.errorDeviceKeyMissing"),
          action: "repair_device",
          syncNowUseful: false,
        };
      }
      if (status.detail === "identity_locked") {
        return {
          dotColor: "var(--warning)",
          label: t("sync.status.errorIdentityLocked"),
          action: "unlock_identity",
          syncNowUseful: false,
        };
      }
      return {
        dotColor: "var(--warning)",
        label: t("sync.status.uploadsBlocked"),
        action: null,
        syncNowUseful: false,
      };
    }
    case "error": {
      // Class-scoped details from the Rust failure gate. One sentence per class, because each
      // one is a different act: re-enroll, wait, free space, unlock, repair.
      switch (status.detail) {
        case "auth_failed":
          return {
            dotColor: "var(--danger)",
            label: t("sync.status.errorAuth"),
            action: null,
            syncNowUseful: true,
          };
        case "rate_limited":
          return {
            dotColor: "var(--warning)",
            label: t("sync.status.errorRateLimited"),
            action: null,
            syncNowUseful: true,
          };
        case "quota_exceeded":
          return {
            dotColor: "var(--danger)",
            label: t("sync.status.errorQuota"),
            action: null,
            syncNowUseful: true,
          };
        case "payload_too_large":
          return {
            dotColor: "var(--danger)",
            label: t("sync.status.errorTooLarge"),
            action: null,
            syncNowUseful: true,
          };
        case "frozen":
          return {
            dotColor: "var(--danger)",
            label: t("sync.status.errorFrozen"),
            action: null,
            syncNowUseful: true,
          };
        case "identity_locked":
          return {
            dotColor: "var(--warning)",
            label: t("sync.status.errorIdentityLocked"),
            action: "unlock_identity",
            syncNowUseful: false,
          };
        case "device_key_missing":
          // The key this device PUBLISHED is gone (myne-md/myne#983). Not folded into
          // `identity_locked`: the repair is the same phrase entry, but the sentence has to name
          // the missing key, because "unlock your identity" was shown for this state for a week
          // and sent people to a fix that only sometimes applied.
          return {
            dotColor: "var(--warning)",
            label: t("sync.status.errorDeviceKeyMissing"),
            action: "repair_device",
            syncNowUseful: false,
          };
        case "storage_full":
          // The LOCAL store, not the account's server-side ceiling: only one of the two is
          // fixable on this device, and "you're over your storage limit" would send a user to an
          // account page while their disk is what filled up.
          return {
            dotColor: "var(--warning)",
            label: t("sync.status.errorStorageFull"),
            action: null,
            syncNowUseful: true,
          };
        case "device_revoked":
          // NOT folded into `auth_failed`: that copy says the sign-in expired and points at
          // re-enrolling, which is the wrong instruction for a device the account owner
          // deliberately removed from another client (`REMOVE_DEVICE_DISCLOSURE`).
          return {
            dotColor: "var(--danger)",
            label: t("sync.status.errorDeviceRevoked"),
            action: null,
            syncNowUseful: true,
          };
        case "tls_failure":
          return {
            dotColor: "var(--danger)",
            label: t("sync.status.errorTls"),
            action: null,
            syncNowUseful: true,
          };
        default:
          return {
            dotColor: "var(--danger)",
            label: t("sync.status.error"),
            action: null,
            syncNowUseful: true,
          };
      }
    }
    case "conflicts":
      return {
        dotColor: "var(--warning)",
        label: t("sync.status.conflicts", { count: status.count }),
        action: null,
        syncNowUseful: true,
      };
  }
}
