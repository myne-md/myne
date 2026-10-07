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
  /** The note this conversation is anchored to, when it is (myne-md/myne#771).
   *  Absent for a vault-general conversation.
   *
   *  Mirrored here even though mobile has no way to SET it: this is a mirror of
   *  the Rust type, the rows sync, and a row written on a computer arrives here
   *  carrying the field. A mirror that is missing a field the data has is a type
   *  that lies about the bytes — the next mobile surface wanting to show the
   *  anchor would reach for a cast, which is how a mirror stops being one.
   *
   *  The create-side `noteId` parameter is deliberately NOT mirrored: anchoring
   *  happens where a note is open beside an agent run, and mobile has neither. */
  note_id?: string;
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
  // Client-minted id for idempotent retry (same contract as desktop).
  requestedIdHex?: string,
  // The note this conversation is anchored to, when it is (myne-md/myne#771).
  // Optional and additive: a conversation created without it is vault-general.
  //
  // Mobile has no caller that passes it today — anchoring happens where a note
  // is open beside an agent run, and mobile has neither. It is here because the
  // wrapper is a mirror of ONE host command, and a mirror that omits an argument
  // is a second, narrower contract wearing the same name: the next mobile
  // surface that needs to anchor would either add the parameter and find the
  // two files had drifted for months, or reach past the wrapper to `invoke`.
  noteId?: string | null,
): Promise<string> {
  const id = await invoke<string>("plugin:chats|chats_create", {
    firstTurnPayload,
    ...(requestedIdHex !== undefined ? { requestedIdHex } : {}),
    ...(noteId !== undefined && noteId !== null ? { noteId } : {}),
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
