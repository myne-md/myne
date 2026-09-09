// AI-conversation command wrappers (mobile twin, myne-md/myne#675): the TS
// mirror of the `chats` plugin surfaced by `mobile/src-tauri/src/plugins/chats/`.
// Conversations are VAULT CONTENT: the `vault.chats` `MYM1` catalog + `MYJ1`
// per-conversation files (protocol.md § 9.23 / § 9.24), synced and backed up.
// Consumed by the mobile conversation-list flow (task 13). Keep the types in
// lockstep with the desktop `src/lib/chats.ts` twin (same-named by design; the
// twin-inventory roster carries the pair).

import { invoke } from "../platform/core";

/** Mirror of the desktop twin's `ChatsReadErrorKind` (same serde shape). */
export type ChatsReadErrorKind =
  | "SlotNotUnlocked"
  | "Io"
  | "InvalidVaultMeta"
  | "CatalogUnreadable"
  | "ConversationUnreadable"
  | "ConversationNotFound";

export interface ChatsReadError {
  kind: ChatsReadErrorKind;
  detail?: unknown;
}

/** Mirror of the desktop twin's `ChatsMutateErrorKind` (same serde shape). */
export type ChatsMutateErrorKind =
  | "SlotNotUnlocked"
  | "Io"
  | "InvalidVaultMeta"
  | "CatalogUnreadable"
  | "ConversationNotFound"
  | "InvalidTurnPayload"
  | "PayloadTooLarge"
  | "RandomnessUnavailable";

export interface ChatsMutateError {
  kind: ChatsMutateErrorKind;
  detail?: unknown;
}

/** Mirror of Rust `ConversationEntry`: one catalog row (id lives in the key). */
export interface ConversationEntry {
  created_at: number;
  deleted_at?: number;
  title: string;
  updated_at: number;
  version: number;
}

/** Mirror of Rust `ConversationListRow`: what `chatsList` returns. */
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

/** Create a conversation; returns the new conversation id (32-char hex). */
export async function chatsCreate(
  firstTurnPayload: string,
): Promise<string> {
  return await invoke<string>("plugin:chats|chats_create", {
    firstTurnPayload,
  });
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
}

/** Delete a conversation everywhere (tombstone + file removal; idempotent). */
export async function chatsDelete(
  conversationIdHex: string,
): Promise<void> {
  await invoke("plugin:chats|chats_delete", { conversationIdHex });
}
