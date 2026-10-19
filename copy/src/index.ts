// @myne/copy — shared LOAD-BEARING user-facing copy (SYNC-42).
//
// The exact English wording of these strings is a security/privacy property, not
// a stylistic choice. They are consumed as SOURCE by BOTH the desktop client
// (`src/lib/load-bearing-copy.ts` re-exports them) and the mobile client
// (`mobile/src/…`), so the literals are byte-identical across clients by
// construction — cross-client paraphrase is impossible. E2E asserts them by
// FULL-literal equality; changing any is a `design-notes.md` event, never a
// copy edit. Never i18n these (see `src/AGENTS.md` "Do NOT i18n load-bearing copy").
//
// **What "by construction" covers, stated because it was overclaimed.** This
// sentence was TRUE of the sync/enroll family below and FALSE of eighteen
// per-note-export, clip-notice and settings literals, which were declared in both
// client files byte-identical BY HAND while this header claimed otherwise (audit
// 2026-10-18, R0.1; fixed 2026-10-19). A declaration is now the whole mechanism:
// a client tree may not define a name this file exports, and
// `scripts/check-copy-membership.mjs` fails by naming the file when one does. What
// each client still declares locally is that client's own surface copy, which is
// per-client by design and outside this package's claim.

// Device removal honesty (MYND-425). "Remove device" revokes a per-device sync
// token — it stops the server from serving that device — but it does NOT
// cryptographically lock out a device that already holds root_key (an attacker
// with the vault file + the password/phrase is unaffected, threat-model no-FS
// note). The copy MUST say what removal does and does not do, and MUST NEVER
// imply a cryptographic lockout.

/** Short confirm line for the Remove-device action. */
export const REMOVE_DEVICE_CONFIRM =
  "Remove this device from sync?";

/** The honest "what it does / what it doesn't do" disclosure (expandable). It
 *  is deliberately two plain sentences: the effect (sync stops) and the limit
 *  (no cryptographic lockout) — never collapsed, never overstated. */
export const REMOVE_DEVICE_DISCLOSURE =
  "Removing this device revokes its sync access, so the server stops syncing to it. It does not lock a device that already has your vault and password — removal is not a remote wipe.";

// Sync integrity alert (MYND-427 task 2). When the engine's head-verify fails to
// extend the last-seen head (a rollback or a withheld/omitted update), the client
// raises a hard, honest integrity alert (SuspicionBanner-class) — NEVER silently
// accepted. The copy is load-bearing honesty: it says the problem is *possible*
// (head-verify catches rollback/non-extension, but a perfectly-consistent
// withholding is not generally detectable — the threat-model no-general-detection
// note), it never claims Myne detects all tampering, and it reassures that local
// notes are safe.

/** The hard integrity-alert banner shown on a rollback / non-extending head. */
export const SYNC_INTEGRITY_ALERT =
  "Possible sync integrity problem: the server may have sent out-of-date or altered sync data, which Myne did not accept. Your local notes are safe. If this keeps happening, verify your devices.";

// The recovery DRILL's failure sentence (myne-md/myne#468). Here rather than
// hand-copied into each client's `load-bearing-copy.ts`, because BOTH clients
// render it and myne-md/myne#474 is the precedent: six literals lived as
// byte-identical hand copies in two files, "kept identical by hand", which is
// exactly the distinction SYNC-42 exists to make.

/**
 * Shape 1 twice over: a non-distinguishing collapse that explains its own
 * refusal.
 *
 * **What it must not distinguish.** A wrong phrase, ANOTHER vault's phrase and
 * structurally invalid input all reach this one line, because the backend
 * answers all three with `false` — `recovery-flow.md` §3.4's non-distinguishing
 * tag is what is being checked and it does not tell them apart. So the message
 * cannot either.
 *
 * **Why it says WHY.** The tempting improvement is to name the position that did
 * not match, which is the standard affordance for a multi-field form and here is
 * a vulnerability: it turns one whole-phrase check into twenty-four independent
 * one-word checks, so anyone holding a nearly correct phrase — a photograph of
 * part of a page, a partially remembered set — can complete it by iteration.
 * Saying so out loud is the only thing that stops a later reviewer reading the
 * absence as an oversight and "fixing" it.
 *
 * Rendered verbatim in every locale and pinned by FULL-literal equality rather
 * than a substring, which would pass an edit that appended the missing word.
 * Changing it is a `design-notes.md` event, never a copy edit.
 */
export const RECOVERY_DRILL_FAILED_SENTENCE =
  "These words do not open this vault. Myne cannot tell you which word is wrong: " +
  "saying so would let anyone with a nearly-correct phrase find the rest one word " +
  "at a time. Check the whole thing against what you wrote down, including the order.";

// Device-enrollment copy (MYND-425 task 5). The add-device flow proves account
// ownership with {account# + password OR 24-word phrase}; a wrong credential and
// a wrong account number both fail at the same AEAD-open step, so the failure copy
// MUST be a single non-distinguishing message (collapsing to "wrong password"
// alone would leak that the account number was valid). The pending message must be
// honest about the approval gate (the server holds the device until an
// already-trusted device approves it — Myne cannot sync until then).

