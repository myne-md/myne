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

// Deterministic expected-base fingerprint: jsdom's `crypto.subtle` availability
// varies across runners, and the hook fail-opens on hash errors — mock the
// hash so the third `saveImpl` argument is assertable ("h:<base body>").
vi.mock("../../src/notes/baseHash", () => ({
  sha256Hex: (text: string) => Promise.resolve(`h:${text}`),
}));

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
    expect(saveImpl).toHaveBeenCalledWith("note-1", "initial edit", "h:initial");
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
    expect(saveImpl).toHaveBeenNthCalledWith(1, "note-1", "v1", "h:v0");
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
    // The follow-up fires after the first save re-baselined to "v1".
    expect(saveImpl).toHaveBeenNthCalledWith(2, "note-1", "v2", "h:v1");

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
    expect(saveImpl).toHaveBeenNthCalledWith(2, "note-1", "v1-updated", expect.any(String));
    expect(result.current.status).toMatchObject({ status: "saved" });
  });

  it("noteId change → the OUTGOING note is flushed, then state resets (myne#288)", async () => {
    // This used to assert `saveImpl` was NOT called — which is precisely the
    // data-loss the switch caused. Every keyboard switch path (Ctrl+Tab, Mod-W,
    // Mod-[ / Mod-]) lands here with the editor still focused and nothing else
    // in the notes domain flushing, so up to ~10 s of typing was dropped with no
    // error and a status that reset to `clean`.
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { result, rerender } = renderHook(
      ({ id, body }: { id: string | null; body: string }) =>
        useAutosave(id, body, saveImpl),
      { initialProps: { id: "note-1" as string | null, body: "v0" } },
    );

    rerender({ id: "note-1" as string | null, body: "v1" });
    expect(result.current.status).toEqual({ status: "editing" });

    // Switch note before the idle timer fires.
    rerender({ id: "note-2" as string | null, body: "completely different" });
    expect(result.current.status).toEqual({ status: "clean" });
    // The pending keystrokes were written, attributed to the note they came
    // from and carrying that note's body — not the incoming one's.
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(saveImpl).toHaveBeenCalledWith("note-1", "v1");

    // …and the original idle-debounce timer still does not fire afterwards.
    saveImpl.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS + 100);
    });
    expect(saveImpl).not.toHaveBeenCalled();
    // Switching to no-note also clears (and has nothing dirty to flush).
    rerender({ id: null, body: "" });
    expect(result.current.status).toEqual({ status: "clean" });
    expect(saveImpl).not.toHaveBeenCalled();
  });

  it("noteId change on a CLEAN buffer writes nothing (myne#288)", async () => {
    // The flush is conditional on real pending work; a plain tab-cycle through
    // untouched notes must not rewrite every one of them with a fresh nonce.
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { rerender } = renderHook(
      ({ id, body }: { id: string | null; body: string }) =>
        useAutosave(id, body, saveImpl),
      { initialProps: { id: "note-1" as string | null, body: "v0" } },
    );
    rerender({ id: "note-2" as string | null, body: "other" });
    rerender({ id: "note-3" as string | null, body: "third" });
    expect(saveImpl).not.toHaveBeenCalled();
  });

  it("flushOutgoing() saves for the note the hook still holds (myne#288)", async () => {
    // The pane's cached state swap runs BEFORE this hook's own note-change
    // effect, so it needs a way to write the outgoing note's buffer before
    // `acceptReloadedBody` re-baselines it for the incoming one.
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { result, rerender } = renderHook(
      ({ id, body }: { id: string | null; body: string }) =>
        useAutosave(id, body, saveImpl),
      { initialProps: { id: "note-1" as string | null, body: "v0" } },
    );
    rerender({ id: "note-1" as string | null, body: "v1" });
    act(() => result.current.flushOutgoing());
    expect(saveImpl).toHaveBeenCalledWith("note-1", "v1");
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

  it("onSaved hands back an updater that adopts the patch only on the body it was derived from", async () => {
    // Simulates the frontmatter `updated:` injection: saveImpl receives
    // body "v1" and returns the patched body "v1-patched" (timestamp
    // injected). The hook mirrors this back via `onSaved` so the editor's
    // local content reflects the patch — fixes the bug where frontmatter
    // only updated on close-reopen.
    //
    // `onSaved` receives an UPDATER, not a value (myne#167). The latest-wins
    // gate above it reads a ref; this updater is what makes the adoption
    // correct without depending on the ref being current, because React
    // resolves `prev` against the latest queued state. Asserting both branches
    // of it here is the timing-free proof of the fix: no scheduler
    // choreography, no race, just the function the hook handed out.
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
    expect(onSaved).toHaveBeenCalledTimes(1);
    const applyPatch = onSaved.mock.calls[0]![0] as (prev: string) => string;
    // Buffer still exactly what was saved → adopt the stamped body.
    expect(applyPatch("v1")).toBe("v1-patched");
    // Buffer moved on (a keystroke landed inside the save's IPC window) →
    // refuse it. Applying "v1-patched" here would delete that keystroke, which
    // is myne#167.
    expect(applyPatch("v1 and one more char")).toBe("v1 and one more char");
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
    const applyPatch = onSaved.mock.calls[0]![0] as (prev: string) => string;
    expect(applyPatch("v2")).toBe("v2-patched");
  });

  it("the follow-up save declares the base the FIRST save actually wrote", async () => {
    // `savedBodyRef` is the §11.3 expected-base source. The first save wrote
    // the PATCHED body to disk (`saveNote` stamps `updated:` and returns the
    // stamped bytes), so the follow-up must declare that — not the pre-patch
    // body it was fired with. Declaring the pre-patch body names a base the
    // disk does not hold: the follow-up is rejected `BaseMismatch` and the
    // keep-both handler mints a conflict copy for a note only this editor ever
    // touched. Latent while the latest-wins branch almost never ran; the
    // render-written `latestBodyRef` makes it the common path.
    const first = defer();
    const second = defer();
    const saveImpl = vi
      .fn<
        (
          id: string,
          body: string,
          expectedBaseHashHex?: string,
        ) => Promise<string>
      >()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    // The user types while the first save is in flight, then it resolves.
    rerender({ body: "v2" });
    await act(async () => {
      first.resolve("v1-patched");
      await first.promise;
    });

    expect(saveImpl).toHaveBeenCalledTimes(2);
    expect(saveImpl).toHaveBeenNthCalledWith(2, "note-1", "v2", "h:v1-patched");

    await act(async () => {
      second.resolve("v2-patched");
      await second.promise;
    });
  });

  it("hasPendingWork() is true for a buffer whose keystroke has not reached disk", async () => {
    // The predicate the out-of-band reload gates on. It must answer for the
    // buffer as it is NOW — `status` is React state written from a passive
    // effect, so it still reads `saved` for a whole scheduler slice after the
    // user has typed, which is long enough for a `noteRead` to resolve inside
    // it and overwrite those keystrokes with disk bytes.
    const saveImpl = vi.fn(
      (_id: string, body: string) => Promise.resolve(body + "-patched"),
    );
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v0" } },
    );

    rerender({ body: "v1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    // Save settled: disk holds "v1-patched", and that is what the buffer would
    // hold once the echo is adopted.
    rerender({ body: "v1-patched" });
    expect(result.current.hasPendingWork()).toBe(false);

    // One keystroke. `latestBodyRef` is written during render, so the predicate
    // is already true — before any effect for this body has run.
    rerender({ body: "v1-patched!" });
    expect(result.current.hasPendingWork()).toBe(true);
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

  // ── Sync Bug 1 fix: acceptReloadedBody ──────────────────────────────
  // A `sync://changed` pull rewrites the open note's `.myn`; the pane re-reads
  // it and must register the swap as freshly-LOADED content, not a user edit.
  // Otherwise the buffer looks locally-dirty and the next sync stages a spurious
  // keep-both conflict for a note the user never touched.

  it("acceptReloadedBody adopts a sync-reloaded body as clean — no dirty, no save", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v1" } },
    );
    expect(result.current.status).toEqual({ status: "clean" });

    // A peer's edit arrived: re-baseline to the reloaded body, THEN swap it in
    // (the PaneView reload-effect order).
    act(() => result.current.acceptReloadedBody("v2 from peer"));
    rerender({ body: "v2 from peer" });

    // The reload must NOT look like a user edit — the buffer is non-dirty
    // (settles to "saved"/in-sync, not "editing"/"saving") and no save fires.
    expect(result.current.status.status).toBe("saved");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_MS);
    });
    expect(saveImpl).not.toHaveBeenCalled();
  });

  it("a real user edit AFTER acceptReloadedBody still autosaves (re-baseline isn't permanent)", async () => {
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "v1" } },
    );

    act(() => result.current.acceptReloadedBody("v2"));
    rerender({ body: "v2" });
    expect(result.current.status.status).toBe("saved"); // non-dirty after reload

    // Now the user actually types over the reloaded content.
    rerender({ body: "v2 + user edit" });
    expect(result.current.status).toEqual({ status: "editing" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    // Baseline at fire time = the accepted reloaded body "v2".
      expect(saveImpl).toHaveBeenCalledWith("note-1", "v2 + user edit", "h:v2");
  });

  // ── §11.3 expected-base guard: BaseMismatch → local keep-both ──────────
  // A save that lost to a sync pull is rejected backend-side; the hook hands
  // the stale buffer to `onBaseMismatch` (conflict copy + reload) and shows
  // the transient `conflict` status while the handler runs.

  const BASE_MISMATCH = { kind: "BaseMismatch" } as const;

  it("BaseMismatch → conflict status, handler awaited with the latest buffer", async () => {
    const saveImpl = vi
      .fn<(id: string, body: string, h?: string) => Promise<string>>()
      .mockRejectedValueOnce(BASE_MISMATCH);
    const handler = defer();
    const onBaseMismatch = vi.fn(() => handler.promise.then(() => undefined));

    const { result, rerender } = renderHook(
      ({ body }: { body: string }) =>
        useAutosave("note-1", body, saveImpl, undefined, onBaseMismatch),
      { initialProps: { body: "base" } },
    );
    rerender({ body: "typed on stale base" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });

    // The handler is told WHICH note was rejected and what it tried to write
    // (myne#335) — not just a body, and not the pane's current note.
    expect(onBaseMismatch).toHaveBeenCalledWith({
      noteId: "note-1",
      body: "typed on stale base",
    });
    expect(result.current.status).toEqual({ status: "conflict" });

    // While the handler is in flight, retry() must no-op (inFlight non-null).
    act(() => result.current.retry());
    expect(saveImpl).toHaveBeenCalledTimes(1);

    // Handler finishes (in production it ends via acceptReloadedBody → clean).
    await act(async () => {
      handler.resolve("done");
      await handler.promise;
    });
    act(() => result.current.acceptReloadedBody("pulled disk body"));
    expect(result.current.status).toEqual({ status: "clean" });
    expect(saveImpl).toHaveBeenCalledTimes(1); // no phantom re-save
  });

  it("BaseMismatch with a THROWING handler falls back to the error state", async () => {
    const saveImpl = vi
      .fn<(id: string, body: string, h?: string) => Promise<string>>()
      .mockRejectedValueOnce(BASE_MISMATCH);
    const onBaseMismatch = vi.fn(() => Promise.reject(new Error("copy failed")));

    const { result, rerender } = renderHook(
      ({ body }: { body: string }) =>
        useAutosave("note-1", body, saveImpl, undefined, onBaseMismatch),
      { initialProps: { body: "base" } },
    );
    rerender({ body: "typed on stale base" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });

    expect(onBaseMismatch).toHaveBeenCalledTimes(1);
    // Buffer untouched, dirty retained, plain error with Retry available.
    expect(result.current.status).toMatchObject({ status: "error" });
  });

  it("BaseMismatch WITHOUT a handler is a plain error (workspaceBuffers/tests path)", async () => {
    const saveImpl = vi
      .fn<(id: string, body: string, h?: string) => Promise<string>>()
      .mockRejectedValueOnce(BASE_MISMATCH);

    const { result, rerender } = renderHook(
      ({ body }: { body: string }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "base" } },
    );
    rerender({ body: "typed on stale base" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    expect(result.current.status).toMatchObject({
      status: "error",
      error: BASE_MISMATCH,
    });
  });

  it("guard disabled (sync off) → no expected-base hash is sent", async () => {
    // With `guardEnabled = false` (PaneView passes this when sync is
    // disabled/not-enrolled), the §11.3 fingerprint is omitted entirely — the
    // save falls back to plain last-write-wins, so the editor's own local base
    // churn (a create→rename hop, an out-of-band reload racing a keystroke)
    // can never manufacture a false BaseMismatch.
    const saveImpl = vi.fn((_id: string, body: string) => Promise.resolve(body));
    const { rerender } = renderHook(
      ({ body }: { body: string }) =>
        useAutosave("note-1", body, saveImpl, undefined, undefined, false),
      { initialProps: { body: "initial" } },
    );

    rerender({ body: "initial edit" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });

    expect(saveImpl).toHaveBeenCalledTimes(1);
    // Third arg (the expected-base hash) is undefined — guard skipped.
    expect(saveImpl).toHaveBeenCalledWith("note-1", "initial edit", undefined);
  });
});

