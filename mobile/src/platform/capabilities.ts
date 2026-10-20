// Platform seam: the capability descriptor, mobile implementation.
//
// # What this file is, and what it is not
//
// The desktop seam module (`src/platform/capabilities.ts`) answers the same
// question for that client, and the web client substitutes its own file at that
// same path. Mobile has its own tree, so it needs its own file: this is the
// third implementation the closed list always implied and never had.
//
// The VOCABULARY is not repeated here. It lives in `@myne/client-core`, because
// "which capabilities exist" is a question all three clients answer identically
// and is therefore a cross-client decision, while "does THIS client have it" is
// not. Before the split the union sat inside the desktop seam, so mobile could
// not answer the list at all and the closure the desktop module documents was
// true of one client.
//
// # Why the record is keyed
//
// `Record<Capability, boolean>` is what makes the closure machine-checked: a
// capability added to the shared union makes THIS file a TS2739 naming the
// capability until somebody answers it. The desktop module learned that the hard
// way, and its own comment records it: a bare array checks that every element is
// a capability and not that every capability is an element, so two capabilities
// silently went ABSENT on desktop, which is a working feature hidden by a list.
//
// # Absent, not disabled
//
// `decisions.md` 2026-07-26 makes the desktop and web rule normative: an
// unavailable feature is omitted, never greyed out. A `false` here is therefore
// a build-time input to omission, and every `false` carries the reason it is
// false so a later reader can check the claim rather than re-derive it.

import { CAPABILITY_KEYS } from "@myne/client-core/capabilities";
import type { Capability } from "@myne/client-core/capabilities";

export type { Capability };

/**
 * Whether the MOBILE client provides each capability.
 *
 * Every `false` states why, because a `false` is a claim about this client that
 * nothing else in the tree can check.
 */
