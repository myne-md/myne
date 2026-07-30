// Importer source seam — plan/load contract + the D3 discipline (MYND-579).
//
// The pre-existing `tests/notes/import-*.test.ts` suites are the behavioural
// regression gate for the generalization (they drive `importVault`, which now runs
// through `createObsidianSource`). THIS suite covers what is new: the seam contract,
// the D3 one-item-in-RAM rule, determinate `total` for a source with no filesystem,
// and `lossy` propagation into `ImportResult.lossyNotes`.

import { describe, expect, it } from "vitest";
import {
  importFromSource,
  importVault,
  type ImportPorts,
  type ImportResult,
} from "../../src/notes/import/engine";
import { createObsidianSource } from "../../src/notes/import/sources/obsidian";
import { emptyIgnoreCounts } from "../../src/notes/import/skipPredicate";
import type {
  ImportItemRef,
  ImportPlan,
  ImportSink,
  ImportSource,
  LoadedItem,
} from "../../src/notes/import/source";

/** A sink that records what was written. */
function recordingSink(): ImportSink & { created: string[]; folders: string[][] } {
  const created: string[] = [];
  const folders: string[][] = [];
  return {
    created,
    folders,
    async createNote(plaintext) {
      created.push(plaintext);
      return `id-${created.length}`;
    },
    async setDeliberateFolders(f) {
      folders.push([...f]);
    },
  };
}

/** A source with no filesystem at all — the `.enex` shape (one blob → N notes). */
function blobSource(notes: readonly { name: string; body: string; lossy?: string[] }[]) {
  let concurrent = 0;
  let maxConcurrent = 0;
  let liveBodies = 0;
  let maxLiveBodies = 0;
  const source: ImportSource = {
    id: "evernote",
    async plan(): Promise<ImportPlan> {
      return {
        // Descriptors only — indices into the blob, never the bodies themselves.
        items: notes.map((n, i) => ({ relPath: `${n.name}.md`, handle: i })),
        dirs: [],
        ignore: emptyIgnoreCounts(),
      };
    },
    async load(ref: ImportItemRef): Promise<LoadedItem> {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      liveBodies++;
      maxLiveBodies = Math.max(maxLiveBodies, liveBodies);
      await Promise.resolve();
      const n = notes[ref.handle as number]!;
      const out = { markdown: n.body, lossy: n.lossy ?? [] };
      concurrent--;
      // The engine consumes the markdown synchronously after the await, so by the
      // time the NEXT load runs the previous body is releasable.
      liveBodies--;
      return out;
    },
  };
  return {
    source,
    stats: () => ({ maxConcurrent, maxLiveBodies }),
  };
}

async function run(source: ImportSource): Promise<{
  result: ImportResult;
  sink: ReturnType<typeof recordingSink>;
}> {
  const sink = recordingSink();
  const result = await importFromSource(source, sink, new Set(), "skip");
  return { result, sink };
}

