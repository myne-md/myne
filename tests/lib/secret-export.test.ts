// Routing test for `saveSecretAsTextFile` (review Ö-8): after removing the broad
// WebView `fs:allow-write-text-file $HOME/**` scope, the save must go through the
// Rust `secret-export:save_secret_text` command with the dialog-chosen path —
// never the fs plugin. We mock the Tauri boundary (dialog + invoke) and assert
// the routing + the early-return / error-swallow behaviour.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
const saveMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
}));
// secret-export.ts also imports the clipboard plugin at module scope; stub it so
// the module loads under vitest (unused by saveSecretAsTextFile).
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(),
  readText: vi.fn(),
  clear: vi.fn(),
}));

import { saveSecretAsTextFile } from "../../src/lib/secret-export";

beforeEach(() => {
  invokeMock.mockReset();
  saveMock.mockReset();
});

describe("saveSecretAsTextFile", () => {
  it("routes the write through the Rust command with the dialog-chosen path", async () => {
    saveMock.mockResolvedValue("/Users/me/Documents/myne-recovery-phrase.txt");
    invokeMock.mockResolvedValue(undefined);

    await saveSecretAsTextFile("myne-recovery-phrase.txt", "correct horse battery staple");

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("plugin:secret-export|save_secret_text", {
      path: "/Users/me/Documents/myne-recovery-phrase.txt",
      contents: "correct horse battery staple",
    });
  });

  it("does nothing when the user cancels the save dialog (null path)", async () => {
    saveMock.mockResolvedValue(null);
    await saveSecretAsTextFile("kit.txt", "secret");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("swallows a dialog rejection without invoking the command", async () => {
    saveMock.mockRejectedValue(new Error("dialog boom"));
    await saveSecretAsTextFile("kit.txt", "secret");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("swallows a command rejection (never throws to the caller)", async () => {
    saveMock.mockResolvedValue("/tmp/kit.txt");
    invokeMock.mockRejectedValue(new Error("io boom"));
    await expect(saveSecretAsTextFile("kit.txt", "secret")).resolves.toBeUndefined();
  });
});
