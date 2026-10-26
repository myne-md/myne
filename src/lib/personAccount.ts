// SPDX-License-Identifier: AGPL-3.0
// Identity-only setup binding (myne-md/myne#711, b2b-member-sync).
//
// One invoke. The recovery phrase is the only secret that crosses this
// boundary, and only at the same ceremony moment vault creation shows one:
// `personSetup()` with no phrase GENERATES a phrase and returns it once for the
// user to write down; `personSetup(phrase)` recovers an existing identity.
//
// The command registers a person-level server account under `person_id_hash`
// and stores the per-device token device-scoped; no vault is created.
import { invoke } from "../platform/core";

export const PERSON_ACCOUNT_ABSENCE_MARKER = "person-account-binding";

/**
 * The identity-only setup result, as the backend serializes it.
 *
 * `phrase` is non-null ONLY when this call generated a new identity. Response
 * fields are snake_case: `#[tauri::command]` renames ARGUMENTS to camelCase, but
 * a returned struct serializes via serde's default (the field names verbatim),
 * the same convention `PersonIdentityView` in `src/lib/invite.ts` follows.
 */
export interface PersonSetupView {
  phrase: string | null;
  fingerprint_hex: string;
  person_id_hex: string;
  /** The out-of-band identity code an owner pastes to invite this person
   *  (public material only). */
  identity_code: string;
  /**
   * Always `false` on the two arms `personSetup` can take: create does not
   * register and recover does not either, so neither knows whether a device is
   * awaiting approval. Only `personRegister` computes it. A caller that needs
   * the real lifecycle reads `personStatus().state` (`reserved` / `pending` /
   * `enrolled`); the identity panel's pending note is gated on that, and gating
   * it on this field is what once told every first device it was waiting for
   * another device (myne-md/myne#911).
   */
  approved: boolean;
}

/**
 * Create a vault-less identity (no phrase) or recover one (phrase). The account
 * is registered at the configured sync endpoint; a missing endpoint is a typed
 * `NotConfigured` error the caller surfaces as "set a sync server first".
 */
export async function personSetup(phrase?: string): Promise<PersonSetupView> {
  return invoke<PersonSetupView>("plugin:sync|sync_person_setup", {
    phrase: phrase ?? null,
  });
}

/**
 * The account lifecycle (myne-md/myne#911). `null` on the status means this
 * device holds no identity at all, which is the only case Welcome is for.
 *
 * - `reserved`: a sealed identity that has never been registered. Nothing has
 *   been sent, and nothing needs to be.
 * - `pending`: registered, awaiting this device's approval (no token yet).
 * - `enrolled`: registered and holding a device token.
 */
export type PersonAccountState = "reserved" | "pending" | "enrolled";

/**
 * Register an existing identity with the configured server (myne-md/myne#911).
 *
 * The explicit act, and the phrase is the proof: it opens the sealed identity
 * this device already holds, so a wrong phrase cannot mint a second one. A
 * failure leaves the identity `reserved` and fully usable, which is why the
 * caller can offer this without a warning.
 */
