// Mobile person-account bindings (myne-md/myne#768).
//
// A 1:1 port of the desktop `src/lib/personAccount.ts` over the mobile-registered
// `sync` plugin. The commands are the SAME ones the desktop client calls, so the
// identity a phone creates is the identity a laptop sees: one person account,
// keyed by `person_id_hash`, addressable for invites.
//
// Secret discipline: the phrase is passed per-call straight to IPC and is never
// parked in module or hook state. `personSetup()` with no phrase GENERATES a
// phrase and returns it once; `personSetup(phrase)` recovers an existing
// identity. `memberVaultStatus` / `personUnlockMemberVault` are the member-vault
// doors, where the credential is the person's own recovery phrase, never a vault
// phrase (`design-notes/protocol/0606`).

import { invoke } from "../platform/core";

/** The identity-only setup result, as the backend serializes it. */
export interface PersonSetupView {
  /** Non-null ONLY when this call generated a new identity. */
  phrase: string | null;
  fingerprint_hex: string;
  person_id_hex: string;
  /** The out-of-band identity code an owner pastes to invite this person. */
  identity_code: string;
  /** False when a second password-path device is awaiting approval. */
  approved: boolean;
}

/** Create a vault-less identity, or recover one from its phrase. */
export function personSetup(phrase?: string): Promise<PersonSetupView> {
  return invoke<PersonSetupView>("plugin:sync|sync_person_setup", {
    phrase: phrase ?? null,
  });
}

/**
 * The account lifecycle (myne-md/myne#911). `null` means this device holds no
 * identity at all. Mirrors the desktop shape so the two clients cannot disagree
 * about what a status payload means.
 */
export type PersonAccountState = "reserved" | "pending" | "enrolled";

/** Whether this device holds a person account, and whose it is. Device-local. */
export interface PersonStatusView {
  enrolled: boolean;
  /** The three-state lifecycle; `null` when there is no identity. */
  state: PersonAccountState | null;
  identity_unlocked: boolean;
  person_id_hex: string | null;
  identity_code: string | null;
  /** True when a recoverable sealed keypair exists even with no token
   *  (myne-md/myne#780). `enrolled` can be false while this is true, and in
   *  that state Create cannot open the sealed frame it did not write. */
  sealed_keypair_present: boolean;
}

export function personStatus(): Promise<PersonStatusView> {
  return invoke<PersonStatusView>("plugin:sync|sync_person_status");
}

export function personRegister(phrase: string): Promise<PersonSetupView> {
  return invoke<PersonSetupView>("plugin:sync|sync_person_register", { phrase });
}

/**
 * The person's account number, in canonical form, or `null` when this device
 * holds no identity (myne-md/myne#911 review).
 *
 * Derived from the person id, so it needs no phrase and no network. Format it
 * for display with `@myne/client-core`'s `formatPersonAccountNumber`, which is
 * the one place the `MY-` grouping lives on the client side.
 */
export async function personAccountNumber(): Promise<string | null> {
  return invoke<string | null>("plugin:sync|sync_person_account_number");
}

/** Mirrors the Rust `PersonJoinView` (myne-md/myne#911 task 9). */
export interface PersonJoinView {
  /** The person this device now belongs to, 32 lowercase hex. It equals the id
   *  the QR carried: a phrase for anyone else is refused (`PersonMismatch`). */
  person_id_hex: string;
  /** False while the device waits for an existing device to approve it. */
  approved: boolean;
}

/**
 * Admit THIS device to a person's account from a scanned person QR and the
 * phrase (myne-md/myne#911 task 9, wired on this client by task 12).
 *
 * The phrase crosses IPC once, exactly as the identity-unlock path does. The
 * device lands PENDING rather than approved: an existing device has to approve
 * it, which is what stops a stolen phrase from attaching a device by itself
 * (story 16).
 */
export function personJoinDevice(
  personIdHex: string,
  endpointUrl: string,
  phrase: string,
): Promise<PersonJoinView> {
  return invoke<PersonJoinView>("plugin:sync|sync_person_join_device", {
    personIdHex,
    endpointUrl,
    phrase,
  });
}

/**
 * Finish a pending device's enrolment once an existing device has approved it.
 *
 * Re-runs the same handshake with the session's cached derived secret, so no
 * phrase is entered a second time. `PersonSessionRequired` means the session (or
 * the app) ended in between and only the phrase can restart it.
 */
export function personClaimDevice(): Promise<PersonJoinView> {
  return invoke<PersonJoinView>("plugin:sync|sync_person_claim_device");
}

/** One vault the person account is bound to (mirrors the Rust `PersonVaultRow`). */
export interface PersonVaultRow {
  vault_id: string | null;
  account_hash_hex: string;
  role: string;
}

/**
 * List the account's vaults and materialise each one's FRAME locally, so the
 * picker can show a vault this device has never opened. Opening one still asks
 * for that vault's password: the join installs no key material.
 */
export function personListVaults(): Promise<PersonVaultRow[]> {
  return invoke<PersonVaultRow[]>("plugin:sync|sync_person_list_vaults");
}

