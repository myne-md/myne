// @myne/copy — shared LOAD-BEARING user-facing copy (SYNC-42).
//
// The exact English wording of these strings is a security/privacy property, not
// a stylistic choice. They are consumed as SOURCE by BOTH the desktop client
// (`src/lib/load-bearing-copy.ts` re-exports them) and the mobile client
// (`mobile/src/…`), so the literals are byte-identical across clients by
// construction — cross-client paraphrase is impossible. E2E asserts them by
// FULL-literal equality; changing any is a `design-notes.md` event, never a
// copy edit. Never i18n these (see `src/CLAUDE.md` "Do NOT i18n load-bearing copy").

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

// The beta terms, as the app states them (operations#15). The published text is
// at https://myne.md/terms and this is not a substitute for it — it is the four
// clauses a person must actually have read before sync starts carrying their
// notes to a server, phrased so that reading only these four leaves them with an
// accurate picture rather than a flattering one.
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
 *  `core/src/plugins/sync/legal_consent.rs`. */
export const BETA_TERMS_VERSION = "1";

/** What the service is, and what it is not. */
export const BETA_TERMS_WHAT_THIS_IS =
  "Myne's sync is a free beta. It takes no payment, carries no warranty and makes no uptime promise — software this young breaks, and a bug can lose data.";

/** The clause the architecture makes necessary, and the one most terms omit. */
export const BETA_TERMS_DATA_LOSS =
  "If you lose your password and your recovery phrase, your notes cannot be recovered — not by you and not by us. There is no reset, because a reset would mean we held a key to your notes.";

/** The anti-Skiff clause: what happens when the beta ends, and if it shuts. */
export const BETA_TERMS_WHAT_HAPPENS_NEXT =
  "When the beta ends your account keeps working. If a paid tier ever exists it will be a choice, not a gate in front of notes you already have. If we ever shut the service down you get at least 90 days' notice, with export working the whole time.";

/** The moderation reality, which is also the DSA Art. 14 transparency line. */
export const BETA_TERMS_WHAT_WE_CAN_SEE =
  "We cannot read what you store, so we cannot screen it and do not try. On a substantiated report we can act on an account — freeze it or delete it — but never on a single note, because we cannot tell them apart.";

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
 *  myne-md/myne#531 review round six. */
export const CONSENT_WHAT_LEAVES =
  "The text of the notes involved in each request leaves your device: the note you are working in, and any note used to answer you. An agent run also sends the titles and identifiers of every note in the scope you approved, before it has read any of them.";

/** WHEN it leaves. Bounded by the SYNC-14 bar: only work the user asks for.
 *
 *  The agent run is the fifth trigger and was added late: this branch amends
 *  TB12 and TB13 to widen what crosses, and this screen is the surface that
 *  amendment is meant to reach (myne-md/myne#531 review round six). A consent
 *  screen that enumerates four of five triggers is not one. */
export const CONSENT_WHEN_IT_LEAVES =
  "Only when you ask for something: chat, summarize, rewrite, edit selection, or an agent run. Nothing is sent as you type, and nothing is sent in the background.";

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
export const CONSENT_DEVICE_SCOPE =
  "This choice covers this device only. Your key does travel to your other devices, but each one asks before it sends anything.";

/** HOW IT TRAVELS. Added by myne-md/myne#456, and it is stated nowhere else.
 *
 *  Myne can route its SYNC traffic through Tor on a desktop where the user has
 *  turned that on. The AI provider arm is not routed: `provider_transport.rs`
 *  opens a direct connection on every client, so the provider learns the
 *  device's IP address and the local network learns which provider is in use.
 *
 *  Worth a clause of its own because the rest of this screen is about WHAT
 *  leaves and TO WHOM, and a reader who has seen the Tor option elsewhere in the
 *  product would reasonably assume it applies here. Routing it is
 *  myne-md/myne#607; until then, this is the honest sentence. */
export const CONSENT_DIRECT_CONNECTION =
  "The connection is direct. The provider sees this device's IP address, and your network can see which provider you use.";
