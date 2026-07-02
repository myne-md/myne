// Tag-suggest → render-store orchestration (auto-tag-link MYND-411 tasks 2-4).
// The connective tissue between `runTagSuggestionPass` (the exclusion-gated,
// infer-once pass) and the `tagSuggestStore` the AI Chat tab renders as chips:
// dispatch `THINKING`, run the pass, then `READY` (ranked suggestions) or
// `FAILED`. A note in an excluded folder yields `idle` (no model call, no chips)
// — the pass returns `skipped`. `dispatch` is injectable for tests.

import {
  type TagSuggestAction,
  beginTagRunEpoch,
  dispatchTagSuggest,
  isTagRunCurrent,
} from "./tagSuggestStore";
import { runTagSuggestionPass } from "./suggestTags";

export async function runTagSuggestToStore(args: {
  noteBody: string;
  noteFolder: string;
  existingTags: readonly string[];
  excludedFolders: readonly string[];
  infer: (prompt: string) => Promise<string>;
  dispatch?: (action: TagSuggestAction) => void;
}): Promise<void> {
  const dispatch = args.dispatch ?? dispatchTagSuggest;
  // Epoch guard (see aiOutputStore): drop the suggestions if the user switched
  // notes / locked / started a newer run during the blocking infer.
  const token = beginTagRunEpoch();
  dispatch({ type: "THINKING" });
  try {
    const pass = await runTagSuggestionPass({
      noteBody: args.noteBody,
      noteFolder: args.noteFolder,
      existingTags: args.existingTags,
      excludedFolders: args.excludedFolders,
      infer: args.infer,
    });
    if (!isTagRunCurrent(token)) return;
    if (pass.skipped) {
      // Excluded folder → no pass ran; leave the tab empty (idle), not an error.
      dispatch({ type: "CLEARED" });
      return;
    }
    dispatch({ type: "READY", suggestions: pass.suggestions });
  } catch {
    if (!isTagRunCurrent(token)) return;
    dispatch({ type: "FAILED" });
  }
}
