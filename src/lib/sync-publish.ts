// Publishing a vault to the sync server (myne-md/myne#911 task 8).
//
// The explicit act that turns a device-only vault into a server vault. Two
// things happen, and the backend owns both: the vault's metadata is PUT under the
// identity this device holds (the server records the owner on its first write),
// and the vault's namespace is recorded locally so every later sync request can
// address it.
//
// It is deliberately NOT part of creation: a vault is usable the moment it
// exists, and uploading is a decision the user makes afterwards. A published
// vault says so; an unpublished one says "device only"; a failed publish leaves
// the vault exactly as usable as it was and can be retried.

import { invoke } from "../platform/core";

/** Mirrors the Rust `PublishOutcome`. */
export interface PublishOutcome {
  /** The vault's server namespace, lowercase hex. */
  namespace_hex: string;
  /**
   * `true` when this call did the work, `false` when the vault was already
   * published. The surface says "already published" rather than claiming a
   * second upload.
   */
  newly_published: boolean;
}

/** The error kinds `sync_publish_vault` can reject with, as the surface needs
 *  them distinguished. Each names a different remedy:
 *
 *  - `NotConfigured` → set an endpoint (Settings → Sync).
 *  - `PersonSessionRequired` → unlock the identity; the vault is person-born and
 *    publishing needs a credential that names the person.
 *  - `PersonNotRegistered` → register the identity; it holds no server token yet.
 *  - `NotEnrolled` → the vault is legacy and this device was never enrolled on it.
 *  - `NotOwner` → this vault already belongs to another person.
 *  - `Unauthenticated` / `Transport` / `TlsFailure` → retryable once fixed.
 */
export type PublishErrorKind =
  | "NotConfigured"
  | "PersonSessionRequired"
  | "PersonNotRegistered"
  | "NotEnrolled"
  | "NotOwner"
  | "Unauthenticated"
  | "Transport"
  | "TlsFailure"
  | "BadRequest"
  | "Other";

export function publishErrorKind(error: unknown): PublishErrorKind {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  switch (kind) {
    case "NotConfigured":
    case "PersonSessionRequired":
    case "PersonNotRegistered":
    case "NotEnrolled":
    case "NotOwner":
    case "Unauthenticated":
    case "Transport":
    case "TlsFailure":
    case "BadRequest":
      return kind;
    default:
      return "Other";
  }
}

/** Publish this vault. Idempotent: a second call reports `newly_published: false`. */
export function publishVault(): Promise<PublishOutcome> {
  return invoke<PublishOutcome>("plugin:sync|sync_publish_vault");
}

/** Mirrors the Rust `PublishState` (myne-md/myne#911 task 8). */
export interface PublishState {
  /** `true` when this vault is reachable on a server. `false` is "device only". */
  published: boolean;
  /** The namespace publish recorded, lowercase hex. `null` for a legacy vault. */
  namespace_hex: string | null;
  /** Epoch-ms of the publish performed on this device, if any. */
  published_at_ms: number | null;
  /**
   * `true` for a vault born under an identity (`NTV7`). Its credential is the
   * person session, so the legacy "add this device with an account number" form
   * does not apply to it and publishing is the only way it reaches a server.
   */
  person_born: boolean;
}

/**
 * The DURABLE publish state of the active vault.
 *
 * The panel used to learn this from its own last click, so a published vault read
 * "device only" again after a restart. This reads the recorded state instead, and
 * it is also the surface's gate: a client that does not answer this command (the
 * browser, and mobile until its person plane lands) does not offer publishing.
 */
export function readPublishState(): Promise<PublishState> {
  return invoke<PublishState>("plugin:sync|sync_published_state");
}
