// The capability VOCABULARY: every product capability a client may answer for.
//
// Cross-client by construction (myne-md/myne#849): each client keeps its own
// ANSWERS in its own seam module, and none of them keeps its own copy of this
// list. No imports — compiled into all three clients, read by no host.

export type Capability =
  /** Browser-extension web clipper (native-messaging host + pairing). */
  | "clipper"
  /** On-device LLM: ask, chat, summarise, transcribe. */
  | "localAi"
  /** Apple Watch dictated-note capture queue. */
  | "watchCapture"
  /** OS share-sheet import. */
  | "shareImport"
  /** Keychain / biometric quick-unlock. (The PIN path is separate.) */
  | "biometricQuickUnlock"
  /** OS idle detection driving auto-lock. */
  | "osIdleAutoLock"
  /** Compositor-level screen-capture exclusion. */
  | "screenCaptureProtection"
  /** The opt-in diagnostic log the user is invited to send on (myne-md/myne#860). */
  | "diagnosticLog"
  /** Legacy single-vault → multi-vault migration. */
  | "vaultMigration"
  /**
   * The identity phrase opening a person-wrapped (`NTV7`/`NTV8`) vault, where it
   * replaces the retired per-vault recovery phrase. Present on all three clients.
   */
  | "personVaultCredential"
  /**
   * The person identity plane: create, register, unlock with the phrase, join
   * from a scanned code. Split from `memberSharing` so a client can ship one
   * without the other. Present on all three clients.
   */
  | "personIdentity"
  /**
   * Whether this client keeps the person identity AT REST: a native client
   * seals the keypair and device token to its app-config dir, a browser holds
   * neither on disk and so re-asks for the phrase on reload (A15/TB11, A18).
   */
  | "personCredentialPersisted"
  /** Encrypted backup export and restore. */
  | "backup"
  /** Native Save-As to a user-chosen path. */
  | "nativeSaveAs"
  /** Account and vault CREATION (generates and shows the recovery phrase). */
  | "vaultCreation"
  /** Recovery by typing the 24-word phrase. */
  | "phraseRecovery"
  /**
   * Clearing the OS clipboard after a secret was copied, gated on reading it
   * back. Absent on web: no page clipboard read, so the affordance ships and
   * the auto-clear does not (recovery-flow.md §2.2).
   */
  | "clipboardAutoClear"
  /**
   * The phrase as a DEVICE-ENROLMENT credential. Separable from
   * `phraseRecovery` because routine phrase prompts in a page are the mechanism
   * behind A18, and enrolment already accepts account number + password.
   */
  | "phraseEnrolment"
  /** Markdown-tree export to an OS directory. */
  | "vaultExport"
  /** Spell-check: detection, suggestions and the dictionary ops around them. */
  | "spellCheck"
  /** Export a note to PDF — the one export whose FORMAT, not destination, is platform-specific. */
  | "pdfExport"
  /**
   * Writing `vault.prefs`. A build without it must send an EMPTY agent intent
   * catalogue rather than a change the user approves and watches fail. Does not
   * cover the detached window, which is gated by window ROLE (`offeredSettingIds`).
   */
  | "prefsWrite"

  // Kept on web by decision rather than by default, so that removing one is a
  // visible edit instead of a quiet omission.

  /** Changing the master password — already typed into the page at every unlock (2026-07-26). */
  | "changePassword"
  /**
   * PIN quick-unlock. Distinct from `biometricQuickUnlock`, which web lacks: the
   * PIN path is portable (Argon2id + three files, no OS secret).
   */
  | "pinQuickUnlock"
  /** Scanning the vault directory for orphan artefacts. Absent on web: an OPFS container holds nothing this app did not write (MYND-574 task 72). */
  | "vaultRepair"
  /**
   * A vault can live on this client with NO sync server behind it, so erasing
   * the local copy is not a remote wipe. Selects the load-bearing copy; never
   * infer it at a call site.
   */
  | "localOnlyVault"
  /**
   * A HOST-CONFINED directory read (desktop `importer:`), named for the read
   * rather than the import: markdown import ships on web too, through the user's
   * own directory pick.
   */
  | "hostDirectoryRead"
  /**
   * Importing notes from ANOTHER local vault (myne-md/myne#464). Absent on web:
   * one container per origin, and the `importer:` plugin is `Unsupported`
   * wholesale there.
   */
  | "vaultImport"
  /**
   * Searching the TEXT inside attachments. Absent on web: the extractors live in
   * `src-tauri/` and the `MYE1` cache is device-local, never synced (§9.15).
   */
  | "attachmentTextSearch"
  /**
   * The ingest-time image transform (downscale + re-encode). Absent on web for
   * containment: `catch_unwind` needs unwinding and wasm32 has none, so a
   * hostile image would kill the vault Worker. Changes copy, not a control.
   */
  | "imageCompression"
  /**
   * The `myne` CLI reaching this vault over a local command socket (MYND-490).
   * Absent on web: no socket to bind and no filesystem for a sidecar.
   */
  | "cliAccess"
  /**
   * An external MCP client through the `myne-mcp` sidecar (myne-md/myne#923).
   * A second flag rather than a reuse of `cliAccess`: a program that reads on
   * its own is a different offer from a terminal the user drives. Absent on web
   * and mobile: no PATH to install a stdio binary onto.
   */
  | "externalMcp"
  /**
   * Vault names on the LOCKED picker, and the device-local sealed `MYL1` cache
   * behind them (myne-md/myne#411). Absent on web: no OS keychain to wrap it.
   */
  | "lockedVaultNames"
  /**
   * Routing this client's own sync egress through a device-local Tor proxy
   * (MYND-650). Absent on web: no subprocess and no SOCKS5 socket.
   */
  | "torRouting"
  /**
   * Grouping vaults under an account (myne-md/myne#684). Absent on web: the
   * account record's wrap key lives in an OS keychain.
   */
  | "accountGrouping"
  /** B2B member sharing: person identity, invite, roster, removal. */
  | "memberSharing"
  /** Desktop pop-out into its own OS window (myne-md/myne#173). Absent on web and mobile: neither spawns OS windows. */
  | "detachedWindows"
  /** The sandboxed editor for the user's own on-disk markdown (myne-md/myne#788). Desktop-only: needs an OS file ingress. */
  | "plainFile"
  /** In-app desktop self-update. Desktop-only: `tauri-plugin-updater` has no browser target. */
  | "selfUpdate"

  // The live-collab epic's three flags (SYNC-31).

  /** A live co-editing SESSION: this client can be the single durable writer. Present on all three. */
  | "liveCollabPeerPresence"
  /** Rendering peers' cursors, selections and live typing. Absent on web: the awareness supervisor is a native SSE consumer. */
  | "liveCollabAwarenessCursors"
  /** B2B live collaboration between different PEOPLE. Absent on web: no person identity there, the same reason as `memberSharing`. */
  | "liveCollabMultiUser";

