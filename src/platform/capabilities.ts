// Platform seam — the capability descriptor (phase3-web-client task 27).
//
// # Why this is a seam module rather than a runtime probe
//
// Every other module here re-exports a Tauri module; this one does not, and the
// reason it still belongs is the substitution mechanism. The UI needs to know
// what the platform can do **before rendering** — a menu that briefly shows a
// clipper entry and then removes it is worse than one that never showed it — so
// the answer must be a build-time constant, not an `await`. `src/platform/` is
// the one directory swapped at build time, which is exactly that.
//
// # Absent, not disabled
//
// `decisions.md` 2026-07-26 ("Web capability set") makes this normative rather
// than a UX preference: an unavailable feature is **omitted**, never greyed out.
// A disabled control is an offer the platform cannot honour — it tells the user
// the feature exists here and they are doing something wrong.
//
// # One descriptor, not gating re-derived per call site
//
// The failure this prevents is a feature that is hidden from the menu, still
// reachable from the command palette, and still bound to a keyboard shortcut.
// Every surface consults `has()`; none re-derives the answer.

/**
 * The capability set. Each name is a **product** capability, not a command:
 * `clipper` is absent because the whole feature is, not because some particular
 * IPC call is unported.
 *
 * The list is closed, so adding a capability forces every implementation of this
 * module to answer for it — which is what stops a new feature from being
 * silently available everywhere.
 */
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
  /** Legacy single-vault → multi-vault migration. */
  | "vaultMigration"
  /** Encrypted backup export and restore. */
  | "backup"
  /** Native Save-As to a user-chosen path. */
  | "nativeSaveAs"
  /** Account and vault CREATION (generates and shows the recovery phrase). */
  | "vaultCreation"
  /** Recovery by typing the 24-word phrase. */
  | "phraseRecovery"
  /**
   * Clearing the OS clipboard after a secret was copied to it, gated on reading
   * it back so unrelated content is never destroyed.
   *
   * The read-back is what makes the clear safe, and it is what a page cannot
   * do: Firefox grants page content no clipboard read at all, and the other
   * engines gate it behind a permission prompt plus document focus. So on web
   * the Copy affordance ships and the 30 second auto-clear does not
   * (`recovery-flow.md` §2.2 as amended 2026-08-15).
   *
   * A capability rather than a silent branch because the UI owes the user a
   * sentence when it is absent: `recovery-flow.md` forbids presenting a control
   * whose stated protection the client cannot perform.
   */
  | "clipboardAutoClear"
  /**
   * The 24-word phrase used as a DEVICE-ENROLMENT credential, the third phrase
   * path and the one that is easy to miss because that screen is about adding a
   * device rather than about the phrase.
   *
   * Split out of `phraseRecovery` by `decisions.md` 2026-08-15. One flag used to
   * gate both, so lifting the served-code phrase ban would have shipped three
   * phrase screens while the decision named two. They are separable on the
   * merits: recovery is the one situation with no alternative credential, and
   * enrolment already accepts account number plus master password. Every
   * ROUTINE use of the phrase is what teaches a user that typing 24 words into a
   * page is normal, which is the whole mechanism behind `threat-model.md` A18.
   */
  | "phraseEnrolment"
  /** Markdown-tree export to an OS directory. */
  | "vaultExport"
  /** Spell-check: misspelling detection, suggestions and the dictionary ops
   *  around them. Distinct from the `MYD1` personal dictionary itself, which is
   *  vault content and is not a capability. */
  | "spellCheck"
  /** Export a note to PDF. Distinct from `vaultExport` and from the note /
   *  attachment downloads: it is the one export whose OUTPUT FORMAT, not its
   *  destination, is the platform-specific part. */
  | "pdfExport"
  // ── capabilities web KEEPS, and keeps by decision rather than by default ──
  //
  // A descriptor listing only absences is an absence list wearing a capability
  // list's name, and it cannot express "this was considered and kept". These
  // two were, and both readings are load-bearing.
  /**
   * Changing the master password.
   *
   * **Present on web by decision** (`decisions.md` 2026-07-26): the master
   * password is already typed into the page at every unlock, so allowing it to
   * be changed there adds no exposure that unlocking did not already accept.
   * Recorded as a capability so that removing it is a visible edit rather than
   * a quiet omission.
   */
  | "changePassword"
  /**
   * PIN-based quick-unlock.
   *
   * Distinct from `biometricQuickUnlock`, which is absent: the PIN path is
   * "genuinely portable — Argon2id + three files under one vault root, no OS
   * secret involved" (`core-wasm-assessment.md`). Collapsing the two into one
   * capability would have made a portable feature look impossible.
   */
  | "pinQuickUnlock"
  /**
   * Scanning the vault directory for orphan artefacts and repairing them.
   *
   * **Absent on web by decision** (owner, 2026-07-27; MYND-574 task 72). The
   * repair exists because a desktop vault directory is a place other software —
   * a sync client, a backup tool, the user — can also write to, so it can hold
   * artefacts this app did not put there. An OPFS container is written by this
   * origin's client and nothing else, and the one damage mode it does have
   * (browser eviction) is answered by re-sync rather than by repair (task 22).
   * A repair affordance here would offer to fix a class of problem the storage
   * cannot have.
   */
  | "vaultRepair"
  /**
   * A vault can live on this client with **no sync server behind it**, so the
   * local copy may be the only copy there is.
   *
   * Desktop and mobile are local-first: sync is optional, and a user who never
   * enables it has exactly one copy of their notes. The web client is the other
   * shape — `decisions.md` 2026-07-26 makes sync **required** there, because the
   * OPFS container is a cache of a server-held vault rather than the vault
   * itself.
   *
   * **Not an affordance — a fact the copy has to know**, which is why it is here
   * rather than inferred at a call site. `vault_delete` runs on both clients and
   * removes the same bytes, but on a client where this is false, erasing the
   * local store is a SIGN-OUT: the account and everything already synced are on
   * the server, and signing in again brings them back. Telling that user their
   * notes are "permanently deleted" and that "your recovery phrase will not
   * restore the data" would be false in the direction that matters — someone
   * trying to destroy their data would believe they had, while every note was
   * still on the server. That is the same class of claim as
   * `REMOVE_DEVICE_DISCLOSURE`'s "removal is not a remote wipe", and it is
   * handled the same way: a load-bearing constant, selected by this flag.
   */
  | "localOnlyVault"
  /**
   * A HOST-CONFINED directory read: naming a folder and having the platform
   * walk and read it inside a root-validated seam the UI itself does not have.
   *
   * Desktop's `importer:` plugin is exactly that (`canonicalize` plus a
   * component-wise within-root check), and it exists BECAUSE the WebView is
   * denied `fs:allow-read-dir` — least privilege, TB6, SYNC-1.
   *
   * **Absent on web, and markdown import still ships.** That pairing is the
   * whole reason this is named for the READ rather than for the import: a
   * browser has no absolute path, no `canonicalize` and no host to confine to,
   * so it gets the tree from the user's own directory pick instead — which is
   * not a lesser version of the same mechanism, it is a different one that needs
   * no confinement because a page is only ever handed what the user chose. A
   * capability called `markdownImport` would have been a lie: the feature ships
   * on both.
   */
  | "hostDirectoryRead"
  /**
   * Importing notes from ANOTHER LOCAL MYNE VAULT (myne-md/myne#464).
   *
   * Named for the second vault, not for the import, and the distinction is the
   * same one `hostDirectoryRead` makes two entries down: markdown import ships
   * on every client. What does not is the ability to hold a SECOND vault's keys
   * while the first is unlocked, which is what this feature is.
   *
   * **Absent on web, on two independent grounds, and either alone is enough.**
   * A browser origin holds exactly ONE container under a constant vault id
   * (`phase3-web-client` task 85), so there is no second vault to import FROM
   * and the source list would be permanently empty. And the `importer:` plugin
   * is classified `Class::Unsupported` wholesale by the wasm dispatcher, so
   * every command behind the flow refuses.
   *
   * A capability rather than an empty list, because an empty list is a dead
   * affordance: the card would sit in the picker, the setup step would render,
   * and the user would reach a credential field for a vault that cannot exist.
   * `decisions.md` 2026-07-26 makes omission the normative answer to exactly
   * that shape.
   *
   * It also carries a SECOND consequence that the runtime flag alone cannot
   * deliver, so the module is substituted as well (`web/vite.config.ts`): the
   * setup step accepts a 24-word recovery phrase, and `threat-model.md` A18 is
   * about ROUTINE phrase prompts in a browser teaching a user that typing 24
   * words into a page is normal. `decisions.md` 2026-08-15 bounds this client
   * to asking for the phrase in exactly one situation, a recovery the user
   * started themselves, and an import is not that situation. A hidden branch
   * would leave the field in the artefact, one devtools breakpoint away, which
   * is the reason `scripts/check-web-no-phrase.mjs` exists at all.
   */
  | "vaultImport"
  /**
   * Searching the TEXT INSIDE attachments — a PDF's or DOCX's contents, not its
   * filename.
   *
   * **Absent on web this release** (MYND-574 task 90). Three facts make it a
   * decision rather than a port: the extractors live in `src-tauri/` so they do
   * not arrive here; the `MYE1` cache is device-local and **never synced**
   * (`protocol.md` §9.15), so a browser cannot inherit a desktop's extractions
   * either; and `read_extracted` collapses every decode failure to a cache MISS
   * whose contract is "the caller re-extracts" — which on web would mean
   * re-attempting an extraction that can never succeed, on every import.
   *
   * Named for the SEARCH, not the extraction, because that is what a user
   * loses: attachments still import, still sync, still open, and their filenames
   * are still searchable. Only their contents are not.
   */
  | "attachmentTextSearch"
  /**
   * Performing the ingest-time image TRANSFORM — downscale + re-encode before
   * an imported image is encrypted and stored.
   *
   * Named for the transform, not for the preference, and the distinction is the
   * whole point. `attachment_compression_enabled` is ordinary shared vault
   * content (`decisions.md` 2026-07-30): every client reads it, writes it and
   * syncs it, and a web session flipping it changes what this user's desktop
   * does. What a client without this capability declines is doing the decode.
   *
   * **Absent on web**, and for a containment reason rather than a capability
   * one: `catch_unwind` needs unwinding and `wasm32-unknown-unknown` has none,
   * so a hostile image that panicked the decoder would kill the vault Worker
   * instead of falling back to storing the original — turning a successful
   * import into a dead tab. `compress::is_supported_on_this_target` is the
   * backend half of the same statement.
   *
   * Like `localOnlyVault`, this changes COPY rather than removing a control:
   * the setting stays (it governs the user's other devices), but a helper line
   * claiming it "applies on every device" is false in front of the one client
   * that will not honour it.
   */
  | "imageCompression"
  /**
   * The `myne` terminal client reaching this vault over a local command socket
   * (MYND-490).
   *
   * **Absent on web, and it cannot be otherwise.** The door is a Unix domain
   * socket (or named pipe) that a shell command connects to, and the command is
   * a binary shipped inside the desktop bundle. A page has neither: no socket to
   * bind, no filesystem for a sidecar to sit on, and nothing on the machine that
   * could reach the tab if it did.
   *
   * Named for the ACCESS, not for the binary, because that is what the Settings
   * block governs — a door onto already-decrypted notes whose whole risk story
   * (`threat-model.md` §7) is about which programs on the machine can walk
   * through it. There is no browser-shaped version of that question.
   */
  | "cliAccess"
  /**
   * Vault names on the LOCKED picker, and with them the device-local sealed
   * `MYL1` store that makes showing one possible (myne-md/myne#411).
   *
   * **Absent on web, and already decided before this capability existed.** The
   * picker is the whole subject: a name is cached so the pre-unlock screen can
   * label a row, and `check-web-screens.mjs` records `VaultPicker.tsx` as
   * `excluded` because an origin holds exactly one container, so the
   * two-or-more-vault branch that produces that screen cannot be reached. The
   * store behind it is sealed under an OS keychain `wrap_key`, and a page has
   * no keychain, so there is no second half either.
   *
   * Named for the NAMES rather than for the Privacy switch that hides them,
   * because the switch is downstream: what a client without this capability
   * lacks is the display and its cache, and the setting that governs them is
   * omitted as a consequence. `decisions.md` 2026-08-15 records the erase
   * semantics; none of that changes here, and none of it is what web is
   * missing. `MYL1` and desktop behaviour are untouched.
   */
  | "lockedVaultNames"
  /**
   * Routing this client's own sync egress through a device-local Tor proxy
   * (MYND-650).
   *
   * **Absent on web, and not as a port that is owed.** The desktop client does
   * this by spawning a bundled Tor client as a subprocess and opening a SOCKS5
   * tunnel to it over a loopback TCP socket; a page has neither a subprocess
   * nor a raw socket, and `fetch` cannot be told to use a proxy. There is no
   * in-page version of the mechanism — the browser-shaped answer is Tor
   * Browser, which routes the whole page and does it better than an app ever
   * could from inside one.
   *
   * Named for the ROUTING, not for the sidecar: what the Developer Options
   * block governs is where this device's sync traffic goes, and the arti
   * process is an implementation detail of the desktop answer to it.
   */
  | "torRouting"
  /**
   * Grouping vaults under an account (the account/vault split, myne-md/myne#684).
   *
   * **Absent on web, and not as a port that is owed.** A browser holds exactly
   * one vault per origin and has no OS keychain, so there is no grouping to
   * render and nowhere to keep the wrap key whose seal is the account record.
   * The picker grouping UI is omitted rather than rendered against commands
   * that reject.
   */
  | "accountGrouping"
  /** B2B member sharing: person identity, invite, roster, removal. */
  | "memberSharing"
  /**
   * Desktop pop-out: open a note in its own OS-level window (second monitor;
   * myne-md/myne#173). Host-spawned `WebviewWindow`; web (single-tab OPFS) and
   * mobile cannot spawn OS windows, so the affordance is absent there.
   */
  | "detachedWindows"
  /**
   * The sandboxed editor for the user's own on-disk markdown files
   * (myne-md/myne#788).
   *
   * Desktop-only by the feature's own verdict: it needs an OS file ingress, a
   * native open dialog and, at graduation, a file-type handler registration,
   * none of which a browser page has. Absent rather than degraded: the
   * surface is omitted, never rendered against commands that refuse.
   */
  | "plainFile";