/**
 * Drop the backend-held person identity. `forget` also erases the device-local
 * sealed keypair and the device-scoped token (myne-md/myne#780): the first-run
 * flow uses it to clear an identity this device already holds so a fresh create
 * can proceed.
 */
export function personLock(forget = false): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_lock", { forget });
}

/** One invite addressed to this person. The payload is not here; only a claim
 *  releases it. */
export interface InviteSummary {
  invite_id_hex: string;
  vault_account_hash_hex: string;
  claimed: boolean;
}

export function personListInvites(): Promise<InviteSummary[]> {
  return invoke<InviteSummary[]>("plugin:sync|sync_person_list_invites");
}

/** Claim an invite and materialize the member vault.
 *
 * `password` is REQUIRED, and becomes the vault's device-local fast credential
 * (`vault.member-unlock`), written as part of installing the member session
 * (myne-md/myne#851 task 7). It is this device's password, not the vault owner's.
 * Both clients collect it in their own accept form: desktop's `IdentityHome` and
 * the phone's `IdentityFlow` accept step (myne-md/myne#851 task 14). */
export function personAcceptInvite(
  inviteIdHex: string,
  ownerCode: string,
  phrase: string,
  password: string,
): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_accept_invite", {
    inviteIdHex,
    ownerCode,
    phrase,
    password,
  });
}

/** Join a vault this identity ALREADY belongs to onto THIS device.
 *
 * The second-device path (myne-md/myne#852 task 7), and the reason it is a second
 * command rather than a flag on the accept. The accept is addressed to a person
 * who is not yet a member: it collects the owner's identity code out of band and
 * verifies the group package against THAT. A member's second device has no
 * out-of-band code and must not be given one, so the owner it verifies against is
 * the one its own per-`(person, vault)` profile already pins
 * (`decisions/protocol/0675`), read from the person plane before anything is
 * claimed. Hence no `ownerCode` here, and `vaultAccountHashHex` on its own, so the
 * pinned owner is resolved for the named vault before the re-claim.
 *
 * `inviteIdHex` comes from the recipient-scoped invite list, which INCLUDES claimed
 * rows: a re-claim by the invite's own recipient is idempotent
 * (`decisions/protocol/0672`) and mints a fresh per-vault membership token.
 *
 * `phrase` is this person's OWN recovery phrase, never a vault password a member
 * never had (`decisions/protocol/0606`). `password` is REQUIRED and becomes this
 * device's member-unlock credential; it is not the owner's password.
 *
 * Typed `void` like its sibling above rather than the desktop's
 * `AcceptedInviteView`: the shell re-probes after the call and this client's accept
 * has never returned the view, so a return shape here would have no reader.
 */
export function personJoinVault(
  inviteIdHex: string,
  vaultAccountHashHex: string,
  phrase: string,
  password: string,
): Promise<void> {
  return invoke<void>("plugin:sync|sync_member_join_vault", {
    inviteIdHex,
    vaultAccountHashHex,
    phrase,
    password,
  });
}

/** Whether this vault is a member vault (unlocked by the person phrase). */
export function memberVaultStatus(vaultId: string): Promise<boolean> {
  return invoke<boolean>("plugin:sync|sync_member_vault_status", { vaultId });
}

/** Re-unlock a member vault from the person's own recovery phrase. */
export function personUnlockMemberVault(vaultId: string, phrase: string): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_unlock_member_vault", {
    vaultId,
    phrase,
  });
}

/** The configured member-vault fast-unlock method, or null. */
export type MemberUnlockMethod = "password" | "pin" | "biometric";

/** The configured member-vault fast-unlock method, or null. */
export function memberUnlockStatus(vaultIdHex: string): Promise<MemberUnlockMethod | null> {
  return invoke<MemberUnlockMethod | null>("plugin:sync|sync_member_unlock_status", {
    vaultIdHex,
  });
}

/** Set (or replace) the device-local member vault password. Active member vault
 *  + held person session required; the phrase remains the portable fallback. */
export function setMemberPassword(password: string): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_set_member_password", { password });
}

/** Set (or replace) the device-local member vault PIN (replaces other methods). */
export function setMemberPin(pin: string): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_set_member_pin", { pin });
}

/** Set (or replace) the member vault biometric credential (Apple only). */
export function setMemberBiometric(): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_set_member_biometric");
}

/** Remove the device-local member fast-unlock credential for the active vault. */
export function clearMemberUnlock(): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_clear_member_unlock");
}

/** Re-unlock a member vault from its device-local password. */
export function personUnlockMemberVaultWithPassword(
  vaultIdHex: string,
  password: string,
): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_unlock_member_vault_with_password", {
    vaultIdHex,
    password,
  });
}

/** Re-unlock a member vault from its device-local PIN. */
export function personUnlockMemberVaultWithPin(
  vaultIdHex: string,
  pin: string,
): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_unlock_member_vault_with_pin", {
    vaultIdHex,
    pin,
  });
}

/** Re-unlock a member vault from its device-local biometric credential. */
export function personUnlockMemberVaultWithBiometric(vaultIdHex: string): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_unlock_member_vault_with_biometric", {
    vaultIdHex,
  });
}
