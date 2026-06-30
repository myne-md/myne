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
    await noteCreate("hello");
    expect(invoke).toHaveBeenCalledWith("plugin:notes|note_create", { plaintext: "hello" });
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
