// The phone's conversation-transcript layer (myne-md/myne#675, task 13).
//
// Desktop keeps its transcript in a module store (`src/notes/ai/chatStore.ts`
// + `chatPersist.ts`); this client keeps turns in component state
// (myne-md/myne#617), so what this module owns is smaller and precisely
// bounded: the turn JSON shape, the id scheme, the create-or-append write,
// and the background-flush backstop. Everything it writes must read back
// through desktop's `parseTranscript` unchanged. The wire contract is JSON,
// and the validation rules below mirror it field for field rather than
// importing it (mobile source-consumes desktop modules only through the
// `@myne/*` aliases, and the chat store is not one of them; see
// `mobile/src/lib/relative-time.ts` for the port-not-import precedent).
//
// Turn ids follow the desktop scheme (`<16-hex-boot>-<10-digit-seq>`, the
// pattern `chatStore.test.ts` pins): unique per client by the boot
// discriminator, monotonic per boot, so the sync merge's id-ordered union
// stays deterministic across clients.

import {
  chatsAppendTurn,
  chatsCreate,
  type ConversationListRow,
} from "./chats";

/** One transcript turn as it travels: the wire shape desktop parses. */
export interface ChatTurnJson {
  id: string;
  kind: "text" | "agent";
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  agentSummary?: AgentSummaryJson;
}

/** The settled-run summary a turn keeps. Mirrors desktop's `AgentTurnSummary`
 *  (same field names, same meanings); `proposal` rides along frozen so a
 *  conversation written here keeps what its run proposed for readers
 *  elsewhere. This surface never renders it. */
export interface AgentSummaryJson {
  runId: string;
  summary: string;
  edits: number;
  newNotes: number;
  notesRead: number;
  iterations: number;
  charsOffDevice: number | null;
  end: string;
  proposal?: {
    edits: { noteId: string; anchor: string; replacement: string }[];
    newNotes: { title: string; body: string; folder: string | null }[];
  };
}

/** The newest-first pick both clients derive rather than store: the
 *  conversation with the greatest `updated_at`. Task 8's accepted divergence
 *  (an observable definition instead of a stored pointer) governs here too:
 *  a stored pointer would cost a prefs field both clients would then have to
 *  agree on, for behaviour identical in every reachable case. */
export function newestConversation(
  rows: readonly ConversationListRow[],
): ConversationListRow | null {
  let best: ConversationListRow | null = null;
  for (const row of rows) {
    if (best === null || row.updated_at > best.updated_at) best = row;
  }
  return best;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Serialize turns to the canonical payload JSON the host seals verbatim.
 *  `title_derived_from` rides along when the caller knows it (the first user
 *  turn's snapshot); the host derives the row title itself. */
export function serializeTranscript(
  turns: readonly ChatTurnJson[],
  titleDerivedFrom?: string,
): string {
  const out: Record<string, unknown> = {
    turns: turns.map((t) => ({ ...t })),
  };
  if (titleDerivedFrom !== undefined && titleDerivedFrom.length > 0) {
    out["title_derived_from"] = titleDerivedFrom;
  }
  return JSON.stringify(out);
}

/** Parse a sealed payload back to turns. `null` on anything malformed. The
 *  same fail-closed shape as desktop's `parseTranscript`, whose validation
 *  this mirrors: a JSON object carrying a `turns` array of records with
 *  string `id`/`text` and closed `kind`/`role` sets. Unknown fields ride
 *  through on the turn (forward-compat); unknown turns are skipped, not
 *  fatal. */
export function parseTranscript(payload: string): ChatTurnJson[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["turns"])) return null;
  const turns: ChatTurnJson[] = [];
  for (const raw of parsed["turns"] as unknown[]) {
    if (!isRecord(raw)) continue;
    const { id, kind, role, text } = raw;
    if (typeof id !== "string" || typeof text !== "string") continue;
    if (kind !== "text" && kind !== "agent") continue;
    if (role !== "user" && role !== "assistant") continue;
    const turn: ChatTurnJson = { id, kind, role, text };
    if (raw["error"] === true) turn.error = true;
    if (isRecord(raw["agentSummary"])) {
      turn.agentSummary = raw["agentSummary"] as unknown as AgentSummaryJson;
    }
    turns.push(turn);
  }
  return turns;
}

/** One model-bound turn: the only shape the run's history argument takes. */
export interface HistorySeedTurn {
  role: "user" | "assistant";
  text: string;
}

/** The visible transcript as model seed. Mirrors desktop's `visibleHistory`
 *  turn for turn: streaming/error states never occur here (only settled
 *  turns persist), empty texts are dropped, and an assistant turn contributes
 *  its closing summary first (in one mode the summary IS the answer) falling
 *  back to its text. */
export function toHistorySeed(turns: readonly ChatTurnJson[]): HistorySeedTurn[] {
  const out: HistorySeedTurn[] = [];
  for (const turn of turns) {
    if (turn.error === true) continue;
    if (turn.role === "user") {
      const text = turn.text.trim();
      if (text.length > 0) out.push({ role: "user", text });
      continue;
    }
    const text = (turn.agentSummary?.summary ?? turn.text).trim();
    if (text.length > 0) out.push({ role: "assistant", text });
  }
  return out;
}

