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
  /**
   * Enter the fresh-device sync-join flow ("Connect to my account").
   *
   * The welcome screen has ONE create action (myne-md/myne#911 task 12), so
   * there is no `onCreate` any more: the identity is created first and the vault
   * follows from the identity home. A device that wants a vault without an
   * identity is not a state this client offers, because the desktop does not
   * offer it either and a client that invented one would be the only place the
   * two-phrase model still existed.
   */
  /**
   * The QR door is no longer on this screen (myne-md/myne#932): it lives inside
   * the identity flow's fork step, beside the phrase door, because "I already have
   * an identity" has two credentials and the first-run screen cannot show both.
   */
  onJoin?: () => void;
  /**
   * The one create door (myne-md/myne#768, narrowed by myne-md/myne#911 task 12).
   * Opens the mobile identity flow, which fronts the sync-server step when none is
   * configured, creates the identity, and lands on the identity home whose
   * create-vault action is the next step of the same chain.
   */
  onIdentity: () => void;
  /**
   * "I already have an identity" (myne-md/myne#932), the second door on the
   * first-run screen.
   *
   * It opens the identity flow at its fork step, which offers the two credentials
   * a device can bring an existing identity with: the 24 words, or a code from a
   * device that already has it. The door used to be one level in, behind the
   * button labelled "Create your identity and vault", which is the mislabel this
   * fixes: a returning user will not look for their own identity inside a create
   * action. The desktop has answered this fork at the top level since it shipped
   * (`IdentitySetupPanel`: "A new identity" beside "I already have one").
   */
  onHaveIdentity: () => void;
}

export interface IdentityFlowProps {
  /** Leave the flow. From the gate it is the skip path; from the home it
   *  dismisses the overlay. An identity, once created, is not undone here. */
  onCancel: () => void;
  /**
   * The third row of the first-run fork: the account-and-password door that used
   * to BE the welcome screen's second button (myne-md/myne#932). It is kept
   * reachable because an account made before identities existed is not an
   * identity, and a fresh device with one had no other way in once the label on
   * that button changed. Absent means the surface offers only the identity
   * credentials, which is what Settings' own entry does.
   */
  onJoinAccount?: () => void;
  /**
   * Prefill from a scanned member-vault code: the endpoint to offer, and the
   * vault whose invite row to open the join wizard for. Seeded into the server
   * step's input (a visible, editable prefill, not a configured endpoint) and
   * used to auto-open the join step once the home step's invites have loaded.
   * Absent on every other entry into this flow, which is why it is optional.
   */
  fromQr?: { endpointUrl: string; accountHashHex: string };
  /**
   * A scanned PERSON code (myne-md/myne#911 task 9, wired on this client by task
   * 12): the endpoint and the person this device is joining. When set, the flow
   * opens at the person-join phrase step BEFORE any identity probe, because the
   * device joining an account has no identity yet and the phrase it types is what
   * creates one.
   */
  fromPersonQr?: { endpointUrl: string; personIdHex: string };
  /**
   * Which step the flow opens on when nothing scanned it here (myne-md/myne#932).
   *
   * The shell decides, because the shell owns the door that was pressed: the
   * create button opens `"create"`, and "I already have an identity" opens the
   * `"join-fork"` step. Absent, the flow opens on its gate, which is what every
   * Settings entry wants.
   */
  initialStep?: "gate" | "join-fork" | "create" | "recover";
  /**
   * Hand a scan request back to the shell (myne-md/myne#932). The fork step offers
   * "Scan the code from my other device", and the scanner is the shell's: it owns
   * the overlay, decodes the payload and re-enters this flow with `fromPersonQr`.
   * Absent when the flow was not opened from the first-run fork.
   */
  onScanCode?: () => void;
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
  /**
   * Create a vault from the identity home (myne-md/myne#911 task 12).
   *
   * Passed ONLY by the entry that knows there are zero vaults on this device
   * (the welcome door), because the identity home is also reachable from Settings
   * on a device that already holds vaults, where a create action would be a second
   * door to a flow the picker and the editor already own. The flow renders the
   * action only when it is given, so the caller stays authoritative and the flow
   * needs no vault-list probe of its own.
   */
  onCreateVault?: () => void;
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
  /**
   * A scanned PERSON code (myne-md/myne#911 task 9, wired on this client by task
   * 12): the shell closes this overlay and opens the identity flow's person-join
   * wizard, which takes the phrase and waits for an existing device to approve.
   *
   * Same shape as `onMemberJoin` and for the same reason: this flow owns the
   * account-number confirm step, and a person code has no account number. The
   * credential a person join needs is the identity phrase, which lives in the
   * identity flow rather than here.
   */
  onPersonJoin: (target: { endpointUrl: string; personIdHex: string }) => void;
  /**
   * Open on the approval WAIT instead of on the credential form, and close on the
   * compare instead of on Cancel (myne-md/myne#535, mobile half).
   *
   * The shell mounts the flow this way for the `pending-approval` stage: a device
   * that is enrolled and has never adopted a head, reached after unlock. The wait
   * is a MOUNT-TIME initial value, not a controlled prop — once mounted the flow
   * owns its own step, so an approval it observes takes effect immediately
   * instead of waiting for the shell to re-render it. Same contract as desktop's
   * `AccountBootstrap.initiallyPending`.
   */
  initiallyPending?: boolean;
  /**
   * The vault the wait is about, for the resumed entry. The overlay entry learns
   * it from `sync_join_account`'s result; the stage already knows it, and
   * `onComplete` needs it to address the editor.
   */
  initialVaultId?: VaultId;
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
  /** Open the approval wait for this vault from Settings → Sync (#535). The
   *  automatic route is a verdict read after unlock; this is the door that
   *  survives the verdict being wrong. Optional because the editor's own tests
   *  render it without a shell to dispatch to. */
  onShowApprovalCode?: () => void;
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
