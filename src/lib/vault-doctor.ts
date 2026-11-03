// One verdict over the five facts that decide whether this device can sync
// (myne-md/myne#1003).
//
// # What this is for
//
// "Sync is not working" has five causes that look identical from a log tail, and the
// product used to answer for exactly one of them. `readVaultDoctor()` asks the backend
// for all five at once: the vault's generation, the authority (and, when it is missing,
// which half is), the device-binding row, the key at rest, and the session.
//
// # Read, not poll
//
// One call verifies the vault's roster (an ML-DSA verification), so this belongs on a
// user action: a failure appearing in the panel, or a copy-diagnostics press. Never on
// the sync status beat. Nothing in this module caches: a verdict describes one moment,
// and a stale one is worse than none.
//
// # Why the mirror is hand-written
//
// `core/src/plugins/sync/doctor.rs` serializes closed enums with pinned tokens
// (`the_report_serializes_as_closed_tokens` pins the exact JSON), and the union below
// mirrors it. Every value is a bounded token: no identifier, no path, no key material.
// That is what lets the same facts reach the diagnostics block a user pastes into a
// public issue.

import { invoke } from "../platform/core";

/** The `vault.meta` magic on disk, or the reason there is none to name. */
export type VaultGeneration =
  | "NTV5"
  | "NTV6"
  | "NTV7"
  | "NTV8"
  | "MYV1"
  | "absent"
  | "unreadable"
  | "unknown";

/**
 * Why nothing may sign this vault's head, when nothing may.
 *
 * Mirrors Rust's `AuthorityMissing` (`core/src/plugins/sync/authority/mod.rs`), whose
 * nine variants are exhaustive by design: the failure class, the log line and the
 * sentence the user reads all derive from one of these. `no_person_session` is a
 * cycle-level cause and cannot reach a report: a bound device key authors without the
 * phrase, so the report names the device instead.
 */
export type AuthorityCause =
  | "no_head_context"
  | "no_person_session"
  | "no_device_id"
  | "no_key_at_rest"
  | "key_unreadable"
  | "no_binding_row"
  | "row_names_different_key"
  | "row_unverified"
  | "key_missing_while_bound";

/**
 * What may sign this vault's head right now.
 *
 * Three of these are NOT a missing credential, and reporting them as one was the defect
 * class this verdict exists to end: a locked vault is `locked`, a frame with no signed
 * head is `not_applicable`, and an unreadable frame is `unknown` (the `generation` field
 * says why, and the cycle refuses to author anything at all on it).
 */
export type AuthorityVerdict =
  | { state: "locked" }
  | { state: "not_applicable" }
  | { state: "unknown" }
  | { state: "person_key" }
  | { state: "device_key" }
  | { state: "missing"; cause: AuthorityCause };

/** This device's `vault.device-bindings` row. `unknown` means the write was not asked. */
export type BindingState =
  | "verified"
  | "unverified"
  | "names_other_key"
  | "absent"
  | "orphaned"
  | "unknown";

/** The storage ladder's answer about the device signing key. */
export type KeyAtRestState = "present" | "absent" | "unreadable" | "unknown";

/** The session as the authority resolver saw it. `null` means the read was not reached. */
export interface SessionFacts {
  person_held: boolean | null;
  device_id_adopted: boolean | null;
}

/** The five facts, in one value. Read-only: nothing here repairs anything. */
export interface VaultDoctor {
  generation: VaultGeneration;
  authority: AuthorityVerdict;
  binding: BindingState;
  key_at_rest: KeyAtRestState;
  session: SessionFacts;
}

/**
 * The diagnosis of the ACTIVE vault, or `null` when there is no vault to diagnose.
 *
 * Dispatched on web as well as desktop (`web/wasm/src/dispatch.rs`): a browser's key at
 * rest genuinely is `absent`, and saying so is the truthful verdict rather than a
 * refusal.
 */
export function readVaultDoctor(): Promise<VaultDoctor | null> {
  return invoke<VaultDoctor | null>("plugin:sync|sync_vault_doctor");
}

/**
 * The verdict's authority half as one token, for the diagnostics block.
 *
 * Composed rather than two fields because the cause only means something beside the
 * state: `missing:no_binding_row` is one fact, and `missing` plus `no_binding_row` in two
 * lines is two facts a reader has to join. Both halves are bounded enums, so the value
 * cannot grow.
 */
export function authorityToken(authority: AuthorityVerdict): string {
  return authority.state === "missing" ? `missing:${authority.cause}` : authority.state;
}

/**
 * The session half as one token, for the diagnostics block.
 *
 * `unknown` is printed rather than omitted: a locked vault did not ask, and a report that
 * silently dropped the field would read as "no person session", which is a different
 * fact.
 */
export function sessionToken(session: SessionFacts): string {
  const held = session.person_held === null ? "unknown" : session.person_held ? "held" : "closed";
  const device =
    session.device_id_adopted === null
      ? "unknown"
      : session.device_id_adopted
        ? "adopted"
        : "none";
  return `person=${held} device=${device}`;
}
