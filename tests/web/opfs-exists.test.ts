// Regression test for the OPFS `exists()` directory probe (task 13).
//
// # The bug this pins
//
// OPFS answers `getFileHandle(name)` on an existing **directory** with
// `TypeMismatchError`, not `NotFoundError`. The first implementation only
// tolerated `NotFoundError` before falling through to the directory probe, so
// `exists()` **threw on every directory**.
//
// It surfaced three layers away: `notes_dir_for_host_io` probes the vault root
// (a directory) before creating `notes/`, so every `note_list` in the browser
// came back as `Io { Other }` — a generic failure naming nothing. Finding it
// took a full browser round-trip and an OPFS tree dump.
//
// Tested against a hand-written fake rather than a real OPFS because the real
// one is dedicated-Worker-only. The fake's job is narrow and stated: reproduce
// the *error shapes* the spec mandates. If it drifts from real OPFS this test
// passes while the code is broken — which is why the real behaviour was also
// confirmed in a browser, and why this file exists to stop a REGRESSION rather
// than to be the only evidence.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** A DOMException-shaped error: only `name` matters to the code under test. */
const domError = (name: string) => Object.assign(new Error(name), { name });

interface FakeNode {
  kind: "file" | "directory";
  children?: Record<string, FakeNode>;
}

function makeDir(node: FakeNode): FileSystemDirectoryHandle {
  const children = node.children ?? {};
  return {
    kind: "directory",
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      const child = children[name];
      if (!child) {
        if (opts?.create) {
          children[name] = { kind: "file" };
          return { kind: "file" } as unknown as FileSystemFileHandle;
        }
        throw domError("NotFoundError");
      }
      // THE BEHAVIOUR THIS TEST EXISTS FOR.
      if (child.kind === "directory") throw domError("TypeMismatchError");
      return { kind: "file" } as unknown as FileSystemFileHandle;
    },
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      const child = children[name];
      if (!child) {
        if (opts?.create) {
          const created: FakeNode = { kind: "directory", children: {} };
          children[name] = created;
          return makeDir(created);
        }
        throw domError("NotFoundError");
      }
      if (child.kind === "file") throw domError("TypeMismatchError");
      return makeDir(child);
    },
  } as unknown as FileSystemDirectoryHandle;
}

const tree: FakeNode = {
  kind: "directory",
  children: {
    myne: {
      kind: "directory",
      children: {
        vaults: {
          kind: "directory",
          children: {
            "v1": {
              kind: "directory",
              children: { "vault.meta": { kind: "file" } },
            },
          },
        },
      },
    },
  },
};

beforeEach(() => {
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => makeDir(tree) },
  });
});

async function exists(path: string): Promise<boolean> {
  vi.resetModules();
  const { __testing } = await import("../../web/src/worker/opfs");
  return await __testing.exists(path);
}

describe("OPFS exists()", () => {
  it("reports a DIRECTORY as existing (the regression)", async () => {
    // Each of these is a directory. Before the fix every one of them THREW.
    await expect(exists("/myne")).resolves.toBe(true);
    await expect(exists("/myne/vaults")).resolves.toBe(true);
    await expect(exists("/myne/vaults/v1")).resolves.toBe(true);
  });

  it("reports a file as existing", async () => {
    await expect(exists("/myne/vaults/v1/vault.meta")).resolves.toBe(true);
  });

  it("reports an absent leaf as absent, not as an error", async () => {
    await expect(exists("/myne/vaults/v1/nope")).resolves.toBe(false);
  });

  it("reports an absent INTERMEDIATE directory as absent, not as an error", async () => {
    // A missing parent means the leaf is missing too. The distinction that
    // matters is absent-vs-unreadable: those have opposite recoveries, so this
    // must not silently swallow a real failure.
    await expect(exists("/myne/vaults/ghost/vault.meta")).resolves.toBe(false);
  });

  it("treats the OPFS root as existing without probing a parent it has none of", async () => {
    await expect(exists("/")).resolves.toBe(true);
  });
});
