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
// The clipboard plugin is mocked with WRITE ONLY, matching the seam after
// myne#379. `readText` / `clear` are deliberately absent here: if a future edit
// reaches for either, this mock does not supply it and the test fails rather
// than silently exercising a path the desktop ACL no longer grants.
const clipboardWriteMock = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...args: unknown[]) => clipboardWriteMock(...args),
}));

import { copySecretToClipboard, saveSecretAsTextFile } from "../../src/lib/secret-export";

beforeEach(() => {
  invokeMock.mockReset();
  saveMock.mockReset();
  clipboardWriteMock.mockReset();
  clipboardWriteMock.mockResolvedValue(undefined);
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

// The Copy half of the same screen. There was no coverage here at all before
// myne#379 — a gap that predated the change and is why the read-side grant went
// unexamined for as long as it did.
describe("copySecretToClipboard", () => {
  const PHRASE = "correct horse battery staple";

  it("writes through the seam and schedules the auto-clear", async () => {
    vi.useFakeTimers();
    try {
      const cancel = await copySecretToClipboard(PHRASE);
      expect(clipboardWriteMock).toHaveBeenCalledWith(PHRASE);
      expect(cancel).toBeTypeOf("function");
      // Nothing fires early — the spec's window is 30 s, not "soon".
      await vi.advanceTimersByTimeAsync(29_000);
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the read+compare+clear to the host, never doing it in the WebView", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockResolvedValue(undefined);
      await copySecretToClipboard(PHRASE);
      await vi.advanceTimersByTimeAsync(30_000);

      // The whole point of the change: one host command, with the value to
      // compare against — and no clipboard READ from this side. A `readText`
      // call would throw here anyway (the mock does not define it), which is
      // the regression net.
      expect(invokeMock).toHaveBeenCalledWith(
        "plugin:secret-export|clipboard_clear_if_matches",
        { value: PHRASE },
      );
      expect(invokeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() suppresses the auto-clear entirely", async () => {
    vi.useFakeTimers();
    try {
      const cancel = await copySecretToClipboard(PHRASE);
      cancel?.();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null and schedules nothing when the clipboard write fails", async () => {
    vi.useFakeTimers();
    try {
      clipboardWriteMock.mockRejectedValue(new Error("no clipboard"));
      expect(await copySecretToClipboard(PHRASE)).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows a refused clear rather than throwing from a timer", async () => {
    vi.useFakeTimers();
    try {
      // The `catch` in the timer body is now for an ACL refusal, not for the
      // clipboard's state — an unhandled rejection here would surface as an
      // unattributable console error 30 s after a screen the user has left.
      invokeMock.mockRejectedValue(new Error("command refused"));
      await copySecretToClipboard(PHRASE);
      await vi.advanceTimersByTimeAsync(30_000);
      // Reached the host once, and the rejection did not escape the timer.
      expect(invokeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
