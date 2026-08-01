// Obsidian importer — engine walk + serial ingest + cancel (MYND-53, tasks 3–5).
// IO is faked via injected ports; no Tauri, no real fs.

import { describe, it, expect, vi } from "vitest";
import {
  importVault,
  type ImportDirEntry,
  type ImportPorts,
} from "../../src/notes/import/engine";
import type { EntryLink } from "../../src/notes/import/source";
import {
  buildExistingIdentitySet,
  type ExistingNote,
} from "../../src/notes/import/conflict";

/**
 * A symlink in the fake tree, standing in for what the HOST resolved: only the
 * Rust side can follow a link, so the walk sees this verdict and nothing else.
 */
interface LinkNode {
  readonly kind: "link";
  readonly link: EntryLink;
  /** The node the link resolves to — `null` for a refused or dangling link. */
  readonly target: Tree | string | null;
}

function symlink(link: EntryLink, target: Tree | string | null = null): LinkNode {
  return { kind: "link", link, target };
}

function isLink(node: Node): node is LinkNode {
  return typeof node === "object" && node !== null && (node as LinkNode).kind === "link";
}

/** A fake directory tree: a node is a directory (record), a file (string body)
 *  or a symlink the host already resolved. */
type Node = Tree | string | LinkNode;
type Tree = { [name: string]: Node };

function resolve(tree: Tree, root: string, absPath: string): Tree | string {
  const rel = absPath === root ? "" : absPath.slice(root.length + 1);
  let node: Node = tree;
  if (rel.length > 0) {
    for (const seg of rel.split("/")) {
      if (isLink(node)) node = node.target ?? {};
      if (typeof node === "string") throw new Error("not a dir");
      node = node[seg]!;
    }
  }
  if (isLink(node)) return node.target ?? {};
  return node;
}

interface Harness {
  ports: ImportPorts;
  created: string[];
  deliberateWrites: string[][];
}

interface HarnessOptions {
  /** Source-relative paths whose read rejects, and with what. */
  readFails?: Record<string, unknown>;
  /** Reject the Nth `createNote` (1-based) with `createError`. */
  createFailsOn?: number;
  createError?: unknown;
  /** Reject the deliberate-folders write. */
  deliberateFails?: boolean;
}

