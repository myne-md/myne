// Tauri IPC wrappers for the vault-import source commands (myne-md/myne#464).
//
// Every one of these is an `importer:` command, not a `vault-unlock:` or
// `attachments:` one, and that is load-bearing rather than tidy. The web
// dispatcher classifies the whole `importer` plugin `Class::Unsupported` and the
// mobile client omits it, so the feature adds no command surface to either and
// `check-web-command-coverage.mjs` needs no new entry. Moving any of these into
// the plugin whose SUBJECT it touches would widen a plugin the web client does
// dispatch, and would owe each command its own classification.
//
// The Rust cores live in `core/src/plugins/vault_unlock/import_source.rs` (the
// slot, the reads, the attachment re-seal) and
// `src-tauri/src/plugins/importer/source_dictionary.rs` (the added words).
// Signature drift between these wrappers and the `#[tauri::command]`
// definitions has no automated canary; keep them in lockstep by hand, the same
// standing caveat `src/lib/attachments.ts` carries.

import { invoke } from "../platform/core";
import type { VaultUnlockError } from "../types/vault-unlock-error";

/**
 * Open one of the user's other LOCAL vaults as a read-only import source.
 *
 * Exactly one credential. The Rust side refuses both-or-neither rather than
 * preferring one, because guessing is how a recovery phrase gets Argon2id'd as
 * a password.
 *
 * This is NOT an unlock. It populates a distinct, non-`Unlocked` slot keyed by
 * the SOURCE vault's id; every editor command rejects that variant at compile
 * time, and SYNC-1's at-most-one-unlocked invariant is untouched. The slot is
 * dropped by {@link importSourceClose}, by a TTL independent of the importer's
 * auto-lock hold, or by the target vault locking.
 *
 * Rejects with `VaultOpenAsImportSource` when that vault already has a source
 * open, and with `UnlockInProgress` when another Argon2id-bound auth operation
 * holds the shared permit (rejected, never queued).
 */
export async function importSourceOpen(
  sourceVaultId: string,
  credential: { password: string } | { recoveryPhrase: string },
): Promise<void> {
  await invoke<void>("plugin:importer|import_source_open", {
    sourceVaultId,
    password: "password" in credential ? credential.password : null,
    recoveryPhrase:
      "recoveryPhrase" in credential ? credential.recoveryPhrase : null,
  });
}

/**
 * Drop a source vault's key slot and zeroize it.
 *
 * Idempotent by design, so every exit path can call it (finish, cancel,
 * unmount, error) without first asking whether one is open.
 */
export async function importSourceClose(sourceVaultId: string): Promise<void> {
  await invoke<void>("plugin:importer|import_source_close", { sourceVaultId });
}

/**
 * The source vault's note ids, oldest first.
 *
 * Ids only and no decryption: one `read_dir` rather than one AEAD open per
 * note. A file whose name does not parse as a note UUID is skipped rather than
 * failing the listing, because `notes/` is the user's own directory and a stray
 * file in it is not a reason to make their vault unimportable.
 */
export async function importSourceListNotes(
  sourceVaultId: string,
): Promise<string[]> {
  return await invoke<string[]>("plugin:importer|import_source_list_notes", {
    sourceVaultId,
  });
}

/** Decrypt ONE note from the source vault and return its plaintext markdown. */
export async function importSourceReadNote(
  sourceVaultId: string,
  noteId: string,
): Promise<string> {
  return await invoke<string>("plugin:importer|import_source_read_note", {
    sourceVaultId,
    noteId,
  });
}

/** What the attachment re-seal produced in the target vault. */
export interface ResealedAttachment {
  /**
   * The id these bytes have in the TARGET vault. Different from the source's by
   * construction: the id is an HMAC keyed under the vault's own `root_key`
   * (`protocol.md` §9.9), so a fresh id falls out of the re-seal and none has to
   * be minted.
   */
  target_id: string;
  /** `true` when the target already held these exact bytes: no second blob. */
  deduplicated: boolean;
}

/**
 * Decrypt one attachment from the source vault and re-seal it under the target
 * vault's keys.
 *
 * Runs entirely host-side, so the decrypted file never crosses IPC. The
 * alternative shape, handing the bytes back here to call the ordinary
 * `attachments:attachment_import`, would marshal up to 64 MiB per attachment
 * through a JSON byte array into V8 and back for a transfer whose bytes never
 * had to leave Rust.
 */
export async function importSourceResealAttachment(
  sourceVaultId: string,
  attachmentId: string,
): Promise<ResealedAttachment> {
  return await invoke<ResealedAttachment>(
    "plugin:importer|import_source_reseal_attachment",
    { sourceVaultId, attachmentId },
  );
}

/** What one dictionary carry did. */
export interface DictionaryCarry {
  /** Words that were NOT already in the target's personal set. */
  added: number;
  /** Words read from the source, whether or not the target already had them. */
  read: number;
}

/**
 * Union the source vault's added words into the TARGET's personal dictionary.
 *
 * One call and one persist, host-side. The previous shape read the words here
 * and looped `addToPersonalDictionary`, which cost one IPC round trip AND one
 * full `vault.dictionary` re-seal per word: 500 shared words meant 500 AEAD
 * seals and 500 fsyncs in sequence. It also could not report anything but the
 * number of calls it had made, so the import report claimed 500 words crossed
 * when the two vaults shared 480 of them.
 *
 * The ignore set is still not carried. Host-side this reads through
 * `added_words_from_dir`, which returns the ADDED words and has no parameter
 * that would return anything else, so there is nothing here that could carry
 * it either: an ignore decision is vault-scoped, and importing another vault's
 * would silently change spell-check on target notes the import never touched.
 */
export async function importSourceMergeDictionary(
  sourceVaultId: string,
): Promise<DictionaryCarry> {
  return await invoke<DictionaryCarry>(
    "plugin:importer|import_source_merge_dictionary",
    { sourceVaultId },
  );
}

/** Narrow an unknown rejection from {@link importSourceOpen} to the enum. */
export function asVaultUnlockError(e: unknown): VaultUnlockError | null {
  return typeof e === "object" && e !== null && "kind" in e
    ? (e as VaultUnlockError)
    : null;
}
