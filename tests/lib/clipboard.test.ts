// The clipboard copy contract, asserted once for every client.
//
// Eleven call sites across three trees used to decide independently what a copy
// tells the user, and four patterns emerged, two of which said nothing at all
// (myne-md/myne#390, myne-md/myne#455). The module under test is the chokepoint
// that ends that: it cannot be called without a feedback pair, and a caller that
// wants silence has to name a reason for it.
//
// Two properties carry most of the value and are asserted here rather than left
// to review:
//
//   1. A FAILED write never schedules a clear. Scheduling one anyway would wipe
//      whatever the user actually had on the clipboard, which turns a failed
//      copy into data loss on a surface that was only supposed to report.
//   2. A `silent` arm is structurally distinct from a forgotten one. It carries
//      a reason and no `run`, so "nothing happens" is a decision the type system
//      made the author state.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  copySecret,
  copyText,
  type ClearStrategy,
  type Feedback,
} from "../../src/lib/clipboard";

/** A feedback pair whose arms record that they ran. */
function recordingFeedback(): { feedback: Feedback; ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    feedback: {
      onSuccess: { kind: "toast", run: () => ran.push("success") },
      onFailure: { kind: "toast", run: () => ran.push("failure") },
    },
  };
}

const SILENT_FAILURE: Feedback = {
  onSuccess: { kind: "inline", run: () => {} },
  onFailure: {
    kind: "silent",
    reason: "the fail-closed screen must not stack a second error surface",
  },
};

describe("copyText", () => {
  it("runs the success arm and returns true when the write lands", async () => {
    const { feedback, ran } = recordingFeedback();
    const write = vi.fn().mockResolvedValue(undefined);

    await expect(copyText(write, "hello", feedback)).resolves.toBe(true);

    expect(write).toHaveBeenCalledWith("hello");
    expect(ran).toEqual(["success"]);
  });

  it("runs the failure arm and returns false when the write rejects", async () => {
    const { feedback, ran } = recordingFeedback();
    const write = vi.fn().mockRejectedValue(new Error("denied"));

    await expect(copyText(write, "hello", feedback)).resolves.toBe(false);

    expect(ran).toEqual(["failure"]);
  });

  it("reports the rejection to the injected error sink and swallows it", async () => {
    const onError = vi.fn();
    const write = vi.fn().mockRejectedValue(new Error("denied"));

    await expect(
      copyText(write, "hello", SILENT_FAILURE, { onError }),
    ).resolves.toBe(false);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("does nothing observable for a silent arm, and never throws for it", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied"));

    await expect(copyText(write, "hello", SILENT_FAILURE)).resolves.toBe(false);
  });

  it("never passes the copied value to the feedback arm", async () => {
    // The arms take no argument at all, which is the structural version of the
    // module's rule: a confirmation names the OUTCOME, never the VALUE. A toast
    // that renders the recovery phrase defeats the entire feature.
    const seen: unknown[] = [];
    const feedback: Feedback = {
      onSuccess: { kind: "toast", run: (...args: unknown[]) => seen.push(args) },
      onFailure: { kind: "toast", run: (...args: unknown[]) => seen.push(args) },
    };

    await copyText(vi.fn().mockResolvedValue(undefined), "s3cret", feedback);

    expect(seen).toEqual([[]]);
  });
});

describe("copySecret", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function hostClear(clear: (value: string) => Promise<void>): ClearStrategy {
    return { kind: "host", clear, delayMs: 30_000 };
  }

  it("schedules the host clear and returns a cancel function on success", async () => {
    const { feedback, ran } = recordingFeedback();
    const clear = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn().mockResolvedValue(undefined);

    const cancel = await copySecret(write, "phrase", feedback, hostClear(clear));

    expect(cancel).toBeTypeOf("function");
    expect(ran).toEqual(["success"]);
    expect(clear).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(clear).toHaveBeenCalledWith("phrase");
  });

  it("cancels the pending clear when the returned function is called", async () => {
    const { feedback } = recordingFeedback();
    const clear = vi.fn().mockResolvedValue(undefined);

    const cancel = await copySecret(
      vi.fn().mockResolvedValue(undefined),
      "phrase",
      feedback,
      hostClear(clear),
    );
    cancel?.();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(clear).not.toHaveBeenCalled();
  });

  it("returns null and schedules NO clear when the write failed", async () => {
    // The load-bearing one. A clear scheduled after a failed write wipes whatever
    // the user really had on the clipboard, so a surface that was supposed to
    // report a failure would instead destroy data.
    const { feedback, ran } = recordingFeedback();
    const clear = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn().mockRejectedValue(new Error("denied"));

    const cancel = await copySecret(write, "phrase", feedback, hostClear(clear));

    expect(cancel).toBeNull();
    expect(ran).toEqual(["failure"]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(clear).not.toHaveBeenCalled();
  });

  it("schedules no timer at all when the OS owns the expiry", async () => {
    // Mobile: the pasteboard item carries its own expiry, enforced by the OS and
    // surviving process death. A JS timer here would be a worse duplicate of it
    // AND would hold the secret in the heap for the whole window.
    const { feedback, ran } = recordingFeedback();

    const cancel = await copySecret(
      vi.fn().mockResolvedValue(undefined),
      "phrase",
      feedback,
      { kind: "os-managed" },
    );

    expect(cancel).toBeTypeOf("function");
    expect(ran).toEqual(["success"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops passing the secret to the clear once the caller has cancelled", async () => {
    // Retention, asserted through the only observable the module has. The
    // hazard is that the returned cancel closure and the timer body are siblings
    // in one scope, so a caller holding the cancel keeps the secret reachable
    // even after the clear has run or been cancelled. `src/lib/secret-export.ts`
    // has that shape today and its docstring claims otherwise.
    //
    // A JS test cannot read the heap, so this asserts the consequence the fix
    // produces: after cancelling, the timer body finds nothing to clear and does
    // not call through even if it somehow fires.
    const { feedback } = recordingFeedback();
    const clear = vi.fn().mockResolvedValue(undefined);

    const cancel = await copySecret(
      vi.fn().mockResolvedValue(undefined),
      "phrase",
      feedback,
      hostClear(clear),
    );
    cancel?.();
    cancel?.(); // idempotent, an unmount path may fire twice

    await vi.advanceTimersByTimeAsync(60_000);
    expect(clear).not.toHaveBeenCalled();
  });

  it("returns the same no-op cancel for every OS-managed copy", async () => {
    // Identity, not just behaviour. A fresh `() => {}` per call would be a
    // closure over `copySecret`'s scope, and that scope holds the secret; a
    // shared module-level constant cannot reference it at all. This is the only
    // way to observe that difference from a test.
    const { feedback } = recordingFeedback();
    const write = vi.fn().mockResolvedValue(undefined);

    const a = await copySecret(write, "phrase-one", feedback, { kind: "os-managed" });
    const b = await copySecret(write, "phrase-two", feedback, { kind: "os-managed" });

    expect(a).toBe(b);
  });

  it("swallows a clear failure rather than surfacing it after the fact", async () => {
    // The window has passed and the user has moved on; an error about it lands on
    // whatever screen they are on now, which is not the one they copied from.
    const { feedback } = recordingFeedback();
    const onError = vi.fn();
    const clear = vi.fn().mockRejectedValue(new Error("acl refused"));

    await copySecret(
      vi.fn().mockResolvedValue(undefined),
      "phrase",
      feedback,
      hostClear(clear),
      { onError },
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