/** Non-distinguishing enroll failure — covers wrong account#, wrong credential,
 *  or a missing/corrupt vault.meta on the server, with one message. */
export const ENROLL_NON_DISTINGUISHING_BANNER =
  "Account number, password, or recovery phrase is incorrect. Please try again.";

/** The same message on a client that cannot accept a recovery phrase
 *  (phase3-web-client task 98; `decisions.md` 2026-07-28).
 *
 *  A **sibling, not a paraphrase**: the non-distinguishing property is
 *  identical — a wrong account number and a wrong password fail at the same
 *  AEAD-open step and collapse to one message — and the only difference is that
 *  it does not name a credential the client structurally cannot take. On the web
 *  client the phrase paths are ABSENT from the bundle (tasks 32 and 92), so
 *  offering "or recovery phrase" as a possible cause sends the user looking for
 *  a field that does not exist and cannot be made to exist.
 *
 *  Selected by the `phraseRecovery` capability rather than by a platform name,
 *  so a future client with the same shape inherits the right one. Changing
 *  either literal is a `design-notes.md` event, never a copy edit — and
 *  changing one without the other is how the two drift into disagreeing about
 *  what failed. */
export const ENROLL_NON_DISTINGUISHING_BANNER_NO_PHRASE =
  "Account number or password is incorrect. Please try again.";

/** Honest enroll-pending notice — the device is held by the approval gate. */
export const ENROLL_PENDING_NOTICE =
  "This device is waiting for approval. Approve it from a device that already has access to start syncing.";

/** Enroll success — the device was approved and a sync token issued. */
export const ENROLL_APPROVED_NOTICE =
  "This device is now connected and syncing.";

// Local-erase honesty (MYND-574 task 72, owner decision 2026-07-27). On a client
// whose storage is a cache of a sync-held vault — the web client, where sync is
// required by `decisions.md` 2026-07-26 — `vault_delete` erases THIS client's
// copy and nothing else. The desktop copy for the same command says the deletion
// is permanent and that the recovery phrase will not bring the data back; said
// here that would be false in the dangerous direction, because a user trying to
// destroy their notes would believe they had while every synced note remained on
// the server. Same class of claim as REMOVE_DEVICE_DISCLOSURE above, and the
// same rule: state the effect, state the limit, never imply a remote wipe, and
// name the one thing that IS irreversibly lost.

/** The honest scope of a local erase on a sync-backed client. Four plain
 *  sentences — effect, what survives, what this is NOT, and the real loss — and
 *  the last of them is why the typed-DELETE gate stays: unsynced edits die here
 *  and nothing brings them back. */
/** What a device REVOCATION means to the browser it was revoked from
 *  (phase3-web-client task 94).
 *
 *  The sibling of `REMOVE_DEVICE_DISCLOSURE`, written from the other end. That
 *  one tells the person doing the removing that it is not a remote wipe; this
 *  one tells the person it happened TO what actually occurred here — and the two
 *  must not contradict each other, because a user reading both would otherwise
 *  conclude one of them is lying.
 *
 *  So: this browser's copy is deleted, and that is a LOCAL deletion this client
 *  performed on itself because it can no longer sync — not the server reaching
 *  in. The account is untouched. And the sentence that keeps it honest is the
 *  last one: anything not yet synced from this browser is gone, which is exactly
 *  what `REMOVE_DEVICE_DISCLOSURE`'s "not a remote wipe" implies and no copy
 *  should let the user discover by surprise. */
export const DEVICE_REVOKED_DISCLOSURE =
  "This browser was removed from your account, so it can no longer sync. Myne has deleted its local copy of your vault from this browser — a local deletion, not something the server reached in and did. Your account and everything already synced are safe on the server. Anything this browser had not synced yet is gone.";

export const LOCAL_ERASE_DISCLOSURE =
  "This erases Myne's copy of your vault from this browser only. Your account and everything already synced stay on the server, and signing in here again brings them back. It is not an account deletion and not a remote wipe. Anything this browser has not synced yet is lost for good.";

