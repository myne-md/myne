// Persisted-conversation wiring for the AI chat transcript (myne-md/myne#675).
//
// The store (`chatStore.ts`) owns the transcript and calls a persister after
// every settled turn; this module IS that persister, plus the unlock-time
// re-hydration. It is the only production importer of `src/lib/chats.ts`
// (the `check-unwired`/`check-ipc-binding-callers` claim), installed by the AI
// tab mount and by nothing else.
//
// Two rules bound this file:
//
// 1. **The transcript shape here is opaque to the backend.** The Rust side
//    stores the turn list verbatim and merges on `turns[].id` only, so the
//    ONE load-bearing field name is `id` (plus the top-level `turns` key the
//    host validates). Every other field is the frontend's own rendering
//    state, serialized for re-hydration and for nothing else.
// 2. **Persistence never breaks the chat.** Every IPC call in this file runs
//    fire-and-forget from the store's perspective (the store never awaits),
//    and every failure path leaves the live transcript exactly as it was.
//    A vault whose conversation store is unreachable behaves like the old
//    RAM-only transcript, not like a broken tab.

import {
  chatsAppendTurn,
  chatsCreate,
  chatsList,
  chatsRead,
  type ConversationListRow,
} from "../../lib/chats";
import {
  chatReducer,
  clearPendingAnchorFolderId,
  clearPendingAnchorNoteId,
  getActiveConversationId,
  getChat,
  getPendingAnchorFolderId,
  getPendingAnchorNoteId,
  hydrateChatTurns,
  setActiveConversationId,
  setChatPersister,
  type AgentRunOutcome,
  type AgentTurnSummary,
  type ChatTurn,
  type TurnAttachment,
} from "./chatStore";

/** The persisted form of one turn: the rendering state minus the transient. */
export interface PersistedTurn {
  id: string;
  kind: "text" | "agent";
  role: "user" | "assistant";
  text: string;
  error: boolean;
  errorCause?: unknown;
  insertable?: boolean;
  answeredBy?: unknown;
  scopeLabel?: string;
  agentSummary?: unknown;
  /** Files the message carried (myne-md/myne#913). Additive and optional: a
   *  turn written before this field re-hydrates without it. */
  attachments?: unknown;
}

/** Title-derivation budget (§ 9.24.2): first 48 Unicode scalar values. */
export const TITLE_DERIVATION_MAX_USVS = 48;

/**
 * The derivation input snapshot (§ 9.24.2 `title_derived_from`): the first
 * turn's text, first 48 scalar values, newlines stripped, no model call.
 * Mirrors the backend derivation byte-for-behavior (the backend owns the
 * catalog title; this snapshot lets any reader of a raw conversation file
 * recover what the title derived from). Iterates code points, matching
 * Rust's `chars()`.
 */
function deriveTitleSnapshot(turns: readonly ChatTurn[]): string {
  const first = turns.length > 0 ? turns[0]!.text : "";
  if (typeof first !== "string") return "";
  let out = "";
  let count = 0;
  for (const ch of first) {
    if (ch === "\n" || ch === "\r") continue;
    if (count >= TITLE_DERIVATION_MAX_USVS) break;
    out += ch;
    count += 1;
  }
  return out;
}

/** Serialize the live transcript for the conversation file (§ 9.24.2 shape:
 *  a `turns` array plus the title-derivation snapshot; `streaming` is always
 *  false here because only settled turns persist). */
export function serializeTranscript(turns: readonly ChatTurn[]): string {
  const persisted: PersistedTurn[] = turns.map((t) => {
    const out: PersistedTurn = {
      // Unknown fields first: a newer writer's field rides through an older
      // frontend's hydrate plus re-persist untouched (forward tolerance).
      // Known fields after, so this writer's own values always win.
      ...(t.rest !== undefined ? t.rest : {}),
      id: t.id,
      kind: t.kind,
      role: t.role,
      text: t.text,
      error: t.error,
    };
    if (t.errorCause !== undefined) out.errorCause = t.errorCause;
    if (t.insertable) out.insertable = true;
    if (t.answeredBy !== undefined) out.answeredBy = t.answeredBy;
    if (t.scopeLabel !== undefined) out.scopeLabel = t.scopeLabel;
    if (t.attachments !== undefined && t.attachments.length > 0) {
      out.attachments = t.attachments;
    }
    if (t.agentSummary !== undefined) out.agentSummary = t.agentSummary;
    return out;
  });
  return JSON.stringify({ turns: persisted, title_derived_from: deriveTitleSnapshot(turns) });
}

