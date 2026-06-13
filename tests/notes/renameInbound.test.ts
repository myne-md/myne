// Rename auto-update orchestrator (MYND-85 / §8.3 / WL-7 / WL-8). Composes the
// tested pure pieces (planInboundRewrites, partitionInbound) + injected I/O
// into the all-or-nothing batch. The deps are faked — no Tauri, no React.

import { describe, it, expect, vi } from "vitest";
import {
  applyInboundRewrites,
  planRenameBatch,
  type RenameInboundDeps,
} from "../../src/notes/renameInbound";
import { planInboundRewrites } from "../../src/notes/renameWikilinks";

const T = { oldTitle: "Old Title", newTitle: "New Title" };

describe("applyInboundRewrites", () => {
  it("applies a single planned rewrite (round-trips through the real planner)", () => {
    const body = "see [[Old Title]] here";
    const out = applyInboundRewrites(body, planInboundRewrites(body, T));
    expect(out).toBe("see [[New Title]] here");
  });

  it("applies multiple rewrites in one body (offsets stay valid)", () => {
    const body = "[[Old Title]] and again [[Old Title|alias]]";
    const out = applyInboundRewrites(body, planInboundRewrites(body, T));
    expect(out).toBe("[[New Title]] and again [[New Title|alias]]");
  });

  it("is offset-correct across non-ASCII chars around the link", () => {
    // Mixes a 1-UTF16-unit accented char ("é") and a surrogate-pair emoji
    // ("☕"/"🔗") — the apply uses the planner's lezer/UTF-16 offsets, so
    // string slicing must line up exactly.
    const body = "café [[Old Title]] 🔗 done";
    const out = applyInboundRewrites(body, planInboundRewrites(body, T));
    expect(out).toBe("café [[New Title]] 🔗 done");
  });

  it("is a no-op for an empty rewrite list", () => {
    expect(applyInboundRewrites("nothing here", [])).toBe("nothing here");
  });
});

/** Build deps over an in-memory note→body map; records flush calls. */
function fakeDeps(
  bodies: Record<string, string>,
  opts: {
    sources?: string[];
    open?: string[];
    onFlush?: () => void;
  } = {},
): RenameInboundDeps {
  return {
    findBacklinkSources: async () => opts.sources ?? [],
    readBody: async (id) => bodies[id] ?? "",
    openNoteIds: () => new Set(opts.open ?? []),
    flushOpenPanes: async () => opts.onFlush?.(),
  };
}

describe("planRenameBatch", () => {
  const base = {
    renamedNoteId: "R",
    oldTitle: "Old Title",
    newTitle: "New Title",
    renamedNewBody: "# New Title\nbody",
    preNotes: [],
  };

  it("untitled-before rename → only the renamed note, no inbound", async () => {
    const plan = await planRenameBatch(fakeDeps({}), {
      ...base,
      oldTitle: null,
    });
    expect(plan.batch).toEqual([{ noteId: "R", plaintext: "# New Title\nbody" }]);
    expect(plan.inboundIds).toEqual([]);
  });

  it("puts the renamed note first, then each rewritten inbound note", async () => {
    const deps = fakeDeps(
      { A: "links [[Old Title]]", B: "also [[Old Title|x]]" },
      { sources: ["A", "B"] },
    );
    const plan = await planRenameBatch(deps, base);
    expect(plan.batch[0]).toEqual({ noteId: "R", plaintext: "# New Title\nbody" });
    expect(plan.batch.slice(1)).toEqual([
      { noteId: "A", plaintext: "links [[New Title]]" },
      { noteId: "B", plaintext: "also [[New Title|x]]" },
    ]);
    expect(plan.inboundIds).toEqual(["A", "B"]);
  });

  it("excludes a self-link source (the renamed note's own body is handled separately)", async () => {
    const deps = fakeDeps(
      { R: "self [[Old Title]]", A: "links [[Old Title]]" },
      { sources: ["R", "A"] },
    );
    const plan = await planRenameBatch(deps, base);
    expect(plan.inboundIds).toEqual(["A"]);
    expect(plan.batch.map((e) => e.noteId)).toEqual(["R", "A"]);
  });

  it("skips a source whose rewrite plan is empty (no matching ref)", async () => {
    const deps = fakeDeps(
      { A: "links [[Old Title]]", B: "no link here" },
      { sources: ["A", "B"] },
    );
    const plan = await planRenameBatch(deps, base);
    expect(plan.inboundIds).toEqual(["A"]);
  });

  it("WL-8: flushes panes before reading when an inbound note is open", async () => {
    const flush = vi.fn();
    const deps = fakeDeps(
      { A: "links [[Old Title]]" },
      { sources: ["A"], open: ["A"], onFlush: flush },
    );
    await planRenameBatch(deps, base);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("WL-8: does NOT flush when every inbound note is closed", async () => {
    const flush = vi.fn();
    const deps = fakeDeps(
      { A: "links [[Old Title]]" },
      { sources: ["A"], open: [], onFlush: flush },
    );
    await planRenameBatch(deps, base);
    expect(flush).not.toHaveBeenCalled();
  });

  it("reads inbound bodies AFTER the flush (so the rewrite sees current content)", async () => {
    const bodies: Record<string, string> = { A: "stale [[Old Title]]" };
    const deps: RenameInboundDeps = {
      findBacklinkSources: async () => ["A"],
      readBody: async (id) => bodies[id] ?? "",
      openNoteIds: () => new Set(["A"]),
      // The flush writes the editor's unsaved edits to "disk" — the read below
      // must observe THIS, not the pre-flush body (SYNC-15).
      flushOpenPanes: async () => {
        bodies.A = "fresh [[Old Title]] edit";
      },
    };
    const plan = await planRenameBatch(deps, base);
    expect(plan.batch[1]).toEqual({
      noteId: "A",
      plaintext: "fresh [[New Title]] edit",
    });
  });
});
