// Grounded Q&A IPC wrapper (semantic-search-qa MYND-412, tasks 6 + 7). The thin
// TS binding for the local-inference `ask` command: it embeds the question,
// retrieves the top-k resident chunks, assembles a grounding context from the
// already-decrypted note bodies, and runs a blocking on-device `infer` — all in
// the Rust host, no provider call, no streaming (SYNC-2/7). Mirrors the
// `infer` / model-store wrappers; adds no new capability or CSP origin.
//
// The answer + its source chunk set are AS1-class RAM (the model's own words +
// note-local byte-ranges) — never logged here, dropped on lock by the render
// store's teardown (`clearAiOutput`) like the summarize output.

import { invoke } from "@tauri-apps/api/core";

/** One retrieved source chunk backing an answer, for citation. Mirrors the Rust
 *  `SearchHit` (snake_case serde fields). */
export interface AiSource {
  note_id: string;
  byte_start: number;
  byte_end: number;
  score: number;
}

/** The grounded answer + the source chunks it was grounded on. Mirrors the Rust
 *  `AskResult`. `answer` is empty when nothing resident could ground the
 *  question (no model call was made). */
export interface AskResult {
  answer: string;
  sources: AiSource[];
}

/** Default number of chunks to retrieve + ground on. Kept modest so the
 *  assembled context stays inside the model's window (the Rust side is the
 *  binding authority; this is only the request hint). */
export const ASK_DEFAULT_K = 6;

/** Ask a natural-language question over the resident (embedded) vault. Returns
 *  the grounded answer + its source set. Local-only; never sends the question
 *  anywhere (the no-egress gate is the structural guarantee). */
export async function askQuestion(question: string, k: number = ASK_DEFAULT_K): Promise<AskResult> {
  return await invoke<AskResult>("plugin:local-inference|ask", { question, k });
}