/**
 * Validate one turn's attachment list (myne-md/myne#913).
 *
 * **Validated, not cast.** The payload arrives from the conversation file and,
 * through sync, from another device: a malformed entry must cost that entry and
 * never the transcript, and a `name` that is not a string would reach the render
 * path as `undefined.name`. Anything wrong drops the field; the turn keeps its
 * text, so user content is never the price of bad metadata.
 */
function parseTurnAttachments(raw: unknown): { attachments?: TurnAttachment[] } {
  if (!Array.isArray(raw)) return {};
  const out: TurnAttachment[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    const name = entry["name"];
    const contentType = entry["contentType"];
    if (typeof id !== "string" || typeof name !== "string") continue;
    out.push({
      id,
      name,
      contentType: typeof contentType === "string" ? contentType : "",
    });
  }
  return out.length > 0 ? { attachments: out } : {};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Every turn key this writer knows. Anything else on a parsed turn is a
 * newer writer's field and rides in `rest` (forward tolerance). `streaming`
 * is known and deliberately dropped: only settled turns persist.
 */
const KNOWN_TURN_KEYS: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "role",
  "text",
  "streaming",
  "error",
  "errorCause",
  "insertable",
  "answeredBy",
  "scopeLabel",
  "agentSummary",
  "attachments",
]);

/**
 * Validate a persisted agent summary. A malformed summary arriving via sync
 * (unvalidated at every layer) must not reach render paths that read
 * `summary.length`: returns the summary intact when its shape holds, `null`
 * otherwise, and the caller keeps the turn's text either way. Mirrors the
 * mobile twin's validation (same closed end set as `AgentTurnEnd`).
 */
function parseAgentSummary(raw: unknown): { agentSummary: AgentTurnSummary } | null {
  if (!isRecord(raw)) return null;
  const { runId, summary, end } = raw;
  if (typeof runId !== "string" || typeof summary !== "string") return null;
  const nums: unknown[] = [raw["edits"], raw["newNotes"], raw["notesRead"], raw["iterations"]];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [edits, newNotes, notesRead, iterations] = nums as [number, number, number, number];
  const { charsOffDevice } = raw;
  if (charsOffDevice !== null && (typeof charsOffDevice !== "number" || !Number.isFinite(charsOffDevice))) {
    return null;
  }
  if (
    end !== "finished" &&
    end !== "awaitingScope" &&
    end !== "cancelled" &&
    end !== "exhaustedIterations" &&
    end !== "stalled"
  ) {
    return null;
  }
  const out: AgentTurnSummary = {
    runId,
    summary,
    edits,
    newNotes,
    notesRead,
    iterations,
    charsOffDevice,
    end,
  };
  // **Optional numbers are carried, not dropped** (myne-md/myne#848). This
  // parser builds a fresh object from a known field list, so a field the
  // interface declares but this function does not name is silently lost on
  // every re-hydration: the turn looks complete, and the marker it should have
  // shown is gone by the next unlock. `memoryUpdated` shipped that way, which is
  // how the footprint's memory chip would have vanished from every conversation
  // the user reopened.
  if (typeof raw["memoryUpdated"] === "number" && Number.isFinite(raw["memoryUpdated"])) {
    out.memoryUpdated = raw["memoryUpdated"];
  }
  if (typeof raw["durationMillis"] === "number" && Number.isFinite(raw["durationMillis"])) {
    out.durationMillis = raw["durationMillis"];
  }
  // **And now `outcome`, which is the failure this comment predicted**
  // (myne-md/myne#894, from the review). The counts line reads it, so dropping it
  // here sent a decided run back to "Proposed N changes" after any lock or
  // reload, asserting an actionable state for a run that was dropped and has no
  // re-apply affordance. Two arms only: anything else is not a decision this
  // client can name, and the field is optional.
  if (raw["outcome"] === "applied" || raw["outcome"] === "rejected") {
    out.outcome = raw["outcome"];
  }
  if (isRecord(raw["proposal"])) {
    const proposal = raw["proposal"];
    const editsOk =
      Array.isArray(proposal["edits"]) &&
      proposal["edits"].every(
        (e) =>
          isRecord(e) &&
          typeof e["noteId"] === "string" &&
          typeof e["anchor"] === "string" &&
          typeof e["replacement"] === "string",
      );
    const newNotesOk =
      Array.isArray(proposal["newNotes"]) &&
      proposal["newNotes"].every(
        (n) =>
          isRecord(n) &&
          typeof n["title"] === "string" &&
          typeof n["body"] === "string" &&
          (typeof n["folder"] === "string" || n["folder"] === null),
      );
    if (!editsOk || !newNotesOk) return null;
    // Shape-checked above: the unknown round-trip is the honest cast for
    // validated JSON rather than a blind one.
    out.proposal = proposal as unknown as NonNullable<AgentTurnSummary["proposal"]>;
  }
  return { agentSummary: out };
}