/**
 * Every capability, keyed so the compiler can count.
 *
 * **This used to be a bare array, and the comment above it claimed a missing
 * entry was "a compile error rather than a silent `undefined`". It was not.**
 * `readonly Capability[]` checks that every element IS a capability; nothing
 * checked that every capability is an element. Adding `spellCheck` (task 47) and
 * `pdfExport` (task 48) to the union while missing this list did exactly what
 * the comment promised could not happen: `DESKTOP` is built from these values,
 * so both features silently went ABSENT ON DESKTOP — a working feature hidden by
 * a list, which is the precise failure the comment named.
 *
 * A `Record<Capability, true>` is what actually enforces it: a missing key is a
 * TS2739 naming the capability, at the file that forgot it.
 */
const CAPABILITY_KEYS: Readonly<Record<Capability, true>> = Object.freeze({
  clipper: true,
  localAi: true,
  watchCapture: true,
  shareImport: true,
  biometricQuickUnlock: true,
  osIdleAutoLock: true,
  screenCaptureProtection: true,
  vaultMigration: true,
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
  vaultRepair: true,
  localOnlyVault: true,
  hostDirectoryRead: true,
  vaultImport: true,
  attachmentTextSearch: true,
  imageCompression: true,
  cliAccess: true,
  lockedVaultNames: true,
  torRouting: true,
  accountGrouping: true,
  memberSharing: true,
  detachedWindows: true,
  plainFile: true,
});

/** Every capability, derived from the keyed record so it cannot fall behind. */
export const ALL_CAPABILITIES: readonly Capability[] = Object.freeze(
  Object.keys(CAPABILITY_KEYS) as Capability[],
);
/**
 * The desktop client has every capability.
 *
 * Spelled out rather than `() => true` so that adding a capability which
 * desktop *also* lacks (a future mobile-only feature, say) has an obvious place
 * to say so, instead of being invisible behind a blanket yes.
 */
const DESKTOP: ReadonlySet<Capability> = new Set(ALL_CAPABILITIES);

/** Whether this platform provides `cap`. Synchronous by design — see the header. */
export function has(cap: Capability): boolean {
  return DESKTOP.has(cap);
}
