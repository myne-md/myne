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
import type { Feedback } from "../../src/lib/clipboard";
import { recordingFeedback } from "./_recordingFeedback";

beforeEach(() => {
  invokeMock.mockReset();
  saveMock.mockReset();
  clipboardWriteMock.mockReset();
  clipboardWriteMock.mockResolvedValue(undefined);
});

describe("saveSecretAsTextFile", () => {
  // myne-md/myne#522: the feedback pair is a REQUIRED argument here for the same
  // reason it is on the copy half, and these tests are what hold it. The arms
  // record rather than report, so an assertion can say WHICH outcome was
  // announced and not merely that something was. `inline`, because that is the
  // arm these two screens pass: a secret shown once gets a persistent line
  // rather than a toast that can be missed.
  const recorder = () => recordingFeedback("inline");

  it("routes the write through the Rust command with the dialog-chosen path", async () => {
    saveMock.mockResolvedValue("/Users/me/Documents/myne-recovery-phrase.txt");
    invokeMock.mockResolvedValue(undefined);
    const { feedback } = recorder();

    await saveSecretAsTextFile(
      "myne-recovery-phrase.txt",
      "correct horse battery staple",
      feedback,
    );

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("plugin:secret-export|save_secret_text", {
      path: "/Users/me/Documents/myne-recovery-phrase.txt",
      contents: "correct horse battery staple",
    });
  });

  it("announces the success once the command resolves", async () => {
    saveMock.mockResolvedValue("/tmp/kit.txt");
    invokeMock.mockResolvedValue(undefined);
    const { ran: said, feedback } = recorder();

    await saveSecretAsTextFile("kit.txt", "secret", feedback);

    expect(said).toEqual(["success"]);
  });

  it("does nothing when the user cancels the save dialog (null path)", async () => {
    saveMock.mockResolvedValue(null);
    const { ran: said, feedback } = recorder();
    await saveSecretAsTextFile("kit.txt", "secret", feedback);
    expect(invokeMock).not.toHaveBeenCalled();
    // Silent on purpose: the user closed the dialog, so they already know.
    // Announcing here would be the app narrating their own action back at them.
    expect(said).toEqual([]);
  });

  it("announces a failure when the dialog will not open, which a cancel does not", async () => {
    saveMock.mockRejectedValue(new Error("dialog boom"));
    const { ran: said, feedback } = recorder();
    await saveSecretAsTextFile("kit.txt", "secret", feedback);
    expect(invokeMock).not.toHaveBeenCalled();
    // The pair of assertions is the point. Nothing was written in EITHER case,
    // so the transport cannot tell the two apart; only what the user is told
    // separates "you closed it" from "it would not open".
    expect(said).toEqual(["failure"]);
  });

  it("announces a failure when the command rejects, and still never throws", async () => {
    saveMock.mockResolvedValue("/tmp/kit.txt");
    invokeMock.mockRejectedValue(new Error("io boom"));
    const { ran: said, feedback } = recorder();
    await expect(saveSecretAsTextFile("kit.txt", "secret", feedback)).resolves.toBeUndefined();
    expect(said).toEqual(["failure"]);
  });
});

// The Copy half of the same screen. There was no coverage here at all before
// myne#379 — a gap that predated the change and is why the read-side grant went
// unexamined for as long as it did.
describe("copySecretToClipboard", () => {
  const PHRASE = "correct horse battery staple";

  // myne-md/myne#390 made the feedback pair a REQUIRED argument, so a caller can
  // no longer copy without saying what the user is told. These tests are about
  // the DESKTOP BINDING this function still owns, the platform seam's write,
  // the host-side clear, the 30 s window, so they pass a pair that reports
  // nothing and assert on the transport, exactly as they did before. What the
  // arms themselves do is `tests/lib/clipboard.test.ts`'s subject.
  const NO_FEEDBACK: Feedback = {
    onSuccess: { kind: "silent", reason: "transport test: feedback is not under test here" },
    onFailure: { kind: "silent", reason: "transport test: feedback is not under test here" },
  };

  it("writes through the seam and schedules the auto-clear", async () => {
    vi.useFakeTimers();
    try {
      const cancel = await copySecretToClipboard(PHRASE, NO_FEEDBACK);
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
      await copySecretToClipboard(PHRASE, NO_FEEDBACK);
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
      const cancel = await copySecretToClipboard(PHRASE, NO_FEEDBACK);
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
      expect(await copySecretToClipboard(PHRASE, NO_FEEDBACK)).toBeNull();
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
      await copySecretToClipboard(PHRASE, NO_FEEDBACK);
      await vi.advanceTimersByTimeAsync(30_000);
      // Reached the host once, and the rejection did not escape the timer.
      expect(invokeMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