/** Parse a persisted conversation back into turns. Returns `null` when the
 *  payload is not a conversation at all; drops malformed TURNS individually
 *  (one bad turn must not hide the rest) and forces `streaming: false`
 *  (only settled turns persist, so a stored streaming flag would be a lie). */
export function parseTranscript(json: string): ChatTurn[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["turns"])) return null;
  const turns: ChatTurn[] = [];
  for (const raw of parsed["turns"] as unknown[]) {
    if (!isRecord(raw)) continue;
    const { id, kind, role, text } = raw;
    if (typeof id !== "string" || typeof text !== "string") continue;
    if (kind !== "text" && kind !== "agent") continue;
    if (role !== "user" && role !== "assistant") continue;
    // Residual unknown fields ride through opaquely (forward tolerance): a
    // turn carrying a field added by a newer writer keeps it across this
    // frontend's hydrate plus re-persist instead of losing it on the next
    // settle (which would strip it cluster-wide on merge). `streaming` is
    // deliberately NOT carried: only settled turns persist, so a stored
    // streaming flag would be a lie.
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(raw)) {
      if (!KNOWN_TURN_KEYS.has(key)) rest[key] = raw[key];
    }
    turns.push({
      id,
      kind,
      role,
      text,
      streaming: false,
      error: raw["error"] === true,
      // Guarded reads mirroring the serializer's writers (D11, fix round):
      // every optional field `serializeTranscript` persists is restored here,
      // or the re-hydrated transcript silently loses the field and the UI
      // renders a plausibly wrong view of what was saved.
      ...(raw["errorCause"] !== undefined ? { errorCause: raw["errorCause"] } : {}),
      ...(raw["insertable"] === true ? { insertable: true } : {}),
      ...(raw["answeredBy"] !== undefined ? { answeredBy: raw["answeredBy"] } : {}),
      // Validated like the mobile twin: a malformed summary arriving via sync
      // (unvalidated at every layer) must not reach render paths that read
      // `summary.length`. The turn keeps its text; only the summary is
      // dropped, so user content is never the price of bad metadata.
      ...(parseAgentSummary(raw["agentSummary"]) ?? {}),
      ...(typeof raw["scopeLabel"] === "string" ? { scopeLabel: raw["scopeLabel"] } : {}),
      ...parseTurnAttachments(raw["attachments"]),
      ...(Object.keys(rest).length > 0 ? { rest } : {}),
    } as ChatTurn);
  }
  return turns;
}