/** What removing a SHARED (member) vault from this device does, and what it does
 *  not do (audit 2026-10-18 K2-i, decided 2026-10-18 and shipped 2026-10-19).
 *
 *  **Load-bearing, and the reason is the third sentence.** A member's danger zone
 *  used to carry the OWNER's sentence ("Lost both password and recovery phrase?
 *  Delete vault and start over") and the owner's confirm copy, which says the
 *  action cannot be undone and that the recovery phrase will not bring the data
 *  back. Said to a member that is false in the dangerous direction twice over: the
 *  shared vault is not theirs to destroy, and the vault they just removed is one
 *  they can add again. What a member needs to know is the asymmetry the two
 *  sentences hide: removing the vault HERE is not removing themselves FROM the
 *  vault, and only its owner can do the second.
 *
 *  Five clauses, and each is one of the shapes `src/lib/load-bearing-copy.ts`
 *  enumerates: the effect, what survives, what this is NOT, the real loss (this
 *  device's unsynced edits), and the way back.
 *
 *  **The way back was verified rather than assumed, and the first version of this
 *  sentence got it wrong.** It said "you can add the vault here again with the
 *  password you set for this device", which is a path that does not exist: the
 *  device-local member stores (`vault.member-unlock`, `vault.member-key`) live
 *  INSIDE the vault directory
 *  (`person_account::wipe_member_unlock(io, &vault_dir)`), so a removal that takes
 *  the directory takes the device credential with it. What is left is the member's
 *  person recovery phrase, which is how the vault is added again
 *  (`mobile/docs/dev/device-matrix.md` walks exactly that flow). The clause says
 *  so now, which is the whole point of K2-i's "verify what the action means"
 *  half: the copy had to follow the code, not the other way round.
 *
 *  Rendered verbatim in every locale and pinned by full-literal equality, like its
 *  three siblings above.
 *
 *  In `@myne/copy` rather than desktop-local because BOTH clients hold a member
 *  vault: `mobile/src/app/flows/UnlockFlow.tsx` and its Settings sheet render the
 *  same owner copy today, and the sentence has to be one sentence before that is
 *  fixed on the phone. */
export const MEMBER_VAULT_REMOVAL_DISCLOSURE =
  "This removes this device's copy of the shared vault. The vault and its notes stay on the server and on the owner's other devices, and your account is untouched. It is not a removal from the vault itself: only the vault's owner can take your access away, and this does not do that. Anything this device has not synced yet is lost, and you can add the vault here again from your recovery phrase.";

// What turning sync on means, as the app states it (operations#15). These four
// clauses are what a person must actually have read before sync starts carrying
// their notes to a server, phrased so that reading only these four leaves them
// with an accurate picture rather than a flattering one.
//
// The published text this used to defer to (https://myne.md/terms) is no longer
// linked from the dialog and no longer governs anything: it is the beta terms of
// a service Myne closed (`design-notes/sync/0696`), so the clauses can no
// longer be a summary of it. They stand on their own.
//
// Load-bearing for the same reason the consent copy above is: each clause is a
// bounded claim, and a translation that softened "cannot be recovered" into
// "may be difficult to recover" would be a good translation and a false
// statement. Rendered verbatim in every locale; only the chrome around them is
// translated.
//
// Changing any of these four strings is a decisions.md event AND requires
// bumping BETA_TERMS_VERSION, which re-asks everyone who accepted the old text.
// `scripts/check-beta-terms-version.mjs` fails the commit that changes one
// without the other — the discipline is mechanical because "remember to bump
// it" is exactly the kind of thing that gets remembered four times out of five.

/** The version of the four clauses below. Compared, never ranked: any change
 *  re-asks, in either direction. Stored device-local by
 *  `core/src/plugins/sync/legal_consent.rs`.
 *
 *  **v2, 2026-10-16:** three clauses were reworded when Myne stopped offering a
 *  sync service (`design-notes/sync/0696`). The old text described Myne as the
 *  provider ("Myne's sync is a free beta", the end-of-beta guarantee, the
 *  moderation reality); the new text describes what sync is on whatever server
 *  the reader names, which is the only thing left for the dialog to be about.
 *  `BETA_TERMS_DATA_LOSS` is unchanged, because it was never about a provider. */
export const BETA_TERMS_VERSION = "2";

/** What sync is, and what it is not. Reworded in v2: this clause used to call
 *  Myne the provider of a free beta, which stopped being true. */
export const BETA_TERMS_WHAT_THIS_IS =
  "Sync stores your notes on a server you choose. They leave this device encrypted and stay that way there: the server holds ciphertext and no key, so it cannot read them, and neither can Myne, which runs no server for you. Software this young still breaks, and a bug can lose data.";

/** The clause the architecture makes necessary, and the one most terms omit.
 *  Unchanged in v2: it was never about a provider. */
export const BETA_TERMS_DATA_LOSS =
  "If you lose your password and your recovery phrase, your notes cannot be recovered — not by you and not by us. There is no reset, because a reset would mean we held a key to your notes.";

/** What a server going away costs. Reworded in v2: this clause was the
 *  anti-Skiff end-of-beta guarantee ("when the beta ends your account keeps
 *  working"), and there is no beta and no account of ours to guarantee. What
 *  survives it is the property that made the guarantee unnecessary. */
export const BETA_TERMS_WHAT_HAPPENS_NEXT =
  "Your notes live on your devices, so a server going away is not data loss: each device holds a complete vault on its own. You lose sync until you point it at another server and push again, and the only copy that goes is the one on the server.";

/** What the operator of the server sees and can do. Reworded in v2: this clause
 *  was the moderation reality of Myne's own service, and it is now about
 *  whoever runs the server the reader named. Same bound as the old one: it
 *  claims only the metadata the protocol exposes and the policy-level actions
 *  an operator can take (`docs/threat-model.md` §7, `self-host-policy.md` §7). */
export const BETA_TERMS_WHAT_WE_CAN_SEE =
  "Whoever runs that server can refuse to serve you, keep a copy of something you deleted until their own retention window passes, and see that an account synced, when, and roughly how much. None of that lets them read a note, because to them a note is ciphertext.";