// ── myne#333: a follow-up save keeps the in-flight slot ────────────────────
//
// The latest-wins branch hands the slot to a follow-up fire and returns; the
// outer `finally` then ran and ERASED that registration. Every guard keyed on
// `inFlightRef` therefore saw an idle hook while a `note_update` was still in
// flight: `flushIfDirty` resolved, so the close paths proceeded — the web
// `pagehide` chain discards the page, the desktop close-intercept calls
// `destroy()` — taking the aborted IPC and the keystrokes typed during the first
// save with them. And `fireSave` re-entered instead of joining, so a SECOND
// concurrent write ran for the same note.
describe("the latest-wins follow-up (myne#333)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("flushIfDirty awaits the follow-up, not just the first save", async () => {
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
    expect(saveImpl).toHaveBeenCalledTimes(1);

    // The user types through the save, so the resolve schedules a follow-up.
    rerender({ body: "v2" });
    await act(async () => {
      first.resolve("v1");
      await first.promise;
    });
    expect(saveImpl).toHaveBeenCalledTimes(2);

    // A close/lock flush now must WAIT for the follow-up.
    let flushed = false;
    await act(async () => {
      void result.current.flushIfDirty().then(() => {
        flushed = true;
      });
      await Promise.resolve();
    });
    expect(flushed).toBe(false);

    await act(async () => {
      second.resolve("v2");
      await second.promise;
      await Promise.resolve();
    });
    expect(flushed).toBe(true);
  });

  it("does not start a THIRD concurrent write while the follow-up runs", async () => {
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
    rerender({ body: "v2" });
    await act(async () => {
      first.resolve("v1");
      await first.promise;
    });

    // Retry while the follow-up is in flight must no-op, not fire again.
    act(() => result.current.retry());
    await act(async () => {
      await Promise.resolve();
    });
    expect(saveImpl).toHaveBeenCalledTimes(2);
  });
});

