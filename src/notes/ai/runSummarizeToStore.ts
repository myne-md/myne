// Summarize → render-store orchestration (note-summarization MYND-409 tasks
// 3 + 4). The connective tissue between the pure `runSummarize` pipeline and the
// ephemeral AI-output store the AI Chat tab renders: dispatch `THINKING` before
// the blocking `infer`, then `RESOLVED` with the summary + truncation notice, or
// `FAILED` if the engine errors. Kept out of the pure `summarize.ts` so that
// module stays React-free; this is the one place the two are wired.
//
// The only remaining un-unit-testable seam is the caller (the `onSummarizeNote`
// command handler) supplying the live `EditorState` + the `local-inference|infer`
// IPC — this orchestration is fully testable with a stub `infer` + a spy
// dispatch.

import type { EditorState } from "@codemirror/state";

import {
  type AiOutputAction,
  beginAiRunEpoch,
  dispatchAiOutput,
  isAiRunCurrent,
} from "./aiOutputStore";
import { runSummarize } from "./summarize";

/**
 * Drive a summarize pass into the render store. Dispatches `THINKING`, runs the
 * pure `runSummarize` pipeline (resolve → truncate → assemble → blocking
 * `infer`), then `RESOLVED` (summary + truncation notice) or `FAILED`. The
 * `dispatch` is injectable for tests; it defaults to the module store.
 */
export async function runSummarizeToStore(args: {
  state: EditorState;
  budget: number;
  infer: (prompt: string) => Promise<string>;
  dispatch?: (action: AiOutputAction) => void;
}): Promise<void> {
  const dispatch = args.dispatch ?? dispatchAiOutput;
  // Capture this run's epoch: if the user switches notes, locks, or starts a
  // newer run during the blocking infer, the stale result is dropped rather than
  // rendered against (or inserted into) the wrong note.
  const token = beginAiRunEpoch();
  dispatch({ type: "THINKING" });
  try {
    const outcome = await runSummarize({
      state: args.state,
      budget: args.budget,
      infer: args.infer,
    });
    if (!isAiRunCurrent(token)) return;
    dispatch({
      type: "RESOLVED",
      text: outcome.summary,
      truncated: outcome.truncated,
      summarizedChars: outcome.summarizedChars,
    });
  } catch {
    // The engine error is a closed kind on the Rust side (DENY-list); the tab
    // shows a bounded error state, never the raw failure.
    if (!isAiRunCurrent(token)) return;
    dispatch({ type: "FAILED" });
  }
}