/* ---- AI provider names (myne-md/myne#456) ----------------------------------
 *
 * Proper nouns, so deliberately outside i18n: "OpenRouter" is "OpenRouter" in
 * every locale, and a translated brand name is a wrong brand name.
 *
 * Here rather than in one client's tree because three surfaces now name a
 * provider: the desktop AI panel, the desktop chat transcript, and the mobile
 * settings panel. The mapping used to live privately in `AiPanel.tsx`, which is
 * what made the transcript unable to name the provider without copying it.
 */

/**
 * The proper noun a user reads for a stored provider wire name.
 *
 * The host stores `openrouter`; a person reads `OpenRouter`.
 *
 * An unknown wire name returns ITSELF rather than an empty string: a newer build
 * may have written one, and rendering the raw value tells the user more than
 * rendering nothing. A caller that wants to say "this build does not know that
 * provider" has to decide that from the wire value, not from this.
 */
export function providerLabelOf(wire: string | null | undefined): string | undefined {
  if (!wire) return undefined;
  switch (wire) {
    case "ollama-cloud":
      return "Ollama Cloud";
    case "openrouter":
      return "OpenRouter";
    default:
      return wire;
  }
}

/* ---- AI provider consent (myne-md/myne#456) --------------------------------
 *
 * Moved here from `src/lib/load-bearing-copy.ts` so the mobile consent screen
 * shows the same sentences as the desktop one, by construction rather than by
 * discipline. Deliberately outside i18n: the exact wording is what
 * `docs/threat-model.md` bounds.
 */

/** WHAT leaves. Names the content, not a euphemism for it.
 *
 *  **The scope roster is named because nothing else names it.** An agent run
 *  answers the model's first `list_scope` with the note ids and titles of the
 *  whole approved scope, before a single body has been read, so a user who
 *  grants a folder and then stops the run has still sent that folder's titles,
 *  which are frequently the most disclosing line in a note. `threat-model.md`
 *  says of that roster: "Naming it here because the sentence above says nothing
 *  else and a bulk enumeration of notes the model has not read is not covered by
 *  it." This is the sentence it meant, and it did not say so until
 *  myne-md/myne#531 review round six.
 *
 *  **Memory rides along and is named for the same reason.** Every agent run
 *  also carries what it remembers about you: distilled facts from earlier
 *  runs (at most 100 entries) and your voice preferences, each entry with a
 *  stable identifier (myne-md/myne#697). */
export const CONSENT_WHAT_LEAVES =
  "The text of the notes involved in each request leaves your device: the note you are working in, and any note used to answer you. An agent run also sends the titles, identifiers and folder paths of the notes it may read, before it has read any of them. That set is the whole working set, minus the folders you excluded from AI, unless you narrow it. It also carries what it remembers about you: distilled facts from earlier runs (at most 100 entries) and your voice preferences, each entry with a stable identifier. A meeting-notes run sends the transcript of the recording, which is other people's speech as well as your own.";

/** WHEN it leaves. Bounded by the SYNC-14 bar: only work the user asks for.
 *
 *  The agent run is the fifth trigger and was added late: this branch amends
 *  TB12 and TB13 to widen what crosses, and this screen is the surface that
 *  amendment is meant to reach (myne-md/myne#531 review round six). A consent
 *  screen that enumerates four of five triggers is not one. **The meeting-notes
 *  run is the sixth and was added later still** (example-org/operations#63): it is a
 *  second bounded-series surface and, unlike every other entry here, what it
 *  sends is other people's speech. Leaving it out left a user who consented to
 *  "chat, summarize, rewrite, edit selection, or an agent run" untold that a
 *  surface they can reach also reaches a provider. */
export const CONSENT_WHEN_IT_LEAVES =
  "Only when you ask for something: chat, summarize, rewrite, edit selection, an agent run, or a meeting-notes run. Nothing is sent as you type, and nothing is sent in the background.";

/** TO WHOM. Interpolates the provider because a consent screen that cannot
 *  name the recipient is not consent. */
export function consentToWhom(provider: string): string {
  return `Everything above goes to ${provider}, which Myne does not run.`;
}

/** WHAT MYNE CANNOT VERIFY (A17). Myne may state what it sends and to whom;
 *  never what the far side retains. */
export function consentCannotVerify(provider: string): string {
  return `Myne cannot see or control what ${provider} keeps, how long it keeps it, or whether it passes your request to someone else.`;
}

/** How to undo it, stated on the screen rather than discovered later. The
 *  distinction matters: deleting the key here stops THIS account's requests,
 *  but the credential itself lives at the provider. */
export const CONSENT_HOW_TO_REVOKE =
  "You can remove the key at any time, which stops Myne sending anything. Revoking the key itself is done at the provider, and it applies to the key rather than to this device.";

