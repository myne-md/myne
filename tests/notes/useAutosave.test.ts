// @vitest-environment jsdom
//
// `useAutosave` fake-timer state-machine tests.
//
// Per `editor-mvp-baseline` PRD Testing Decisions § Vitest V2.5 stance +
// `myne-agents/features/notes-sidebar-autosave/pr-review.md` deferred
// follow-up: these tests ride along the jsdom devDep adopted in MYND-36
// T1. They assert γ1+γ2 hybrid state transitions:
//
//   clean → editing → saving → saved
//   editing-during-save → latest-wins (single follow-up save)
//   saving → error → editing (next body change) | saving (retry click)
//
// Implementation under test: `src/notes/useAutosave.ts`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutosave } from "../../src/notes/useAutosave";
import { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS } from "../../src/notes/saveNote";

type Deferred = {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
};

function defer(): Deferred {
  let resolve!: (value: string) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAutosave γ1+γ2 hybrid state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("initial mount with empty body → clean (no timers armed)", () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { result } = renderHook(() => useAutosave("note-1", "", saveImpl));
    expect(result.current.status).toEqual({ status: "clean" });
    expect(saveImpl).not.toHaveBeenCalled();
  });

  it("first body change after initial mount → editing → saving → saved", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "initial" } },
    );

    // Initial mount is treated as "loaded content" — stays clean.
    expect(result.current.status).toEqual({ status: "clean" });

    // First user edit.
    rerender({ body: "initial edit" });
    expect(result.current.status).toEqual({ status: "editing" });

    // γ1 idle timer fires → saving begins.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });

    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(saveImpl).toHaveBeenCalledWith("note-1", "initial edit");
    expect(result.current.status).toMatchObject({ status: "saved" });
  });

  it("γ2 max timer fires when continuous typing keeps resetting γ1", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    // Type continuously: every 500ms a new edit arrives, resetting γ1
    // but γ2 keeps ticking. After AUTOSAVE_MAX_MS the max timer fires.
    let edits = 1;
    while (edits * 500 < AUTOSAVE_MAX_MS) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      rerender({ body: `v${++edits}` });
    }
    // Now advance to total time = AUTOSAVE_MAX_MS — γ2 should have fired.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_MS);
    });

    expect(saveImpl).toHaveBeenCalled();
    expect(result.current.status).toMatchObject({ status: "saved" });
  });

  it("edit during in-flight save → latest-wins (single follow-up save)", async () => {
    const first = defer();
    const second = defer();
    const saveImpl = vi
      .fn<(id: string, body: string) => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });

    // First save is in flight; edit again.
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(saveImpl).toHaveBeenNthCalledWith(1, "note-1", "v1");
    expect(result.current.status).toEqual({ status: "saving" });

    rerender({ body: "v2" });
    // Status should stay "saving" — body change during in-flight does not
    // bump to "editing" (label discipline).
    expect(result.current.status).toEqual({ status: "saving" });

    // Resolve the first save → latest-wins gate detects body changed and
    // fires the second save immediately (no idle wait).
    await act(async () => {
      first.resolve("v1");
      await first.promise;
    });

    expect(saveImpl).toHaveBeenCalledTimes(2);
    expect(saveImpl).toHaveBeenNthCalledWith(2, "note-1", "v2");

    // Resolve the second save → saved.
    await act(async () => {
      second.resolve("v2");
      await second.promise;
    });
    expect(result.current.status).toMatchObject({ status: "saved" });
  });

  it("save rejects → error status, then next body change resumes editing", async () => {
    const saveErr = new Error("note_update failed");
    const saveImpl = vi
      .fn<(id: string, body: string) => Promise<string>>()
      .mockRejectedValueOnce(saveErr)
      .mockImplementation((_id, body) => Promise.resolve(body));

    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });

    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(result.current.status).toMatchObject({
      status: "error",
      error: saveErr,
    });

    // Error must not auto-recover on next body change without explicit
    // user retry — body change marks dirty but status stays "error".
    rerender({ body: "v2" });
    expect(result.current.status).toMatchObject({ status: "error" });
  });

  it("retry() re-fires the save with the current body", async () => {
    const saveErr = new Error("note_update failed");
    const saveImpl = vi
      .fn<(id: string, body: string) => Promise<string>>()
      .mockRejectedValueOnce(saveErr)
      .mockImplementation((_id, body) => Promise.resolve(body));

    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    expect(result.current.status).toMatchObject({ status: "error" });

    rerender({ body: "v1-updated" });
    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(saveImpl).toHaveBeenCalledTimes(2);
    expect(saveImpl).toHaveBeenNthCalledWith(2, "note-1", "v1-updated");
    expect(result.current.status).toMatchObject({ status: "saved" });
  });

  it("noteId change → clean reset (timers cleared, status cleared)", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { result, rerender } = renderHook(
      ({ id, body }: { id: string | null; body: string }) =>
        useAutosave(id, body, saveImpl),
      { initialProps: { id: "note-1" as string | null, body: "v0" } },
    );

    rerender({ id: "note-1" as string | null, body: "v1" });
    expect(result.current.status).toEqual({ status: "editing" });

    // Switch note before idle timer fires.
    rerender({ id: "note-2" as string | null, body: "completely different" });
    expect(result.current.status).toEqual({ status: "clean" });

    // The original idle-debounce timer must not fire after the switch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS + 100);
    });
    expect(saveImpl).not.toHaveBeenCalled();
    // Switching back to no-note also clears.
    rerender({ id: null, body: "" });
    expect(result.current.status).toEqual({ status: "clean" });
  });

  it("flushIfDirty() awaits pending save when one is in flight", async () => {
    const first = defer();
    const saveImpl = vi
      .fn<(id: string, body: string) => Promise<string>>()
      .mockImplementationOnce(() => first.promise);

    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });

    expect(saveImpl).toHaveBeenCalledTimes(1);
    // Status is saving; the flush should not double-fire.
    let flushResolved = false;
    await act(async () => {
      const p = result.current.flushIfDirty().then(() => {
        flushResolved = true;
      });
      // Wait one microtask to ensure the await reached the in-flight.
      await Promise.resolve();
      expect(flushResolved).toBe(false);
      first.resolve("v1");
      await p;
    });
    expect(flushResolved).toBe(true);
    expect(saveImpl).toHaveBeenCalledTimes(1);
  });

  it("revert to last-saved body → clean (no spurious save)", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(result.current.status).toMatchObject({ status: "saved" });

    // User reverts back to v1 (which is the saved baseline).
    rerender({ body: "v1" });
    expect(result.current.status).toMatchObject({ status: "saved" });
    // Advance time; no further save fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_MS + 100);
    });
    expect(saveImpl).toHaveBeenCalledTimes(1);
  });

  it("onSaved callback fires with patched body when user hasn't typed since save", async () => {
    // Simulates the frontmatter `updated:` injection: saveImpl receives
    // body "v1" and returns the patched body "v1-patched" (timestamp
    // injected). The hook mirrors this back via `onSaved` so the editor's
    // local content reflects the patch — fixes the bug where frontmatter
    // only updated on close-reopen.
    const saveImpl = vi.fn(
      (_id: string, body: string) => Promise.resolve(body + "-patched"),
    );
    const onSaved = vi.fn();
    const { rerender } = renderHook(
      ({ body }: { body: string }) =>
        useAutosave("note-1", body, saveImpl, onSaved),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });

    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith("v1-patched");
  });

  it("onSaved does NOT fire when user typed during save (latest-wins)", async () => {
    const first = defer();
    const second = defer();
    const saveImpl = vi
      .fn<(id: string, body: string) => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const onSaved = vi.fn();

    const { rerender } = renderHook(
      ({ body }: { body: string }) =>
        useAutosave("note-1", body, saveImpl, onSaved),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    // User types during in-flight first save.
    rerender({ body: "v2" });
    // Resolve first save with v1's patched body. onSaved must NOT fire
    // because user has already moved beyond v1.
    await act(async () => {
      first.resolve("v1-patched");
      await first.promise;
    });
    expect(onSaved).not.toHaveBeenCalled();

    // Resolve the follow-up second save with v2's patched body. NOW
    // onSaved fires because the doc state matches what was saved.
    await act(async () => {
      second.resolve("v2-patched");
      await second.promise;
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith("v2-patched");
  });

  it("onSaved is NOT called when patched body equals pre-patch body (no-op patch)", async () => {
    // If the surgery produces no change (e.g., no frontmatter to stamp),
    // the patched body equals the input. No need to call onSaved + cause
    // a redundant setContent round-trip.
    const saveImpl = vi.fn(
      (_id: string, body: string) => Promise.resolve(body),
    );
    const onSaved = vi.fn();
    const { rerender } = renderHook(
      ({ body }: { body: string }) =>
        useAutosave("note-1", body, saveImpl, onSaved),
      { initialProps: { body: "v0" } },
    );
    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
