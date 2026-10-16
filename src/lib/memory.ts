// Agent-memory + personality command wrappers (myne-md/myne#697): the TS mirror
// of the `memory` Tauri plugin (`myne-core::plugins::memory`, surfaced on
// desktop by `src-tauri/src/plugins/memory/` and on mobile by its shim).
// Memory entries are VAULT CONTENT: the `vault.agent-memory` `MYN1` catalog
// singleton + one `MYX1` file per entry under `memories/` (protocol.md § 9.25 /
// § 9.26), synced and backed up; the `vault.personality` `MYZ1` singleton rides
// the same plane (§ 9.27). Consumed by the memory UI (the settings panel, the
// chat popover) and by nothing else.
//
// No mock layer (per `src/AGENTS.md`): these call the real IPC commands. Keep
// the types in lockstep with the Rust `MemoryReadError` / `MemoryMutateError`
// serde shapes.

import { invoke } from "../platform/core";

/** Mirror of Rust `memory::error::MemoryReadError` variant tag. */
export type MemoryReadErrorKind =
  | "SlotNotUnlocked"
  | "Io"
  | "InvalidVaultMeta"
  // The `ai_enabled` opt-in is off on this device; the whole surface refuses.
  | "AiDisabled"
  // The catalog blob exists but cannot be decoded. Reported, never an empty
  // roster (§ 9.25.3 report-don't-empty): memory is user content.
  | "CatalogUnreadable"
  // An entry file failed under a live catalog row. Carries no detail: the
  // caller named the entry in its own request. The catalog row is NOT dropped
  // in response (§ 9.26.4).
  | "EntryUnreadable"
  // The named entry is tombstoned or has no catalog row.
  | "EntryNotFound"
  // The personality blob exists but cannot be decoded. Reported, never
  // collapsed to an absent personality (§ 9.27.3).
  | "PersonalityUnreadable";

/** Mirror of Rust `MemoryReadError` (serde `tag = "kind", content = "detail"`). */
export interface MemoryReadError {
  kind: MemoryReadErrorKind;
  detail?: unknown;
}

/** Mirror of Rust `memory::error::MemoryMutateError` variant tag. */
export type MemoryMutateErrorKind =
  | "SlotNotUnlocked"
  | "Io"
  | "InvalidVaultMeta"
  // The `ai_enabled` opt-in is off on this device; the whole surface refuses.
  | "AiDisabled"
  // The mutation was refused over an unreadable store (refuse-don't-wipe).
  | "CatalogUnreadable"
  | "EntryNotFound"
  // The write failed the injection scan or the schema gate (decisions/ai/0590).
  // A refused user write or update is never persisted; a refused model create
  // persists as quarantined (myne-md/myne#709, decisions/ai/0591).
  | "ScanRejected"
  | "TextTooLong"
  | "PayloadTooLarge"
  // The roster holds MAX_MEMORY_ENTRIES live entries; growth refuses.
  | "EntryLimitReached"
  // A model write named a user-authored row (myne-md/myne#709, authorship gate).
  | "ModelOverwriteRefused"
  // The write was learned from a note in an `ai_excluded_folders` folder
  // (myne-md/myne#709, write-time exclusion).
  | "ExcludedSource"
  | "RandomnessUnavailable";

/** Mirror of Rust `MemoryMutateError` (serde `tag = "kind", content = "detail"`). */
export interface MemoryMutateError {
  kind: MemoryMutateErrorKind;
  detail?: unknown;
}

/**
 * Mirror of Rust `memory::commands::MemoryEntryRow`: one catalog row. The id
 * lives in the catalog KEY on disk, not in the row; see `MemoryListRow` for
 * the read-boundary shape that carries it.
 */
export interface MemoryEntryRow {
  created_at: number;
  deleted_at?: number;
  updated_at: number;
  version: number;
  // Held for user review: tripped the injection scan on a model create, listed
  // but never injected until a user edit clears it (myne-md/myne#709).
  quarantined: boolean;
}

/** One roster row as the list command returns it: id + row. */
export interface MemoryListRow {
  id: string;
  created_at: number;
  deleted_at?: number;
  updated_at: number;
  version: number;
  quarantined: boolean;
}

/** One voice directive (§ 9.27): the standing rule text and its update time. */
export interface PersonalityDirective {
  text: string;
  updated_at: number;
}

/** Mirror of Rust `memory::commands::PersonalityView`. */
export interface PersonalityView {
  directives: PersonalityDirective[];
}

/**
 * The roster plus the cap it is bounded by (myne-md/myne#867). The cap comes
 * from the HOST rather than a constant here: it is enforced there, so a copy
 * here would be a second statement of the same number, printing a counter over
 * a denominator nothing keeps in step.
 */
export interface MemoryListView {
  rows: MemoryListRow[];
  cap: number;
}

/** List the memory roster: live rows ordered by `updated_at` desc, each with its id. */
export async function memoryList(): Promise<MemoryListView> {
  return await invoke<MemoryListView>("plugin:memory|memory_list");
}

/** Read one memory entry's text. */
export async function memoryRead(memoryIdHex: string): Promise<string> {
  return await invoke<string>("plugin:memory|memory_read", { memoryIdHex });
}

/** Add or update one memory entry (the write-time gate runs host-side). Always
 * user-authored: the host clears the provenance link on this path, so no
 * payload here can mint a model-authored row. */
export async function memoryWrite(
  text: string,
  memoryIdHex?: string,
): Promise<string> {
  return await invoke<string>("plugin:memory|memory_write", {
    text,
    ...(memoryIdHex !== undefined ? { memoryIdHex } : {}),
  });
}

/** Delete a memory entry everywhere (tombstone + file removal; idempotent). */
export async function memoryDelete(memoryIdHex: string): Promise<void> {
  await invoke("plugin:memory|memory_delete", { memoryIdHex });
}

/** Read the personality directives (absent blob = the default empty voice). */
export async function personalityRead(): Promise<PersonalityDirective[]> {
  const view = await invoke<{ directives: PersonalityDirective[] }>(
    "plugin:memory|personality_read",
  );
  return view.directives;
}

/** Whole-value replace of the personality block (user-authored only). */
export async function personalityWrite(
  directives: PersonalityDirective[],
): Promise<void> {
  await invoke("plugin:memory|personality_write", { directives });
}
