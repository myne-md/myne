// AI-conversation command wrappers (myne-md/myne#675): the TS mirror of the
// `chats` Tauri plugin (`myne-core::plugins::chats`, surfaced on desktop by
// `src-tauri/src/plugins/chats/` and on mobile by its shim). Conversations are
// VAULT CONTENT: the `vault.chats` `MYM1` catalog singleton + one `MYJ1` file
// per conversation under `chats/` (protocol.md § 9.23 / § 9.24), synced and
// backed up. Consumed by the persistence-backed chat store (task 7) and the
// conversation-list UI (task 8).
//
// No mock layer (per `src/AGENTS.md`): these call the real IPC commands. Keep
// the types in lockstep with the Rust `ChatsReadError` / `ChatsMutateError`
// serde shapes.

import { invoke } from "../platform/core";

/** Mirror of Rust `chats::error::ChatsReadError` variant tag. */
export type ChatsReadErrorKind =
  | "SlotNotUnlocked"
  | "Io"
  | "InvalidVaultMeta"
  // The catalog exists but cannot be decoded. Reported, never an empty roster
  // (§ 9.23.3 report-don't-empty): conversations are user content.
  | "CatalogUnreadable"
  // A conversation file failed under a live catalog row. Carries no detail:
  // the caller named the conversation in its own request. The catalog row
  // is NOT dropped in response (§ 9.24.4).
  | "ConversationUnreadable"
  // The named conversation is tombstoned or has no catalog row. Reads check
  // liveness first, so a deleted conversation stays unreadable by id.
  | "ConversationNotFound";

/** Mirror of Rust `ChatsReadError` (serde `tag = "kind", content = "detail"`). */
export interface ChatsReadError {
  kind: ChatsReadErrorKind;
  detail?: unknown;
}

/** Mirror of Rust `chats::error::ChatsMutateError` variant tag. */
export type ChatsMutateErrorKind =
  | "SlotNotUnlocked"
  | "Io"
  | "InvalidVaultMeta"
  // The mutation was refused over an unreadable store (refuse-don't-wipe:
  // creating "as a repair" would persist emptiness over real records).
  | "CatalogUnreadable"
  | "ConversationNotFound"
  | "InvalidTurnPayload"
  | "PayloadTooLarge"
  | "RandomnessUnavailable";

/** Mirror of Rust `ChatsMutateError` (serde `tag = "kind", content = "detail"`). */
export interface ChatsMutateError {
  kind: ChatsMutateErrorKind;
  detail?: unknown;
}

/**
 * Mirror of Rust `chats::commands::ConversationEntry`: one catalog row. The
 * `id` lives in the catalog KEY on disk, not in the row; see
 * `ConversationListRow` for the read-boundary shape that carries it.
 */
export interface ConversationEntry {
  created_at: number;
  deleted_at?: number;
  title: string;
  updated_at: number;
  version: number;
  /** The note this conversation is anchored to, when it is (myne-md/myne#771).
   *  Absent for a vault-general conversation. A field on the existing row, not a
   *  new blob family: the roster already syncs, so the Hub lists anchors without
   *  reading each conversation file. */
  note_id?: string;
  /** The folder this conversation is scoped to, when it is
   *  (myne-md/myne#848). Additive and optional in the same way `note_id` is: a
   *  row written before the field existed reads back without it, and the Hub
   *  renders that as a vault-general conversation. A conversation carries at
   *  most one of `note_id` / `folder`. */
  folder?: string;
}

/**
 * Mirror of Rust `chats::commands::ConversationListRow`: what `chatsList`
 * returns: the catalog key (the conversation id) plus the row. The id is
 * duplicated here, at the read boundary, and nowhere else.
 */
export interface ConversationListRow extends ConversationEntry {
  id: string;
}

/**
 * The canonical conversation inner plaintext (§ 9.24.2) as the host serializes
 * it: the ordered immutable turn list plus the title-derivation snapshot.
 * The turn shape mirrors the frontend `ChatTurn` (kind/role/text + the agent
 * summary fields); the host validates the `turns` key and seals the payload
 * verbatim.
 */
