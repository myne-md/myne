// Obsidian importer — round-trip / C1-preservation proof (MYND-90).
//
// The grill (D1) settled the achievable proof: import → the plaintext handed to
// `note_create` (which IS what gets encrypted; decrypt is its inverse) must equal
// the source bytes MODULO the sanctioned-diff allowlist (SYNC-9): only the
// `folder:` frontmatter injection and the media `![[att:<id>]]` rewrite differ;
// every other byte is identical. No exporter is built (the "export again" leg is
// a separate feature). The engine's injected `ImportPorts` make an in-memory
// vault the fixture — the real-fs read path is covered by the Rust read-seam's
// own `cargo test`s; this asserts the parse+ingest preservation end-to-end.
//
// Also covers every SYNC case: empty dir → deliberate_folders (SYNC-4),
// ignore buckets (SYNC-10: .obsidian/.git/.foo.md/.canvas/.txt), import-twice
// idempotency (SYNC-5), media ingest + residual placeholder (SYNC-7).

import { describe, it, expect } from "vitest";
import {
  importVault,
  type ImportDirEntry,
  type ImportPorts,
} from "../../src/notes/import/engine";
import { buildExistingIdentitySet, type ExistingNote } from "../../src/notes/import/conflict";
import type { RefImporter } from "../../src/notes/import/media";
import type { ImportedAttachment } from "../../src/editor/attachments/insert";

type Tree = { [name: string]: Tree | string };

function resolve(tree: Tree, root: string, absPath: string): Tree | string {
  const rel = absPath === root ? "" : absPath.slice(root.length + 1);
  let node: Tree | string = tree;
  if (rel.length > 0) for (const s of rel.split("/")) {
    if (typeof node === "string") throw new Error("not a dir");
    node = node[s]!;
  }
  return node;
}

interface Harness {
  ports: ImportPorts;
  created: Map<string, string>; // first-line-ish key → plaintext (we key by content)
  createdList: string[];
  deliberate: string[][];
}

function harness(tree: Tree, root = "/v"): Harness {
  const createdList: string[] = [];
  const created = new Map<string, string>();
  const deliberate: string[][] = [];
  let id = 0;
  const ports: ImportPorts = {
    async readDir(p) {
      const node = resolve(tree, root, p);
      if (typeof node === "string") throw new Error("not a dir");
      return Object.entries(node).map(
        ([name, child]): ImportDirEntry => ({ name, isDir: typeof child !== "string" }),
      );
    },
    async readFile(p) {
      const node = resolve(tree, root, p);
      if (typeof node !== "string") throw new Error("not a file");
      return node;
    },
    async createNote(plaintext) {
      createdList.push(plaintext);
      created.set(`n${id}`, plaintext);
      return `id-${id++}`;
    },
    async setDeliberateFolders(folders) {
      deliberate.push([...folders]);
    },
  };
  return { ports, created, createdList, deliberate };
}

const attachment = (id: string, filename: string): ImportedAttachment => ({
  id,
  content_type: "image/png",
  filename,
  size: 10,
  created_at: 0,
  deduplicated: false,
});

/** Ingest .png, fail everything else (the residual). */
const pngImporter: RefImporter = async (ref) =>
  ref.source.toLowerCase().endsWith(".png")
    ? { ok: true, attachment: attachment("att1", ref.source.split("/").pop() ?? ref.source) }
    : { ok: false };

const NON_CANONICAL_BODY =
  "# Heading\n\n__bold__ and _italic_, a [[WikiLink]] and #tag.\n" +
  "- [X] uppercase task\n1) alt marker\n\nSetext\n======\n\n    indented code\n";

describe("MYND-90 round-trip — C1 preservation (allowlist-modulo byte equality)", () => {
  it("a no-media note: created plaintext == body + only the folder: injection", async () => {
    const h = harness({ Notes: { "raw.md": NON_CANONICAL_BODY } });
    await importVault("/v", h.ports, new Set(), "skip");
    expect(h.createdList).toHaveLength(1);
    const out = h.createdList[0]!;
    // strip the single sanctioned folder: FM block → must be byte-identical to source.
    expect(out.replace("---\nfolder: Notes/\n---\n\n", "")).toBe(NON_CANONICAL_BODY);
  });

  it("media: ingestable image → att: rewrite, residual audio → placeholder, rest preserved", async () => {
    const body = "before\n![[photo.png]]\nmiddle\n![[song.mp3]]\nafter\n";
    const h = harness({ Media: { "pics.md": body } });
    const r = await importVault("/v", h.ports, new Set(), "skip", { importMedia: pngImporter });
    const out = h.createdList[0]!;
    expect(out).toContain("att:att1"); // image ingested + rewritten
    expect(out).toContain("<!-- omitted attachment: song.mp3 -->"); // residual placeholder
    expect(out).toContain("folder: Media/");
    expect(out).toContain("before\n");
    expect(out).toContain("middle\n");
    expect(out).toContain("after\n");
    expect(r.media.ingested.image).toBe(1);
    expect(r.media.omitted.audio).toBe(1);
  });

  it("ignore buckets + empty dir + summary counts (SYNC-10 / SYNC-4)", async () => {
    const h = harness({
      "top.md": "x\n",
      Sub: { "a.md": "y\n", "board.canvas": "{}", "readme.txt": "t" },
      Empty: {},
      ".obsidian": { "app.json": "{}" },
      ".git": { HEAD: "ref" },
      ".foo.md": "edge", // dot-prefixed → hidden (silent drop)
    });
    const r = await importVault("/v", h.ports, new Set(), "skip");
    expect(r.imported).toBe(2); // top.md + Sub/a.md
    expect(r.ignore.canvasSkipped).toBe(1);
    expect(r.ignore.nonMarkdownSkipped).toBe(1); // readme.txt
    expect(r.ignore.hiddenIgnored).toBe(3); // .obsidian dir + .git dir + .foo.md
    expect(r.emptyFoldersPreserved).toBe(1);
    expect(h.deliberate).toEqual([["Empty/"]]);
  });

  it("import-twice idempotency: second run skips all FM-titled notes (SYNC-5)", async () => {
    // Both notes carry an FM `title:` so they have a persisted identity (an
    // untitled note has none — the documented residual, owned by sub-feature 2).
    const tree: Tree = {
      Notes: { "a.md": "---\ntitle: Alpha\n---\nbody\n" },
      "b.md": "---\ntitle: Bravo\n---\nB\n",
    };
    const h1 = harness(tree);
    const r1 = await importVault("/v", h1.ports, new Set(), "skip");
    expect(r1.imported).toBe(2);
    const existing: ExistingNote[] = [
      { folder: "Notes/", title: "Alpha", trashed: null, template: false },
      { folder: null, title: "Bravo", trashed: null, template: false },
    ];
    const h2 = harness(tree);
    const r2 = await importVault("/v", h2.ports, buildExistingIdentitySet(existing), "skip");
    expect(r2.imported).toBe(0);
    expect(r2.skippedExisting).toBe(2);
    expect(h2.createdList).toHaveLength(0);
  });
});
