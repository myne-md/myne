// Obsidian importer — engine walk + serial ingest + cancel (MYND-53, tasks 3–5).
// IO is faked via injected ports; no Tauri, no real fs.

import { describe, it, expect, vi } from "vitest";
import {
  importVault,
  type ImportDirEntry,
  type ImportPorts,
} from "../../src/notes/import/engine";
import {
  buildExistingIdentitySet,
  type ExistingNote,
} from "../../src/notes/import/conflict";

/** A fake directory tree: a node is a directory (record) or a file (string body). */
type Tree = { [name: string]: Tree | string };

function resolve(tree: Tree, root: string, absPath: string): Tree | string {
  const rel = absPath === root ? "" : absPath.slice(root.length + 1);
  let node: Tree | string = tree;
  if (rel.length > 0) {
    for (const seg of rel.split("/")) {
      if (typeof node === "string") throw new Error("not a dir");
      node = node[seg]!;
    }
  }
  return node;
}

interface Harness {
  ports: ImportPorts;
  created: string[];
  deliberateWrites: string[][];
}

function harness(tree: Tree, root = "/v"): Harness {
  const created: string[] = [];
  const deliberateWrites: string[][] = [];
  let id = 0;
  const ports: ImportPorts = {
    async readDir(absPath) {
      const node = resolve(tree, root, absPath);
      if (typeof node === "string") throw new Error("not a dir");
      return Object.entries(node).map(
        ([name, child]): ImportDirEntry => ({
          name,
          isDir: typeof child !== "string",
        }),
      );
    },
    async readFile(absPath) {
      const node = resolve(tree, root, absPath);
      if (typeof node !== "string") throw new Error("not a file");
      return node;
    },
    async createNote(plaintext) {
      created.push(plaintext);
      return `id-${id++}`;
    },
    async setDeliberateFolders(folders) {
      deliberateWrites.push([...folders]);
    },
  };
  return { ports, created, deliberateWrites };
}

const note = (folder: string | null, title: string | null): ExistingNote => ({
  folder,
  title,
  trashed: null,
  template: false,
});

describe("importVault — walk, classify, serial ingest", () => {
  it("ingests .md files (folder: injected), recurses non-dot dirs, counts skips", async () => {
    const h = harness({
      "root.md": "# root\n",
      Projects: {
        "spec.md": "# spec\n",
        "board.canvas": "{}",
        "image.png": "binary",
      },
      ".obsidian": { "app.json": "{}" }, // dot-dir → skipped whole
      ".DS_Store": "junk", // dot-file → hidden
    });
    const r = await importVault("/v", h.ports, new Set(), "skip");

    expect(r.total).toBe(2); // root.md + Projects/spec.md
    expect(r.imported).toBe(2);
    expect(h.created.some((p) => p.includes("folder: Projects/"))).toBe(true);
    expect(h.created.some((p) => p === "# root\n")).toBe(true); // root → no folder:
    expect(r.ignore.canvasSkipped).toBe(1);
    expect(r.ignore.nonMarkdownSkipped).toBe(1); // image.png
    expect(r.ignore.hiddenIgnored).toBe(2); // .obsidian dir + .DS_Store
    expect(r.cancelled).toBeNull();
  });

  it("idempotent skip: a (folder,title) already in the vault is not re-created", async () => {
    const h = harness({ Projects: { "spec.md": "# spec\n" }, "fresh.md": "x\n" });
    const existing = buildExistingIdentitySet([note("Projects/", "spec")]);
    const r = await importVault("/v", h.ports, existing, "skip");
    expect(r.skippedExisting).toBe(1);
    expect(r.imported).toBe(1); // only fresh.md
    expect(h.created).toHaveLength(1);
  });

  it("import-as-copy creates even on a match", async () => {
    const h = harness({ Projects: { "spec.md": "# spec\n" } });
    const existing = buildExistingIdentitySet([note("Projects/", "spec")]);
    const r = await importVault("/v", h.ports, existing, "import-as-copy");
    expect(r.imported).toBe(1);
    expect(r.skippedExisting).toBe(0);
  });

  it("preserves an empty source dir via one set_deliberate_folders write (SYNC-4)", async () => {
    const h = harness({
      Projects: { "spec.md": "# spec\n" },
      Empty: {}, // no note beneath
    });
    const r = await importVault("/v", h.ports, new Set(), "skip");
    expect(r.emptyFoldersPreserved).toBe(1);
    expect(h.deliberateWrites).toEqual([["Empty/"]]);
  });
});

describe("importVault — cancellation keeps the partial import (SYNC-6)", () => {
  it("cancel after the first file leaves it created and reports remaining", async () => {
    const h = harness({ "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" });
    let done = 0;
    const r = await importVault("/v", h.ports, new Set(), "skip", {
      onProgress: () => {
        done++;
      },
      shouldCancel: () => done >= 1, // cancel before the 2nd file
    });
    expect(h.created).toHaveLength(1); // partial kept, no rollback
    expect(r.imported).toBe(1);
    expect(r.cancelled).toBe(2); // 2 of 3 remaining
    expect(r.total).toBe(3);
  });

  it("no write port other than createNote / setDeliberateFolders is used (no plaintext-to-disk)", async () => {
    const h = harness({ "a.md": "a\n" });
    const createSpy = vi.spyOn(h.ports, "createNote");
    await importVault("/v", h.ports, new Set(), "skip");
    expect(createSpy).toHaveBeenCalledTimes(1); // the ONLY write path is note_create
  });
});