describe("ImportSource seam — plan/load contract", () => {
  it("ingests every planned item through the shared loop", async () => {
    const { source } = blobSource([
      { name: "One", body: "# One\n\nbody one" },
      { name: "Two", body: "# Two\n\nbody two" },
    ]);
    const { result, sink } = await run(source);
    expect(result.imported).toBe(2);
    expect(result.total).toBe(2);
    expect(sink.created).toHaveLength(2);
  });

  it("keeps `total` determinate for a source with no filesystem", async () => {
    // The reason the seam is plan+load rather than a bare async generator: a
    // streaming source would not know N until it finished, breaking "X of N".
    const { source } = blobSource(
      Array.from({ length: 7 }, (_, i) => ({ name: `N${i}`, body: `# N${i}` })),
    );
    const seen: Array<[number, number]> = [];
    const sink = recordingSink();
    const result = await importFromSource(source, sink, new Set(), "skip", {
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(result.total).toBe(7);
    // Every progress tick carries the final denominator from the very first call.
    expect(seen.every(([, total]) => total === 7)).toBe(true);
    expect(seen[0]).toEqual([1, 7]);
  });

  it("loads serially — one item's markdown live at a time (D3)", async () => {
    const { source, stats } = blobSource(
      Array.from({ length: 12 }, (_, i) => ({ name: `N${i}`, body: `# N${i}` })),
    );
    await run(source);
    const { maxConcurrent, maxLiveBodies } = stats();
    expect(maxConcurrent).toBe(1);
    expect(maxLiveBodies).toBe(1);
  });

  it("stops loading once cancelled and reports the remainder", async () => {
    const { source } = blobSource(
      Array.from({ length: 5 }, (_, i) => ({ name: `N${i}`, body: `# N${i}` })),
    );
    const sink = recordingSink();
    let done = 0;
    const result = await importFromSource(source, sink, new Set(), "skip", {
      shouldCancel: () => done >= 2,
      onProgress: () => {
        done++;
      },
    });
    expect(result.cancelled).toBe(3);
    expect(result.imported).toBe(2);
  });
});

describe("ImportSource seam — lossy propagation", () => {
  it("records a LossyNote per created note that lost something", async () => {
    const { source } = blobSource([
      { name: "Clean", body: "# Clean" },
      { name: "Lossy", body: "# Lossy", lossy: ["iframe", "toggle"] },
    ]);
    const { result } = await run(source);
    expect(result.lossyNotes).toHaveLength(1);
    expect(result.lossyNotes[0]).toMatchObject({
      relPath: "Lossy.md",
      title: "Lossy",
      dropped: ["iframe", "toggle"],
    });
  });

  it("does not record loss for a note that was skipped as a duplicate", async () => {
    // No note exists for the report to link to, so recording it would produce a
    // dangling wikilink in the generated import report (MYND-585).
    const { source } = blobSource([
      { name: "Dup", body: "# Dup", lossy: ["iframe"] },
    ]);
    const sink = recordingSink();
    const { noteIdentityKey } = await import("../../src/notes/import/conflict");
    const existing = new Set([noteIdentityKey(null, "Dup")]);
    const result = await importFromSource(source, sink, existing, "skip");
    expect(result.skippedExisting).toBe(1);
    expect(result.lossyNotes).toEqual([]);
  });

  it("is an empty list for a lossless source", async () => {
    const { source } = blobSource([{ name: "A", body: "# A" }]);
    const { result } = await run(source);
    expect(result.lossyNotes).toEqual([]);
  });
});

describe("Obsidian source — behaviour-preserving extraction", () => {
  function fakePorts(tree: Record<string, string[]>, files: Record<string, string>) {
    const ports: ImportPorts = {
      async readDir(abs) {
        const entries = tree[abs] ?? [];
        return entries.map((name) => ({
          name: name.replace(/\/$/, ""),
          isDir: name.endsWith("/"),
        }));
      },
      async readFile(abs) {
        return files[abs] ?? "";
      },
      async createNote() {
        return "id";
      },
      async setDeliberateFolders() {},
    };
    return ports;
  }

  it("plans the same items and tallies the old walk produced", async () => {
    const ports = fakePorts(
      {
        "/v": ["a.md", "b.canvas", "notes/", ".obsidian/", "img.png"],
        "/v/notes": ["c.md"],
      },
      { "/v/a.md": "# A", "/v/notes/c.md": "# C" },
    );
    const plan = await createObsidianSource("/v", ports).plan();
    expect(plan.items.map((i) => i.relPath)).toEqual(["a.md", "notes/c.md"]);
    expect(plan.dirs).toEqual(["notes"]);
    expect(plan.ignore).toEqual({
      canvasSkipped: 1,
      excalidrawSkipped: 0,
      nonMarkdownSkipped: 1,
      hiddenIgnored: 1,
    });
  });

  it("loads file bytes verbatim with no lossy entries", async () => {
    const ports = fakePorts({ "/v": ["a.md"] }, { "/v/a.md": "# A\n\nverbatim  bytes" });
    const loaded = await createObsidianSource("/v", ports).load({ relPath: "a.md" });
    expect(loaded.markdown).toBe("# A\n\nverbatim  bytes");
    expect(loaded.lossy).toEqual([]);
  });

  it("importVault still routes through the source and reports lossyNotes", async () => {
    const ports = fakePorts({ "/v": ["a.md"] }, { "/v/a.md": "# A" });
    const result = await importVault("/v", ports, new Set(), "skip");
    expect(result.imported).toBe(1);
    expect(result.lossyNotes).toEqual([]);
  });
});
