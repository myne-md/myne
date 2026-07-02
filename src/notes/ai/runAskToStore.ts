// Ask → render-store orchestration (semantic-search-qa MYND-412 tasks 6/7 +
// ai-ux-surface MYND-408). The connective tissue between the `ask` IPC command
// and the ephemeral AI-output store the AI Chat tab renders: dispatch `THINKING`
// before the blocking on-device inference, then `RESOLVED` with the grounded
// answer, or `FAILED` if the engine errors. Mirrors `runSummarizeToStore` — the
// AI Chat tab's Q&A input drives this the same way the summarize command drives
// that one, and both surface into the single `aiOutputStore` (which was designed
// to hold "a summary today; Q&A answers later").
//
// The answer is the model's own words over already-decrypted, non-excluded
// chunks (SYNC-3) — AS1 RAM, never logged, dropped on lock by the store's
// teardown. The `ask` fn is injectable so this orchestration is fully testable
// with a stub answerer + a spy dispatch (no Tauri IPC).

import {
  type AiOutputAction,
  beginAiRunEpoch,
  dispatchAiOutput,
  isAiRunCurrent,
} from "./aiOutputStore";

/**
 * Drive a grounded-Q&A pass into the render store. Dispatches `THINKING`, runs
 * the injected `ask` (the `local-inference|ask` IPC in production), then
 * `RESOLVED` with the answer text, or `FAILED` if it throws. A blank question
 * (whitespace only) is a no-op — no `THINKING`, no engine call. The `dispatch`
 * is injectable for tests; it defaults to the module store.
 */
export async function runAskToStore(args: {
  question: string;
  ask: (question: string) => Promise<string>;
  dispatch?: (action: AiOutputAction) => void;
}): Promise<void> {
  const dispatch = args.dispatch ?? dispatchAiOutput;
  const question = args.question.trim();
  if (question.length === 0) return; // nothing to ask — never call the engine
  // Epoch guard (see runSummarizeToStore): drop the answer if the user switched
  // notes / locked / started a newer run during the blocking inference, and keep
  // two overlapping asks from resolving out of order.
  const token = beginAiRunEpoch();
  dispatch({ type: "THINKING" });
  try {
    const answer = await args.ask(question);
    if (!isAiRunCurrent(token)) return;
    dispatch({
      type: "RESOLVED",
      text: answer,
      truncated: false,
      summarizedChars: 0,
    });
  } catch {
    // The engine error is a closed kind on the Rust side (DENY-list); the tab
    // shows a bounded error state, never the raw failure.
    if (!isAiRunCurrent(token)) return;
    dispatch({ type: "FAILED" });
  }
}
