# Myne Recovery Flow Specification v0.1

> **Status: draft.** UX-normative specification for the Myne Phase 1 desktop client. Cryptographic surfaces defer to `protocol.md` §3.1 + §7; this document specifies the user-facing ceremony around them. Source decisions: grill session `myne-agents/sessions/grill/2026-05-01-recovery-flow-spec.md` (Q1–Q9).

---

## 1. Scope

This document covers two halves of the same lifecycle:

1. **Create-time recovery UX** — the screens and rules that present the freshly generated recovery phrase to the user at vault creation and force its confirmation. Already implemented in `src/screens/vault-creation/` (B3a + B3b); this section captures the canonical behavior.
2. **Recovery-time UX** — the screens and rules for unlocking a vault when the master password has been forgotten, using the 24-word recovery phrase. Forward-design for B4b implementation.

Out of scope:

- The vault-unlock-with-password screen itself (B4a). This document only fixes the **entry point** at which recovery is reachable from that screen (§3.1).
- Multi-vault and sync-aware account-number UX. Phase 1 is single-vault local-only (§5). _(Forward pointer: multi-vault later activated the optional account-number selector role — see §5's forward pointer + `decisions.md` 2026-06-09 "Multi-vault recovery".)_
- Cryptographic primitive selection — see `protocol.md` §2 + §7.

---

## 2. Create-time recovery UX

### 2.1 Phrase generation

At vault creation the client generates a 24-word BIP-39 phrase per `protocol.md` §7.2: 256 bits of OS CSPRNG entropy plus an 8-bit checksum, encoded against the canonical English BIP-39 wordlist, joined with single ASCII spaces.

### 2.2 Phrase display

The 24 words MUST be presented on a dedicated step within the vault-creation flow, with the following normative properties.

**The step is the recovery kit** (`decisions/ui/0642`, myne-md/myne#468). The phrase and the account number are shown together, on ONE step, laid out as a preview of the single file Save writes: a header naming the vault and the date, the phrase section, the account-number section. They were two consecutive steps; the account step arrived after the §2.3 challenge had already been passed and read as an epilogue, and no product surveyed asks a user to absorb two back-to-back "keep this forever" moments. The document layout is itself the statement that both secrets go into one file, so a client MUST NOT add a warning box restating it.

- **Layout** — 4-column grid of numbered word cells (4×6 or 6×4 visually equivalent), one BIP-39 word per cell, position indices 1–24 visible to the user. The grid MUST be laid out left-to-right in every locale, including right-to-left ones, while the page keeps the locale's direction: the ORDER of the words is part of the secret, BIP-39's checksum does not catch a permutation, and §2.4 means a mis-copied order is never discoverable. A mobile client MAY reveal the grid in halves where 24 words do not fit legibly.
- **Why the words are English** — the step MUST say, once, that the words are the BIP-39 English wordlist on every client and are not translated. Without it an untranslated grid in a translated interface reads as a missing translation, and a user who translates the words back has destroyed their only backup.
- **Account number** — shown in the same sheet, under a label stating what it is FOR: adding another device (`account-number.md` §7). It carries no acknowledgement control of its own.
- **Blur-by-default** — the grid is rendered blurred until the user explicitly clicks a "Reveal phrase" affordance. This anchors awareness that the value is sensitive.
- **Walk-away guard** — when the OS window loses focus (`window.blur` event from Cmd-Tab, app-switch, or screen lock), the grid MUST re-blur immediately. The user must click "Reveal phrase" again to view it. **Web client:** `window.blur` alone under-covers a browser, where the most common walk-away is a tab switch rather than a window switch, so the web client MUST additionally re-blur on `visibilitychange` to a hidden document. Same requirement, two events, because one event does not observe the same user action on both platforms.
- **Copy**, a "Copy" affordance MUST be offered **where the platform can hold the phrase to the standard below**. Where it cannot, the client MUST NOT present the affordance as though it carried a protection it does not: it either WITHHOLDS the affordance, or OFFERS it and states plainly, beside the control, what is not happening. Which of the two a platform owes is a product decision, argued per platform and written down each time; what is never permitted is leaving the gap implicit. The clipboard contents MUST stop being available after 30 seconds wherever a mechanism below can make that true, and the mechanism is per platform:
  - **Desktop**, a scheduled clear gated on a read precondition: it MUST verify the clipboard still contains the phrase before wiping, so that later unrelated clipboard contents are never destroyed. The comparison MAY run host-side rather than in the WebView (`decisions.md` 2026-06-24, myne#379), and the clear MUST NOT be cancelled merely because the step was left, or the 30-second promise is one the mechanism does not keep.
  - **iOS**, the item is written with device confinement AND an OS-enforced expiry, set together. This SUPERSEDES the read-precondition requirement on this platform (`decisions.md` 2026-08-15, entry 0510): an expiring item drops only itself, so it serves the requirement's intent, never destroying a later copy, more exactly than a compare-and-clear, and needs no clipboard READ to do it.
  - **Android**, neither confinement nor per-item expiry exists at any API level, and the sensitivity extra is a rendering hint rather than an access control. The affordance is therefore ABSENT (`decisions.md` 2026-08-15, entry 0511). This is the "MUST be offered" clause yielding to the "where the platform can hold it" condition above, not an implementation shortfall. Absence is the right answer HERE because the alternative on that platform is intact: Save-to-file works, and the grid is behind screen-capture protection, so withholding Copy does not push the user toward a worse route.
  - **Web**, the read precondition cannot be satisfied at all: Firefox grants page content no clipboard read, and the other engines gate it behind a permission prompt and document focus, so a web auto-clear would either never fire or would have to wipe blind and destroy contents that are no longer the phrase. The affordance is nevertheless OFFERED, and the client MUST state beside it that the clipboard will not be cleared. Absence is the wrong answer here because it does not remove copying: the words are on screen in a page, manual selection over a numbered grid yields mangled text, and the user is pushed to retype or screenshot, both worse, on the one client that also has no screen-capture protection to fall back on. The promise is what is dropped on web, not the affordance, and saying so is mandatory rather than optional.

  Recorded so the history is legible: `decisions.md` 2026-08-04, entry 0427, declined to soften this MUST to a MAY, on the grounds that retiring the affordance would be a product decision across three clients rather than a documentation fix. That deferral is now closed, and closed the way 0427 said it would have to be. What has happened is that the product made the decision, per platform, with the argument written down each time; the spec now describes it. The two outcomes differ because the arguments differ, not because the rule does: Android and web are both platforms that cannot keep the 30-second promise, and each was asked separately what a user does when the button is not there.
- **Save as file** — a "Save as file" affordance MUST be offered, writing ONE plain-text file holding both secrets to a user-chosen location: a title line, the vault's name and the date, a heading and then the 24 words as a single space-joined line (the shape phrase entry and a password manager both accept), and a heading and then the account number. Labels are localised; the words never are. Both clients MUST produce this text from one shared implementation, so a kit saved on one client is the document the recovery flow on another expects. Filename default: `myne-recovery-kit.txt`. Copy MUST put the same bytes on the clipboard that Save writes. **Web client:** a page has no arbitrary write path, so this is satisfied by a browser download of the same content and the same default filename; the destination is the browser's, not the user's pick. The file's exposure is otherwise identical, and §5 of `threat-model.md` covers both.
- **Both affordances MUST report their outcome, and MUST NOT report one they cannot observe** (`decisions.md` 2026-08-25, entry 0537, myne-md/myne#522). This step shows the phrase once and never again, so a save or a copy that failed and looked like it worked is not an inconvenience: the user advances believing a file exists, and §2.4's no-re-display commitment makes that permanent. Three rules follow, and the third is the one an implementer gets wrong:
  - A failure MUST be reported, in a form the user cannot miss on a shown-once screen. A console log is not a report.
  - A CANCELLED save dialog MUST report nothing. The user closed it; announcing it is the client narrating the user's own action back at them, and it trains them to ignore the line that matters.
  - A success MUST claim only what the client actually observed. A native save dialog returns after the write, so "saved" is true. A browser download returns when the page hands the bytes to the browser, which chooses the destination and reports neither a block, a cancelled destination prompt, nor a failed write; on that path the client MUST say the download was started rather than that the file was saved. Stating a landing the client never saw is the same defect as saying nothing, wearing a reassuring sentence.
- **Extension exposure (web client)** — the phrase grid, once revealed, is readable by any browser extension holding host permissions on the origin, which no content-security policy prevents and the page cannot detect (`threat-model.md` A19). The web client MUST say so on this step. Native clients have no equivalent surface and MUST NOT carry the notice, which would be a false symmetry.
- **Acknowledgement CTA** — a single action transitions to the confirmation step (§2.3), labeled to communicate that the user attests they have saved the kit. It is the ONLY acknowledgement on the step; there is no checkbox (§2.3 is what gates creation, and `protocol.md` §7.2 says a checkbox is not evidence). Save is the visually primary action on this step, because saving is the step's job; the acknowledgement and Copy are secondary. *(Revised 2026-09-27, `decisions/ui/0642`: this bullet previously made the acknowledgement primary and Save a ghost, when the phrase had a step of its own.)*
- **Print** is NOT offered. `window.print()` does nothing in some WebViews, so a Print control would silently fail on a shown-once screen; the honest route would stage the phrase into a second rendering surface, which is a threat-model change and is not made here.

### 2.3 Type-back confirmation challenge

A bare "I have written it down" checkbox is **insufficient** (`protocol.md` §7.2). The flow MUST require the user to demonstrate knowledge of the phrase before vault creation completes. The challenge:

- **Four positions** drawn from the 24-word phrase using a biased distribution: **one** position from indices 1–8, **two distinct** positions from 9–16, and **one** position from 17–24. The biased distribution defends against partial-write failure modes (user wrote down only the first half).
- **Position stability** — the four drawn positions MUST persist across navigation back-and-forth between confirmation and adjacent steps; redrawing on every entry punishes the user for navigating.
- **Per-cell typed input** — one input per drawn position, labeled "Word at position N".
- **Per-cell exact-match validation** — comparison applies §7.4 normalization (NFKD + lowercase + trim) to both the typed value and the target word; an inline per-cell error "Doesn't match word #N" appears when the cell has any input that fails to match. Empty cells stay neutral.
- **No autocomplete, no typeahead, no spellcheck** — input fields disable browser-level autocomplete and spellcheck.
- **Submit gating** — the "Continue" affordance is disabled until all four cells match. This is the LAST step of creation, so that affordance also commits the vault; a commit failure returns here with the typed words intact.
- **Direction** — the inputs MUST be left-to-right in every locale, for the reason §2.2's grid is.

> Rationale: the create-time challenge has access to the phrase the client just generated, so per-cell validation against a known target is appropriate here. Recovery-time validation (§3) is fundamentally different and follows different rules.

### 2.4 No re-display commitment

The recovery phrase is shown to the user on §2.2 **exactly once**, and never again by any client surface. After the user advances past the confirmation step, the in-memory phrase string MUST be dropped from the client's state.

Reaffirmed 2026-09-27 (myne-md/myne#468): the read-only verification in §3.6 does not weaken this. It takes the phrase as INPUT and answers yes or no; it never displays one.

This commitment is **narrow**: it covers the *generated* phrase displayed at vault creation. It does not extend to user-typed input during recovery (§3.2), which is governed separately (§3.5). A future client MUST NOT add a "show me my recovery phrase" affordance under any authenticated condition; the architecture additionally enforces this structurally because the phrase plaintext is zeroized at vault creation and only `enc_root_key_recovery` survives on disk.

---

## 3. Recovery-time UX

### 3.1 Entry point

The recovery flow MUST be reachable from the vault-unlock screen via an explicit affordance (e.g., a "Recover with phrase" link or button). The visual and interaction design of that affordance is specified by the vault-unlock-screen spec (B4a) and is out of scope here. No other entry points to recovery are defined for v0.1; adding one (command palette, settings menu, deep link) requires a new `decisions.md` entry.

**A surface that accepts the phrase as a CREDENTIAL is not an entry point to recovery**, and the distinction is what keeps the sentence above true as the product grows. Recovery replaces a forgotten master password: it derives `recovery_wrap_key`, transitions the slot to `Slot::Recovering`, and is not finished until a new password is committed (§4). A credential surface derives a key and stops. Six non-recovery credential surfaces exist today, and none is reachable from this flow or leads into it: device enrolment (`sync_enroll`, which also accepts account number plus master password), the SOURCE-vault credential of a vault import (`Slot::ImportSource`, myne-md/myne#464), the B2B member-identity unlock (`src/components/sync/PersonIdentityUnlock.tsx`, `myne-md/myne#698`), the B2B member-vault unlock (`myne-md/myne#711`), identity-only recovery (`src/components/IdentitySetupDialog.tsx`), and the vault-migration credential (`src/components/settings/MigrateVaultForm.tsx`). All are subject to §3.2 below, which is where the rules that DO travel are stated.

### 3.2 Phrase entry

The recovery-entry screen MUST present a **24-cell grid** matching the visual idiom of §2.2 (numbered cells, monospace font, position indices 1–24 visible). The user types one BIP-39 word per cell.

**These properties bind EVERY surface on which a user types the phrase, not only this one.** The rationale below is a privacy argument about what a screen leaks while it is being typed into, and that argument does not know which flow it is in: a typeahead over the BIP-39 list leaks the same bit per word on the device-enrolment form and on a vault import's source credential as it does here. Stating it as a property of the recovery screen alone is what let a second surface ship a single-line input, which is a `paste`-shaped affordance with no position indices and, on a platform with autofill, a phrase in a password manager's heuristics. A client that adds a phrase surface implements this section or does not add the surface.

Normative properties:

- **No per-cell validation during entry.** No red borders, no green checkmarks, no inline "this word is in the BIP-39 list" feedback, no per-cell error states tied to typing.
- **No per-cell typeahead or autocomplete.** The 2048-word BIP-39 list MUST NOT be exposed through a typeahead surface. Browser-level autocomplete and spellcheck MUST be disabled.
- **Paste-to-distribute.** When the user pastes a value into the first cell that contains two or more whitespace-separated tokens, the client MUST split on whitespace and distribute one token per cell, populating cells 1 through N (where N is the token count, capped at 24). This supports the common case where a user has stored their phrase as a single string in a password manager.
- **Submit gating.** The "Submit" affordance is enabled when all 24 cells are non-empty. No other gating.
- **Normalization at submit.** When the user clicks Submit, the client MUST apply `protocol.md` §7.4 normalization (NFKD + lowercase + trim, whitespace runs collapsed to single ASCII space) to produce the `phrase_normalized` byte string fed to Argon2id.

> Rationale (privacy): even though the BIP-39 wordlist is public, surfacing wordlist membership through any UI affordance — typeahead, suggestion list, per-cell red border, "X words are not BIP-39" batched error — leaks a 1-bit-per-word membership signal to anyone observing the screen. This specification rejects that leak in either direction (positive or negative feedback). The cost is that users with a typo pay one Argon2id roundtrip per attempt with no in-product hint pointing at the wrong cell.

> **Where the surfaces are, so the list can be checked rather than assumed.** Recovery (`src/screens/vault-recover/PhraseEntryStep.tsx`), device enrolment (`src/components/sync/EnrollPhraseCredential.tsx`), the vault-import source credential (`src/notes/import/MyneVaultSetup.tsx`), the B2B member-identity unlock (`src/components/sync/PersonIdentityUnlock.tsx`), the B2B member-vault unlock (`src/components/sync/MemberVaultUnlockCard.tsx`), identity-only recovery (`src/components/IdentitySetupDialog.tsx`), and the vault-migration credential (`src/components/settings/MigrateVaultForm.tsx`) each provide a caller-specific credential surface. The non-recovery paths are either substituted as a whole or resolve through the shared grid's build-time substitute, while the recovery and enrolment grid remains the source module; each caller still carries its own `data-testid`, since `scripts/check-web-no-phrase.mjs` asserts the ABSENCE of one marker per prohibited phrase path from the served bundle, and a shared testid would make these surfaces indistinguishable in the artefact.

> **Open implementation question (B4b).** If the recovery-drill smoke test reveals the typo-cost-per-attempt is too punishing in practice, this rule MAY be revisited via a new `decisions.md` entry. Candidate softening: a single batched, non-cell-specific message ("phrase contains words not in the BIP-39 list — please re-check") shown only after a failed Argon2id+AEAD cycle, without per-cell highlighting.

### 3.3 Submit and in-flight state

On Submit, the client MUST transition to a **dedicated "Decrypting…" step** (parallel to the create-time `EncryptingStep` idiom). The 24-cell grid MUST be hidden during this step; the UI MUST be locked; a progress affordance MUST be shown.

During this step, the client:

1. Holds `phrase_normalized` in a Rust-side `Zeroizing<String>` (or `Zeroizing<Vec<u8>>`) — see §3.5.
2. Derives `recovery_wrap_key` via Argon2id with `salt_recovery` per `protocol.md` §3.1.
3. Attempts AEAD-decrypt of `enc_root_key_recovery` with `recovery_wrap_key` and the `AAD_recovery_wrap` AAD per `protocol.md` §3.1 + §5.

**No cancel affordance.** Once Submit fires, the operation runs to completion. Argon2id is not cleanly interruptible mid-iteration; offering a Cancel button that drops the result while letting Argon2id continue would be UI sleight-of-hand, and the ~1-second cycle is short enough not to warrant it.

### 3.4 Outcome and error handling

**Success.** AEAD-tag verification succeeds; `root_key` is recovered into client memory. The flow MUST advance to the post-recovery password reset (§4). The 24 typed cells MUST be cleared from React state.

**Failure.** AEAD-tag verification fails. Per `protocol.md` §7.3, the client MUST NOT distinguish between "phrase entered wrong" and "`vault.meta` was tampered". The user-facing error message MUST be a single non-distinguishing string:

> **"Phrase or vault is invalid — please retry."**

(Equivalent wording is acceptable provided it preserves the non-distinguishing property.)

On failure:

- **Wipe all 24 cells.** The typed input MUST be cleared from React state; the user retypes from scratch on retry.
- **No throttle, no attempt counter.** The ~1-second Argon2id cost is the structural rate limit (~60 attempts/minute regardless of UI). The client MUST NOT track an attempt counter, MUST NOT progressively delay retries, and MUST NOT lock the user out after N failures. (Phase 1 is local-only; UI lockout offers no defense against a forensic attacker with the file offline, and only burdens panicked legitimate users.)
- **Each retry is independent.** Each Submit MUST initiate a fresh Argon2id call and a fresh AEAD-decrypt. No state — typed phrase, derived wrap key, partial computations — carries across attempts.

### 3.5 Memory hygiene

The 24-word phrase is one of two critical secrets per `threat-model.md` AS11. The client's memory-hygiene posture is **honest**, distinguishing what each layer can and cannot guarantee:

- **JavaScript / WebView side: best-effort.** V8 strings are immutable and not zeroizable. The React state MUST drop references to the typed phrase on success and on failure (per §3.4 wipe), allowing GC to eventually collect the underlying allocations. The client MUST NOT claim that the phrase has been zeroized at this layer — only that references have been released.
- **Tauri IPC bridge (native clients): best-effort.** Tauri JSON-serializes the phrase across the IPC boundary; the serialized bytes briefly live in the WebView process. Same V8 limitation applies.
- **Worker and wasm boundary (web client): best-effort on the JS side, mandated on the Rust side.** The web client has no Tauri IPC; the phrase crosses a `postMessage` to the vault Worker and then into wasm linear memory. The `postMessage` copy is a JS value subject to the same immutability limit as every other, so the client MUST NOT claim it is zeroized. Inside wasm the Rust rule below applies unchanged and is enforceable: `Zeroizing` wrappers really do overwrite linear memory. What a browser adds that a native client does not have is **two copies outside the client's reach**, and the spec names them rather than implying they do not exist. First, **form restoration**: browsers repopulate inputs on back-navigation and session restore from browser-managed storage, which clearing React state does not touch. The web client MUST disable autocomplete on the phrase cells and MUST clear them explicitly on `pagehide`; both are best-effort mitigations of a store the client does not own, not guarantees. Second, **extension access**: an extension with host permissions reads the cells as they are typed (`threat-model.md` A19), and no client-side measure addresses it.
- **Rust side: mandated zeroization.** Once Rust receives the phrase, the implementation MUST hold it in a `Zeroizing<String>` (or `Zeroizing<Vec<u8>>`) wrapper. The same rule applies to:
  - the normalized phrase bytes,
  - the derived `recovery_wrap_key`,
  - any intermediate buffers used during Argon2id or AEAD-decrypt.
  These wrappers MUST be dropped — and therefore zeroized — immediately after AEAD-decrypt returns success-or-error. Successful recovery transitions `root_key` into a separate `Zeroizing` container that lives until vault lock or process exit; the phrase-side material does not survive past the decrypt step.

The spec deliberately avoids promising "the phrase is zeroized" without qualification, because that would misrepresent what the V8 runtime can deliver.

### 3.6 Read-only verification (the drill)

A client MUST offer a way to check, on an UNLOCKED vault, whether a phrase the user types opens that vault (`decisions/security/0640`, myne-md/myne#468). §2.4 means a phrase mis-copied at creation is otherwise discovered on the day it is needed, which is the day the password is already gone.

- **Read-only.** The command derives the recovery wrap-key under the vault's recovery salt domain, attempts the AEAD-open of `enc_root_key_recovery`, discards the result, and returns a boolean. It MUST NOT transition any slot (in particular it MUST NOT populate `Recovering`, which would demand a password reset from a user who was only checking) and MUST NOT write.
- **Unlock-gated.** It MUST refuse when no vault is unlocked. This is what bounds it as an oracle: a caller at a locked app cannot reach it, and a caller at an unlocked app already holds the plaintext.
- **Shared auth budget.** Attempts ride the same single-permit budget as unlock, recovery and password change, so a check cannot run beside any of them or be used to keep that budget busy.
- **One failure answer.** A wrong phrase, another vault's phrase and structurally invalid input MUST all produce the same result and the same message. The message MUST NOT name a mismatched position — that would turn one whole-phrase check into twenty-four one-word checks — and SHOULD say why it does not. A `vault.meta` that cannot be read or parsed is an ERROR, not a wrong phrase.
- **Entry only.** The surface MUST NOT display a phrase. It clears its input after every attempt.
- **Not surfaced automatically,** with one exception: a single, dismissible line on the backup-success screen, which never returns once dismissed.

### 3.7 Joining a new device with the phrase

A device join MAY use the phrase instead of the password (`decisions/sync/0641`, myne-md/myne#468), for a user who has lost every other device and so has nobody to approve a password join.

- **Path.** The enrolment sends the `recovery` path (`server-protocol.md`), which the server self-approves.
- **Opening the vault** uses the same pipeline as §3.2–§3.4, so the vault is `Recovering` afterwards and the §4 mandatory password reset follows before it can be used.
- **From the waiting screen.** A device already joined with the password and waiting for approval MAY re-run its enrolment with the phrase. That vault is already unlocked with the password the user just typed, so no password reset follows.
- **Web.** Not offered: the phrase as a device credential is the `phraseEnrolment` capability, absent on the web client for the reason `threat-model.md` A18 gives.

---

## 4. Post-recovery password reset

### 4.1 Mandatory chained step

`protocol.md` §7.3 requires the client to set a new master password after successful recovery. This specification interprets that requirement **strictly**: recovery is **not complete** until a new password is committed.

Normative properties:

- **No skip affordance.** The chained password-reset form MUST be non-dismissible. There is no "skip", "do this later", or "keep current password" option.
- **B3a-style form.** The form mirrors the create-time password step (`src/screens/vault-creation/PasswordStep.tsx`): single password field plus zxcvbn strength meter, with the same minimum-strength gating used at create time.
- **Force-quit and idle-timeout are the bail paths.** The user can close the window or kill the process; additionally, auto-lock on idle (MYND-121) bails the recovery session after an absolute timeout measured from `recovered_at`. Both route through the same automated `vault_lock` and are bail behavior governed by §4.3. There is still no user-facing "skip" / "cancel" affordance on the form itself.

### 4.2 vault.meta rewrite atomicity

When the user commits the new master password, the client:

1. Derives a new `password_wrap_key` via Argon2id with a freshly generated `random_salt_password_16` and the canonical KDF parameter block (`protocol.md` §3.1, §4).
2. AEAD-encrypts the in-memory `root_key` under the new `password_wrap_key`, producing a new `enc_root_key_password` and a new `nonce_password_wrap`. The AAD binds the length-prefixed `password-wrap` role string and the canonical KDF parameter block per `protocol.md` §3.1 + §4.3; it does **not** contain the salt. The fresh salt is bound *implicitly*, by being an Argon2id input — a substituted salt derives a different `password_wrap_key`, so the CTX tag fails and the substitution is caught.
3. Assembles a new `vault.meta` byte sequence per `protocol.md` §9.3, **preserving** all recovery-side fields unchanged: `random_salt_recovery_16`, `nonce_recovery_wrap`, `enc_root_key_recovery`. The recovery phrase does not change across password resets (`protocol.md` §7.3).
4. Writes the new bytes via the **tempfile-rename** pattern: write to `vault.meta.tmp` in the same directory as `vault.meta`, fsync the temp file, then rename it over `vault.meta`. POSIX `rename(2)` on the same filesystem is atomic — a power loss before the rename leaves the original `vault.meta` intact and the temp file orphaned (cleanable on next start); a power loss after the rename leaves the new `vault.meta` fully written.

The client MUST NOT use in-place overwrite (a partial write would corrupt both credential paths). The client MUST NOT use a dual-slot scheme that doubles `vault.meta` size; `protocol.md` §9.3 specifies a single set of password-side fields.

### 4.3 Bail behavior

If the user closes the window, navigates away, or otherwise leaves the password-reset form before commit, the client MUST:

1. **Zeroize the in-memory `root_key`** and any derived material.
2. **Return to the unlock screen** on next session.

The session pays its ~1 second of Argon2id without producing a usable result; the user re-enters the recovery flow next session. This is the cost of bailing on a strict-mandatory chained step.

The client MUST NOT keep a "soft-unlocked" session that grants editor access without committing a new password — that would diverge `vault.meta` on disk from the credential the user expects to own.

### 4.4 What is reset

The reset writes only the **password-side credential**: new salt, new wrap key, new wrapped `root_key`. The recovery side is preserved as-is. The account number is **not** displayed and **not** re-affirmed during this step.

---

## 5. Account-number role

In Phase 1, the account number (`account-number.md`) is a Phase 2+ sync identifier with no role in recovery. The recovery flow operates on whichever `vault.meta` exists at `app_data_dir/vault/vault.meta`; the account-number stored in that file's plaintext header is not read, displayed, or required by any recovery surface.

If Phase 2 multi-vault or sync introduces a meaningful UX role for the account number during recovery, a new `decisions.md` entry MUST supersede this section.

> **Forward pointer — superseded for multi-vault (`decisions.md` 2026-06-09 "Multi-vault recovery: vault-selection = pick-from-list + optional account-number selector", supersedes 2026-05-01 — Recovery flow spec (S3)).** With multiple vaults present, recovery activates the account-number's *optional selector* role: the user **may** type their account number to match `account_number_hash` against on-disk `vault.meta` headers and jump straight to that vault — **never required** (the primary path is the vault picker reused from onboarding; the 24-word phrase remains the sole recovery secret). This selects *which* `vault.meta` the unchanged §3–§4 pipeline reads; it does **not** change the KDF, the AAD, or how `account_number_hash` binds the Argon2id salts. The single-vault statement above stays accurate; the supersession lives in `decisions.md` (audit trail).

---

## 6. Cross-references

- **`protocol.md` §3.1** — dual-credential wrap pattern; the cryptographic basis for password and recovery being independent paths to the same `root_key`.
- **`protocol.md` §7.1** — phrase format (24 BIP-39 English words, 256 bits of entropy + 8-bit checksum).
- **`protocol.md` §7.2** — phrase generation at vault creation; mandates a confirmation flow stronger than a checkbox (§2.3 is the realization).
- **`protocol.md` §7.3** — recovery-time decrypt; non-distinguishing single error; mandatory password reset (§3.4 + §4 are the realizations).
- **`protocol.md` §7.4** — phrase normalization (NFKD + lowercase + trim).
- **`protocol.md` §7.5** — what the phrase does NOT do; the rationale anchor for the recovery-flow's "no server-side recovery hint" posture.
- **`protocol.md` §9.3** — `vault.meta` layout; the atomicity-load-bearing surface for §4.2.
- **`threat-model.md` AS11** — recovery phrase as critical secret; user offline storage only; never on server.