// ── myne#335: the rejection names the note it was for ──────────────────────
//
// The catch passed `latestBodyRef.current` to a handler bound to the pane's
// CURRENT note. After a note switch those are different notes: the keep-both
// copy was attributed to the wrong one, carrying either that note's untouched
// body or the previous note's edited one — a spurious duplicate in the sidebar
// and the Conflicts view either way. And the REJECTED keystrokes were never
// preserved into a copy, which is the sole purpose of the §11.3 handler; they
// survived only in the volatile per-pane EditorState cache, and even on return
// `acceptReloadedBody` marks them saved, so they are never written to disk.
describe("a BaseMismatch that lands after a note switch (myne#335)", () => {
  const BASE_MISMATCH = { kind: "BaseMismatch" } as const;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("attributes the copy to the note the save was for, with that note's body", async () => {
    const rejection = defer();
    const saveImpl = vi
      .fn<(id: string, body: string, h?: string) => Promise<string>>()
      .mockImplementationOnce(() => rejection.promise);
    const onBaseMismatch = vi.fn(() => Promise.resolve());

    const { rerender } = renderHook(
      ({ id, body }: { id: string; body: string }) =>
        useAutosave(id, body, saveImpl, undefined, onBaseMismatch),
      { initialProps: { id: "note-A", body: "base" } },
    );
    rerender({ id: "note-A", body: "A edited" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    });
    expect(saveImpl).toHaveBeenCalledTimes(1);

    // The user switches notes while A's save is in flight.
    rerender({ id: "note-B", body: "B body" });

    // …and only then does A's save come back rejected.
    await act(async () => {
      rejection.reject(BASE_MISMATCH);
      await rejection.promise.catch(() => {});
    });

    expect(onBaseMismatch).toHaveBeenCalledWith({
      noteId: "note-A",
      body: "A edited",
    });
  });
});