// The last payload written, keyed by conversation: a STOP followed by its
// late FINALIZE (and any other terminal pair landing on identical turns)
// writes once, not twice.
let lastPersisted: { id: string | null; payload: string; seq: number } | null = null;

/** Test-only reset for the dedup memory. */
export function __resetChatPersistForTest(): void {
  lastPersisted = null;
  lagging = false;
  hydrateFailed = false;
  unsavedAppend = null;
  persistQueue = Promise.resolve();
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** Test-only drain: resolves once every enqueued persist (including the one
 *  a settle notify just fired) has finished its attempt. The production
 *  callers never need this: retries are timer-driven, and the queue is an
 *  internal serialization detail. */
export async function __flushChatPersistForTest(): Promise<void> {
  await persistQueue;
}

// ---- persist health (surfaced failure state, myne-md/myne#675 review) -----
//
// The store's contract stands: a persist failure never breaks the chat. What
// the fire-and-forget arm hid was HOW LONG a failure stays hidden: a failed
// write at lock time meant turns dying with the `clearChat` wipe and nothing
// anywhere saying so. Three pieces close that, without letting persistence
// break the chat:
//
// 1. Bounded retry: a failed persist re-fires after a short delay (twice),
//    which covers a transient IPC failure without waiting for a next settled
//    turn that may never come.
// 2. A replay stash: a failed write keeps the exact payload module-side
//    (module state survives `clearChat`, the RAM transcript does not), and
//    the unlock hydrate replays it before anything else, so the conversation
//    file recovers the turns the wipe would have cost. An append re-appends;
//    a first-turn create replays as a create (the conversation never
//    existed, so there is no id to append to).
// 3. A lagging flag the UI renders (`ai.persist-warning`), so "not saved"
//    is visible while retries or a replay are still pending instead of
//    looking exactly like a saved conversation.

let lagging = false;
const healthListeners = new Set<() => void>();
function setLagging(next: boolean): void {
  if (lagging === next) return;
  lagging = next;
  for (const listener of healthListeners) listener();
}

/** Whether the last persist attempt failed and its payload is not yet on
 *  disk. Rendered by the chat tab as a warning line; reads as `false` once a
 *  retry or the unlock replay lands. */
export function isChatPersistLagging(): boolean {
  return lagging;
}

/** Subscribe to lagging changes; returns an unsubscribe. */
export function subscribeChatPersistHealth(listener: () => void): () => void {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
}

// The replay stash: one pending write, module-scoped so it survives the
// `clearChat` wipe. Cleared on successful replay (or test reset).
let unsavedAppend: ChatPersistSnapshot | null = null;

// The hydrate-failure flag (the review's second I9 half): the unlock hydrate
// could not read the conversation store. An empty-looking tab is the exact
// lie § 9.23.3 forbids presenting silently (report-never-empty), so a
// `CatalogUnreadable` refusal raises this flag and the tab renders an error
// line (`ai.hydrate-error`) instead of an innocent blank transcript. Cleared
// by any successful hydrate, replay, or explicit `openConversation`.
let hydrateFailed = false;

function setHydrateFailed(next: boolean): void {
  if (hydrateFailed === next) return;
  hydrateFailed = next;
  for (const listener of healthListeners) listener();
}

/** Whether the last unlock hydrate failed to read the conversation store.
 *  Rendered by the chat tab as an error line while the transcript is empty. */
export function isChatHydrateFailed(): boolean {
  return hydrateFailed;
}

/** Does this thrown chats error say the STORE is unreadable (as opposed to
 *  one conversation, or merely absent)? The bindings reject with the serde
 *  error object (`{ kind, detail }`), so the kind is the only safe probe. */
function isStoreUnreadable(e: unknown): boolean {
  return isRecord(e) && e["kind"] === "CatalogUnreadable";
}

const PERSIST_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let persistQueue: Promise<void> = Promise.resolve();

/**
 * A persist attempt's immutable input: the bound conversation (null = the
 * next write creates) plus the full serialized transcript. Captured
 * synchronously by the persister listener at notify time, carried unchanged
 * through retries. `seq` is the capture order: a retry whose snapshot is
 * older than what already landed drops instead of writing (an older payload
 * must never land after a newer one).
 */
export interface ChatPersistSnapshot {
  id: string | null;
  payload: string;
  seq: number;
  /** Wipe epoch at capture time. A lock/switch wipe bumps the module epoch;
   *  an attempt from an older epoch drops instead of writing, stashing, or
   *  retrying, so an in-flight persist can never resurrect plaintext after
   *  the wipe nor replay vault A's turns into vault B's store. */
  epoch: number;
  /** Client-minted conversation id, fixed at snapshot time. Every attempt of
   *  this snapshot (including retries after a lost response) carries the
   *  same id, so a create that succeeded server-side is adopted rather than
   *  duplicated. */
  clientId: string;
  /** The note this conversation is anchored to, captured at snapshot time
   *  (myne-md/myne#771). Read by the create path; ignored once the conversation
   *  exists, because an anchor is immutable for the life of a conversation. */
  noteId: string | null;
  /** The folder the conversation is scoped to, captured the same way
   *  (myne-md/myne#848). At most one of the two anchors is ever set. */
  folder: string | null;
}

let persistSeq = 0;

// Wipe epoch for the persist queue. Bumped by `clearChatPersistForLock` on
// every vault-leaving path; attempts captured before the bump are stale.
let persistWipeEpoch = 0;

async function persistSnapshotOnce(attempt: number, snap: ChatPersistSnapshot): Promise<void> {
  if (snap.epoch !== persistWipeEpoch) {
    // A lock/switch wipe landed after this snapshot was captured: stale,
    // drop. No write, no stash, no retry, no lagging flag.
    return;
  }
  if (
    lastPersisted !== null &&
    lastPersisted.id === snap.id &&
    lastPersisted.payload === snap.payload
  ) {
    setLagging(false);
    return;
  }
  if (lastPersisted !== null && snap.seq < lastPersisted.seq) {
    // A newer snapshot already landed while this retry waited: stale, drop.
    // The lagging flag belongs to the newer snapshot's attempt now.
    return;
  }
  try {
    if (snap.id === null) {
      const created = await chatsCreate(
        snap.payload,
        snap.clientId,
        snap.noteId,
        snap.folder,
      );
      setActiveConversationId(created);
      // The anchors rode the create; a second conversation starts clean.
      clearPendingAnchorNoteId();
  // **The folder anchor is the same lifecycle** (review finding): the two are
  // held and cleared together everywhere else, and this site left the folder one
  // armed, so the NEXT conversation created on this device was written as
  // folder-scoped for a folder it was never scoped to.
  clearPendingAnchorFolderId();
      clearPendingAnchorFolderId();
      lastPersisted = { id: created, payload: snap.payload, seq: snap.seq };
    } else {
      await chatsAppendTurn(snap.id, snap.payload);
      lastPersisted = { id: snap.id, payload: snap.payload, seq: snap.seq };
    }
    setLagging(false);
    if (
      unsavedAppend !== null &&
      unsavedAppend.id === snap.id &&
      unsavedAppend.payload === snap.payload
    ) {
      unsavedAppend = null;
    }
  } catch (e) {
    // Stashed for the unlock replay (module state survives `clearChat`;
    // the RAM transcript does not): appends and first-turn creates alike
    // (a create replays as a create). Dropped by `clearChatPersistForLock`
    // on the vault-leaving paths: the lock wipe is total, and a replay that
    // crossed a vault switch would write vault A's turns into vault B's store.
    unsavedAppend = {
      id: snap.id,
      payload: snap.payload,
      seq: snap.seq,
      epoch: snap.epoch,
      clientId: snap.clientId,
      noteId: snap.noteId,
      folder: snap.folder,
    };
    setLagging(true);
    if (attempt < PERSIST_RETRIES) {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void enqueueSnapshot(attempt + 1, snap);
      }, RETRY_DELAY_MS);
      return;
    }
    // Retries exhausted: the stash + the lagging flag carry it until the
    // next settled turn (which snapshots and retries from scratch) or the
    // unlock replay.
    void e;
  }
}

