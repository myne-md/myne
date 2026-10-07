// Meeting AI: the map-reduce orchestration (meeting-ai task 2).
//
// The pass is two batches. The MAP batch summarizes each transcript chunk with
// the fixed mechanical prompt; the REDUCE batch turns those summaries into the
// requested sections with the default instruction or the user's custom one.
// Each batch is driven through an injected `runBatch`, so this module stays
// free of IPC and is testable with a stub (the same shape `runSummarize` uses
// for its `infer`).
//
// A stop, or a batch that returns fewer outputs than it was given, is a
// cancellation rather than a failure: the result says so and carries no
// sections. Nothing here writes a note, so a cancelled pass cannot lose data;
// the write is a separate, approval-gated step.

import type { RunBatch } from "../../lib/meeting-ai";
import { chunkTranscript } from "./meetingChunk";
import { buildMapPrompt, buildReducePrompt } from "./meetingPrompts";
import {
  parseSections,
  type MeetingSectionId,
  type MeetingSections,
} from "./meetingSections";

/** Characters per transcript chunk. A token proxy until a tokenizer lands. */
export const MEETING_CHUNK_BUDGET = 6000;
/** Whole tokens of overlap between chunks, so a boundary thought is in both. */
export const MEETING_CHUNK_OVERLAP = 200;
/** Reduce-side budget. When the chunk summaries together exceed this, they are
 *  condensed in groups first (a tree reduce) before the section-producing
 *  reduce, so a meeting far past the model context is summarized whole rather
 *  than only its first part. */
export const MEETING_REDUCE_BUDGET = 6000;

function joinedLength(items: readonly string[]): number {
  return items.reduce((n, s) => n + s.length + 2, 0);
}

/** Split `items` into consecutive groups whose joined length fits `budget`. A
 *  single over-budget item gets its own group rather than being cut. */
function groupByBudget(items: readonly string[], budget: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let len = 0;
  for (const item of items) {
    if (current.length > 0 && len + item.length + 2 > budget) {
      groups.push(current);
      current = [];
      len = 0;
    }
    current.push(item);
    len += item.length + 2;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export interface MeetingRunOptions {
  transcript: string;
  sections: readonly MeetingSectionId[];
  /** Replaces the reduce instruction entirely when set and non-blank. */
  customInstruction?: string | null;
  budget?: number;
  overlap?: number;
  onProgress?: (done: number, total: number) => void;
  runBatch: RunBatch;
}

export interface MeetingRunResult {
  sections: MeetingSections;
  /** True when the pass was stopped, or a batch came back short. */
  cancelled: boolean;
}

export interface MeetingRun {
  result: Promise<MeetingRunResult>;
  stop: () => void;
}

const CANCELLED: MeetingRunResult = { sections: {}, cancelled: true };
const EMPTY: MeetingRunResult = { sections: {}, cancelled: false };

/** Start the pass. `stop()` reaches whichever batch is currently running. */
export function startMeetingAi(opts: MeetingRunOptions): MeetingRun {
  let current: { stop: () => void } | null = null;
  let stopped = false;
  const progress = opts.onProgress ?? ((): void => {});

  const result = (async (): Promise<MeetingRunResult> => {
    const chunks = chunkTranscript(opts.transcript, {
      budget: opts.budget ?? MEETING_CHUNK_BUDGET,
      overlap: opts.overlap ?? MEETING_CHUNK_OVERLAP,
    });
    if (chunks.length === 0) return EMPTY;

    const map = opts.runBatch(
      chunks.map((chunk) => buildMapPrompt(chunk.text)),
      progress,
    );
    current = map;
    const summaries = await map.done;
    if (stopped || summaries.length < chunks.length) return CANCELLED;

    // Tree reduce: condense the summaries in groups until they fit the reduce
    // budget, so a meeting far past the model context is summarized whole
    // rather than only its first part. Each level uses the map instruction,
    // which is the "condense this text" prompt.
    let condensed = summaries;
    while (
      joinedLength(condensed) > MEETING_REDUCE_BUDGET &&
      condensed.length > 1
    ) {
      const groups = groupByBudget(condensed, MEETING_REDUCE_BUDGET);
      if (groups.length >= condensed.length) break;
      const condense = opts.runBatch(
        groups.map((group) => buildMapPrompt(group.join("\n\n"))),
        progress,
      );
      current = condense;
      const out = await condense.done;
      if (stopped || out.length < groups.length) return CANCELLED;
      condensed = out;
    }

    const reduce = opts.runBatch(
      [buildReducePrompt(condensed, opts.sections, opts.customInstruction)],
      progress,
    );
    current = reduce;
    const outputs = await reduce.done;
    if (stopped || outputs.length === 0) return CANCELLED;

    return { sections: parseSections(outputs[0] ?? ""), cancelled: false };
  })();

  return {
    result,
    stop: () => {
      stopped = true;
      current?.stop();
    },
  };
}