/** WHICH DEVICES this covers, and it says "this one".
 *
 *  **This sentence used to say the opposite, and it was true when written.** As
 *  `CONSENT_ACCOUNT_SCOPE` it read: "This choice is part of your vault, so any
 *  device you add later inherits it and will not ask again." That was the
 *  SYNC-22 residual, stated on the screen rather than discovered later, which
 *  was the right way to carry a cost that had no remedy.
 *
 *  myne-md/myne#456 built the remedy: `ai_provider_consent` is device-local now,
 *  so the inheritance it described no longer happens. A screen still claiming it
 *  would be telling the user something worse about their own privacy than what
 *  the code does, which is a strange direction to be wrong in and still wrong.
 *
 *  The KEY still travels, and the sentence says so, because that is the part a
 *  user could otherwise be surprised by: a phone can hold a credential it has
 *  not been permitted to use. */
/** The suffix a consent recorded ON THIS DEVICE carries in `ai_provider_consent`.
 *
 *  **Not user-facing copy, and it lives here anyway**, which is the one thing
 *  worth justifying. This package is source-consumed by the desktop, web and
 *  mobile trees, and it is already where the consent's own wording lives, so a
 *  second copy of this constant per client is exactly the twin-drift
 *  `check-twin-inventory.mjs` exists over. A drifted spelling here is silent:
 *  the backend gate compares for equality, so a client that computes the wrong
 *  token shows the consent screen forever, or worse, decides a legacy consent
 *  is current and never shows it at all.
 *
 *  The grammar is defined by `protocol::prefs::CONSENT_DEVICE_SUFFIX`, which
 *  carries the whole argument for why the value marks its own classification.
 *  In one line: a legacy bare-provider-name value is what an install that
 *  turned Developer mode off, and a device enrolled before the
 *  reclassification, both hold, and the gate must re-ask rather than honour it
 *  (myne-md/myne#456). */
/** The AI trust INVARIANT, rendered FIRST and unchanged by the provider state.
 *
 *  **Why it lives here, and why that matters more than tidiness.** It was a
 *  verbatim copy in `src/lib/load-bearing-copy.ts` and
 *  `mobile/src/lib/load-bearing-copy.ts`, and the mobile copy's own comment
 *  claimed the two were "byte-identical by construction" because "desktop's
 *  `src/lib/load-bearing-copy.ts` re-exports this same literal". It did not: it
 *  declared its own identical string, so the sentence could drift between
 *  clients with nothing saying so. This package is the construction that
 *  comment described, one layer down from where the A7 residual already
 *  established it (myne-md/myne#456).
 *
 *  The string is a privacy claim, not UI copy: pinned byte-for-byte by
 *  `tests/lib/aiTrustCopy.test.ts`, rendered VERBATIM in every locale, and
 *  bounded by `threat-model.md` §5 — "no byte leaves the device unless the user
 *  has named a provider" — plus the download clause of `decisions/ai/0627`.
 *  A later slice may say LESS than this, never more. */
export const AI_TRUST_INVARIANT =
  "Myne never sends your notes anywhere you have not named. A model downloads only when you ask, from Myne's own origin, which keeps no IP logs and no analytics.";

/** The A7 residual, rendered as the LAST clause of every AI trust disclosure.
 *
 *  **It lives here rather than in `src/lib/load-bearing-copy.ts` because mobile
 *  could not import it from there, and shipped a consent screen with seven
 *  clauses where the desktop screen shows eight** (myne-md/myne#456, found by
 *  review). `mobile/src/components/AiConsentScreen.tsx`'s own header says what
 *  it carries is "the WHOLE disclosure, never a summary with the detail one tap
 *  away" and that the clauses are "byte-identical to the desktop screen's by
 *  construction", and the construction was a per-tree copy that had one file it
 *  could not reach.
 *
 *  The residual applies to a phone in full, and this same change is the
 *  evidence: it fixed a lock teardown because the mobile process holds the
 *  plaintext provider key and note-derived text in app memory.
 *
 *  Bounded by `threat-model.md` A7. A later slice may say LESS than this,
 *  never more.
 *
 *  **The em dash stays.** `reference/writing-rules.md` governs the prose this
 *  repository AUTHORS, and this is a SHIPPED string whose exact bytes
 *  `tests/lib/aiTrustCopy.test.ts` pins: the test's own comment says no
 *  provider setting changes this residual, so the sentence must not drift.
 *  Recomposing it during the move to this package would have been a copy
 *  change wearing a punctuation fix, which is the thing that test exists to
 *  catch, and it did. */
export const AI_TRUST_A7_RESIDUAL =
  // eslint-disable-next-line no-irregular-whitespace
  "Like the rest of Myne, this does not protect against malware already running on your device \u2014 such software can read app memory.";

export const CONSENT_DEVICE_SUFFIX = "@device";

/** The value stored when this device records consent for `provider`.
 *
 *  Private, and it was an export until audit R0.1's membership guard asked who
 *  consumed it: the answer was `consentIsDeviceScoped` two functions down. No
 *  client composes this value — the consent is WRITTEN by the Rust side
 *  (`protocol::prefs` owns the grammar) and a client only ever compares what it
 *  reads. An export nobody outside the file can use is an affordance that reads
 *  as a contract. */