function harness(tree: Tree, root = "/v", opts: HarnessOptions = {}): Harness {
  const created: string[] = [];
  const deliberateWrites: string[][] = [];
  let id = 0;
  const ports: ImportPorts = {
    async readDir(absPath) {
      const node = resolve(tree, root, absPath);
      if (typeof node === "string") throw new Error("not a dir");
      return Object.entries(node).map(([name, child]): ImportDirEntry => {
        if (isLink(child)) {
          return {
            name,
            // Only a followable link to a DIRECTORY walks as one — the host
            // resolves that, `file_type()` alone cannot.
            isDir:
              child.link.status === "followable" &&
              typeof child.target === "object" &&
              child.target !== null,
            link: child.link,
          };
        }
        return { name, isDir: typeof child !== "string", link: null };
      });
    },
    async readFile(absPath) {
      const rel = absPath === root ? "" : absPath.slice(root.length + 1);
      if (opts.readFails && rel in opts.readFails) throw opts.readFails[rel];
      const node = resolve(tree, root, absPath);
      if (typeof node !== "string") throw new Error("not a file");
      return node;
    },
    async createNote(plaintext) {
      if (opts.createFailsOn !== undefined && created.length + 1 === opts.createFailsOn) {
        throw opts.createError ?? { kind: "Io", io_error_kind: "NoSpace" };
      }
      created.push(plaintext);
      return `id-${id++}`;
    },
    async setDeliberateFolders(folders) {
      if (opts.deliberateFails) throw new Error("nope");
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
    // root file: filename title injected, body preserved, no folder field.
    expect(
      h.created.some(
        (p) => p.includes("title: root") && p.includes("# root\n") && !p.includes("folder:"),
      ),
    ).toBe(true);
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

  it("idempotent skip when the note's own `folder:` FM diverges from its path (SYNC-5)", async () => {
    // The file is at Notes/todo.md but declares `folder: Archive`, so it persists
    // under Archive/ and the live-set keys it there. Keying dedup on the
    // path-derived folder ("Notes") would miss and re-create it every re-import.
    const h = harness({
      Notes: { "todo.md": "---\nfolder: Archive\ntitle: Todo\n---\nbody\n" },
    });
    const existing = buildExistingIdentitySet([note("Archive", "Todo")]);
    const r = await importVault("/v", h.ports, existing, "skip");
    expect(r.skippedExisting).toBe(1);
    expect(r.imported).toBe(0);
    expect(h.created).toHaveLength(0); // no duplicate
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

// myne-md/myne#223 defect 1. A symlinked folder used to report `is_dir: false`,
// so the walk never entered it and everything under it vanished behind a muted
// "other files skipped" count. The host now resolves the link and says what it
// is; these pin what the walk does with each verdict.
describe("importVault — symlinked folders are walked, refusals are named", () => {
  const followable = (key: string): EntryLink => ({ status: "followable", targetKey: key });

  it("walks a symlinked folder like any other folder", async () => {
    const h = harness({
      "a.md": "a\n",
      External: symlink(followable("k-external"), { "b.md": "b\n", Deep: { "c.md": "c\n" } }),
    });
    const r = await importVault("/v", h.ports, new Set(), "skip");
    expect(r.imported).toBe(3);
    expect(r.total).toBe(3);
    // NOT counted as a skipped non-markdown file, which is what the name-only
    // classifier used to do with a folder called `External`.
    expect(r.ignore.nonMarkdownSkipped).toBe(0);
    expect(r.unfollowedLinks).toEqual([]);
  });

  it("reads a symlinked FILE like any other file", async () => {
    const h = harness({ "alias.md": symlink(followable("k-file"), "aliased\n") });
    const r = await importVault("/v", h.ports, new Set(), "skip");
    expect(r.imported).toBe(1);
    expect(h.created[0]).toContain("aliased");
  });

  it.each([
    ["outside the picked folder", { status: "outside" } as const, "outside"],
    ["a dangling link", { status: "broken" } as const, "broken"],
    ["a link back into an ancestor", { status: "loop" } as const, "loop"],
  ])("names %s in the report instead of counting it as a skipped file", async (
    _label,
    link,
    reason,
  ) => {
    const h = harness({ "a.md": "a\n", Elsewhere: symlink(link) });
    const r = await importVault("/v", h.ports, new Set(), "skip");
    expect(r.imported).toBe(1);
    expect(r.unfollowedLinks).toEqual([{ relPath: "Elsewhere", reason }]);
    expect(r.ignore.nonMarkdownSkipped).toBe(0);
  });

  it("terminates on a cycle the host cannot see from one listing", async () => {
    // `a/toB → b` and `b/toA → a`: each link is legal on its own, and neither
    // points at an ancestor of the directory it sits in, so only a visited-set
    // across the whole walk stops it. Without one this test hangs rather than
    // failing, which is exactly why it is worth having.
    const a: Tree = { "in-a.md": "a\n" };
    const b: Tree = { "in-b.md": "b\n" };
    a["toB"] = symlink(followable("key-b"), b);
    b["toA"] = symlink(followable("key-a"), a);
    const h = harness({ a, b });

    const r = await importVault("/v", h.ports, new Set(), "skip");
    // Both real notes land; the second traversal of each subtree is refused.
    expect(r.imported).toBeGreaterThanOrEqual(2);
    expect(r.unfollowedLinks.some((l) => l.reason === "loop")).toBe(true);
  });
});

// myne-md/myne#223 defect 2. One unreadable file used to abort the whole run,
// and every accumulated tally died with it because the counts are loop-locals.
describe("importVault — a failure names itself instead of ending the run", () => {
  it("flags and skips a file it cannot read, then carries on", async () => {
    const h = harness({ "a.md": "a\n", "legacy.md": "x\n", "c.md": "c\n" }, "/v", {
      readFails: { "legacy.md": { kind: "NotUtf8" } },
    });
    const r = await importVault("/v", h.ports, new Set(), "skip");
    expect(r.imported).toBe(2);
    expect(r.unreadable).toEqual([{ relPath: "legacy.md", reason: "not-utf8" }]);
    expect(r.stopped).toBeNull();
    expect(r.total).toBe(3);
  });

  it("stops on a failed WRITE but still returns everything that landed", async () => {
    // Asymmetric with a read failure on purpose: a full disk will not fix
    // itself on the next of 50 000 files.
    const h = harness({ "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" }, "/v", {
      createFailsOn: 2,
      createError: { kind: "Io", io_error_kind: "NoSpace" },
    });
    const r = await importVault("/v", h.ports, new Set(), "skip");
    expect(r.imported).toBe(1);
    expect(r.stopped).toEqual({ relPath: "b.md", reason: "no-space" });
    expect(r.total).toBe(3);
    // NOT reported as cancelled — that row is labelled "Cancelled" and the user
    // did not cancel. The banner reads the stopping point off `stopped`.
    expect(r.cancelled).toBeNull();
  });

  it("does not fail an import whose notes all landed when only the folder write fails", async () => {
    const h = harness({ "a.md": "a\n", Empty: {} }, "/v", { deliberateFails: true });
    const r = await importVault("/v", h.ports, new Set(), "skip");
    expect(r.imported).toBe(1);
    expect(r.stopped).toBeNull();
    expect(r.emptyFoldersPreserved).toBe(0); // honestly reported as not preserved
  });

  it("classifies an unknown rejection rather than putting it in front of the user", async () => {
    const h = harness({ "a.md": "a\n" }, "/v", {
      readFails: { "a.md": new Error("something the UI cannot render") },
    });
    const r = await importVault("/v", h.ports, new Set(), "skip");
    expect(r.unreadable).toEqual([{ relPath: "a.md", reason: "unknown" }]);
  });
});