/** Serialize persists behind one queue: every attempt carries its own
 *  immutable snapshot, and a retry whose snapshot is older than what already
 *  landed drops instead of writing (the `seq` rule in `persistSnapshotOnce`),
 *  so a retry can never land an older payload after a newer one. */
function enqueueSnapshot(attempt: number, snap: ChatPersistSnapshot): Promise<void> {
  const run = persistQueue.then(() => persistSnapshotOnce(attempt, snap));
  persistQueue = run.catch(() => {});
  return run;
}

/**
 * Install the store's persistence listener. Idempotent; the AI tab mount owns
 * the one call. A persist failure never breaks the chat (the store's
 * contract), but it is no longer silent: it retries (bounded), stashes a
 * known-id append for the unlock replay, and raises the lagging flag the
 * chat tab renders (`ai.persist-warning`).
 */
export function installChatPersistence(): void {
  setChatPersister(() => {
    // Captured SYNCHRONOUSLY at notify time: the queue defers the IPC past
    // the notify, and `clearChat`'s CLEARED dispatch runs in between, so a
    // lazily-read transcript would persist the wiped state (an empty-turns
    // create for a lock that cut a stream).
    const snap: ChatPersistSnapshot = {
      id: getActiveConversationId(),
      payload: serializeTranscript(getChat().turns),
      seq: ++persistSeq,
      epoch: persistWipeEpoch,
      clientId: crypto.randomUUID().replace(/-/g, ""),
      noteId: getPendingAnchorNoteId(),
      folder: getPendingAnchorFolderId(),
    };
    void enqueueSnapshot(0, snap).catch(() => {
      // Unreachable (persistSnapshotOnce catches internally); kept so the
      // queue chain can never turn rejected.
    });
  });
}

