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
   * Opens the mobile identity flow AT ITS CREATE STEP — not its gate, whose menu
   * re-asked this screen's own two choices — creates the identity, and lands on the
   * identity home whose create-vault action is the next step of the same chain.
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
   * The wizard finished and put vaults on this device. The shell closes the
   * overlay and hands the landing to `landOnJoinedVaults`, which is how every
   * flow hands a new vault back.
   *
   * NOT called by the accept itself. The name step sits between the two and reads
   * this through a ref, so the accepted vault cannot reach an editor unnamed: the
   * callback is the name gate's completion, not the accept's.
   *
   * `undefined` keeps the old re-probe behaviour for a caller that installed
   * nothing.
   */
  onAccepted: (landing?: JoinLanding) => void;
  /**
   * Create a vault from the identity home (myne-md/myne#911 task 12).
   *
   * Passed ONLY by the entry that knows there are zero vaults on this device
   * (the welcome door): a device that already holds a vault reaches this flow from
   * the sync surface's repair door or from a scanned code, where a create action
   * would be a second door to a flow the picker and the editor already own. The
   * flow renders the action only when it is given, so the caller stays
   * authoritative and the flow needs no vault-list probe of its own.
   *
   * The identity UNLOCK door does not depend on this (myne-md/myne#1029): it used
   * to, which is why a device holding a vault had no surface here that could open
   * its identity.
   */
  onCreateVault?: () => void;
  /**
   * Present when this mount IS the sync surface's repair door (myne-md/myne#1029).
   *
   * The shell opens the flow for a device whose sync is blocked on a closed
   * identity, so the mount lands on the phrase grid instead of the home whenever
   * the probe answers "sealed", and calls this instead of landing on the home once
   * the phrase is accepted: the caller closes the overlay and the surface that
   * asked re-reads its own status. Absent on every other entry, which keeps the
   * home as the landing step those doors have always used.
   */
  onUnlocked?: () => void;
}

/**
 * What a wizard put on this device, and whether it left it OPEN.
 *
 * The presence of a vault id is what tells the shell that this device still owes
 * its approval wait: a freshly installed vault carries a device the owner has to
 * admit, so re-probing would land on an ordinary editor (or the unlock form) with
 * the §6.3 compare never made.
 *
 * `holding` is the second half and it is the flow's fact, not something the shell
 * can infer: an ACCEPT and a member-vault join install the keys with the invite
 * and hand the vault back unlocked, while a PERSON join writes frames and no key
 * at all (`core/src/plugins/sync/person_discovery.rs`), so its vaults arrive
 * locked and the approval wait cannot run against them yet, because the wait's poll
 * claims a token, and the claim needs `root_key`.
 */
export interface JoinLanding {
  vaultIds: string[];
  holding: "unlocked" | "locked";
}


export interface CreateVaultFlowProps {
  briefing?: boolean;
  /** Exit the flow back to wherever it was entered (editor / picker / welcome).
   *  Wired to the boot re-probe, mirroring restore-backup's exit. Without it the
   *  first step's "Back" is a dead end — a trap when entered with briefing off. */
  onCancel: () => void;
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
  /** Scan a join code from the vault switcher — the "join a vault" twin of
   *  `onCreateVault` (myne-mobile#40). It opens the scanner, not a form: the only
   *  join door left is the QR (`decisions/sync/0767`). */
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
