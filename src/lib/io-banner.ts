// Map a bounded `IoFailureKind` to a user-facing TR banner string.
// Shared by `Unlock.tsx` (vault_unlock IO failure) and the recover
// flow's `PhraseEntryStep` (recover_with_phrase IO failure).
//
// Closed mapping — adding a new IoFailureKind variant compile-fails
// the switch via `assertNever`. Wire to keep banner copy aligned
// across both surfaces; drift would silently weaken consistency.

import i18n from "../i18n";
import type { IoFailureKind } from "./stage";

export function ioBanner(kind: IoFailureKind): string {
  switch (kind) {
    case "PermissionDenied":
      return i18n.t("vault.ioBanner.permissionDenied");
    case "NotFound":
      // Defensive — `vault_unlock` / `vault_recover_with_phrase`
      // special-case NotFound to a dedicated `VaultNotFound` variant;
      // this branch is unreachable in practice when the caller
      // discriminates.
      return i18n.t("common.vaultfilenotfoundpleaserestarttheapp");
    case "NoSpace":
    case "Other":
      return i18n.t("vault.ioBanner.cannotRead");
  }
}
