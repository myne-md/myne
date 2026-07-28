// The Worker transport's failure behaviour (phase3-web-client task 11).
//
// # What is worth testing here, and what is not
//
// The happy path is one line of code and is exercised end-to-end by the browser
// run (tasks 15 / 105). What no browser run reliably reproduces is the set this
// file covers: a Worker that dies mid-call, that dies before starting, that
// never starts at all, that fails to structured-clone a reply. Those are the
// paths where "the promise never settles" is the natural bug, and a hung promise
// is the worst outcome on this path — a spinner with no cause, no error boundary
// reached, and no recovery short of the user guessing to reload.
//
// So every test here asserts that something SETTLES.
//
// The fake `Worker` is a real class with the real event-handler surface
// (`onmessage` / `onerror` / `onmessageerror` / `postMessage` / `terminate`), not
// a mocked module, because the module under test is precisely the wiring between
// those four handlers — mocking them out would leave nothing under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPlatformUnsupported } from "../../src/platform/unsupported";
import { FATAL_CODES, WORKER_READY } from "../../web/src/worker/protocol";
import type { WorkerResponse } from "../../web/src/worker/protocol";

/** The one live fake, so a test can drive the Worker side of the conversation. */
let live: FakeWorker | null = null;

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessageerror: ((e: Event) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;

  constructor() {
    live = this;
  }

  postMessage(message: unknown): void {
    if (this.failClone) throw new DOMException("could not be cloned", "DataCloneError");
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Set by a test to make `postMessage` throw, as a non-cloneable payload does. */
  failClone = false;

  // ── the Worker→page direction ───────────────────────────────────────────────

  send(message: WorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  announceReady(): void {
    this.send({ id: 0, kind: "event", event: WORKER_READY, payload: {} });
  }

  /** The last `invoke` request's correlation id. */
  lastId(): number {
    const last = this.posted.at(-1) as { id: number } | undefined;
    if (!last) throw new Error("nothing posted");
    return last.id;
  }
}

/**
 * Import a FRESH copy of the host module.
 *
 * `host.ts` holds the Worker, the waiter map and the fatal flag at module scope
 * — correctly, since there is exactly one Worker per page. That makes the module
 * stateful, so every test needs its own instance or a fatal from one test would
 * poison the next.
 */
async function freshHost() {
  vi.resetModules();
  return await import("../../web/src/worker/host");
}

beforeEach(() => {
  live = null;
  vi.stubGlobal("Worker", FakeWorker);
  // The host builds the Worker URL with `new URL("./worker.ts", import.meta.url)`,
  // which resolves fine under Vitest — no stub needed for it.
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Let queued microtasks run so the host's `await ready` resumes. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("worker host — the happy path it must not break", () => {
  it("correlates replies to their own call, out of order", async () => {
    const host = await freshHost();
    const first = host.invoke("plugin:prefs|device_platform");
    const second = host.invoke("plugin:prefs|prefs_read");
    await settle();
    live!.announceReady();
    await settle();

    const [a, b] = live!.posted as Array<{ id: number }>;
    // Replied in REVERSE order on purpose: a transport that assumed FIFO would
    // hand each caller the other's value, which is a silent wrong answer rather
    // than a failure.
    live!.send({ id: b.id, kind: "ok", value: "second-value" });
    live!.send({ id: a.id, kind: "ok", value: "first-value" });

    await expect(first).resolves.toBe("first-value");
    await expect(second).resolves.toBe("second-value");
  });

  it("queues calls made before the Worker announces itself", async () => {
    const host = await freshHost();
    const call = host.invoke("plugin:prefs|device_platform");
    await settle();
    // Nothing may be posted yet — the instance is not up.
    expect(live!.posted).toHaveLength(0);

    live!.announceReady();
    await settle();
    expect(live!.posted).toHaveLength(1);

    live!.send({ id: live!.lastId(), kind: "ok", value: "unknown" });
    await expect(call).resolves.toBe("unknown");
  });

  it("rejects with the backend's error value verbatim, not wrapped in an Error", async () => {
    // Load-bearing: every caller in `src/` pattern-matches on Rust error enums
    // (`src/types/`), and Tauri's own `invoke` rejects with the bare value.
    // Wrapping here would break the shared tree on web only.
    const host = await freshHost();
    const call = host.invoke("plugin:vault-unlock|unlock");
    await settle();
    live!.announceReady();
    await settle();

    const backendError = { kind: "WrongPassword", attemptsLeft: 2 };
    live!.send({ id: live!.lastId(), kind: "error", error: backendError });

    await expect(call).rejects.toEqual(backendError);
    await call.catch((e) => {
      expect(e).not.toBeInstanceOf(Error);
      expect(e.kind).toBe("WrongPassword");
    });
  });
});

describe("worker host — the typed unsupported outcome", () => {
  it("raises the SAME error type the desktop seam raises, carrying the command", async () => {
    const host = await freshHost();
    const call = host.invoke("plugin:backup|vault_export_backup");
    await settle();
    live!.announceReady();
    await settle();

    live!.send({
      id: live!.lastId(),
      kind: "unsupported",
      operation: "plugin:backup|vault_export_backup",
    });

    await call.catch((e) => {
      // `isPlatformUnsupported` is the guard the seam contract test uses, and it
      // works across bundle boundaries by pinning `name` — so this asserts the
      // web transport is indistinguishable from the desktop seam to a caller.
      expect(isPlatformUnsupported(e)).toBe(true);
      expect(e.operation).toBe("plugin:backup|vault_export_backup");
    });
    expect.assertions(2);
  });

  it("does not mint a malformed operation when the string lost its shape", async () => {
    // `operation` crosses structured clone as a plain string; a version-skewed
    // Worker could send something else. Falling back to the seam-level operation
    // keeps the error type honest instead of inventing an IPC name.
    const host = await freshHost();
    const call = host.invoke("plugin:backup|vault_export_backup");
    await settle();
    live!.announceReady();
    await settle();

    live!.send({ id: live!.lastId(), kind: "unsupported", operation: "garbage" });
    await call.catch((e) => {
      expect(isPlatformUnsupported(e)).toBe(true);
      expect(e.operation).toBe("core.invoke");
    });
    expect.assertions(2);
  });
});

describe("worker host — every death route settles every promise", () => {
  // One table, four routes. They are tested together because the property is
  // shared: whichever way the Worker dies, no caller may be left hanging. A
  // per-route test would let one route regress into a hang while the others pass.
  const routes: Array<[string, (w: FakeWorker) => void, string]> = [
    [
      "a fatal message (wasm panic)",
      (w) => w.send({ id: 1, kind: "fatal", code: FATAL_CODES.wasmPanic }),
      FATAL_CODES.wasmPanic,
    ],
    [
      "onerror (uncaught exception in the Worker script)",
      (w) => w.onerror?.({ preventDefault() {} } as unknown as Event),
      FATAL_CODES.workerError,
    ],
    [
      "onmessageerror (a reply that could not be cloned)",
      (w) => w.onmessageerror?.({} as Event),
      FATAL_CODES.messageError,
    ],
    [
      "a fatal message (CSPRNG unavailable at startup)",
      (w) => w.send({ id: 0, kind: "fatal", code: FATAL_CODES.csprngUnavailable }),
      FATAL_CODES.csprngUnavailable,
    ],
  ];

  for (const [label, kill, expectedCode] of routes) {
    it(`rejects the in-flight call on ${label}`, async () => {
      const host = await freshHost();
      const call = host.invoke("plugin:notes|note_read");
      await settle();
      live!.announceReady();
      await settle();

      kill(live!);

      await call.catch((e) => {
        expect(host.isWorkerFatal(e)).toBe(true);
        expect(e.code).toBe(expectedCode);
      });
      expect.assertions(2);
    });

    it(`rejects a SUBSEQUENT call after ${label}`, async () => {
      // The half that is easy to miss: a dead Worker must keep failing. A
      // transport that only rejected in-flight calls would let the next one hang
      // forever on an instance that will never answer.
      const host = await freshHost();
      const first = host.invoke("plugin:notes|note_read");
      await settle();
      live!.announceReady();
      await settle();
      kill(live!);
      await first.catch(() => {});

      await expect(host.invoke("plugin:notes|note_list")).rejects.toMatchObject({
        code: expectedCode,
      });
    });
  }

  it("keeps the FIRST cause when a second death follows", async () => {
    // A panic commonly cascades into `onerror`. The second event is not new
    // information, and overwriting would lose the diagnosis.
    const host = await freshHost();
    const call = host.invoke("plugin:notes|note_read");
    await settle();
    live!.announceReady();
    await settle();

    live!.send({ id: 1, kind: "fatal", code: FATAL_CODES.wasmPanic });
    live!.onerror?.({ preventDefault() {} } as unknown as Event);

    await call.catch(() => {});
    expect(host.fatalCause()?.code).toBe(FATAL_CODES.wasmPanic);
  });

  it("declares the Worker dead if it never announces itself", async () => {
    vi.useFakeTimers();
    const host = await freshHost();
    const call = host.invoke("plugin:prefs|device_platform");
    // The assertion is attached BEFORE the clock advances, on purpose:
    // `advanceTimersByTimeAsync` drains the microtask queue, and Node reports an
    // unhandled rejection at that checkpoint. Awaiting the advance first would
    // make a correctly-rejecting promise look like an unhandled error.
    const rejects = expect(call).rejects.toMatchObject({
      code: FATAL_CODES.startupTimeout,
    });
    // Nothing sent from the Worker at all — the shape of a `.wasm` that never
    // fetched, or a Worker script that never ran.
    await vi.advanceTimersByTimeAsync(31_000);
    await rejects;
  });

  it("does NOT declare the Worker dead when the caller's own args are uncloneable", async () => {
    // A `DataCloneError` from `postMessage` is a CALLER bug (a function, a DOM
    // node in the payload). Killing the Worker for it would turn one bad call
    // site into a dead vault, which is a much worse outcome than one rejection.
    const host = await freshHost();
    const warmUp = host.invoke("plugin:prefs|device_platform");
    await settle();
    live!.announceReady();
    await settle();
    live!.send({ id: live!.lastId(), kind: "ok", value: "unknown" });
    await warmUp;

    live!.failClone = true;
    await expect(host.invoke("plugin:notes|note_update", { fn: () => {} })).rejects.toThrow(
      /cloned/,
    );
    expect(host.fatalCause()).toBeNull();

    // …and the transport still works afterwards.
    live!.failClone = false;
    const after = host.invoke("plugin:prefs|device_platform");
    await settle();
    live!.send({ id: live!.lastId(), kind: "ok", value: "unknown" });
    await expect(after).resolves.toBe("unknown");
  });
});

describe("worker host — backend events", () => {
  it("delivers to every listener and stops after unsubscribe", async () => {
    const host = await freshHost();
    const seen: unknown[] = [];
    const off = host.subscribe("myne:prefs-changed", (p) => seen.push(p));
    host.subscribe("myne:prefs-changed", (p) => seen.push(p));
    await settle();
    live!.announceReady();

    live!.send({ id: 0, kind: "event", event: "myne:prefs-changed", payload: 1 });
    expect(seen).toEqual([1, 1]);

    off();
    live!.send({ id: 0, kind: "event", event: "myne:prefs-changed", payload: 2 });
    expect(seen).toEqual([1, 1, 2]);
  });

  it("a throwing listener does not stop its siblings or kill the pump", async () => {
    // An exception escaping `onmessage` surfaces as `onerror`, which the host
    // reads as the Worker dying — so a buggy UI listener would look like a
    // crashed vault. This is the test that keeps those separate.
    const host = await freshHost();
    const seen: unknown[] = [];
    host.subscribe("e", () => {
      throw new Error("listener bug");
    });
    host.subscribe("e", (p) => seen.push(p));
    await settle();
    live!.announceReady();

    live!.send({ id: 0, kind: "event", event: "e", payload: "delivered" });
    expect(seen).toEqual(["delivered"]);
    expect(host.fatalCause()).toBeNull();
  });

  it("the ready announcement is not delivered to event listeners", async () => {
    // `WORKER_READY` travels on the same channel as backend events but is the
    // transport's own handshake; leaking it to subscribers would make it
    // observable as a vault event.
    const host = await freshHost();
    const seen: unknown[] = [];
    host.subscribe(WORKER_READY, (p) => seen.push(p));
    await settle();
    live!.announceReady();
    await settle();
    expect(seen).toEqual([]);
  });
});

describe("worker host — teardown", () => {
  it("terminate() rejects outstanding calls rather than dropping them", async () => {
    const host = await freshHost();
    const call = host.invoke("plugin:notes|note_read");
    await settle();
    live!.announceReady();
    await settle();

    host.terminate();

    expect(live!.terminated).toBe(true);
    await expect(call).rejects.toMatchObject({ code: FATAL_CODES.terminated });
  });
});
