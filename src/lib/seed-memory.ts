// The reviewed vault seed's IPC surface (myne-md/myne#915).
//
// **A dedicated job, not an agent run.** The host projects the vault tree,
// asks the model for distilled entries, optionally reads the folders the model
// asked for, and returns candidates for review. Nothing is written here: the
// apply is a separate, explicit command after the user has read every line.
//
// Types mirror `src-tauri/src/plugins/local_inference/seed_memory.rs` and the
// `memory_seed_apply` additions to `myne-core`'s memory plugin. Hand-maintained
// like every other binding in this tree.

import { Channel, invoke } from "../platform/core";

/** Mirror of Rust `SeedError` (serde `tag = "kind", content = "detail"`). */
export type SeedErrorKind =
  | "AiDisabled"
  | "SlotNotUnlocked"
  | "JobBusy"
  | "RemoteConsentRequired"
  | "VaultUnreadable"
  | "Engine"
  | "MalformedOutput"
  | "Cancelled"
  | "NoBodiesReadable";

export interface SeedError {
  kind: SeedErrorKind;
  detail?: unknown;
}

/** Mirror of Rust `SeedStatus`: the counts the Memory row shows. */
export interface SeedStatus {
  notes: number;
  folders: number;
  tags: number;
  /** Live rows carrying `origin: "seed"`. */
  seedEntries: number;
  /** Newest seed row's creation time (epoch millis), or null before a seed. */
  seededAt: number | null;
  provider: string;
  remote: boolean;
}

/** Mirror of Rust `SeedPayload`: the tree phase one will send. */
export interface SeedPayload {
  notes: number;
  folders: number;
  tags: number;
  excludedNotes: number;
  titlesOmitted: number;
  payload: string;
  chars: number;
}

export interface SeedCandidate {
  text: string;
}

export interface SeedResult {
  candidates: SeedCandidate[];
  notesRead: number;
  foldersRead: string[];
}

/** Mirror of Rust `SeedProgress`. */
export interface SeedProgress {
  phase: "projecting" | "asking" | "reading" | "finalizing" | string;
  done: number;
  total: number;
}

/** Mirror of Rust `SeedCandidateRefusal`. */
export type SeedCandidateRefusal = "empty" | "textTooLong" | "scanRejected";

/** Mirror of Rust `SeedApplyOutcome`. */
export interface SeedApplyOutcome {
  ids: string[];
  replaced: number;
  liveCount: number;
}

/** The status the Memory row and the card gate on. */
export async function seedMemoryStatus(): Promise<SeedStatus> {
  return await invoke<SeedStatus>("plugin:local-inference|seed_memory_status");
}

/** The exact tree payload phase one sends, for the scope screen. */
export async function seedMemoryPayload(): Promise<SeedPayload> {
  return await invoke<SeedPayload>("plugin:local-inference|seed_memory_payload");
}

/**
 * Run the two-phase seed. `jobId` is minted by the caller so a cancel can name
 * the run before this call resolves; `remoteConsent` is checked host-side, so a
 * caller that skipped the screen is refused rather than trusted.
 */
export async function seedMemoryGenerate(
  jobId: string,
  remoteConsent: boolean,
  onProgress?: (progress: SeedProgress) => void,
): Promise<SeedResult> {
  const channel = new Channel<SeedProgress>();
  if (onProgress !== undefined) channel.onmessage = onProgress;
  return await invoke<SeedResult>("plugin:local-inference|seed_memory_generate", {
    jobId,
    remoteConsent,
    onProgress: channel,
  });
}

/** Ask the running job to stop. The host discards anything it has not returned. */
export async function seedMemoryCancel(jobId: string): Promise<void> {
  await invoke("plugin:local-inference|seed_memory_cancel", { jobId });
}

/**
 * Write the reviewed batch. `replaceExisting` tombstones the previous seed rows
 * in the same catalog write, so a rebuild replaces rather than doubles.
 */
export async function memorySeedApply(
  candidates: string[],
  replaceExisting: boolean,
): Promise<SeedApplyOutcome> {
  return await invoke<SeedApplyOutcome>("plugin:memory|memory_seed_apply", {
    candidates,
    replaceExisting,
  });
}

/** The staleness thresholds, named once (the design session's values). */
export const SEED_STALE_COOLDOWN_DAYS = 14;
export const SEED_STALE_RATIO = 0.25;
/** A floor, not a rate: a three-note vault has nothing to distil. */
export const SEED_SUGGEST_MIN_NOTES = 10;

/**
 * Whether a seed is old enough and the vault has moved enough to mention it.
 *
 * Derived rather than stored: the seed date is the newest seed row's
 * `created_at`, and "the vault changed" is the share of live notes whose
 * `updatedAt` is newer than that. No preference field and no fingerprint, so
 * there is no second copy of a fact the rows already carry. The result is
 * informational only; nothing re-runs.
 */
export function isSeedStale(
  seededAt: number | null,
  notes: ReadonlyArray<{ updatedAt: Date | null }>,
  now: number = Date.now(),
): boolean {
  if (seededAt === null) return false;
  if (now - seededAt < SEED_STALE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000) return false;
  const dated = notes.filter((n) => n.updatedAt !== null);
  if (dated.length === 0) return false;
  const changed = dated.filter((n) => n.updatedAt!.getTime() > seededAt).length;
  return changed / dated.length >= SEED_STALE_RATIO;
}

