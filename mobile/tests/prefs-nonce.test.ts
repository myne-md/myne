// @vitest-environment jsdom
//
// The mobile prefs-nonce chokepoint (myne-md/myne#486).
//
// `scripts/check-prefs-nonce.mjs` is the static half: it proves no prefs write
// literal sits outside `writePref`. It cannot prove `writePref` still BUMPS:
// deleting the bump line leaves the guard green, because the guard reads call
// shapes, not behaviour. That is this file's half, and the two together are the
// rule.
//
// Two assertions, and the second is not a weaker restatement of the first:
//
//  1. **The roster.** Every exported binding that reaches the IPC boundary with a
//     prefs WRITE advances the nonce. Keyed off what the function actually sent
//     to `invoke`, never off its name, so a setter added tomorrow is covered by
//     existing code rather than by somebody remembering to extend a list. The
//     count is asserted too: an empty roster would satisfy a for-loop silently.
//  2. **The consequence.** A write made from one surface is observed by a
//     `usePrefs` mounted on ANOTHER one, in the same session. That is the
//     acceptance criterion in the issue's own words, and it pins the whole chain
//     (writePref → bumpPrefsNonce → useSyncExternalStore → re-read), of which
//     assertion 1 pins only the first link. Mobile has four independent mount
//     sites (EditorFlow, SettingsSheet, AttachmentsSheet, SyncSettingsPanels),
//     which is why a missing bump here is a stale open editor rather than a
//     latent defect.
//
// `tests/` sits outside `tsc`'s `include: ["src"]`, so the loose call shapes in
// assertion 1 are untyped by design: the mocked `invoke` resolves regardless of
// payload, and the payload is not what is under test.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
// @ts-expect-error: a .mjs guard script with no type declarations. Importing the
// guard's own classification rather than mirroring it is the point: a copy here
// would go stale in both directions (a new read command would make this file
// demand a bump from something that writes nothing; a command moved OUT of the
// set would keep being exempted, silently shrinking the only check that proves
// `writePref` still bumps).
import { READ_COMMANDS as READ_COMMANDS_UNTYPED } from "../../scripts/check-prefs-nonce.mjs";

const READ_COMMANDS = READ_COMMANDS_UNTYPED as Set<string>;

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

// `usePrefs` short-circuits to DEFAULT_PREFS without a Tauri host, which would
// make assertion 2 pass without ever reaching disk. Mocking the seam is how the
// test gets the host path; `HAS_TAURI` itself is a `window.__TAURI_INTERNALS__`
// probe evaluated at module load, so it cannot be set after the fact.
vi.mock("../src/lib/app-window", () => ({ HAS_TAURI: true, closeApp: async () => {} }));

import * as prefs from "../src/lib/prefs";
import {
  getPrefsNonce,
  subscribePrefsNonce,
  bumpPrefsNonce,
  withPrefsBatch,
  __resetPrefsNonceForTest,
} from "../src/lib/prefsNonce";
import { usePrefs, DEFAULT_PREFS } from "../src/lib/use-prefs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Setters sanctioned to skip the bump via `writePref(cmd, args, { bump: false })`.
 *
 * Landed EMPTY and compared in the one direction that matters: without this set
 * the first legitimate use of the documented escape hatch fails below with
 * "wrote … without bumping the nonce", a message that reads like a defect rather
 * than like "you took the opt-out and owe an entry here". The hatch is
 * documented in both prefs modules and used in neither, so an empty set with a
 * reason is what keeps it usable at the cost of one reviewable line, the shape
 * AGENTS.md praises for `ai-no-network-check.sh` check 4.
 */
const BUMPLESS = new Set<string>();

const prefsWritesOf = (calls: unknown[][]) =>
  calls
    .map((c) => c[0])
    .filter((c): c is string => typeof c === "string" && c.startsWith("plugin:prefs|"))
    .map((c) => c.slice("plugin:prefs|".length))
    .filter((c) => !READ_COMMANDS.has(c));

