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
  onRecover: () => void;
}

export interface CreateVaultFlowProps {
  briefing?: boolean;
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