function deviceScopedConsent(provider: string): string {
  return `${provider}${CONSENT_DEVICE_SUFFIX}`;
}

/** Whether `stored` is a consent recorded on THIS device for `provider`.
 *
 *  A legacy bare-name value is deliberately false here, so a surface that asks
 *  this question shows the consent screen for the two populations that hold one
 *  (an install that turned Developer mode off, and a device enrolled before the
 *  reclassification). Both desktop and mobile call exactly this, and both
 *  comments at the call sites say why it is not an equality against the provider
 *  name: an equality would read a legacy value as current and start sending note
 *  text with no act by this device.
 *
 *  The distinction between "legacy" and "no consent at all" is deliberately NOT
 *  surfaced, and saying so is the point of this paragraph. A `consentIsLegacy`
 *  sibling existed to make it sayable, had no caller, and was removed in audit
 *  R0.1's follow-up: a second function with a doc comment describing a surface
 *  nobody built is the shape this audit exists to find. Add it back with the
 *  surface that needs it. */
export function consentIsDeviceScoped(
  stored: string | null | undefined,
  provider: string,
): boolean {
  return stored === deviceScopedConsent(provider);
}

export const CONSENT_DEVICE_SCOPE =
  "This choice covers this device only. Your key does travel to your other devices, but each one asks before it sends anything.";

/** HOW IT TRAVELS. Added by myne-md/myne#456, and it is stated nowhere else.
 *
 *  Myne can route its SYNC traffic through Tor on a desktop where the user has
 *  turned that on. myne-md/myne#607 extended that to the AI provider arm on
 *  desktop: `provider_transport.rs` dials directly by default and through the
 *  same Tor SOCKS5 proxy when the option is on, so the provider learns only the
 *  exit node in that case. Mobile never installs the sidecar, so its provider
 *  traffic stays direct.
 *
 *  Worth a clause of its own because the rest of this screen is about WHAT
 *  leaves and TO WHOM, and a reader who has seen the Tor option elsewhere in the
 *  product would reasonably assume it applies here. myne-md/myne#607 made that
 *  assumption true on desktop: the Tor routing option now covers this request
 *  too. The sentence below states the default AND the Tor case, and that mobile
 *  has no Tor routing yet, so it stays accurate on both clients. */
export const CONSENT_DIRECT_CONNECTION =
  "The connection is direct by default: the provider sees this device's IP address, and your network can see which provider you use. If you turn on Tor routing on desktop, this request goes through the same Tor proxy as sync, so the provider sees the exit node rather than this device. Mobile has no Tor routing yet, so it always connects directly.";

/** WHAT NEW READS NEVER TOUCH. Added by myne-md/myne#675, and it is the one clause
 *  about the content control rather than the disclosure: folders on the
 *  excluded list are closed to new reads on any arm. Worth a clause of its
 *  own because the rest of this screen says what leaves once the user agrees,
 *  and a reader agreeing here should know the one list that withholds whole
 *  folders from that agreement: an empty list withholds nothing, and it is
 *  the same list the command-line client honors, so the two surfaces cannot
 *  be played against each other. Text already saved in a conversation is
 *  outside this clause: it stays as it is and keeps seeding new runs, which
 *  the user guide states in the same words. */
export const CONSENT_EXCLUDED_FOLDERS =
  "Notes in excluded folders are closed to new reads: the AI will not open, search, or suggest from them, and nothing is sent on their behalf. The list lives under Settings, AI, Excluded folders; empty, it excludes nothing, and it is the same list the command-line client uses. Text already saved in a conversation stays as it is and keeps seeding new runs.";

/** Transcript-fallibility honesty note (voice-to-text MYND-552, SYNC-V8).
 *
 *  A load-bearing, threat-model-bounded framing shown beneath the read-only
 *  transcript expander: the transcript comes from a SMALL on-device speech model
 *  and MAY BE WRONG. It must NOT imply cloud-grade accuracy, and it must NOT
 *  claim model-runtime isolation ("sandbox"), per `threat-model.md` §7. That is
 *  the same discipline as `AI_CHAT_HONESTY_NOTE`.
 *
 *  HERE rather than desktop-local, because BOTH clients render it: desktop's
 *  `TranscriptionModal` and mobile's `TranscriptSheet` show the same sentence
 *  beside the same kind of text, and a hand-copy "kept identical by hand" is
 *  exactly the distinction SYNC-42 exists to make. Moved in myne-md/myne#886;
 *  the wording is unchanged, so the E2E/Vitest literal pins (SYNC-8) hold and
 *  this is a relocation rather than a copy edit.
 *
 *  Rendered verbatim in every locale (never i18n'd). */
export const AI_TRANSCRIPT_HONESTY_NOTE =
  "This transcript was made by a small model running on your device and may be wrong — check it against the audio.";

