// The web build's stand-in for the device-join modal (myne#221).
//
// `App.tsx` mounts `<JoinDeviceModal />` GLOBALLY — over welcome, over the
// vault picker, over the unlock screen the account-chip switcher routes to —
// because on desktop the same door is offered from three places. None of them
// exists here: an origin holds exactly one container under a constant vault id
// (phase3-web-client task 85), so there is no second vault to bootstrap, and
// the one join a browser does perform is `AccountBootstrap` — the first-run
// flow that has no server-URL field and no TOFU fingerprint step, because a
// page cannot see a leaf certificate.
//
// So this renders nothing, and the modal's TOFU pinning vocabulary, its SAS
// eye-compare copy and its device-naming form never enter the bundle. Before
// the mount was hoisted out of `Welcome`, that exclusion came for free — the
// welcome screen is itself substituted, and its stub says so. A globally
// mounted component is exactly the shape that otherwise ships unnoticed:
// nothing routes to it, so no route audit finds it. Same reasoning, and the
// same mechanism, as `web/src/components/PairingDialog.tsx`.

interface JoinDeviceModalProps {
  onCancel: () => void;
  onJoined: (vaultId: string) => void;
  onRecovering: () => void;
}

export function JoinDeviceModal(_props: JoinDeviceModalProps) {
  return null;
}
