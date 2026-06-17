// Unit tests for `src/notes/folderNote.ts` — folder-note CRUD orchestrators over
// the existing note IPC (MYND-370). createFolderNote mints via note_create;
// set/unsetFolderIndex toggle the `folder_index:` flag via note_update (no
// `updated:` bump). Mirrors templates.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  createFolderNote,
  setFolderIndex,
  unsetFolderIndex,
} from "../../src/notes/folderNote";

beforeEach(() => invokeMock.mockReset());
afterEach(() => invokeMock.mockReset());

function routeReadThenUpdate(read: string): void {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "plugin:notes|note_read") return Promise.resolve(read);
    if (cmd === "plugin:notes|note_update") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command ${cmd}`));
  });
}

function lastBody(cmd: string): string {
  const call = [...invokeMock.mock.calls].reverse().find(([c]) => c === cmd);
  return (call?.[1] as { plaintext: string }).plaintext;
}

describe("createFolderNote", () => {
  it("mints a note with folder + title + folder_index: true via note_create", async () => {
    invokeMock.mockResolvedValueOnce("00000000-0000-7000-8000-000000000001");
    const id = await createFolderNote("Projects/");
    expect(id).toBe("00000000-0000-7000-8000-000000000001");
    expect(lastBody("plugin:notes|note_create")).toBe(
      "---\nfolder: Projects/\ntitle: Projects\nfolder_index: true\n---\n\n",
    );
  });

  it("titles the note after the folder's last segment for a nested folder", async () => {
    invokeMock.mockResolvedValueOnce("id-x");
    await createFolderNote("Projects/Myne/");
    const body = lastBody("plugin:notes|note_create");
    expect(body).toContain("folder: Projects/Myne/");
    expect(body).toContain("title: Myne");
    expect(body).toContain("folder_index: true");
  });

  it("rejects with the underlying note_create error", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "Io" });
    await expect(createFolderNote("Projects/")).rejects.toMatchObject({
      kind: "Io",
    });
  });
});

describe("setFolderIndex", () => {
  it("sets folder_index: true on an in-folder note", async () => {
    routeReadThenUpdate("---\nfolder: Projects/\n---\n\nbody");
    await setFolderIndex("id-1");
    expect(lastBody("plugin:notes|note_update")).toBe(
      "---\nfolder: Projects/\nfolder_index: true\n---\n\nbody",
    );
  });

  it("does NOT add or bump updated: (flag toggle, not a content edit)", async () => {
    routeReadThenUpdate("---\nfolder: Projects/\n---\n\nbody");
    await setFolderIndex("id-1");
    expect(lastBody("plugin:notes|note_update")).not.toContain("updated:");
  });

  it("is idempotent on an already-index note (single folder_index line)", async () => {
    routeReadThenUpdate("---\nfolder: Projects/\nfolder_index: true\n---\n\nbody");
    await setFolderIndex("id-2");
    const body = lastBody("plugin:notes|note_update");
    expect(body.split("\n").filter((l) => /^folder_index:/.test(l))).toHaveLength(
      1,
    );
  });

  it("rejects when note_read rejects", async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "plugin:notes|note_read"
        ? Promise.reject({ kind: "NoteNotFound" })
        : Promise.resolve(undefined),
    );
    await expect(setFolderIndex("id-x")).rejects.toMatchObject({
      kind: "NoteNotFound",
    });
  });
});

describe("unsetFolderIndex", () => {
  it("removes the folder_index field, preserving folder + body", async () => {
    routeReadThenUpdate("---\nfolder: Projects/\nfolder_index: true\n---\n\n# Body");
    await unsetFolderIndex("id-1");
    expect(lastBody("plugin:notes|note_update")).toBe(
      "---\nfolder: Projects/\n---\n\n# Body",
    );
  });

  it("set→unset round-trips to the original bytes", async () => {
    routeReadThenUpdate("---\nfolder: Projects/\n---\n\n# Note");
    await setFolderIndex("id-3");
    const marked = lastBody("plugin:notes|note_update");

    invokeMock.mockReset();
    routeReadThenUpdate(marked);
    await unsetFolderIndex("id-3");
    expect(lastBody("plugin:notes|note_update")).toBe(
      "---\nfolder: Projects/\n---\n\n# Note",
    );
  });
});
