import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri IPC bridge so we can assert the exact command name + arg shape
// each wrapper sends — this pins the WebView↔Rust contract against the backend's
// registered plugin commands (build.rs / capabilities).
const invoke = vi.fn(async () => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import {
  beginVaultCreation,
  commitVaultCreation,
  cancelVaultCreation,
  unlockWithPassword,
} from "../src/lib/commands";
import { noteCreate, noteRead, noteUpdate, noteDelete, noteList } from "../src/lib/notes";

beforeEach(() => invoke.mockClear());

describe("vault-creation / unlock command wrappers", () => {
  it("beginVaultCreation → plugin:vault-creation|begin { password }", async () => {
    invoke.mockResolvedValueOnce({ phrase: [], account_number: "MY-…", session_token: "t" });
    await beginVaultCreation("pw");
    expect(invoke).toHaveBeenCalledWith("plugin:vault-creation|begin", { password: "pw" });
  });

  it("commitVaultCreation → plugin:vault-creation|commit { sessionToken }", async () => {
    await commitVaultCreation("tok");
    expect(invoke).toHaveBeenCalledWith("plugin:vault-creation|commit", { sessionToken: "tok" });
  });

  it("cancelVaultCreation → plugin:vault-creation|cancel { sessionToken }", async () => {
    await cancelVaultCreation("tok");
    expect(invoke).toHaveBeenCalledWith("plugin:vault-creation|cancel", { sessionToken: "tok" });
  });

  it("unlockWithPassword → plugin:vault-unlock|unlock { password, vaultId }", async () => {
    await unlockWithPassword("pw", "v1");
    expect(invoke).toHaveBeenCalledWith("plugin:vault-unlock|unlock", { password: "pw", vaultId: "v1" });
  });

  it("unlockWithPassword defaults vaultId to null (sole-vault)", async () => {
    await unlockWithPassword("pw");
    expect(invoke).toHaveBeenCalledWith("plugin:vault-unlock|unlock", { password: "pw", vaultId: null });
  });
});

describe("notes command wrappers", () => {
  it("noteCreate → plugin:notes|note_create { plaintext }", async () => {
    invoke.mockResolvedValueOnce("note-id");
    await noteCreate("hello", null);
    expect(invoke).toHaveBeenCalledWith("plugin:notes|note_create", { plaintext: "hello" });
  });

  it("noteCreate registers the folder it filed the note into (myne#613)", async () => {
    // The at-fill chokepoint. It landed at two `EditorFlow` save paths instead
    // of here, so the daily note, the drawing sibling, the app-background
    // flush, a template and a conflict copy all filed notes into folders and
    // registered none of them. The registration is fire-and-forget, so this
    // waits for the queued microtasks rather than for the create.
    invoke.mockResolvedValueOnce("note-id");
    await noteCreate("hello", "Work/Projects");
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).toHaveBeenCalledWith("plugin:prefs|set_deliberate_folders", {
      mutation: { add: ["Work/Projects/"] },
    });
  });

  it("a root note registers nothing", async () => {
    invoke.mockResolvedValueOnce("note-id");
    await noteCreate("hello", null);
    await new Promise((r) => setTimeout(r, 0));
    expect(invoke).not.toHaveBeenCalledWith(
      "plugin:prefs|set_deliberate_folders",
      expect.anything(),
    );
  });

  it("noteRead → plugin:notes|note_read { noteId }", async () => {
    invoke.mockResolvedValueOnce("body");
    await noteRead("id");
    expect(invoke).toHaveBeenCalledWith("plugin:notes|note_read", { noteId: "id" });
  });

  it("noteUpdate → plugin:notes|note_update { noteId, plaintext }", async () => {
    await noteUpdate("id", "body");
    expect(invoke).toHaveBeenCalledWith("plugin:notes|note_update", { noteId: "id", plaintext: "body" });
  });

  it("noteUpdate passes the expected-base hash when given one (MYND-617 task 11)", async () => {
    // The gap this closes was never task-specific: without the parameter,
    // EVERY mobile note write was a blind overwrite of whatever was on disk,
    // which on a note the user is not looking at discards an edit sync had
    // just pulled.
    await noteUpdate("id", "body", "a".repeat(64));
    expect(invoke).toHaveBeenCalledWith("plugin:notes|note_update", {
      noteId: "id",
      plaintext: "body",
      expectedBaseHashHex: "a".repeat(64),
    });
  });

  it("noteUpdate omits the key entirely when no hash is given", async () => {
    // Omitting keeps legacy last-write-wins, so every existing caller behaves
    // exactly as before — the parameter is additive, not a behaviour change.
    await noteUpdate("id", "body");
    const args = invoke.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect("expectedBaseHashHex" in args).toBe(false);
  });

  it("a mismatched hash rejects rather than overwriting", async () => {
    // The backend answers `{kind:"BaseMismatch"}`; the wrapper must propagate
    // it rather than swallowing it into a success.
    invoke.mockRejectedValueOnce({ kind: "BaseMismatch" });
    await expect(noteUpdate("id", "body", "b".repeat(64))).rejects.toMatchObject({
      kind: "BaseMismatch",
    });
  });

  it("noteDelete → plugin:notes|note_delete { noteId }", async () => {
    await noteDelete("id");
    expect(invoke).toHaveBeenCalledWith("plugin:notes|note_delete", { noteId: "id" });
  });

  it("noteList → plugin:notes|note_list", async () => {
    invoke.mockResolvedValueOnce([]);
    await noteList();
    expect(invoke).toHaveBeenCalledWith("plugin:notes|note_list");
  });
});