// ── ids ────────────────────────────────────────────────────────────────────

let boot: string | null = null;
let seq = 0;

/**
 * Mint the boot discriminator: 8 bytes (64 bits) from the platform CSPRNG,
 * with no fallback. The id scheme's uniqueness argument rests on the bits
 * being unpredictable across devices, and `Math.random` does not provide
 * that. Every environment this code ships in carries `crypto`; a missing
 * CSPRNG is an environment failure and fails loudly here rather than
 * silently minting collidable ids.
 */
function bootDiscriminator(): string {
  if (boot === null) {
    if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
      throw new Error("crypto.getRandomValues unavailable: cannot mint chat turn ids");
    }
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    boot = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return boot;
}

/** Mint a turn id: boot discriminator + zero-padded monotonic sequence. */
export function newTurnId(): string {
  seq += 1;
  return `${bootDiscriminator()}-${String(seq).padStart(10, "0")}`;
}

/** Test-only reset for the boot discriminator and sequence. */
export function __resetChatHistoryForTest(): void {
  boot = null;
  seq = 0;
  pending = null;
  lastPersisted = null;
  setLagging(false);
}

/**
 * Drop the staged write state on the vault-leaving paths (lock, switch):
 * one staged transcript plus the last-written payload, both full serialized
 * plaintext. Called from mobile `lockVault` next to `endAgentRun` (the vault
 * switch routes through it); it cannot live in the background flush, which
 * exists precisely to WRITE staged state rather than drop it. After this, a
 * lock keeps no conversation text in module RAM.
 */
export function clearChatHistoryPersistForLock(): void {
  pending = null;
  lastPersisted = null;
  setLagging(false);
}

// ── the write path + its background backstop ───────────────────────────────

interface PendingWrite {
  id: string | null;
  payload: string;
}

let pending: PendingWrite | null = null;
let lastPersisted: { id: string | null; payload: string } | null = null;

// Persist health, the desktop `isChatPersistLagging` twin (myne-md/myne#675
// review): a failed flush is no longer silent while the write stays staged.
// Rendered by `AiChatFlow` next to `historyError`, which covers only
// list/read failures.
let lagging = false;
const healthListeners = new Set<() => void>();

function setLagging(next: boolean): void {
  if (lagging === next) return;
  lagging = next;
  for (const listener of healthListeners) listener();
}

/** Whether the last flush failed and its write is still only staged. */
export function isChatHistoryLagging(): boolean {
  return lagging;
}

/** Subscribe to lagging changes; returns an unsubscribe. */
export function subscribeChatHistoryHealth(listener: () => void): () => void {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
}

/** Stage a transcript for writing. The write itself is `flushPendingTranscript`;
 *  staging and writing are separate so backgrounding can flush what a settle
 *  staged but never got to await (an in-flight append promise may die with
 *  the foreground (the ordinary case on a phone, not the exotic one). */
export function stageTranscript(id: string | null, turns: readonly ChatTurnJson[]): void {
  pending = { id, payload: serializeTranscript(turns) };
}

/** Write the staged transcript, if any, and report the conversation id it
 *  lives under (a fresh create mints one). Deduped against the last write:
 *  a stop-then-finalize pair landing on identical turns writes once. A
 *  failure keeps the pending write staged, so the next flush retries rather
 *  than dropping turns.
 *
 *  Serialized behind one queue: `stageTranscript` overwrites the single
 *  slot while a background `flushChatHistoryNow` can run concurrently with
 *  `persistPair`'s flush, and two in-flight flushes would otherwise land in
 *  IPC-completion order (an older transcript after a newer one, silently
 *  losing turns — the desktop twin closes the same shape with its `seq`
 *  rule). Each execution reads the CURRENT slot, so every flush in the queue
 *  writes the newest staged payload and the dedup collapses the rest. */
export function flushPendingTranscript(): Promise<string | null> {
  const run = flushChain.then(flushOnce);
  flushChain = run.then(
    () => null,
    () => null,
  );
  return run;
}

let flushChain: Promise<string | null> = Promise.resolve(null);

async function flushOnce(): Promise<string | null> {
  if (pending === null) return lastPersisted?.id ?? null;
  const { id, payload } = pending;
  if (
    lastPersisted !== null &&
    lastPersisted.id === id &&
    lastPersisted.payload === payload
  ) {
    pending = null;
    return lastPersisted.id;
  }
  try {
    const liveId = id === null ? await chatsCreate(payload) : id;
    if (id !== null) await chatsAppendTurn(id, payload);
    lastPersisted = { id: liveId, payload };
    pending = null;
    setLagging(false);
    return liveId;
  } catch {
    // Stays staged: the transcript on screen is unaffected, and the next
    // flush (or the next settle) retries with the full transcript. The
    // lagging flag says so on screen until a flush lands.
    setLagging(true);
    return lastPersisted?.id ?? null;
  }
}

/** The background-flush entry EditorFlow's one listener pair calls alongside
 *  the note and workspace flushes: settled turns a backgrounding interrupted
 *  still reach the vault. Best-effort and independent like its neighbours;
 *  it never throws. */
export async function flushChatHistoryNow(): Promise<void> {
  await flushPendingTranscript().catch(() => {});
}