// myne-md/myne#520. `flushAll` refuses to report the disk current when a pane
// did not settle, and `PaneView` answers that question with `lastSaveFailed`.
// These pin WHY it is not `hasPendingWork`: the first version used that, and it
// answers true for a buffer that merely moved on during a successful save, so
// every out-of-band frontmatter write that followed a normal save was refused.
// The E2E suite caught it; nothing here did.
describe("lastSaveFailed, the settled-check a frontmatter writer needs", () => {
  it("is false on a hook that has never saved", () => {
    const { result } = renderHook(() => useAutosave("note-1", "body", vi.fn()));
    expect(result.current.lastSaveFailed()).toBe(false);
  });

  it("is false after a save that landed, even while the buffer has moved on", async () => {
    // The case that broke three E2E scenarios. `hasPendingWork` is TRUE here and
    // correctly so, because there is unsaved work; but nothing FAILED, so a
    // caller about to read-patch-write this note must not be refused.
    const saveImpl = vi.fn(async (_id: string, body: string) => body);
    const { result, rerender } = renderHook(
      ({ body }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "one" } },
    );
    rerender({ body: "two" });
    await act(async () => {
      await result.current.flushIfDirty();
    });
    rerender({ body: "three" });
    expect(result.current.hasPendingWork()).toBe(true);
    expect(result.current.lastSaveFailed()).toBe(false);
  });

  it("is true after a save that rejected, which is the case the guard is for", async () => {
    const saveImpl = vi.fn(async () => {
      throw new Error("storage full");
    });
    const { result, rerender } = renderHook(
      ({ body }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "one" } },
    );
    rerender({ body: "two" });
    await act(async () => {
      await result.current.flushIfDirty();
    });
    expect(result.current.lastSaveFailed()).toBe(true);
  });

  it("clears on the next attempt, so one old failure does not block forever", async () => {
    // The other direction. A latch that never resets would refuse every later
    // cover write for the rest of the session after one transient error.
    let fail = true;
    const saveImpl = vi.fn(async (_id: string, body: string) => {
      if (fail) throw new Error("transient");
      return body;
    });
    const { result, rerender } = renderHook(
      ({ body }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "one" } },
    );
    rerender({ body: "two" });
    await act(async () => {
      await result.current.flushIfDirty();
    });
    expect(result.current.lastSaveFailed()).toBe(true);

    fail = false;
    rerender({ body: "three" });
    await act(async () => {
      await result.current.flushIfDirty();
    });
    expect(result.current.lastSaveFailed()).toBe(false);
  });

  // The three ways the pane stops holding the note the failed attempt was for.
  // Each one leaves the pane CLEAN, so `flushIfDirty` returns immediately and
  // nothing re-fires: a flag left set there is a latch that refuses every
  // out-of-band frontmatter write for the rest of the session, on a note that
  // never failed. The cover toasts write-failed, both template converts no-op,
  // a folder rename reports an unsettled save, and vim `:w` reports a failure
  // for a write that had nothing to do.
  it("clears on a note SWITCH, because the failed save was for another note", async () => {
    const saveImpl = vi.fn(async (_id: string, _body: string) => {
      throw new Error("disk full");
    });
    const { result, rerender } = renderHook(
      ({ id, body }) => useAutosave(id, body, saveImpl),
      { initialProps: { id: "note-1", body: "one" } },
    );
    rerender({ id: "note-1", body: "two" });
    await act(async () => {
      await result.current.flushIfDirty();
    });
    expect(result.current.lastSaveFailed()).toBe(true);

    await act(async () => {
      rerender({ id: "note-2", body: "other note" });
    });
    expect(result.current.lastSaveFailed()).toBe(false);
    // And the pane really is clean, which is what makes the stale flag
    // unreachable by any later attempt.
    expect(result.current.hasPendingWork()).toBe(false);
  });

  it("clears when the buffer is re-baselined against reloaded bytes", async () => {
    const saveImpl = vi.fn(async (_id: string, _body: string) => {
      throw new Error("disk full");
    });
    const { result, rerender } = renderHook(
      ({ body }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "one" } },
    );
    rerender({ body: "two" });
    await act(async () => {
      await result.current.flushIfDirty();
    });
    expect(result.current.lastSaveFailed()).toBe(true);

    act(() => result.current.acceptReloadedBody("from disk"));
    expect(result.current.lastSaveFailed()).toBe(false);
  });

  it("clears when the user reverts to the last body that actually landed", async () => {
    // `savedBodyRef` is only ever set by a save that SUCCEEDED, so matching it
    // means the buffer equals the disk: the failure has been undone by the user
    // rather than by a write.
    let fail = false;
    const saveImpl = vi.fn(async (_id: string, body: string) => {
      if (fail) throw new Error("transient");
      return body;
    });
    const { result, rerender } = renderHook(
      ({ body }) => useAutosave("note-1", body, saveImpl),
      { initialProps: { body: "one" } },
    );
    rerender({ body: "landed" });
    await act(async () => {
      await result.current.flushIfDirty();
    });
    expect(result.current.lastSaveFailed()).toBe(false);

    fail = true;
    rerender({ body: "doomed" });
    await act(async () => {
      await result.current.flushIfDirty();
    });
    expect(result.current.lastSaveFailed()).toBe(true);

    act(() => {
      rerender({ body: "landed" });
    });
    expect(result.current.lastSaveFailed()).toBe(false);
  });
});
