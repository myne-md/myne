// @vitest-environment jsdom
//
// The directory picker, both arms (phase3-web-client task 71).
//
// A folder pick is the thing that makes markdown import possible on web at all,
// and the two platforms answer it in genuinely different shapes — desktop hands
// back a path and lets its root-confined host seam walk the tree, the browser
// hands back the walk because its picker already did it. The asymmetry is
// deliberate (see `src/platform/filePicker.ts`'s `PickedTree`), so what these
// tests pin is that BOTH arms produce the same contract around it: a `root`, and
// an `entries` that is either the list or an explicit `null`.
//
// The string handling is where this silently goes wrong. `webkitRelativePath` is
// always prefixed with the picked folder's own name, and stripping it wrong
// reparents every imported note — a failure that produces a complete, plausible
// import into the wrong place.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.fn();
vi.mock("../../src/platform/dialog", () => ({
  open: (...a: unknown[]) => openMock(...(a as [])),
  save: vi.fn(),
  confirm: vi.fn(),
}));

const desktop = await import("../../src/platform/filePicker");
const web = await import("../../web/src/platform/filePicker");

afterEach(() => {
  vi.restoreAllMocks();
  openMock.mockReset();
});

describe("desktop", () => {
  it("asks for a directory and returns the path with NO entries", async () => {
    openMock.mockResolvedValue("/home/a/MyVault");
    const tree = await desktop.pickDirectory();
    expect(tree).toEqual({ root: "/home/a/MyVault", entries: null });
    // `directory: true` is the whole difference from `pickFiles`; without it the
    // dialog offers files and the import has nothing to walk.
    expect(openMock.mock.calls[0][0]).toMatchObject({ directory: true, multiple: false });
  });

  it("reports a cancel as null", async () => {
    openMock.mockResolvedValue(null);
    expect(await desktop.pickDirectory()).toBeNull();
  });

  /**
   * `entries: null` is load-bearing, not incidental: it is what routes the
   * consumer to the host's root-confined read seam instead of to a page-side
   * list. A desktop arm that returned `[]` would look like an empty folder.
   */
  it("never returns an entry list", async () => {
    openMock.mockResolvedValue("/home/a/MyVault");
    const tree = await desktop.pickDirectory();
    expect(tree?.entries).toBeNull();
  });
});

describe("web — splitting webkitRelativePath", () => {
  it("takes the first segment as the root and the rest as the path", () => {
    expect(web.splitRelativePath("MyVault/notes/daily/a.md")).toEqual({
      root: "MyVault",
      path: "notes/daily/a.md",
    });
  });

  it("keeps a file directly under the root", () => {
    expect(web.splitRelativePath("MyVault/a.md")).toEqual({ root: "MyVault", path: "a.md" });
  });

  /**
   * The three shapes that must NOT become an entry. Each would otherwise
   * produce an empty relative path, which the importer maps to the vault ROOT —
   * a note silently filed somewhere the user did not choose.
   */
  it("refuses a path with no folder component", () => {
    expect(web.splitRelativePath("a.md")).toBeNull();
    expect(web.splitRelativePath("/a.md")).toBeNull();
    expect(web.splitRelativePath("MyVault/")).toBeNull();
  });
});

describe("web — the picker", () => {
  let created: HTMLInputElement | null = null;

  beforeEach(() => {
    created = null;
    const real = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = real(tag);
      if (tag === "input") {
        created = el as HTMLInputElement;
        // jsdom's `click()` on a file input does nothing, which is what we want:
        // the test drives `change` itself.
        (el as HTMLInputElement).click = () => {};
      }
      return el;
    });
  });

  /** A `File` carrying the `webkitRelativePath` the browser would set. */
  function fileAt(relative: string): File {
    const f = new File(["# hi"], relative.split("/").pop() ?? relative, { type: "text/markdown" });
    Object.defineProperty(f, "webkitRelativePath", { value: relative });
    return f;
  }

  function deliver(files: File[]) {
    Object.defineProperty(created!, "files", { value: files, configurable: true });
    created!.dispatchEvent(new Event("change"));
  }

  it("asks for a DIRECTORY, and by both spellings", async () => {
    const pending = web.pickDirectory();
    expect(created!.webkitdirectory).toBe(true);
    expect(created!.hasAttribute("webkitdirectory")).toBe(true);
    expect(created!.multiple).toBe(true);
    deliver([fileAt("MyVault/a.md")]);
    await pending;
  });

  it("returns the folder name as the root and relative paths beneath it", async () => {
    const pending = web.pickDirectory();
    deliver([fileAt("MyVault/a.md"), fileAt("MyVault/notes/b.md")]);
    const tree = await pending;
    expect(tree?.root).toBe("MyVault");
    expect(tree?.entries?.map((e) => e.path)).toEqual(["a.md", "notes/b.md"]);
  });

  /** The root is a NAME, never a path — a page is not told where the folder is,
   *  and a consumer that treats this as openable is broken on this platform. */
  it("never surfaces anything path-shaped", async () => {
    const pending = web.pickDirectory();
    deliver([fileAt("MyVault/a.md")]);
    const tree = await pending;
    expect(tree?.root).not.toContain("/");
  });

  it("carries a picked handle per entry, so the bytes route through the seam", async () => {
    const pending = web.pickDirectory();
    deliver([fileAt("MyVault/a.md")]);
    const tree = await pending;
    const entry = tree!.entries![0];
    expect(entry.file.name).toBe("a.md");
    expect(web.fileFor(entry.file)).toBeInstanceOf(File);
  });

  it("reports an empty pick and a cancel as null", async () => {
    const empty = web.pickDirectory();
    deliver([]);
    expect(await empty).toBeNull();

    const cancelled = web.pickDirectory();
    created!.dispatchEvent(new Event("cancel"));
    expect(await cancelled).toBeNull();
  });

  it("drops an unprefixed entry rather than filing it at the vault root", async () => {
    const pending = web.pickDirectory();
    deliver([fileAt("MyVault/a.md"), fileAt("stray.md")]);
    const tree = await pending;
    expect(tree?.entries?.map((e) => e.path)).toEqual(["a.md"]);
  });
});