/**
 * Drop the persist module's plaintext on the vault-leaving paths (lock,
 * switch): the last serialized payload, one stashed failed write, the
 * lagging and hydrate-failure flags, and any scheduled retry. Called next to
 * `clearChat()` at the choke points (`src/lib/vault-unlock.ts`,
 * `src/lib/vault-switch.ts`); it cannot live inside `clearChat` itself,
 * which also runs on in-session clears where the stash and the flag are
 * still owed. After this, an unlock hydrate reads only what is on disk: a
 * lock that lands mid-persist attempts the write with the snapshot taken
 * above and keeps no retry state.
 */
export function clearChatPersistForLock(): void {
  lastPersisted = null;
  unsavedAppend = null;
  persistWipeEpoch++;
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  setLagging(false);
  setHydrateFailed(false);
}

/**
 * Make the active conversation exist on disk with the transcript as it stands,
 * and return its id (myne-md/myne#848).
 *
 * **The conversation list should show a conversation from the first user
 * message, not from the first reply.** Before this, the only writer was the
 * persister, which fires on SETTLE, so a conversation created by a message that
 * had not been answered yet was invisible in the hub, and on a remote provider
 * "not answered yet" is minutes. A user who sent something and switched away to
 * do something else came back to a list that did not contain what they had just
 * asked.
 *
 * Returns `null` rather than throwing when the write fails: the queue still
 * owes the write (a settle will retry it, and `isChatPersistLagging` already
 * says so on screen), so a run starts with no bound conversation rather than
 * failing to start at all. That is the one state `runConversationId` documents
 * as legitimate.
 *
 * Recorded in `lastPersisted`/`persistSeq` like any other write, so the
 * settle's persist does not re-send a payload that is already on disk, and an
 * older retry cannot land after this one.
 */
