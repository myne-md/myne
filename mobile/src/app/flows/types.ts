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
   * Prefill from a scanned member-vault code: the endpoint to offer, and the
   * vault whose invite row to open the join wizard for. Seeded into the server
   * step's input (a visible, editable prefill, not a configured endpoint) and
   * used to auto-open the join step once the home step's invites have loaded.
   * Absent on every other entry into this flow, which is why it is optional.
   */
  fromQr?: { endpointUrl: string; accountHashHex: string };
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
  /**
   * The join used the recovery phrase (myne-md/myne#837). The vault is then
   * `Slot::Recovering`, NOT unlocked, so the shell mounts the mandatory chained
   * password reset (`recover`, `subStep: "password-reset"`) addressed at the
   * joined vault instead of routing to the editor. The same door desktop's
   * `JoinDeviceModal.onRecovering` opens.
   */
  onRecovering: (vaultId?: VaultId) => void;
  onCancel: () => void;
  /**
   * A scanned member-vault code: the shell closes this overlay and opens the
   * identity flow at the join step for that vault. One door, the code decides —
   * the `account` arm keeps its own confirm-then-form path (`onComplete` above),
   * and this arm has no account number for that confirm step to show, so it
   * hands the target straight back to the shell instead.
   */
  onMemberJoin: (target: { endpointUrl: string; accountHashHex: string }) => void;
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
  /**
   * Route to the restore-backup flow. Offered on the FAIL-CLOSED corrupted
   * screen (audit T6.8): the surface showed a restore hint but only a
   * close-app CTA, so it named a route it did not provide. Mobile has no
   * restore IPC yet, so the target is the honest placeholder, which says so
   * and offers the flows that DO work (create / recover).
   */
  onRestoreBackup?: () => void;
  onDeleteVaultSuccess: () => void;
}

export interface RecoverFlowProps {
  initialSubStep: RecoverSubStep;
  /**
   * The vault this recovery is already pointed at, for the entries that know it
   * before the screen mounts. Today that is the recovery-phrase DEVICE JOIN
   * (myne-md/myne#837): the joined vault is `Recovering` and the chained password
   * reset must target it explicitly, because the sole-vault fallback cannot
   * resolve once the device holds more than one vault. `undefined` on every
   * other entry: the recover screen's own reducer resolves or omits the target.
   */
  initialVaultId?: VaultId;
  onComplete: (vaultId?: VaultId) => void;
  onCancel: () => void;
}

export interface EditorFlowProps {
  vaultId?: VaultId;
  /** Lock the vault. `idle` is the auto-lock timer, which must NOT flush the
   *  structured index first (`protocol.md` §9.8.5, fail-closed); every other
   *  caller is manual and may. */
  onLock: (reason?: "manual" | "idle") => void;
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
