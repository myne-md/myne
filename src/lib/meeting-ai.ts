// Meeting AI IPC wrapper (meeting-ai task 2).
//
// The one call path to the local-inference `infer_batch` command: an ordered
// batch of prompts, a per-completed-prompt progress channel, and a stop that
// rides the shared `chat_stop` cancel token (the same one transcription fires),
// because the batch command registers a user-reachable cancel window. The
// prompts are assembled in RAM by `notes/ai/meetingPrompts.ts` and never
// stored; the transcript chunks are plaintext note content and cross IPC exactly
// as the note-summarization prompt does.

import { Channel, invoke } from "../platform/core";

export type BatchProgress = (done: number, total: number) => void;

export interface InferBatchRun {
  /** Resolves with the outputs that completed (fewer than requested on a stop). */
  done: Promise<string[]>;
  /** Signal the running batch to stop. */
  stop: () => void;
}

/** A batch runner: prompts in, completed outputs out, with progress and stop. */
export type RunBatch = (
  prompts: readonly string[],
  onProgress: BatchProgress,
) => InferBatchRun;

/** The production batch runner over `plugin:local-inference|infer_batch`. */
export const runInferBatch: RunBatch = (prompts, onProgress) => {
  const list = [...prompts];
  const channel = new Channel<number>();
  channel.onmessage = (done) => onProgress(done, list.length);
  const done = invoke<string[]>("plugin:local-inference|infer_batch", {
    prompts: list,
    // `null` is the unbounded path: the engine's own generation budget applies.
    maxNewTokens: null,
    onProgress: channel,
  });
  return {
    done,
    stop: () => {
      // The shared cancel token. A benign race (nothing in flight) is not an
      // error, so the rejection is swallowed.
      void invoke("plugin:local-inference|chat_stop").catch(() => {});
    },
  };
};
