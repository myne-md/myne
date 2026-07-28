// @vitest-environment jsdom
//
// The tree-backed importer ports (phase3-web-client task 71).
//
// The claim under test is the one that makes the whole port small: a client
// whose picker hands back the WALK instead of a path needs no different engine,
// no different adapter and no different media resolution — only `readDir` and
// `readFile` answered from a Map, keyed by the SAME `joinPath(root, rel)` string
// the walk already produces. If that key algebra disagrees by one separator,
// every read misses and the import completes with zero notes and no error, which
// is the failure this file exists to make impossible.

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/platform/core", () => ({ invoke: vi.fn() }));
vi.mock("../../src/platform/filePicker", () => ({
  importPicked: vi.fn(async (f: { name: string }) => ({ id: `att-${f.name}`, filename: f.name })),
  readPickedText: vi.fn(async (f: { name: string }) => `text of ${f.name}`),
}));

const {
  indexTree,
  readDirFromIndex,
  createTreePorts,
  portsForTree,
  createTreeMediaRefImporter,
  buildMediaIndex,
  mediaCandidatePaths,
} = await import("../../src/notes/import/ports");
const { joinPath } = await import("../../src/notes/import/source");

/** A picked tree in the shape `web/src/platform/filePicker.ts` produces. */
function tree(root: string, paths: string[]) {
  return {
    root,
    entries: paths.map((p) => ({
      path: p,
      file: { name: p.split("/").pop() ?? p, size: null, mimeHint: null, handle: { p } },
    })),
  };
}

const VAULT = tree("MyVault", [
  "a.md",
  "notes/b.md",
  "notes/daily/c.md",
  "assets/pic.png",
]);

describe("the index", () => {
  it("keys by exactly what the walk asks for", () => {
    const index = indexTree(VAULT);
    // Not "some equivalent path": the literal string `readFile` is called with.
    expect(index.has(joinPath("MyVault", "notes/b.md"))).toBe(true);
    expect([...index.keys()].sort()).toEqual([
      "MyVault/a.md",
      "MyVault/assets/pic.png",
      "MyVault/notes/b.md",
      "MyVault/notes/daily/c.md",
    ]);
  });

  it("is empty for a host-walked tree", () => {
    expect(indexTree({ root: "/home/a/V", entries: null }).size).toBe(0);
  });
});

describe("reconstructing directories from a flat file list", () => {
  const index = indexTree(VAULT);

  it("lists immediate children only, files and folders alike", () => {
    const entries = readDirFromIndex(index, "MyVault").sort((x, y) =>
      x.name.localeCompare(y.name),
    );
    expect(entries).toEqual([
      { name: "a.md", isDir: false },
      { name: "assets", isDir: true },
      { name: "notes", isDir: true },
    ]);
  });

  it("descends", () => {
    expect(
      readDirFromIndex(index, "MyVault/notes").sort((x, y) => x.name.localeCompare(y.name)),
    ).toEqual([
      { name: "b.md", isDir: false },
      { name: "daily", isDir: true },
    ]);
  });

  it("reports an unknown directory as empty rather than throwing", () => {
    expect(readDirFromIndex(index, "MyVault/nope")).toEqual([]);
  });

  /** A prefix match on the raw string would make `MyVault2` a child of
   *  `MyVault` — the same sibling-lookalike bug the Rust read seam's
   *  component-wise `starts_with` exists to avoid. */
  it("does not treat a sibling with a shared prefix as a child", () => {
    const mixed = indexTree(tree("MyVault", ["a.md"]));
    mixed.set("MyVault2/b.md", { name: "b.md", size: null, mimeHint: null, handle: {} });
    expect(readDirFromIndex(mixed, "MyVault").map((e) => e.name)).toEqual(["a.md"]);
  });
});

describe("the ports", () => {
  it("reads a file through the seam, not off the handle", async () => {
    const ports = createTreePorts(VAULT);
    expect(await ports.readFile("MyVault/notes/b.md")).toBe("text of b.md");
  });

  /** A missing key is a THROW, not an empty string: a walk bug must surface as a
   *  failure, never as a note that imported with no content. */
  it("throws for a path that is not in the tree", async () => {
    const ports = createTreePorts(VAULT);
    await expect(ports.readFile("MyVault/ghost.md")).rejects.toThrow();
  });

  it("routes by the tree's shape, so a caller never branches itself", async () => {
    const hostBacked = portsForTree({ root: "/home/a/V", entries: null });
    const treeBacked = portsForTree(VAULT);
    // The host arm reaches the mocked `invoke`; the tree arm does not.
    await expect(treeBacked.readFile("MyVault/a.md")).resolves.toBe("text of a.md");
    const { invoke } = await import("../../src/platform/core");
    expect(invoke).not.toHaveBeenCalled();
    void hostBacked;
  });

  /**
   * The engine's own walk, run against the tree ports unchanged. This is the
   * actual claim of the port: `buildMediaIndex` was written for the Tauri ports
   * and is not touched here.
   */
  it("supports the engine's media-index walk with no adaptation", async () => {
    const index = await buildMediaIndex("MyVault", createTreePorts(VAULT));
    expect(index.get("pic.png")).toBe("MyVault/assets/pic.png");
    expect(index.get("c.md")).toBe("MyVault/notes/daily/c.md");
  });
});

describe("media resolution", () => {
  it("ingests a ref that resolves inside the tree", async () => {
    const index = await buildMediaIndex("MyVault", createTreePorts(VAULT));
    const importer = createTreeMediaRefImporter(VAULT, index);
    const got = await importer({ source: "assets/pic.png" } as never);
    expect(got).toEqual({ ok: true, attachment: { id: "att-pic.png", filename: "pic.png" } });
  });

  it("resolves a bare basename through the index, as Obsidian embeds do", async () => {
    const index = await buildMediaIndex("MyVault", createTreePorts(VAULT));
    const importer = createTreeMediaRefImporter(VAULT, index);
    const got = await importer({ source: "pic.png" } as never);
    expect(got).toMatchObject({ ok: true });
  });

  it("reports a ref that resolves nowhere, for the omitted tally", async () => {
    const importer = createTreeMediaRefImporter(VAULT, new Map());
    expect(await importer({ source: "missing.png" } as never)).toEqual({ ok: false });
  });

  /**
   * The TB6 guard, unchanged and shared: a crafted ref in untrusted imported
   * content must not name anything outside the picked root. `mediaCandidatePaths`
   * emits no root-relative candidate for an absolute or `..`-carrying source, and
   * the tree arm reuses it rather than reimplementing the check.
   */
  it("emits no candidate for an escaping ref", () => {
    expect(mediaCandidatePaths("MyVault", new Map(), "/etc/passwd.png")).toEqual([]);
    expect(mediaCandidatePaths("MyVault", new Map(), "../../x.png")).toEqual([]);
  });
});