export async function ensureConversation(): Promise<string | null> {
  const payload = serializeTranscript(getChat().turns);
  const existing = getActiveConversationId();
  try {
    if (existing === null) {
      const created = await chatsCreate(
        payload,
        crypto.randomUUID().replace(/-/g, ""),
        getPendingAnchorNoteId(),
        getPendingAnchorFolderId(),
      );
      setActiveConversationId(created);
      // The anchors rode the create; a second conversation starts clean.
      clearPendingAnchorNoteId();
      clearPendingAnchorFolderId();
      lastPersisted = { id: created, payload, seq: ++persistSeq };
      return created;
    }
    if (
      lastPersisted !== null &&
      lastPersisted.id === existing &&
      lastPersisted.payload === payload
    ) {
      return existing;
    }
    await chatsAppendTurn(existing, payload);
    lastPersisted = { id: existing, payload, seq: ++persistSeq };
    return existing;
  } catch {
    return null;
  }
}

/**
 * Settle a run into a conversation that is no longer the one on screen
 * (myne-md/myne#848).
 *
 * The live transcript is a single slot, so a run that outlives navigation has
 * no live slot to settle into: `settleAgentTurn` would write its counts, its
 * summary and its frozen proposal onto whichever conversation the user has
 * opened since. This reads the run's OWN conversation, applies the same
 * reducer action the live path applies, and writes it back.
 *
 * `AGENT_SETTLE` is the action and it targets the last agent turn, so the file
 * must still hold the turns `startAgentRun` appended, which it does, because
 * the conversation is created (or appended) at send time now.
 *
 * Silent on failure, deliberately: the live transcript is not the subject here
 * and has nothing to roll back, and the next settle of the same conversation
 * would carry the same summary. A missing patch is a lost freeze, not a lost
 * run, the host's record of what it did is separate.
 */
export async function settleTurnInConversation(
  id: string,
  summary: AgentTurnSummary,
): Promise<void> {
  try {
    const payload = await chatsRead(id);
    const turns = parseTranscript(payload);
    if (turns === null) return;
    const next = chatReducer({ turns, streaming: false }, { type: "AGENT_SETTLE", summary });
    await chatsAppendTurn(id, serializeTranscript(next.turns));
  } catch {
    // Unreachable in practice (a conversation created moments ago reads back),
    // and the fallback is doing nothing.
  }
}

/**
 * Write a run's decision into the conversation the RUN started in.
 *
 * The active-transcript path (`markAgentTurnOutcome`) only sees the conversation
 * on screen, and the decision arrives after `await agentApply(...)`, so a reader
 * who switched conversations during that round trip used to lose the decision
 * while the notes were already on disk (myne-md/myne#894 review). This is the
 * same routing `settleTurnInConversation` uses for a settle, applied to the one
 * field a settled turn can gain.
 */
export async function markOutcomeInConversation(
  id: string,
  runId: string,
  outcome: AgentRunOutcome,
): Promise<void> {
  try {
    const payload = await chatsRead(id);
    const turns = parseTranscript(payload);
    if (turns === null) return;
    const next = chatReducer(
      { turns, streaming: false },
      { type: "AGENT_OUTCOME", runId, outcome },
    );
    // The reducer returns the same array when nothing matched (the turn is not in
    // this conversation), and an append of identical turns is a wasted write.
    if (next.turns === turns) return;
    await chatsAppendTurn(id, serializeTranscript(next.turns));
  } catch {
    // Best effort by design: the notes are written either way, and a failure here
    // leaves the transcript reading "proposed" rather than corrupting it.
  }
}

/**
 * Open a conversation from the history list: read it, bind the transcript to
 * it, and replace the live turns. Unlike the unlock hydrate this is an
 * EXPLICIT navigation, so no empty-store guard: the epoch bump inside
 * `hydrateChatTurns` drops any in-flight stream first, which is what stops a
 * superseded generation from appending into the newly opened conversation.
 * Returns whether the transcript now shows the requested conversation; a
 * failure leaves the live transcript exactly as it was.
 */
