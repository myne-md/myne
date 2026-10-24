// The web client's `personAccount` module.
//
// # Two halves, and they are not the same shape
//
// **The IDENTITY plane is REAL here since myne-md/myne#911 task 13.** The
// commands dispatch through the Worker, and every one of them reads and writes
// through the in-memory person io (`web/wasm/src/person_io.rs`): a browser keeps
// no phrase-derived keypair and no device token at rest, so a reload asks for the
// phrase again and the phrase step's caveat says so
// (`personCredentialPersisted` is absent on this client).
//
// **The MEMBER plane is still absent** (`memberSharing`, refused in
// `web/wasm/src/capability.rs`): invites, the roster, member names and the
// device-binding map all need a group key and a signed roster this client does
// not carry, and their command cores are gated off wasm32 inside
// `person_account`. Those symbols exist so the shared screens that import them
// still bundle and type-check; reads answer a neutral value and mutators throw a
// typed refusal, which is the honest shape for a feature this client does not
// have.
//
// # Why the identity wrappers are spelled out here rather than re-exported
//
// `web/vite.config.ts` aliases this module path EXACTLY, so
// `web/src/lib/personAccount.ts` REPLACES `src/lib/personAccount.ts` in the web
// build and an import of the shared file from here resolves back to this one (a
// `TS2303` circular-alias error, which is how this file learned that). The
// wrappers below are the shared ones' shape, one invoke each, and the two files
// must agree: a field added to a view on one side and not the other is a drift
// the shared component tree cannot see. The types are what a reviewer should diff.

import { invoke } from "../../src/platform/core";

// ── The identity plane ──────────────────────────────────────────────────────

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

/** The three-state account lifecycle (myne-md/myne#911 task 4). */
export type PersonAccountState = "reserved" | "pending" | "enrolled";

/** Whether this device holds a person account, and whose it is. */
export interface PersonStatusView {
  enrolled: boolean;
  /** The three-state lifecycle; `null` when there is no identity. */
  state: PersonAccountState | null;
  identity_unlocked: boolean;
  person_id_hex: string | null;
  identity_code: string | null;
  sealed_keypair_present: boolean;
}

/** Mirrors the Rust `PersonJoinView` (myne-md/myne#911 task 9). */
export interface PersonJoinView {
  /** The person this device now belongs to, 32 lowercase hex. */
  person_id_hex: string;
  /** False while the device waits for an existing device to approve it. */
  approved: boolean;
}

/** One vault the person account is bound to. */
export interface PersonVaultRow {
  account_hash_hex: string;
  role: "owner" | "member";
  vault_id: string | null;
}

export async function personStatus(): Promise<PersonStatusView> {
  return invoke<PersonStatusView>("plugin:sync|sync_person_status");
}

export async function personSetup(phrase?: string): Promise<PersonSetupView> {
  return invoke<PersonSetupView>("plugin:sync|sync_person_setup", {
    phrase: phrase ?? null,
  });
}

export async function personRegister(phrase: string): Promise<PersonSetupView> {
  return invoke<PersonSetupView>("plugin:sync|sync_person_register", { phrase });
}

/** The browser's sync-server configuration, as the register dialog states it. */
export interface SyncEndpointConfig {
  endpoint_url: string | null;
  invite_code: string | null;
}

/**
 * The sync endpoint and its admission code, as this browser holds them.
 *
 * The twin of the shared module's wrapper (2026-10-23; the code returned too on
 * 2026-10-24, when the register dialog started naming the server it writes the
 * identity to): this client's endpoint is fixed by the deployment, so the read
 * usually answers it rather than `null`, and a gated deployment's admission code
 * is shown in the same row so the dialog can carry it.
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
 * Point this browser at a sync server. `inviteCode: null` PRESERVES a stored
 * admission code; the backend reads `Some("")` as an explicit clear, and the
 * shared module's docblock carries the whole reason.
 */
export async function writeSyncEndpoint(
  endpointUrl: string,
  inviteCode: string | null = null,
): Promise<void> {
  await invoke("plugin:sync|sync_set_endpoint", { endpointUrl, inviteCode });
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

export async function personClaimDevice(): Promise<PersonJoinView> {
  return invoke<PersonJoinView>("plugin:sync|sync_person_claim_device");
}

export async function personListVaults(): Promise<PersonVaultRow[]> {
  return invoke<PersonVaultRow[]>("plugin:sync|sync_person_list_vaults");
}

// ── The member plane: neutral reads, refused writes ─────────────────────────

export async function memberVaultStatus(_vaultId: string): Promise<boolean> {
  return false;
}

export async function personUnlockMemberVault(_vaultId: string, _phrase: string): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export type MemberUnlockMethod = "password" | "pin" | "biometric";

export async function memberUnlockStatus(
  _vaultIdHex: string,
): Promise<MemberUnlockMethod | null> {
  return null;
}

export async function setMemberPassword(_password: string): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function setMemberPin(_pin: string): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function setMemberBiometric(): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function clearMemberUnlock(): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export interface InviteSummary {
  invite_id_hex: string;
  vault_account_hash_hex: string;
  claimed: boolean;
}

export async function personListInvites(): Promise<InviteSummary[]> {
  return [];
}

export interface AcceptedInviteView {
  vault_id: string;
  vault_account_hash_hex: string;
  owner_fingerprint_hex: string;
  group_key_epoch: number;
}

export async function personAcceptInvite(
  _inviteIdHex: string,
  _ownerCode: string,
  _phrase: string,
  _password: string,
): Promise<AcceptedInviteView> {
  throw new Error("member vaults are unavailable on web");
}

export async function personJoinVault(
  _inviteIdHex: string,
  _vaultAccountHashHex: string,
  _phrase: string,
  _password: string,
): Promise<AcceptedInviteView> {
  throw new Error("member vaults are unavailable on web");
}

export async function personUnlockMemberVaultWithPassword(
  _vaultIdHex: string,
  _password: string,
): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function personUnlockMemberVaultWithPin(
  _vaultIdHex: string,
  _pin: string,
): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}

export async function personUnlockMemberVaultWithBiometric(
  _vaultIdHex: string,
): Promise<void> {
  throw new Error("member vaults are unavailable on web");
}
