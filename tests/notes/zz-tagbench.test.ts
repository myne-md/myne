// TEMPORARY bench spec — delete after the prompt search.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseTagCandidates } from "../../src/notes/ai/suggestTags";
import { rankTagCandidates } from "../../src/notes/ai/tagRanker";

const dir = process.env.MYNE_BENCH_DIR ?? "/tmp/tagbench";
const replies = JSON.parse(readFileSync(`${dir}/replies2.json`, "utf8")) as Record<
  string,
  Record<string, { runs: { seed: number; reply: string }[] }>
>;

describe("prompt bench round 2", () => {
  it("turns every run into chips with the real code", () => {
    const out: Record<string, Record<string, string[][]>> = {};
    for (const [noteId, variants] of Object.entries(replies)) {
      out[noteId] = {};
      for (const [name, v] of Object.entries(variants)) {
        out[noteId]![name] = v.runs.map((run) =>
          rankTagCandidates([], parseTagCandidates(run.reply))
            .slice(0, 8)
            .map((s) => s.tag),
        );
      }
    }
    writeFileSync(`${dir}/chips2.json`, JSON.stringify(out));
    expect(Object.keys(out).length).toBeGreaterThan(0);
  });
});