export const CAPABILITY_KEYS: Readonly<Record<Capability, true>> = Object.freeze({
  clipper: true,
  localAi: true,
  watchCapture: true,
  shareImport: true,
  biometricQuickUnlock: true,
  osIdleAutoLock: true,
  screenCaptureProtection: true,
  diagnosticLog: true,
  vaultMigration: true,
  personVaultCredential: true,
  personIdentity: true,
  personCredentialPersisted: true,
  backup: true,
  nativeSaveAs: true,
  vaultCreation: true,
  phraseRecovery: true,
  phraseEnrolment: true,
  clipboardAutoClear: true,
  vaultExport: true,
  changePassword: true,
  pinQuickUnlock: true,
  spellCheck: true,
  pdfExport: true,
  prefsWrite: true,
  vaultRepair: true,
  localOnlyVault: true,
  hostDirectoryRead: true,
  vaultImport: true,
  attachmentTextSearch: true,
  imageCompression: true,
  cliAccess: true,
  externalMcp: true,
  lockedVaultNames: true,
  torRouting: true,
  accountGrouping: true,
  memberSharing: true,
  detachedWindows: true,
  plainFile: true,
  selfUpdate: true,
  liveCollabPeerPresence: true,
  liveCollabAwarenessCursors: true,
  liveCollabMultiUser: true,
});