export interface ConversationPayload {
  turns: unknown[];
  title_derived_from?: string;
}

/**
 * The conversation roster changed — created, renamed or deleted.
 *
 * **A chokepoint, not an event bus.** Every catalog mutation goes through the
 * three wrappers below, so bumping here means a surface listing conversations
 * cannot go stale by somebody forgetting to tell it. That is the same shape
 * `writePref` has for the prefs nonce, and for the same reason: the alternative
 * is a notify call beside every write, which is a call that will one day be
 * missing from the newest one.
 *
 * The agent hub's rail is what made this necessary. It loaded its roster once,
 * on mount, and nothing said a word afterwards — so a conversation created by
 * SENDING a message did not appear in the list beside it until the tab was
 * reopened. The list is the thing that says a conversation exists.
 *
 * Deliberately carries no payload. A listener re-reads the roster, because the
 * roster is what it renders; a diff would be a second model of the catalog kept
 * in step with the first.
 */
const rosterListeners = new Set<() => void>();

/** Subscribe to roster changes. Returns an unsubscribe. */
export function subscribeConversationRoster(listener: () => void): () => void {
  rosterListeners.add(listener);
  return () => {
    rosterListeners.delete(listener);
  };
}

/** Announce that the roster changed. Called by the wrappers below only. */
function rosterChanged(): void {
  for (const listener of rosterListeners) listener();
}

/** Create a conversation; returns the new conversation id (32-char hex). */
export async function chatsCreate(
  firstTurnPayload: string,
  // Client-minted id for idempotent retry: a retry of a create whose
  // response was lost carries the same id and adopts the existing row
  // instead of minting a duplicate conversation. Optional so older callers
  // keep working (backend mints).
  requestedIdHex?: string,
  // The note this conversation is anchored to, when it is (myne-md/myne#771).
  // Optional and additive: a conversation created without it is vault-general,
  // which is the Hub's own case.
  noteId?: string | null,
  // The folder this conversation is scoped to, when it is (myne-md/myne#848).
  // Same optional shape; at most one of the two is ever set.
  folder?: string | null,
): Promise<string> {
  const id = await invoke<string>("plugin:chats|chats_create", {
    firstTurnPayload,
    ...(requestedIdHex !== undefined ? { requestedIdHex } : {}),
    ...(noteId !== undefined && noteId !== null ? { noteId } : {}),
    ...(folder !== undefined && folder !== null ? { folder } : {}),
  });
  // After the await, so a failed create announces nothing: a listener that
  // re-read on a refusal would replace a correct list with the same list, and
  // on a create it would briefly show a row the host rejected.
  rosterChanged();
  return id;
}

/** Write a settled conversation state (append-at-finalize, § 9.24.4). */
export async function chatsAppendTurn(
  conversationIdHex: string,
  turnsPayload: string,
): Promise<void> {
  await invoke("plugin:chats|chats_append_turn", {
    conversationIdHex,
    turnsPayload,
  });
}

/** Read one conversation's turn-list payload. */
export async function chatsRead(
  conversationIdHex: string,
): Promise<string> {
  return await invoke<string>("plugin:chats|chats_read", {
    conversationIdHex,
  });
}

/** List the roster: live rows ordered by `updated_at` desc, each carrying its id. */
export async function chatsList(): Promise<ConversationListRow[]> {
  return await invoke<ConversationListRow[]>("plugin:chats|chats_list");
}

/** Rename a conversation (catalog-row mutation). */
export async function chatsRename(
  conversationIdHex: string,
  newTitle: string,
): Promise<void> {
  await invoke("plugin:chats|chats_rename", {
    conversationIdHex,
    newTitle,
  });
  rosterChanged();
}

/** Delete a conversation everywhere (tombstone + file removal; idempotent). */
export async function chatsDelete(
  conversationIdHex: string,
): Promise<void> {
  await invoke("plugin:chats|chats_delete", { conversationIdHex });
  rosterChanged();
}