/* ---- Per-note export, settings and notice copy (audit R0.1, 2026-10-19) -----
 *
 * The eighteen literals below were DECLARED in both
 * `src/lib/load-bearing-copy.ts` and `mobile/src/lib/load-bearing-copy.ts`,
 * byte-identical by hand, while this package's header claimed the class was
 * "byte-identical across clients by construction" and `docs/dev/twin-inventory.md`
 * recorded the pair as "RESOLVED … both sides now re-export the shared family".
 * Measured: 23 exported consts on desktop, 19 on mobile, 18 in both, and none of
 * the 18 appeared here. The claim was true of the sync/enroll family and false of
 * everything below it.
 *
 * It was latent rather than broken: the two copies were byte-identical on the day
 * it was found, so nothing was misrendering. What was missing is the MECHANISM —
 * a `design-notes.md` event had to be a copy edit in two files, and the only
 * guard over the pair (`check-twin-drift-ratchet.mjs`) fires on a pair that
 * STARTS differing, not on one that was already recorded as differing for an
 * unrelated reason. `scripts/check-copy-membership.mjs` is the missing mechanism
 * now: a client tree may not declare a name this file exports.
 *
 * The load-bearing reason for each group is kept with it here, because this is
 * now the only copy of it.
 */

/** Unlock A8b `InvalidCredentialOrVault` banner — §7.3 compound form. */
export const UNLOCK_NON_DISTINGUISHING_BANNER =
  "Wrong password or vault file is corrupted.";

/** Recovery A8d `InvalidCredentialOrVault` banner — §3.4 single
 *  non-distinguishing outcome (cells wiped, one message, no per-word
 *  or per-cause detail). */
export const RECOVERY_NON_DISTINGUISHING_BANNER =
  "Phrase or vault file is invalid. Please try again.";

// The normative "honest about cost" sentence (PRODUCT.md principle 3 /
// docs/design/README.md "Lost both secrets") — the irreversible
// consequence of losing both credentials, stated plainly. Rendered
// verbatim by PasswordStep's helper copy AND embedded in the first-run
// safety briefing's recovery-phrase "Why?" (MYND-114); the briefing
// component test asserts it as a substring of that "Why?" text. Single
// source so a revision (a product-voice decision, not a copy edit) lands
// in one place.

/** "If you lose both …" — the canonical irreversibility sentence. */
export const LOST_BOTH_SECRETS_SENTENCE =
  "If you lose both your password and recovery phrase, your notes are unrecoverable. We cannot help.";

// Per-note export pre-flight (MYND-116). The honest-egress sentence is
// load-bearing UI honesty (TB3 plaintext egress is stated plainly, once,
// never as a banner); the sub-label pins the attachments-placement
// contract of `note_export_attachments` (files land beside the note).
// E2E asserts both by FULL-literal equality — production renders the
// constants verbatim (`NoteExportModal`).

/** The one plain egress sentence of the per-note markdown export —
 *  shown in the pre-flight modal when the note references attachments,
 *  and carried as the OS save dialog's title on the common no-modal
 *  path (`runNoteExportFlow`), so it is said exactly once at the
 *  decision point either way. */
export const EXPORT_PLAIN_MARKDOWN_SENTENCE =
  "The exported file is plain Markdown — it is not encrypted.";

/** Whole-vault export (MYND-211): the one plain egress sentence shown in
 *  the vault-export modal's setup phase (`VaultExportModal`) — the
 *  whole-tree sibling of `EXPORT_PLAIN_MARKDOWN_SENTENCE`. Same honesty
 *  discipline: stated plainly, once, never as a banner; E2E asserts it by
 *  FULL-literal equality. */
export const VAULT_EXPORT_PLAIN_TREE_SENTENCE =
  "The exported files are plain Markdown — they are not encrypted.";

/** Muted sub-label under the "Include N attachments" toggle. */
export const EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL =
  "Files are placed in the same folder as the note.";

// Per-note PDF export pre-flight (MYND-255). Same honesty discipline as
// the markdown sentences above: the egress is stated plainly, once,
// never as a banner; the exclusion sentence pins the product decision
// that non-image attachment embeds (PDFs, archives, anything else the
// projection cannot inline) are NOT carried into the generated PDF
// (a muted in-document placeholder marks each position instead). The
// notice (`NotePdfExportNotice`) renders both verbatim; E2E asserts
// them by FULL-literal equality.

/** The one plain egress sentence of the per-note PDF export — shown in
 *  the pre-export notice when the projection excludes attachments, and
 *  carried as the OS save dialog's title on the common no-notice path
 *  (`runNotePdfExportFlow`), so it is said exactly once at the decision
 *  point either way. */
export const EXPORT_PDF_PLAIN_SENTENCE =
  "The exported file is a plain PDF — it is not encrypted.";

/** The attachment exclusion sentence (shown only when the note embeds
 *  attachments the projection cannot include — every non-image type,
 *  not just PDFs). */
export const EXPORT_PDF_EXCLUSION_SENTENCE =
  "Attached files (PDFs and other non-image attachments) are not included in the generated PDF.";

// Per-note HTML + plain-text export (note-export MYND-340). Same honesty
// discipline as the markdown / PDF sentences above: the egress is stated
// plainly, once (carried on the OS save dialog title, or shown in the
// pre-flight attachments modal for HTML), never as a banner; E2E asserts
// them by FULL-literal equality.

