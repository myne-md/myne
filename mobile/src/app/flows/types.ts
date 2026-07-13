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
}

export interface JoinFlowProps {
  /** Device bootstrapped + unlocked a fresh local vault from the server —
   *  the shell maps this to `welcome.join-success` (lands in the editor). */
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
  onSwitchVault: (vaultId: VaultId) => void;
  onDeleteVaultSuccess: () => void;
}

export interface PickerFlowProps {
  onSelect: (vaultId: VaultId, fromPicker: boolean) => void;
  onCreate: () => void;
}

export interface RestoreBackupFlowProps {
  entry: "welcome" | "picker" | "corrupted" | "settings";
  onDone: () => void;
}
