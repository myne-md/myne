// Web substitution for the shared identity setup dialog (myne-md/myne#768).
//
// Identity setup registers a person account at a sync server, and
// `plugin:sync|sync_person_setup` is `Class::Unsupported` on web
// (`web/wasm/src/capability.rs`). The served bundle therefore must not carry
// the real dialog, and this substitution is what keeps it out rather than a
// runtime flag: the settings Sync panel gates its identity block on
// `memberSharing`, but a gate is not an exclusion, and the build would still
// pull the dialog in and fail on the missing `personSetup` export.
//
// Renders nothing. The web first run never reaches it (`AccountBootstrap` is
// the first-run screen there, not `Welcome`), so this is only the type and the
// substitution target.

export interface IdentitySetupDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

export function IdentitySetupDialog(_props: IdentitySetupDialogProps) {
  return null;
}