/** The one plain egress sentence of the per-note HTML export — shown in
 *  the pre-flight modal when the note references image attachments, and
 *  carried as the OS save dialog's title on the common no-modal path
 *  (`runNoteHtmlExportFlow`), so it is said exactly once at the decision
 *  point either way. */
export const EXPORT_PLAIN_HTML_SENTENCE =
  "The exported file is plain HTML — it is not encrypted.";

/** The one plain egress sentence of the per-note plain-text export —
 *  carried as the OS save dialog's title (`runNoteTxtExportFlow`); the
 *  TXT projection never includes attachments, so there is no pre-flight
 *  modal and the sentence is said only here. */
export const EXPORT_PLAIN_TEXT_SENTENCE =
  "The exported file is plain text — it is not encrypted.";

// Automatic local-backup failure toast (MYND-351). A backup feature must never
// fail silently — when a scheduled backup cannot write (target gone / disk full
// / permission denied) the user sees this once (debounced); the schedule stays
// enabled and retries next cycle. E2E (task 8 failure-path) asserts it by
// FULL-literal equality, so it lives here as the single source.

/** Scheduled-backup failure toast — the quiet, non-silent failure alert. */
export const BACKUP_SCHEDULE_FAILED_TOAST =
  "Automatic backup failed. Check your backup folder in Settings → Storage.";

/* ---- Browser-extension clip success notice (desktop-ingest task 7, MYND-442) --
 *
 * A clip lands at the vault ROOT (SYNC-15) and the user keeps working — the
 * notice is a non-blocking toast with a "view" affordance that opens the new
 * note. The copy is load-bearing: E2E asserts the message + action label + each
 * omitted-tally line by FULL-literal equality, so the strings live here as the
 * single source. The tally renders PROMINENTLY (one labelled line per omitted
 * media class) because a single clip losing its hero image is surprising — far
 * more so than a per-type loss inside a bulk import.
 *
 * `clipOmittedTallyLine` came with them: it was declared byte-identically in
 * both client files and builds those asserted lines, so leaving it behind would
 * have left half the block duplicated while this package claimed the whole.
 */

/** The clip success notice's primary line — the clip landed at the vault root. */
export const CLIP_NOTICE_ROOT_MESSAGE = "Clipped to your vault root.";

/** The label of the clip notice's "view" affordance (opens the new note). */
export const CLIP_NOTICE_VIEW_ACTION = "View";

/** The display label for each omitted media class in the clip tally. Keyed on
 *  the user-meaningful media class (`src/notes/import/media.ts`); the value is
 *  the singular noun the tally line uses (pluralised by `clipOmittedTallyLine`
 *  when the count is >1). */
const CLIP_OMITTED_CLASS_NOUN: Record<string, string> = {
  image: "image",
  pdf: "PDF",
  audio: "audio file",
  video: "video",
  other: "attachment",
};

/** Render one prominent omitted-by-type tally line (e.g. "1 image omitted",
 *  "3 PDFs omitted"). Load-bearing: E2E asserts the rendered line by literal
 *  equality, so the wording lives here. The count is always ≥1 (the builder
 *  emits a line only for a non-zero class). */
export function clipOmittedTallyLine(mediaClass: string, count: number): string {
  const noun = CLIP_OMITTED_CLASS_NOUN[mediaClass] ?? "attachment";
  const plural = count === 1 ? noun : pluraliseOmittedNoun(noun);
  return `${count} ${plural} omitted`;
}

/** Pluralise an omitted-class noun. "PDF" → "PDFs", "audio file" → "audio
 *  files" (the head noun pluralises), everything else gets a trailing "s". */
function pluraliseOmittedNoun(noun: string): string {
  if (noun === "audio file") return "audio files";
  return `${noun}s`;
}

/* ---- Connected-extensions Settings section (ext-foundation-handoff task 7,
 * MYND-443) ------------------------------------------------------------------
 *
 * Settings → Account lists the live (non-revoked) paired browser extensions
 * with a per-row Revoke. Revoke is desktop-authoritative, immediate + durable —
 * the re-pair hint states the consequence plainly (the extension must pair
 * again to reconnect). E2E asserts these literals by full equality, so they live
 * here as the single source.
 */

/** Section title for the connected-extensions list (Settings → Account). */
export const CONNECTED_EXTENSIONS_TITLE = "Connected extensions";

/** Helper line under the section title — what a paired extension is. */
export const CONNECTED_EXTENSIONS_HELPER =
  "Browser extensions you have paired with this vault. Revoking one disconnects it immediately.";

/** Empty state — no extension has been paired yet (the start-empty case). */
export const CONNECTED_EXTENSIONS_EMPTY = "No connected extensions.";

/** The per-row Revoke action label. */
export const CONNECTED_EXTENSIONS_REVOKE_LABEL = "Revoke";

/** The one-line consequence hint shown after the list — revoke is durable and
 *  the extension must pair again to reconnect (the re-pair itself is the
 *  extension's side, out of scope for this UI). */
export const CONNECTED_EXTENSIONS_REPAIR_HINT =
  "A revoked extension must pair again to reconnect.";
