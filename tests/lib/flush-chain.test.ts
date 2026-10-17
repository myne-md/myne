// The flush chain's order, its skip rule, and the failure isolation that keeps
// a lock from being cancelled (phase3-web-client tasks 43 + 93).
//
// Everything here is a property that no type checker sees and that a passing
// app exercises only on the paths nobody tests by hand: a tab closing, an idle
// deadline, a write that failed.

import { describe, expect, it } from "vitest";
import { runFlushChain, type FlushChainSteps } from "../../src/lib/flush-chain";

/** Steps that record their own invocation order into `log`. */
function steps(log: string[], failing: string[] = []): FlushChainSteps {
  const make = (name: string) => () => {
    log.push(name);
    if (failing.includes(name)) return Promise.reject(new Error(`${name} failed`));
    return Promise.resolve();
  };
  return {
    flushAll: make("flushAll"),
    persistWorkspace: make("persistWorkspace"),
    persistVaultIndices: make("persistVaultIndices"),
    flushGraphLayout: make("flushGraphLayout"),
  };
}

describe("flush chain ordering", () => {
  it("writes content first and the rebuildable caches after", async () => {
    // The ordering IS the integrity guarantee: a chain that gets halfway must
    // leave note bodies correct and lose only things that can be regenerated.
    // Asserted as an exact sequence, because "flushAll was called" would pass on
    // a chain that called it last.
    const log: string[] = [];
    await runFlushChain(steps(log), "lock");
    expect(log).toEqual([
      "flushAll",
      "persistWorkspace",
      "persistVaultIndices",
      "flushGraphLayout",
    ]);
  });

  it("runs the same order on a real close", async () => {
    const log: string[] = [];
    await runFlushChain(steps(log), "closing");
    expect(log).toEqual([
      "flushAll",
      "persistWorkspace",
      "persistVaultIndices",
      "flushGraphLayout",
    ]);
  });

  it("does NOT write the workspace descriptor when merely hiding", async () => {
    // `protocol.md` §9.7.4 keeps `vault.workspace`'s mtime a lock/quit signal. A
    // tab switch happens dozens of times an hour; writing on each one turns that
    // mtime into an editor-activity log.
    const log: string[] = [];
    await runFlushChain(steps(log), "hiding");
    expect(log).not.toContain("persistWorkspace");
  });

  it("still flushes note content when hiding", async () => {
    // The other half of the same rule, and the one that makes skipping the
    // workspace safe: a hidden tab can be discarded with no further event, so
    // content cannot wait for `pagehide`.
    const log: string[] = [];
    await runFlushChain(steps(log), "hiding");
    expect(log[0]).toBe("flushAll");
    expect(log).toEqual(["flushAll", "persistVaultIndices", "flushGraphLayout"]);
  });
});

describe("failure isolation", () => {
  it("keeps going when the FIRST step throws", async () => {
    // The regression this file exists for. As a bare `await` sequence, a
    // rejection here skipped every later step — and, at the lock call site, the
    // lock itself: the idle deadline passed, the vault stayed unlocked, the keys
    // stayed live in the Worker, and the caller's `void` turned the rejection
    // into an unhandled promise rather than an error anyone saw.
    const log: string[] = [];
    const result = await runFlushChain(steps(log, ["flushAll"]), "lock");
    expect(log).toEqual([
      "flushAll",
      "persistWorkspace",
      "persistVaultIndices",
      "flushGraphLayout",
    ]);
    expect(result.failed).toEqual(["flushAll"]);
  });

  it("keeps going when a middle step throws", async () => {
    const log: string[] = [];
    const result = await runFlushChain(steps(log, ["persistWorkspace"]), "closing");
    expect(log).toHaveLength(4);
    expect(result.failed).toEqual(["persistWorkspace"]);
  });

  it("never rejects, even when every step throws", async () => {
    // The caller's next action is to zeroize keys or let the page go away.
    // Neither may be skipped because a cache write failed, so this function has
    // exactly one exit: a resolved result.
    const log: string[] = [];
    const all = ["flushAll", "persistWorkspace", "persistVaultIndices", "flushGraphLayout"];
    const result = await runFlushChain(steps(log, all), "lock");
    expect(result.failed).toEqual(all);
    expect(result.ran).toEqual(all);
  });

  it("survives a step that throws SYNCHRONOUSLY", async () => {
    // A step is typed as `() => Promise<void> | void`, so a synchronous throw is
    // reachable and would escape a bare `.catch()` on the returned promise.
    const log: string[] = [];
    const result = await runFlushChain(
      {
        flushAll: () => {
          log.push("flushAll");
          throw new Error("sync boom");
        },
        persistWorkspace: () => void log.push("persistWorkspace"),
        persistVaultIndices: () => void log.push("persistVaultIndices"),
        flushGraphLayout: () => void log.push("flushGraphLayout"),
      },
      "lock",
    );
    expect(log).toHaveLength(4);
    expect(result.failed).toEqual(["flushAll"]);
  });

  it("reports success as an empty failure list, not an absent one", async () => {
    const result = await runFlushChain(steps([]), "lock");
    expect(result.failed).toEqual([]);
  });
});

describe("the chain is awaited, not fired", () => {
  it("does not start a step before the previous one settles", async () => {
    // Ordering is only meaningful if each step completes first. A chain that
    // launched all four and awaited `Promise.all` would satisfy an
    // invocation-order assertion while writing them concurrently — and the
    // integrity claim ("content is safe even if the rest is lost") would be
    // false, because a half-written cache could land before the note body did.
    const settled: string[] = [];
    let releaseFlush!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFlush = r;
    });
    const run = runFlushChain(
      {
        flushAll: async () => {
          await gate;
          settled.push("flushAll");
        },
        persistWorkspace: () => void settled.push("persistWorkspace"),
        persistVaultIndices: () => void settled.push("persistVaultIndices"),
        flushGraphLayout: () => void settled.push("flushGraphLayout"),
      },
      "lock",
    );
    await Promise.resolve();
    expect(settled).toEqual([]); // nothing ran past the blocked first step
    releaseFlush();
    await run;
    expect(settled[0]).toBe("flushAll");
  });
});
