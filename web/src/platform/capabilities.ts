// Web seam — the capability descriptor (phase3-web-client task 27).
//
// The absences below are **normative**, not a backlog. Each cites the decision
// or the platform fact that puts it here, because the difference matters: a
// capability absent by decision must not quietly reappear when someone ports the
// commands behind it.
//
// Kept honest against the backend by `scripts/check-web-capabilities.mjs`, which
// cross-checks this set against `web/wasm/src/capability.rs`'s `Unsupported`
// classification. Two hand-maintained lists of "what web cannot do" would drift,
// and the drift would be invisible: the UI would offer something the dispatcher
// refuses, which is precisely the greyed-control failure this task exists to
// prevent, arriving by a different route.

import { ALL_CAPABILITIES, type Capability } from "../../../src/platform/capabilities";

export { ALL_CAPABILITIES };
export type { Capability };

/** Capabilities the web client does NOT have, each with its reason. */
const ABSENT: ReadonlySet<Capability> = new Set<Capability>([
  // A page cannot be a native-messaging host; the extension talks to the
  // desktop app or to nothing.
  "clipper",
  // Multi-GiB GGUF weights loaded from a bundled resource path onto a CPU
  // thread pool. A Worker has one thread and no resource directory.
  "localAi",
  // WatchConnectivity has no browser counterpart, and there is no OS queue.
  "watchCapture",
  // No share sheet hands files to a page.
  "shareImport",
  // Keychain/Keystore-backed. The PIN path is portable and is task 40 —
  // deliberately NOT covered by this absence.
  "biometricQuickUnlock",
  // The *pref* syncs and is honoured; OS idle DETECTION is what is missing.
  "osIdleAutoLock",
  // `set_content_protected` asks the compositor to exclude a window. A page
  // cannot ask that.
  "screenCaptureProtection",
  // Legacy single-vault layout never existed in OPFS.
  "vaultMigration",
  // Owner decision, 2026-07-27 (task 72). Repair scans a vault DIRECTORY for
  // orphan artefacts — a thing that exists because a desktop directory is
  // writable by other software. An OPFS container has exactly one writer, and
  // its one real damage mode (eviction) is answered by re-sync (task 22), so
  // this would offer to fix a class of problem the storage cannot have.
  "vaultRepair",
  // `decisions.md` 2026-07-26 makes sync REQUIRED here: the OPFS container is a
  // cache of a server-held vault, never the only copy. This is not an affordance
  // being withheld — it is the fact that makes `vault_delete`'s copy differ. On
  // this client the command erases THIS BROWSER's copy and nothing else, so the
  // UI calls it a sign-out and says plainly that the account and everything
  // already synced stay on the server. Desktop's "cannot be undone, and your
  // recovery phrase will not restore the data" would be false here in the
  // dangerous direction: a user trying to destroy their notes would believe
  // they had.
  "localOnlyVault",
  // The host-confined directory READ, not the import. Desktop's `importer:`
  // plugin canonicalises and checks within-root because the WebView is denied
  // `fs:allow-read-dir`; a browser has no path to canonicalise and no host to
  // confine to. **Markdown import still ships here** (task 71) — the tree comes
  // from the user's own directory pick, which needs no confinement because a
  // page is only ever handed what the user chose.
  "hostDirectoryRead",
  // One container per origin under a constant vault id, so there is no
  // second vault to import FROM, and `importer:` is `Class::Unsupported`
  // wholesale. Substituted as well as gated, because the setup step takes a
  // recovery phrase and A18 is about routine phrase prompts in a page.
  "vaultImport",
  // Task 90. The extractors are `src-tauri/`-side, and `MYE1` is device-local
  // and NEVER synced (`protocol.md` §9.15), so a browser can neither run an
  // extraction nor inherit one. Absent rather than degraded: `read_extracted`
  // reports a decode failure as a cache MISS meaning "re-extract", which here
  // would be an unwinnable retry on every import. Attachments still import,
  // sync, open and match by FILENAME — only their contents do not.
  "attachmentTextSearch",
  // `decisions.md` 2026-07-26: "Opening a backup file as an alternative entry
  // path is not offered"; the code is desktop-side, so it would be net-new.
  "backup",
  // No API grants a page an arbitrary write path. Task 48's download flow is a
  // differently-shaped affordance, not this one.
  "nativeSaveAs",
  // `decisions.md` 2026-07-26: the 24-word recovery phrase is "never generated
  // by, displayed by, or typed into served code". Creation generates and shows
  // it; recovery types it. Both are normative removals, not scope cuts.
  //
  // **Rule 1 is reversed by `decisions.md` 2026-08-15**, and both halves have
  // now left this set: `vaultCreation` (the flow registers the account with the
  // sync server BEFORE the phrase is ever displayed, so a failure leaves no
  // account and no words to write down) and `phraseRecovery` (a user who forgot
  // their password can recover in the browser they have always used, instead of
  // being sent to download a desktop client on the worst day of their Myne
  // life). What did NOT leave is directly below.
  // The 30 second clipboard auto-clear, NOT the Copy affordance, which ships.
  // The clear is gated on reading the clipboard back so unrelated content is
  // never destroyed, and a page cannot read the clipboard: Firefox grants page
  // content none at all, the rest gate it behind a prompt plus focus. A blind
  // clear would be worse than none. The phrase step says so in words, because
  // `recovery-flow.md` §2.2 forbids presenting a control whose stated
  // protection this client cannot perform.
  "clipboardAutoClear",
  // The third phrase path, and the one the 2026-08-15 reversal deliberately
  // does NOT lift: the phrase as a device-enrolment credential. It stays absent
  // on web permanently, which is why it is its own capability rather than a
  // branch of `phraseRecovery`.
  //
  // The reason is not portability. `plugin:sync|sync_enroll` is dispatched here
  // and the credential would work; what is refused is offering it. Enrolment is
  // a ROUTINE action that already accepts account number plus master password,
  // and every routine use of the phrase in a page is what trains a user that
  // typing 24 words into a browser is normal. That training is the entire
  // mechanism behind `threat-model.md` A18, and keeping this absent is what
  // leaves a rule a user can actually apply: this client asks for the phrase in
  // exactly ONE situation, a recovery they started themselves. Never to add a
  // device, never to sign in.
  //
  // Enforced structurally rather than by this flag alone: the credential grid is
  // substituted out of the bundle (`web/vite.config.ts`) and its absence from
  // the built artefact is asserted by `scripts/check-web-no-phrase.mjs`.
  "phraseEnrolment",
  // The command's contract IS the desktop filesystem (`core-wasm-assessment.md`:
  // `cannot-exist-in-browser`).
  "vaultExport",
  // Task 47. Not a portability limit — a BUNDLE-SIZE one, which is why it is a
  // release decision rather than a permanent absence: dictionaries are bundled
  // binary resources on desktop, and shipping even a couple would dominate a web
  // bundle whose whole trust story is "small enough that someone might read the
  // hashes". Shipping them later means fetching on demand from the app's OWN
  // origin and caching — never a CDN, which the zero-third-party rule makes a
  // design step rather than a link.
  //
  // The `MYD1` personal dictionary is NOT covered by this absence and must not
  // be: it is vault content (`sync-protocol.md` §9 Class 1, set-union merge),
  // so a web session leaves it alone and a desktop session keeps using it.
  "spellCheck",
  // Task 48. The one export whose obstacle is the OUTPUT, not the destination:
  // it drives a hidden Tauri WebView window through `pdf-export`, prints it, and
  // collects the result — a desktop render pipeline with no page-side
  // counterpart that does not amount to shipping a PDF engine in the bundle.
  //
  // Note-as-markdown and attachment download are NOT covered by this absence:
  // their obstacle was the destination, and the browser download flow answers
  // that (see `platform/download.ts`).
  "pdfExport",
  // The TRANSFORM, not the preference. `catch_unwind` needs unwinding and
  // `wasm32-unknown-unknown` has none, so a hostile image that panicked the
  // third-party decoder would kill the vault Worker rather than fall back to
  // storing the original — a successful import turning into a dead tab.
  // `compress::is_supported_on_this_target` refuses it in the backend for
  // exactly that reason.
  //
  // `attachment_compression_enabled` is NOT covered by this absence and must not
  // be: it is shared vault content (`decisions.md` 2026-07-30), so this client
  // reads, writes and syncs it like any other field, and a user who turns it off
  // here turns it off for their desktop. The absence changes the COPY around the
  // control — a helper line promising "on every device" is false in front of the
  // one client that will not honour it — not the control.
  "imageCompression",
  // MYND-490 (cli-thin-client task 12). The `myne` terminal client connects to
  // a local Unix socket / named pipe that the desktop process binds, and the
  // binary itself ships inside the desktop bundle as a Tauri `externalBin`. A
  // page can neither bind that socket nor be reached through one, and there is
  // no filesystem here for a sidecar to be installed onto — so the Settings
  // block is omitted rather than greyed. Absent by platform fact, not by
  // decision: there is nothing to port.
  "cliAccess",
  // myne-md/myne#411. Two halves, and both are missing. The picker is what a
  // cached name exists to label, and there is no locked picker here: an origin
  // holds exactly one container, which is why `check-web-screens.mjs` records
  // `VaultPicker.tsx` as `excluded`. And the `MYL1` store is sealed under an OS
  // keychain `wrap_key`, which a page does not have. So the Privacy row is
  // omitted rather than rendered against three commands that reject: its
  // subject does not exist here.
  //
  // The ENCRYPTION is not what is absent, and the distinction matters the same
  // way it does for `spellCheck` and `MYD1`: `MYL1` is unchanged, and on
  // desktop the row ships to everyone, ungated.
  "lockedVaultNames",
  // MYND-650 task 6. The desktop routes sync egress through a Tor client it
  // spawns as a subprocess, reached over a loopback SOCKS5 socket. A page has
  // neither half: no subprocess, no raw TCP, and no way to point `fetch` at a
  // proxy. Absent by platform fact rather than by decision — there is nothing
  // to port, and the browser already has a better answer than an in-page
  // tunnel would be, which is Tor Browser (docs, task 12). The Developer
  // Options block is omitted here rather than greyed.
  "torRouting",
]);

export function has(cap: Capability): boolean {
  return !ABSENT.has(cap);
}