beforeEach(() => {
  invoke.mockReset();
  // `prefs_read` answers a real view rather than `undefined`, and that is not
  // cosmetic. A read-then-write binding (read the current map, splice one key,
  // write it back) throws on `undefined` BEFORE it reaches its write, which the
  // loop below then reads as `writes.length === 0` and skips: the setter drops
  // out of the roster silently, and the floor assertion is the only thing that
  // would notice, one setter at a time. Mobile has no such binding today; the
  // desktop twin does (`toggleFavoriteOnDisk`) and its copy of this loop mocks
  // the read for exactly this reason.
  invoke.mockImplementation(async (cmd: unknown) =>
    cmd === "plugin:prefs|prefs_read" ? DEFAULT_PREFS : undefined,
  );
  __resetPrefsNonceForTest();
});

describe("the mobile prefs chokepoint", () => {
  it("bumps the nonce for every exported binding that writes vault.prefs", async () => {
    const covered: string[] = [];

    for (const [name, fn] of Object.entries(prefs)) {
      if (typeof fn !== "function") continue;
      invoke.mockClear();
      const before = getPrefsNonce();
      // Two positional arguments cover every setter's arity; the mocked `invoke`
      // resolves whatever it is handed, and a binding that ignores them (a pure
      // normalizer) simply reaches no prefs command and is skipped below.
      try {
        await (fn as (...a: unknown[]) => unknown)("probe", "probe");
      } catch {
        // A shape the binding rejects before its IPC call is not a write, and the
        // filter below is what decides that, not this catch.
      }
      const writes = prefsWritesOf(invoke.mock.calls);
      if (writes.length === 0) continue;
      if (BUMPLESS.has(name)) continue;
      covered.push(name);
      expect(getPrefsNonce(), `${name} wrote ${writes.join(", ")} without bumping the nonce`).toBeGreaterThan(
        before,
      );
    }

    // Non-vacuity, pinned at the REAL count rather than under it. A floor fires
    // when the number drops, and an addition raises it, so slack below reality
    // buys nothing and costs coverage: at 40 against 50, ten setters could stop
    // reaching `invoke` (an early return skips them via `writes.length === 0`)
    // with this file still green. `grep -c 'await writePref(' mobile/src/lib/prefs.ts`
    // is the number, and raising it is the whole point of a floor.
    //
    // Raised 47 -> 50 by myne-md/myne#609, which added the three date/time
    // setters. The slack was found by review rather than by this file: a floor
    // left behind an addition is exactly as green as a correct one, so the raise
    // is part of adding a setter and not a follow-up.
    //
    // Raised 50 -> 57 by myne-md/myne#880, which added `setPeriodicNoteSetting`
    // and is the first change to re-measure rather than to bump by one: the
    // count had drifted to 56 setters against a floor of 50, so six could have
    // stopped reaching `invoke` with this file green. 57 is the measured value
    // (`grep -c` reports 53 `await writePref(` calls; the roster keys off what
    // each binding SENT to `invoke`, and a setter whose write sits in a helper
    // still counts, which is why the two numbers differ).
    //
    // Raised 57 -> 62 later in the same branch, whose phase 3 rows bound five
    // more setters (colour groups, AI excluded folders, chat-history budget,
    // meeting prompt, attachment OCR). Measured by the roster, not by `grep`.
    expect(covered.length).toBeGreaterThanOrEqual(62);
    // Two names pinned rather than left to the count, because these two toggles
    // are the ones a user reads as a privacy promise, so a surface showing the
    // old value is worse here than a stale font size. Deliberately NOT cited to
    // `agent-tooling/docs/threat-model.md` §6: that section scopes screen-capture exclusion to
    // Windows, macOS and Linux and describes no mobile platform, and its own text
    // records that one unqualified sentence made the item overclaim for a year.
    // What this assertion pins is narrower and true: the displayed state of these
    // toggles must match disk.
    expect(covered).toContain("setScreenCaptureProtection");
    expect(covered).toContain("setRemindersEnabled");
  });

  it("does not bump when the write rejects", async () => {
    // The twin of `tests/lib/prefsBindings.test.ts`'s rejection case, and the
    // reason it has to exist here too: the roster above proves a RESOLVED write
    // bumps, and nothing proves the bump sits after the invoke. Hoisting
    // `bumpPrefsNonce()` above `await invoke()` in `lib/prefs.ts` passes every
    // other assertion in this file, while making a FAILED write refresh all four
    // mounted `usePrefs` from disk that the write never reached, racing the
    // in-flight write. `lib/prefsNonce.ts` forbids exactly that ("never before,
    // else a re-read pulls stale disk truth"), and `writePref`'s own doc claims
    // "Bumps on SUCCESS only". This is what holds it to the claim.
    invoke.mockReset();
    invoke.mockRejectedValueOnce({ kind: "SlotNotUnlocked" });
    const before = getPrefsNonce();
    await expect(prefs.setScreenCaptureProtection(true)).rejects.toEqual({
      kind: "SlotNotUnlocked",
    });
    expect(getPrefsNonce()).toBe(before);
  });

  it("lets a write on one surface reach a usePrefs mounted on another", async () => {
    let disk = { ...DEFAULT_PREFS, screen_capture_protection: false };
    invoke.mockImplementation(async (cmd: unknown) => {
      if (cmd === "plugin:prefs|prefs_read") return disk;
      if (cmd === "plugin:prefs|set_screen_capture_protection") {
        disk = { ...disk, screen_capture_protection: true };
        return undefined;
      }
      return undefined;
    });

    // Two independent mounts, standing in for the Settings sheet and the editor
    // behind it: separate roots, separate `usePrefs` state, one shared nonce.
    const Probe = () =>
      createElement("span", null, String(usePrefs().prefs.screen_capture_protection));
    const hosts = [document.createElement("div"), document.createElement("div")];
    const roots = hosts.map((h) => {
      document.body.appendChild(h);
      return createRoot(h);
    });

    await act(async () => {
      for (const r of roots) r.render(createElement(Probe));
    });
    expect(hosts.map((h) => h.textContent)).toEqual(["false", "false"]);

    // The write goes through the setter, exactly as SettingsSheet makes it. No
    // test-only bump: a bump called here would assert the plumbing while leaving
    // the thing under test (that `writePref` bumps) unexercised.
    await act(async () => {
      await prefs.setScreenCaptureProtection(true);
    });

    expect(hosts.map((h) => h.textContent)).toEqual(["true", "true"]);

    await act(async () => {
      for (const r of roots) r.unmount();
    });
    for (const h of hosts) h.remove();
  });
});