const MOBILE_ANSWERS: Readonly<Record<Capability, boolean>> = Object.freeze({
  // The browser clipper is a desktop-side pairing host. No mobile plugin, no
  // pairing surface, and the extension talks to the desktop's socket by name.
  clipper: false,
  // On-device LLM: `plugins::local_inference` is registered and the AI chat,
  // review and transcript flows consume it.
  localAi: true,
  // Apple Watch dictated-note capture: `plugins::captures` is registered.
  watchCapture: true,
  // OS share sheet import: `plugins::share_import` plus the `share-intent`
  // platform plugin and the share-import toast.
  shareImport: true,
  // Biometric quick unlock: the mobile `quick_unlock` core carries the
  // biometric arm and the app shell offers it. (The stale comment in
  // `plugins/mod.rs` saying biometric stays desktop-only is what prompted the
  // check; the code disagrees.)
  biometricQuickUnlock: true,
  // Idle auto-lock: a WebView timer on this client, with the Rust side
  // reporting activity. Desktop uses the OS idle source instead.
  osIdleAutoLock: true,
  // Screen-capture protection: `tauri-plugin-screen-guard` is registered.
  screenCaptureProtection: true,
  // The desktop's opt-in diagnostic log has no mobile twin (myne-md/myne#860):
  // the file layer and its toggle are desktop-only, so this client answers false
  // rather than inheriting a capability it cannot honour.
  diagnosticLog: false,
  // The v0.1 to v0.2 on-disk migration. Mobile registers no `vault_migrate`
  // plugin, so a pre-v0.2 vault has no upgrade path on this client.
  vaultMigration: false,
  // Vault backup (MYB1). The mobile backend carries no backup command at all:
  // `RestoreBackupFlow` is a WIRED PLACEHOLDER whose own header says
  // "Backup/restore is a Phase-2 capability that the mobile backend does not yet
  // include, so there is no IPC to call here". Note that `backup_exclude` is a
  // different thing entirely: it keeps the plaintext EXPORT directory out of the
  // platform's cloud backup, and it says nothing about vault backup.
  backup: false,
  // A native "save as" dialog. Neither iOS nor Android offers the WebView a save
  // dialog or folder picker, so the app picks the destination for its plaintext
  // writers (`threat-model.md` TB3 records the exception).
  nativeSaveAs: false,
  // Creating a vault, including one that never syncs.
  vaultCreation: true,
  // Unlocking with the 24-word recovery phrase.
  phraseRecovery: true,
  // Clearing the clipboard on a timer after a secret copy. The mobile transport
  // asks the OS to expire the item instead of scheduling a clear, which is
  // stronger on iOS (it survives the process) and is documented in
  // `mobile/src/lib/clipboardTransport.ts` and `secret-export.ts`.
  clipboardAutoClear: true,
  // Typing the phrase into a credential grid, which the join and accept flows do.
  phraseEnrolment: true,
  // Vault export through `plugins::export` with the export-dir chokepoint.
  vaultExport: true,
  // The spell layer. Mobile compiles `editor/src`, but no spell backend reaches
  // this client: `mobile/src/editor-host.ts` lists spell among the surfaces
  // mobile has no backend for, and no dictionary plugin is registered under
  // `mobile/src-tauri/src/plugins/`. The `spell_enabled` PREFERENCE exists and
  // syncs (a phone toggle reaches the desktop sharing the vault), but nothing
  // consumes it on this client.
  spellCheck: false,
  // PDF export: the mobile crate carries `pdf_export` and listens for its
  // export event.
  pdfExport: true,
  // Writing `vault.prefs`, through the mobile prefs chokepoint.
  prefsWrite: true,
  // Changing the vault password.
  changePassword: true,
  // PIN quick unlock. The mobile quick-unlock core registers the PIN arm.
  pinQuickUnlock: true,
  // Repairing a vault whose metadata is damaged.
  vaultRepair: true,
  // A vault with no sync endpoint at all. `CreateVaultFlow` mints the phrase and
  // the account number locally, so a mobile vault can exist without a server.
  localOnlyVault: true,
  // Reading an arbitrary directory on the host. Mobile has no directory picker
  // and no `plugin:path|*` grant for one.
  hostDirectoryRead: false,
  // Importing another vault's notes. No import plugin and no import flow.
  vaultImport: false,
  // Searching extracted attachment text: the MYE1 cache (an attachment
  // transcript is sealed into it and folded into its owning note's index).
  attachmentTextSearch: true,
  // The attachment compression toggle and its `Apply` ingest arm.
  imageCompression: true,
  // Driving the running desktop over its local command socket. The `myne` CLI is
  // a desktop sidecar; no mobile equivalent exists.
  cliAccess: false,
  // Showing a vault's name while the vault is locked, from the sealed label
  // store.
  lockedVaultNames: true,
  // Tor routing for sync. The arti sidecar ships with the desktop bundle and the
  // device-local routing option is desktop-only.
  torRouting: false,
  // Grouping vaults by account in the picker. `PickerFlow` renders one
  // `picker.account-header` group per account (`groupVaults`), so the picker
  // groups here exactly as it does on desktop.
  accountGrouping: true,
  // Sharing a vault between different people over the group substrate: the join
  // and identity flows, the member-name store and the device-binding store are
  // all registered here.
  memberSharing: true,
  // Opening a note in its own OS window. A phone has no such affordance; the
  // editor is the screen.
  detachedWindows: false,
  // The plain-file surface: `mobile/src/platform/plainFile.ts` is the seam file
  // the shared plain-file tree renders through.
  plainFile: true,
  // In-app auto-update. No updater plugin is registered on this client; mobile
  // updates arrive through the OS store.
  selfUpdate: false,
  // A live co-editing session, making this device the single durable writer for
  // the open note (`SYNC-33`). The `live` plugin is registered on this client.
  liveCollabPeerPresence: true,
  // Rendering peers' carets and selections. Mobile consumes the shared
  // awareness store and drives the shared editor's decoration field.
  liveCollabAwarenessCursors: true,
  // Multiple PEOPLE co-editing one note live. The group substrate this rides on
  // (member names, device bindings, the join flow) is present on this client.
  // The B2B member ROSTER SURFACE is a separate deliverable and is not implied
  // by this answer.
  liveCollabMultiUser: true,
});

/** Every capability, derived from the shared keyed record so it cannot fall behind. */
export const ALL_CAPABILITIES: readonly Capability[] = Object.freeze(
  Object.keys(CAPABILITY_KEYS) as Capability[],
);

/**
 * The capabilities this client actually answers true for.
 *
 * Spelled out from the record rather than hand-listed, so a capability flipped in
 * `MOBILE_ANSWERS` cannot leave this set behind.
 */
const MOBILE: ReadonlySet<Capability> = new Set(
  ALL_CAPABILITIES.filter((cap) => MOBILE_ANSWERS[cap]),
);

/** Whether this platform provides `cap`. Synchronous by design, like the desktop twin. */
export function has(cap: Capability): boolean {
  return MOBILE.has(cap);
}
