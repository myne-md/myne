// Web seam — the capability descriptor (phase3-web-client task 27).
//
// The absences below are **normative**, not a backlog: each states the platform
// fact or owner decision that puts it here, so a capability withheld by decision
// does not quietly reappear when someone ports the commands behind it. Every one
// is OMITTED from the surface rather than greyed out.
//
// Kept honest against the backend by `scripts/check-web-capabilities.mjs`, which
// cross-checks this set against `web/wasm/src/capability.rs`'s `Unsupported`
// classification: two hand-maintained lists of "what web cannot do" would drift,
// and the drift is invisible from either side — the UI would offer something the
// dispatcher refuses.

import { ALL_CAPABILITIES, type Capability } from "../../../src/platform/capabilities";

export { ALL_CAPABILITIES };
export type { Capability };

/** Capabilities the web client does NOT have, each with its reason. */
const ABSENT: ReadonlySet<Capability> = new Set<Capability>([
  // A page cannot be a native-messaging host, so the extension talks to the
  // desktop app or to nothing.
  "clipper",
  // Multi-GiB GGUF weights loaded from a bundled resource path onto a CPU thread
  // pool; a Worker has one thread and no resource directory.
  "localAi",
  // WatchConnectivity has no browser counterpart, and there is no OS queue.
  "watchCapture",
  // No share sheet hands files to a page.
  "shareImport",
  // Keychain/Keystore-backed. The PIN path is portable and is NOT covered here.
  "biometricQuickUnlock",
  // The pref syncs and is honoured; OS idle DETECTION is what is missing.
  "osIdleAutoLock",
  // `set_content_protected` asks the compositor to exclude a window, and a page
  // cannot ask that.
  "screenCaptureProtection",
  // The person identity is SESSION-only here (myne-md/myne#911 task 13): the
  // sealed keypair and the device token live in the Worker's memory, because an
  // origin's storage is readable by any script on that origin and a
  // phrase-derived keypair at rest there is an offline cracking target no
  // password change rotates. What this changes is COPY, not a control: the
  // phrase step says the words are asked for again on reload.
  "personCredentialPersisted",
  // Owner decision 2026-07-27 (MYND-574 task 72): repair scans a vault DIRECTORY
  // for orphan artefacts, a thing that exists because a desktop directory is
  // writable by other software. An OPFS container has exactly one writer, and
  // its one damage mode (eviction) is answered by re-sync, so a repair offer
  // would promise to fix a class of problem this storage cannot have.
  "vaultRepair",
  // Sync is REQUIRED here (`decisions.md` 2026-07-26): the OPFS container is a
  // cache of a server-held vault, never the only copy. So `vault_delete` erases
  // only this browser's copy, and the UI calls it a sign-out — desktop's
  // "cannot be undone" wording would be false in the direction that matters,
  // telling someone they had destroyed data that is still on the server.
  "localOnlyVault",
  // The host-confined directory READ, not the import: desktop's `importer:`
  // plugin canonicalises and checks within-root because the WebView is denied
  // `fs:allow-read-dir`, and a browser has no path to canonicalise and no host
  // to confine to. Markdown import still ships, from the user's own directory
  // pick, which needs no confinement.
  "hostDirectoryRead",
  // One container per origin under a constant vault id, so there is no second
  // vault to import from and `importer:` is `Class::Unsupported` wholesale. The
  // module is substituted as well as gated, because the setup step takes a
  // recovery phrase and A18 is about routine phrase prompts in a page.
  "vaultImport",
  // Extractors are `src-tauri/`-side and `MYE1` is device-local and never synced
  // (`protocol.md` §9.15), so a browser can neither run an extraction nor
  // inherit one; `read_extracted` reports a decode failure as a cache miss
  // meaning "re-extract", an unwinnable retry here. Attachments still import,
  // sync, open and match by filename — only their contents are unsearchable.
  "attachmentTextSearch",
  // `decisions.md` 2026-07-26: opening a backup file as an alternative entry
  // path is not offered, and the code is desktop-side, so it would be net-new.
  "backup",
  // No API grants a page an arbitrary write path; the browser download flow is a
  // differently-shaped affordance, not this one.
  "nativeSaveAs",
  "icsImport",
  // The sandboxed editor for the user's own on-disk files (myne-md/myne#788): a
  // page has no OS file ingress, no native open dialog and no handler
  // registration, and the surface must work independent of vault state in a way
  // a browser session (vault-scoped, sync required) never is. The whole
  // `plain-file` plugin is `Class::Unsupported`; this entry is the other half of
  // that decision.
  "plainFile",
  // The 30-second clipboard auto-clear, not the Copy affordance, which ships.
  // The clear is gated on reading the clipboard back so unrelated content is
  // never destroyed, and a page cannot read the clipboard (Firefox grants page
  // content none; others prompt and require focus), so a blind clear would be
  // worse than none. The phrase step says so in words, because
  // `recovery-flow.md` §2.2 forbids presenting a control whose stated protection
  // this client cannot perform.
  "clipboardAutoClear",
  // The phrase as a device-enrolment credential: refused by OFFERING, not
  // portability — `sync_enroll` dispatches and the credential would work.
  // Enrolment already accepts account number plus master password, and not
  // offering the phrase in a routine flow removes a place a user is trained into
  // typing 24 words into a page, which is the mechanism behind A18. The grid now
  // ships in the bundle (`decisions.md` 2026-10-18, entry 0704, which retired
  // build-time substitution and `scripts/check-web-no-phrase.mjs`), so this flag
  // hides a rendered arm rather than keeping a module out of the artefact.
  "phraseEnrolment",
  // The command's contract IS the desktop filesystem
  // (`core-wasm-assessment.md`: `cannot-exist-in-browser`).
  "vaultExport",
  // A BUNDLE-SIZE decision, not a portability limit: dictionaries are bundled
  // binary resources on desktop, and shipping even a couple would dominate a web
  // bundle whose trust story is "small enough that someone might read the
  // hashes". Shipping later means fetching on demand from the app's own origin
  // — never a CDN, which the zero-third-party rule makes a design step. The
  // `MYD1` personal dictionary is NOT covered: it is vault content
  // (`sync-protocol.md` §9 Class 1), so a web session syncs it like any field.
  "spellCheck",
  // The transform, not the preference: it drives a hidden Tauri WebView through
  // `pdf-export`, prints it and collects the result — a desktop render pipeline
  // with no page-side counterpart short of shipping a PDF engine. Note-as-
  // markdown and attachment download are NOT covered: their obstacle was the
  // destination, answered by the browser download flow.
  "pdfExport",
  // The transform, not the preference: `catch_unwind` needs unwinding and
  // `wasm32-unknown-unknown` has none, so a hostile image that panicked the
  // third-party decoder would kill the vault Worker instead of falling back to
  // storing the original. `attachment_compression_enabled` is NOT covered: it is
  // shared vault content (`decisions.md` 2026-07-30), read, written and synced
  // like any other field.
  "imageCompression",
  // The `myne` CLI connects to a local Unix socket or named pipe the desktop
  // binds, and the binary ships inside the desktop bundle as an `externalBin`; a
  // page can neither bind that socket nor be reached through one, and there is
  // no filesystem here for a sidecar. Absent by platform fact. (MYND-490.)
  "cliAccess",
  // `myne-mcp` is a stdio binary staged as a desktop `externalBin` and installed
  // on PATH by the same shim as the CLI; a page has no filesystem to put one on
  // and nothing on the machine that could launch it. Absent by platform fact, so
  // the Settings section is omitted and the dispatcher refuses the whole `mcp`
  // namespace. (myne-md/myne#923.)
  "externalMcp",
  // The picker ships here (`check-web-screens.mjs` records `VaultPicker.tsx` as
  // ported); what is missing is the CARRIER — the `MYL1` store is sealed under
  // an OS keychain `wrap_key`, which a page does not have. So the Privacy row is
  // omitted rather than rendered against commands that reject. The encryption is
  // not absent: `MYL1` is unchanged. (myne-md/myne#411.)
  "lockedVaultNames",
  // The desktop routes sync egress through a Tor client it spawns as a
  // subprocess, reached over a loopback SOCKS5 socket; a page has neither half —
  // no subprocess, no raw TCP, no way to point `fetch` at a proxy. Absent by
  // platform fact, and the browser already has the better answer (Tor Browser).
  // (MYND-650 task 6.)
  "torRouting",
  // The account/vault split (myne-md/myne#684): a browser CAN hold two containers
  // under one origin, so the obstacle is not the count — the account record is
  // sealed with a wrap key kept in an OS keychain, which a page has none of. The
  // picker renders rows standalone and the grouping UI is omitted.
  "accountGrouping",
  // The B2B member surface: the person identity's sealed file lives outside
  // browser storage, and the panel's recovery-phrase prompt stays out of served
  // code by capability rather than by build-time substitution (retired by
  // `decisions.md` 2026-10-18, entry 0704). The phrase is not an enrolment
  // credential here.
  "memberSharing",
  // A pop-out is a second host-spawned OS window (myne#173); a browser page has
  // one tab context and cannot open an OS window a viewer reads as another app
  // window, and the single-tab OPFS lock is the whole model. Absent by platform
  // fact.
  "detachedWindows",
  // Desktop self-update: `tauri-plugin-updater` has no browser target and a
  // served page cannot replace itself. Absent by platform fact.
  "selfUpdate",
  // The opt-in device-local diagnostic log (myne-md/myne#860): the web build
  // installs no `tracing` subscriber and compiles every event below `warn` out of
  // the bundle (`docs/decisions/ops/0366`), so there is no log to write, no
  // platform log directory to resolve and no folder to reveal. COPYING the
  // diagnostics block is present on web: that is the half a user needs where they
  // cannot open a devtools panel and read a failure back.
  "diagnosticLog",
  // Live-collab (SYNC-31): multi-user co-editing needs the B2B member plane —
  // group substrate, roster and member-removal rekey — held in a device-local
  // sealed file outside browser storage whose panel prompt is refused in the
  // served bundle. A browser can hold a person identity for the session, but not
  // the member half. Split from `liveCollabPeerPresence`, which stays PRESENT
  // here, so a client is not second-class for its own devices while never
  // implying multi-user works in a page.
  "liveCollabMultiUser",
  // Live-collab (`collab-presence-ui`): the awareness CURSOR consumer is a native
  // SSE supervisor (`AwarenessSignal` + `AppHandle`), the web Worker-side consumer
  // is not built, and the local presence report (`live_session_set_presence`) is
  // refused there. Split from `liveCollabPeerPresence`, which stays PRESENT, so a
  // web session still opens for this client's own devices' convergence while the
  // cursor affordance is omitted.
  "liveCollabAwarenessCursors",
]);

export function has(cap: Capability): boolean {
  return !ABSENT.has(cap);
}
