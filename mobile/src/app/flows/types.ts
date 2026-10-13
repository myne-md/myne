import type { StageVaultStatus, SuspicionReason, RecoverSubStep, VaultId } from "../../lib/stage";

/**
 * Props each functional flow receives from the AppShell. The shell owns the
 * Stage machine + side effects (lock, reprobe); flows own their local form
 * state + the IPC calls for their step, and signal completion via these
 * callbacks (which the shell maps to `transition` actions).
 *
 * Flows reuse the design primitives/components — they are the wired, stateful
 * counterparts to the static screens shown in the design gallery.
 */

export interface WelcomeFlowProps {
  onCreate: () => void;
  /** Enter the fresh-device sync-join flow ("Connect to my account"). */
  onJoin: () => void;
  /**
   * Identity-first door (myne-md/myne#768). Opens the mobile identity flow,
   * which fronts the sync-server step when none is configured and lands on the
   * identity home once an identity exists.
   */
  onIdentity: () => void;
}

export interface IdentityFlowProps {
  /** Leave the flow. From the gate it is the skip path; from the home it
   *  dismisses the overlay. An identity, once created, is not undone here. */
  onCancel: () => void;
  /**
   * An invite was accepted, this device has named itself, and the member vault
   * exists on disk and unlocked (myne-md/myne#851 tasks 14 and 15). The shell
   * closes the overlay and re-probes, which is how every other flow hands a new
   * vault back (`JoinFlowProps`' `onComplete` is the same shape): the vault is on
   * disk and unlocked, so the probe is what decides where the user lands, rather
   * than this flow guessing.
   *
   * NOT called by the accept itself. The name step sits between the two and reads
   * this through a ref, so the accepted vault cannot reach an editor unnamed: the
   * callback is the name gate's completion, not the accept's.
   */
  onAccepted: () => void;
}

export interface JoinFlowProps {
  /** Device bootstrapped + unlocked a fresh local vault from the server — the
   *  shell maps this to the `*.join-success` action of whichever stage opened
   *  the flow (welcome / picker / editor), all of which land in the editor. */
  onComplete: (vaultId?: VaultId) => void;
  onCancel: () => void;
}

export interface CreateVaultFlowProps {
  briefing?: boolean;
  /** Exit the flow back to wherever it was entered (editor / picker / welcome).
   *  Wired to the boot re-probe, mirroring restore-backup's exit. Without it the
   *  first step's "Back" is a dead end — a trap when entered with briefing off. */
  onCancel: () => void;
  onCommitSuccess: (vaultId?: VaultId) => void;
  onAutoUnlockSuccess: (vaultId?: VaultId) => void;
  onAutoUnlockFailed: (vaultId?: VaultId) => void;
}

export interface UnlockFlowProps {
  initialStatus: StageVaultStatus;
  vaultId?: VaultId;
  suspicionReason?: SuspicionReason;
  fromPicker?: boolean;
  onUnlocked: () => void;
  onStartRecovery: () => void;
  onBackToPicker?: () => void;
  onDeleteVaultSuccess: () => void;
}

export interface RecoverFlowProps {
  initialSubStep: RecoverSubStep;
  onComplete: (vaultId?: VaultId) => void;
  onCancel: () => void;
}

export interface EditorFlowProps {
  vaultId?: VaultId;
  onLock: () => void;
  onCreateVault: () => void;
  /** Enter the sync-join flow from the vault switcher — the "connect to my
   *  account" twin of `onCreateVault` (myne-mobile#40). */
  onJoinAccount: () => void;
  onSwitchVault: (vaultId: VaultId) => void;
  onDeleteVaultSuccess: () => void;
}

export interface PickerFlowProps {
  onSelect: (vaultId: VaultId, fromPicker: boolean) => void;
  onCreate: () => void;
  /** Enter the sync-join flow from the picker footer (myne-mobile#40). */
  onJoin: () => void;
}

export interface RestoreBackupFlowProps {
  entry: "welcome" | "picker" | "corrupted" | "settings";
  onDone: () => void;
}