export async function openConversation(id: string): Promise<"opened" | "failed"> {
  // Opening an existing conversation is not creating one, so any pending
  // anchor from a run that never persisted is not this conversation's
  // (myne-md/myne#771).
  clearPendingAnchorNoteId();
  let payload: string;
  try {
    payload = await chatsRead(id);
  } catch (e) {
    // An explicit navigation to a conversation the store cannot read is the
    // same unreadable store the hydrate reports; surface it there too.
    if (isStoreUnreadable(e)) setHydrateFailed(true);
    return "failed";
  }
  const turns = parseTranscript(payload);
  if (turns === null) return "failed";
  setActiveConversationId(id);
  setHydrateFailed(false);
  hydrateChatTurns(turns);
  return "opened";
}

/**
 * Re-hydrate the active conversation after unlock (Q9: the tab continues the
 * last conversation). Picks the most recently updated conversation: the
 * observable definition of "last active", needing no extra pointer state,
 * reads it, and binds the transcript to it. Every failure path leaves the
 * store exactly as it was (empty): a vault with no readable conversation is
 * a fresh tab, not an error surface.
 *
 * Two guards, both load-bearing. Already bound (a second mount must not
 * re-fetch), and an empty store (a message typed while the fetch was in
 * flight wins over the hydrate, re-checked after every await, so a late
 * resolve can never clobber user-typed turns). A lock/teardown mid-fetch
 * needs no third guard: it wipes to the same empty state this function
 * requires to proceed.
 */
export async function hydrateActiveConversation(): Promise<void> {
  // Replay-first: a write that failed before the wipe (stashed, module
  // scope survives the `clearChat` wipe) re-lands before the roster read, so
  // the conversation file recovers the turns the wipe would have cost. An
  // append re-appends; a first-turn create replays as a create and binds the
  // transcript to it directly. A replay that fails again keeps the stash and
  // the lagging flag for the next attempt.
  if (unsavedAppend !== null) {
    const stash = unsavedAppend;
    if (stash.epoch !== persistWipeEpoch) {
      // A wipe landed without clearing the stash (or the stash predates it):
      // never replay across a vault-leaving boundary. Drop, do not write.
      unsavedAppend = null;
      setLagging(false);
    } else
    try {
      if (stash.id === null) {
        const created = await chatsCreate(
        stash.payload,
        stash.clientId,
        stash.noteId,
        // **The folder anchor rides the replay too** (myne-md/myne#848). A
        // create whose first persist failed is exactly the case where the
        // anchor matters most, and omitting it recreated a folder-scoped
        // conversation as vault-general with nothing said.
        stash.folder,
      );
        const turns = parseTranscript(stash.payload);
        setActiveConversationId(created);
        clearPendingAnchorNoteId();
        clearPendingAnchorFolderId();
        lastPersisted = { id: created, payload: stash.payload, seq: stash.seq };
        if (turns !== null) hydrateChatTurns(turns);
      } else {
        await chatsAppendTurn(stash.id, stash.payload);
      }
      unsavedAppend = null;
      setLagging(false);
      setHydrateFailed(false);
    } catch {
      // Stash retained; the lagging flag stays up.
    }
  }
  if (getActiveConversationId() !== null) return;
  if (getChat().turns.length > 0) return;
  let list: ConversationListRow[];
  try {
    list = await chatsList();
  } catch (e) {
    // A store the roster cannot read is not an empty store: surface it
    // (report-never-empty, § 9.23.3) instead of rendering an innocent blank
    // transcript the user reads as "no conversations yet".
    if (isStoreUnreadable(e)) setHydrateFailed(true);
    return;
  }
  if (getActiveConversationId() !== null) return;
  if (getChat().turns.length > 0) return;
  let latest: ConversationListRow | null = null;
  for (const entry of list) {
    if (latest === null || entry.updated_at > latest.updated_at) latest = entry;
  }
  if (latest === null) return;
  let payload: string;
  try {
    payload = await chatsRead(latest.id);
  } catch (e) {
    if (isStoreUnreadable(e)) setHydrateFailed(true);
    return;
  }
  if (getActiveConversationId() !== null) return;
  if (getChat().turns.length > 0) return;
  const turns = parseTranscript(payload);
  if (turns === null) return;
  setActiveConversationId(latest.id);
  setHydrateFailed(false);
  hydrateChatTurns(turns);
}
