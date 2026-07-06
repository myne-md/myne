// Map a bounded `IoFailureKind` to a user-facing banner string.
// Shared by `Unlock.tsx` (vault_unlock IO failure) and the recover
// flow's `PhraseEntryStep` (recover_with_phrase IO failure).
//
// Closed mapping — adding a new IoFailureKind variant compile-fails
// the switch via `assertNever`. Wire to keep banner copy aligned
// across both surfaces; drift would silently weaken consistency.
//
// Mobile has no i18n layer (desktop resolves these via `i18n.t(...)`);
// the literal English strings below are inlined verbatim from the
// desktop catalog `locales/en/common.json` (`vault.ioBanner.*`).

import type { IoFailureKind } from "./stage";

export function ioBanner(kind: IoFailureKind): string {
  switch (kind) {
    case "PermissionDenied":
      // vault.ioBanner.permissionDenied
      return "No permission to access the vault file. Check file permissions.";
    case "NotFound":
      // Defensive — `vault_unlock` / `vault_recover_with_phrase`
      // special-case NotFound to a dedicated `VaultNotFound` variant;
      // this branch is unreachable in practice when the caller
      // discriminates. (vault.ioBanner.notFound)
      return "Vault file not found. Please restart the app.";
    case "NoSpace":
    case "Other":
      // vault.ioBanner.cannotRead
      return "Cannot read the vault file.";
  }
}