describe("withPrefsBatch", () => {
  // A multi-write user action (a folder rename writes deliberate_folders,
  // archived_folders, item_colors and folder_icons) awaits between its writes,
  // so the module's microtask coalescing cannot collapse them: it only catches a
  // SYNCHRONOUS burst. Without the batch each write notified separately and
  // every mounted usePrefs re-read and re-decrypted vault.prefs once per write.

  async function notifyCount(run: () => Promise<void>): Promise<number> {
    let notifies = 0;
    const off = subscribePrefsNonce(() => {
      notifies += 1;
    });
    await run();
    // The flush is a microtask; two turns is enough to let a deferred one land.
    await Promise.resolve();
    await Promise.resolve();
    off();
    return notifies;
  }

  it("notifies once for writes that await each other, instead of once each", async () => {
    const unbatched = await notifyCount(async () => {
      for (let i = 0; i < 4; i += 1) {
        bumpPrefsNonce();
        await Promise.resolve();
      }
    });
    __resetPrefsNonceForTest();

    const batched = await notifyCount(() =>
      withPrefsBatch(async () => {
        for (let i = 0; i < 4; i += 1) {
          bumpPrefsNonce();
          await Promise.resolve();
        }
      }),
    );

    // The unbatched arm is the control: without it a passing `batched === 1`
    // could mean the batch works OR that four awaited bumps already coalesced.
    expect(unbatched).toBe(4);
    expect(batched).toBe(1);
  });

  it("keeps the nonce monotonic, so no subscriber sees a skipped change", async () => {
    await withPrefsBatch(async () => {
      for (let i = 0; i < 3; i += 1) {
        bumpPrefsNonce();
        await Promise.resolve();
      }
    });
    // Deferring the NOTIFY is the whole trick. Deferring the increment would let
    // a reader observe a value that never covered one of the writes.
    expect(getPrefsNonce()).toBe(3);
  });

  it("still flushes when the batched action throws", async () => {
    const notifies = await notifyCount(async () => {
      await expect(
        withPrefsBatch(async () => {
          bumpPrefsNonce();
          throw new Error("write two failed");
        }),
      ).rejects.toThrow("write two failed");
    });
    // A rename that fails halfway still wrote something, and a surface left on
    // the pre-write view with no bump coming is the exact defect the chokepoint
    // exists to prevent.
    expect(notifies).toBe(1);
  });

  it("emits one notify for nested batches, not one per level", async () => {
    const notifies = await notifyCount(() =>
      withPrefsBatch(async () => {
        bumpPrefsNonce();
        await withPrefsBatch(async () => {
          bumpPrefsNonce();
          await Promise.resolve();
        });
        bumpPrefsNonce();
      }),
    );
    expect(notifies).toBe(1);
    expect(getPrefsNonce()).toBe(3);
  });
});
describe("usePrefs read ordering", () => {
  // The token is the other half of this change and nothing pinned it: deleted
  // tomorrow, every other spec in this file still passes. Both cases below are
  // races, so they are driven by resolving the mocked reads by hand rather than
  // by hoping a timer lands in the right order.

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("keeps the newer view when an older read resolves last", async () => {
    const first = deferred<typeof DEFAULT_PREFS>();
    const second = deferred<typeof DEFAULT_PREFS>();
    const reads = [first.promise, second.promise];
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "plugin:prefs|prefs_read" ? reads.shift() : undefined,
    );

    let seen: typeof DEFAULT_PREFS | null = null;
    function Probe() {
      const { prefs: p } = usePrefs();
      seen = p;
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(Probe));
    });

    // A second read is issued while the first is still in flight, exactly as a
    // nonce advance during a mount read does.
    await act(async () => {
      bumpPrefsNonce();
    });

    await act(async () => {
      second.resolve({ ...DEFAULT_PREFS, editor_text_size: "xl" });
    });
    await act(async () => {
      first.resolve({ ...DEFAULT_PREFS, editor_text_size: "sm" });
    });

    // Without the token the late-resolving OLDER read wins and the surface
    // shows "sm", which is the stale-open-editor defect one road over.
    expect(seen?.editor_text_size).toBe("xl");

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("applies an older successful read when the newer one fails", async () => {
    const first = deferred<typeof DEFAULT_PREFS>();
    const second = deferred<typeof DEFAULT_PREFS>();
    const reads = [first.promise, second.promise];
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "plugin:prefs|prefs_read" ? reads.shift() : undefined,
    );

    let seen: typeof DEFAULT_PREFS | null = null;
    function Probe() {
      const { prefs: p } = usePrefs();
      seen = p;
      return null;
    }
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(Probe));
    });
    await act(async () => {
      bumpPrefsNonce();
    });

    // The newer read fails, the older one then succeeds. A plain
    // latest-issued-wins check discards the older view and the hook sits on
    // DEFAULT_PREFS, older than what it had in hand.
    await act(async () => {
      second.reject(new Error("read failed"));
    });
    await act(async () => {
      first.resolve({ ...DEFAULT_PREFS, editor_text_size: "sm" });
    });

    expect(seen?.editor_text_size).toBe("sm");

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