export async function personRegister(phrase: string): Promise<PersonSetupView> {
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

/** The device's sync-server configuration, as the register dialog must state it. */
export interface SyncEndpointConfig {
  /** The server this device would register against today, or `null` for none. */
  endpoint_url: string | null;
  /** The stored admission code for a gated server (`MYNE_INVITE_CODE`), or
   *  `null`. Device-local, never synced, and the only copy of the word. */
  invite_code: string | null;
}

/**
 * The device-local sync endpoint and its admission code.
 *
 * Lives here, next to `personRegister`, because registration is the one person
 * act that CANNOT work without a server and the identity home is reachable at
 * zero vaults, where Settings (the endpoint's own home, `SyncPanel` →
 * `EndpointConfig`) does not exist.
 *
 * It returns the CODE as well as the address (2026-10-24): the register dialog
 * shows the server it is about to write this identity to, and a gated server's
 * code has to be in that same row, because a self-hoster who restricts
 * registration could otherwise never register from this surface at all. The
 * address alone was enough while the field only appeared as a fallback.
 */
export async function readSyncConfig(): Promise<SyncEndpointConfig> {
  const view = await invoke<SyncEndpointConfig | null>(
    "plugin:sync|sync_get_endpoint",
  );
  return {
    endpoint_url: view?.endpoint_url ?? null,
    invite_code: view?.invite_code ?? null,
  };
}

/**
 * Point this device at a sync server, before registering against it.
 *
 * The host validates the address and its TLS trust as part of the write, so a
 * failure here is the honest "that server is not reachable" rather than a
 * refusal to register.
 *
 * `inviteCode` defaults to `null` on purpose: the backend reads `None` as "I
 * know nothing about the admission code, preserve what is stored" and `Some("")`
 * as an EXPLICIT CLEAR (`core/src/plugins/sync/config.rs::resolve_invite_code`).
 * A caller that only wants to change the address must not erase a gated server's
 * code, which is the only copy of the admission word and cannot be re-derived.
 */
export async function writeSyncEndpoint(
  endpointUrl: string,
  inviteCode: string | null = null,
): Promise<void> {
  await invoke("plugin:sync|sync_set_endpoint", { endpointUrl, inviteCode });
}

/** Whether this device holds a person account, and whose it is. */
export interface PersonStatusView {
  enrolled: boolean;
  /** The three-state lifecycle; `null` when there is no identity. */
  state: PersonAccountState | null;
  identity_unlocked: boolean;
  person_id_hex: string | null;
  /** The out-of-band public identity code; available while the private identity is locked. */
  identity_code: string | null;
  /**
   * Whether this device holds a recoverable sealed person keypair, even with no
   * token issued (myne-md/myne#780). `enrolled` is false in that state, so the
   * app shows Welcome, but "Create an identity" cannot open the sealed frame it
   * did not write. The first-run dialog reads this to steer to Recover or an
   * explicit forget.
   */
  sealed_keypair_present: boolean;
}

/**
 * Why the invitation list could not be produced.
 *
 * - `no-identity`: this device holds no person identity at all.
 * - `not-enrolled`: it holds one, but the server does not know it yet, so there
 *   is nothing for an owner to invite. Registering (identity home, Settings, or
 *   the invitation dialog's own door) is the act.
 * - `pending`: it is registered and waiting for this device's approval, so it has
 *   an account and no token. Registration would not help and is not offered.
 * - `error`: the relay call failed. The address is fine and a retry may work.
 *
 * It lives here rather than in the hook because three components read it
 * (`VaultPicker`, `VaultSwitcher`, `InvitesDialog`) and none of them should have
 * to import a hook module to name a state.
 */
export type InvitesUnavailable = "no-identity" | "not-enrolled" | "pending" | "error";

/** Device-local probe; no network. Drives the identity-only home. */
export async function personStatus(): Promise<PersonStatusView> {
  return invoke<PersonStatusView>("plugin:sync|sync_person_status");
}

/** One invite addressed to this person. The payload is NOT here; only a claim
 *  releases it. */
export interface InviteSummary {
  invite_id_hex: string;
  vault_account_hash_hex: string;
  claimed: boolean;
}

/** List the invites addressed to this person account (sealed relay). */
export async function personListInvites(): Promise<InviteSummary[]> {
  return invoke<InviteSummary[]>("plugin:sync|sync_person_list_invites");
}

/**
 * Refuse an invitation addressed to this identity.
 *
 * The server DROPS the sealed payload, so the invitation can never be claimed and
 * the sender's own list reports it declined instead of "not accepted yet". It is
 * a real delete rather than a client-side hide, which is what makes "decline"
 * mean something to the person who sent it (myne-md/myne#911 follow-up).
 *
 * Refused `DeviceNotFound` for an id this identity does not hold, and
 * `BadRequest` once the invitation has already been accepted: ending that
 * membership is the owner's removal, not a declined invitation.
 */
export async function personDeclineInvite(inviteIdHex: string): Promise<void> {
  return invoke<void>("plugin:sync|sync_person_decline_invite", { inviteIdHex });
}

/** What a successful acceptance reports: public fields only. */
export interface AcceptedInviteView {
  vault_id: string;
  vault_account_hash_hex: string;
  owner_fingerprint_hex: string;
  group_key_epoch: number;
}

/**
 * Accept a sealed invite: claim it, verify the owner's group package against
 * the owner's identity code (public halves, obtained out of band), and unlock
 * the shared vault as a Member.
 *
 * `password` is REQUIRED and becomes the vault's device-local fast credential
 * (`vault.member-unlock`), written as part of installing the member session. It
 * is this device's password, not the vault owner's, and the recovery phrase stays
 * the portable fallback (myne-md/myne#851 task 7). The command checks the project
 * floor before it claims anything, so a short password cannot leave a claimed
 * invite behind.
 */
export async function personAcceptInvite(
  inviteIdHex: string,
  ownerCode: string,
  phrase: string,
  password: string,
): Promise<AcceptedInviteView> {
  return invoke<AcceptedInviteView>("plugin:sync|sync_person_accept_invite", {
    inviteIdHex,
    ownerCode,
    phrase,
    password,
  });
}

/**
 * Join a vault this identity ALREADY belongs to onto THIS device.
 *
 * The second-device path (myne-md/myne#852 task 7), and the reason it is a second
 * command rather than a flag on the accept. The accept is addressed to a person who
 * is not yet a member: it collects the owner's identity code out of band and verifies
 * the group package against THAT. A member's second device has no out-of-band code
 * and must not be given one: the owner it verifies against is the one its own
 * per-`(person, vault)` profile already pins (`decisions/protocol/0675`), read from
 * the person plane before anything is claimed. Hence no `ownerCode` here, and
 * `vaultAccountHashHex` on its own, so the pinned owner can be resolved for the named
 * vault before the re-claim.
 *
 * `inviteIdHex` comes from the recipient-scoped invite list, which INCLUDES claimed
 * rows: a re-claim by the invite's own recipient is idempotent
 * (`decisions/protocol/0672`) and mints a fresh per-vault membership token.
 *
 * `phrase` is this person's OWN recovery phrase, never a vault password a member
 * never had (`decisions/protocol/0606`). `password` is REQUIRED and becomes this
 * device's member-unlock credential; it is not the owner's password.
 */
export async function personJoinVault(
  inviteIdHex: string,
  vaultAccountHashHex: string,
  phrase: string,
  password: string,
): Promise<AcceptedInviteView> {
  return invoke<AcceptedInviteView>("plugin:sync|sync_member_join_vault", {
    inviteIdHex,
    vaultAccountHashHex,
    phrase,
    password,
  });
}

/** Whether a vault is a member vault (has a device-local member-key store), so
 *  the Unlock surface asks for the recovery phrase instead of a password. */
export async function memberVaultStatus(vaultIdHex: string): Promise<boolean> {
  return invoke<boolean>("plugin:sync|sync_member_vault_status", {
    vaultIdHex,
  });
}

/** Re-unlock a member vault from the recovery phrase. */
export async function personUnlockMemberVault(
  vaultIdHex: string,
  phrase: string,
): Promise<void> {
  return invoke("plugin:sync|sync_person_unlock_member_vault", {
    vaultIdHex,
    phrase,
  });
}

/** The configured member-vault fast-unlock method, or null. */
export type MemberUnlockMethod = "password" | "pin" | "biometric";

/**
 * The configured member-vault fast-unlock method, or `null`, so the Unlock
 * surface offers the right credential instead of the recovery phrase.
 */
export async function memberUnlockStatus(
  vaultIdHex: string,
): Promise<MemberUnlockMethod | null> {
  return invoke<MemberUnlockMethod | null>("plugin:sync|sync_member_unlock_status", {
    vaultIdHex,
  });
}

/**
 * Set (or replace) the device-local member vault password. Requires the active
 * vault to be an unlocked member vault holding the person session: the store
 * seals the vault keys AND the person keypair, so a later password unlock is as
 * complete as a phrase one. Replaces a PIN/biometric credential. The recovery
 * phrase stays the portable fallback.
 */
export async function setMemberPassword(password: string): Promise<void> {
  return invoke("plugin:sync|sync_person_set_member_password", { password });
}

/** Set (or replace) the device-local member vault PIN (replaces other methods). */
export async function setMemberPin(pin: string): Promise<void> {
  return invoke("plugin:sync|sync_person_set_member_pin", { pin });
}

/** Set (or replace) the device-local member vault biometric credential (Apple only). */
export async function setMemberBiometric(): Promise<void> {
  return invoke("plugin:sync|sync_person_set_member_biometric");
}

/** Remove the device-local member fast-unlock credential for the active vault. */
export async function clearMemberUnlock(): Promise<void> {
  return invoke("plugin:sync|sync_person_clear_member_unlock");
}

/** Re-unlock a member vault from its device-local password. */
export async function personUnlockMemberVaultWithPassword(
  vaultIdHex: string,
  password: string,
): Promise<void> {
  return invoke("plugin:sync|sync_person_unlock_member_vault_with_password", {
    vaultIdHex,
    password,
  });
}

/** Re-unlock a member vault from its device-local PIN. */
export async function personUnlockMemberVaultWithPin(
  vaultIdHex: string,
  pin: string,
): Promise<void> {
  return invoke("plugin:sync|sync_person_unlock_member_vault_with_pin", {
    vaultIdHex,
    pin,
  });
}

/** Re-unlock a member vault from its device-local biometric credential. */
export async function personUnlockMemberVaultWithBiometric(
  vaultIdHex: string,
): Promise<void> {
  return invoke("plugin:sync|sync_person_unlock_member_vault_with_biometric", {
    vaultIdHex,
  });
}

/**
 * What a scanned person QR plus the 24 words produced (myne-md/myne#911 task 9).
 * Mirrors the Rust `PersonJoinView`.
 */
export interface PersonJoinView {
  /** The person this device now belongs to, 32 lowercase hex. It equals the id
   *  the QR carried: a phrase for anyone else is refused (`PersonMismatch`). */
  person_id_hex: string;
  /** False while the device waits for an existing device to approve it. */
  approved: boolean;
}

/**
 * Admit THIS device to a person's account from a scanned person QR and the
 * phrase (myne-md/myne#911 task 9).
 *
 * The phrase crosses IPC once, exactly as the identity-unlock path does. The
 * device lands `pending` in the ordinary case: one QR and one phrase admit it
 * only after an existing device approves it, which is what a stolen phrase alone
 * cannot do.
 */
export async function personJoinDevice(
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
 * Finish a pending device's enrolment once it has been approved.
 *
 * Polls the same handshake with the session's cached derived secret, so no
 * phrase is entered a second time. Answers `approved: false` until the approval
 * lands; `PersonSessionRequired` means the session (or the app) was restarted
 * between the two acts, and the phrase has to be entered again.
 */
export async function personClaimDevice(): Promise<PersonJoinView> {
  return invoke<PersonJoinView>("plugin:sync|sync_person_claim_device");
}

/**
 * One vault the person account is bound to (myne-md/myne#911 task 9). Mirrors the
 * Rust `PersonVaultRow`.
 *
 * `vault_id` is present once this device holds a container for it: the listing
 * writes each vault's FRAME, so the picker shows the vault and opening it still
 * asks for that vault's password. `null` means the frame could not be fetched
 * (the account is bound to it, this device just does not hold it yet).
 */
export interface PersonVaultRow {
  /** The vault's namespace, 32 lowercase hex. Public: it is the vault's server
   *  address and the value its own frame carries. */
  account_hash_hex: string;
  /** `"owner"` or `"member"`, the binding's role. */
  role: "owner" | "member";
  /** The local `VaultId` once a container exists here. */
  vault_id: string | null;
}

/**
 * List every vault the account is bound to, writing a local frame for each one
 * this device does not hold yet (myne-md/myne#911 task 9).
 *
 * Listing only. No password is asked for, no key is installed, and no content is
 * downloaded: each listed vault opens later with its own password, and sync
 * pulls the corpus after that.
 */
export async function personListVaults(): Promise<PersonVaultRow[]> {
  return invoke<PersonVaultRow[]>("plugin:sync|sync_person_list_vaults");
}
