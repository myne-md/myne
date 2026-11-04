// The sync status → one honest sentence, in ONE place.
//
// It lives in `lib/` rather than beside the settings panel because a second surface needs it:
// the approval wait shows why its code has not arrived, and that surface used to show nothing
// at all (myne-md/myne#1000's neighbouring defect — the screen discarded the status it was
// already being handed, so a stuck device and a working one looked identical). Two copies of
// this switch would let the same class read as two different problems on two screens.
//
// The rule the switch states: state, never a wall-clock (AS6/AS15), and a detail this build
// does not know is not evidence of a transport failure.

import type { TFunction } from "i18next";
import type { SyncStatus } from "./use-sync-status";

/** Honest status dot + label — state, never a wall-clock (AS6/AS15). */
export function statusView(status: SyncStatus | null, t: TFunction): { color: string; label: string } {
  switch (status?.state) {
    case undefined:
    case "disabled":
      return { color: "var(--line-3)", label: t("settings.archive.off") };
    case "not_enrolled":
      return { color: "var(--line-3)", label: t("settings.sync.summary.notSetUp") };
    case "pending":
      return { color: "var(--warning)", label: t("sync.status.awaitingApproval") };
    case "idle":
      return { color: "var(--success)", label: t("settings.archive.on") };
    case "syncing":
      return { color: "var(--accent)", label: t("sync.status.syncing") };
    case "error":
      // Class-scoped details, mirroring the desktop indicator's arms
      // (`src/components/sync/SyncStatusIndicator.tsx`) because a phone reaches
      // exactly the same classes out of the same core, and the shared copy
      // already exists for every one of them (myne-md/myne#938 task 13).
      //
      // The rule this replaces: everything but a TLS failure read "Offline", so a
      // locked identity, a frozen account, a full disk and a removed device all
      // told the user the same false thing and pointed at a network that was
      // working. "Offline" now means the one class it names, `sync_failed`, which
      // is what `FailureClass::Transport` and `Other` both report.
      switch (status.detail) {
        case "auth_failed":
          return { color: "var(--danger)", label: t("sync.status.errorAuth") };
        case "rate_limited":
          return { color: "var(--warning)", label: t("sync.status.errorRateLimited") };
        case "quota_exceeded":
          return { color: "var(--danger)", label: t("sync.status.errorQuota") };
        case "payload_too_large":
          return { color: "var(--danger)", label: t("sync.status.errorTooLarge") };
        case "frozen":
          return { color: "var(--danger)", label: t("sync.status.errorFrozen") };
        // A shared vault refuses to sync until the person identity is unlocked
        // for this session. Its own copy because the fix is a specific user
        // action, and "Offline" would send them looking at the network.
        case "identity_locked":
          return { color: "var(--warning)", label: t("sync.status.errorIdentityLocked") };
        case "storage_full":
          return { color: "var(--warning)", label: t("sync.status.errorStorageFull") };
        case "device_revoked":
          return { color: "var(--danger)", label: t("sync.status.errorDeviceRevoked") };
        // Not an offline device either: certificate and server-name validation
        // must be fixed before this client can reconnect.
        case "tls_failure":
          return { color: "var(--danger)", label: t("sync.status.errorTls") };
        case "sync_failed":
          return { color: "var(--warning)", label: t("settings.sync.summary.offline") };
        // A detail this build does not know (a newer core, a renamed class) is
        // not evidence of a transport failure, so it gets the generic copy.
        default:
          return { color: "var(--danger)", label: t("sync.status.error") };
      }
    case "conflicts":
      return {
        color: "var(--danger)",
        label: t("settings.sync.summary.conflicts", { count: status.count }),
      };
  }
}
