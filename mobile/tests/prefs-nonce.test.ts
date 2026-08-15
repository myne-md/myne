// @vitest-environment jsdom
//
// The mobile prefs-nonce chokepoint (myne-md/myne#486).
//
// `scripts/check-prefs-nonce.mjs` is the static half: it proves no prefs write
// literal sits outside `writePref`. It cannot prove `writePref` still BUMPS —
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
//     sites — EditorFlow, SettingsSheet, AttachmentsSheet, SyncSettingsPanels —
//     which is why a missing bump here is a stale open editor rather than a
//     latent defect.
//
// `tests/` sits outside `tsc`'s `include: ["src"]`, so the loose call shapes in
// assertion 1 are untyped by design: the mocked `invoke` resolves regardless of
// payload, and the payload is not what is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const invoke = vi.fn(async () => undefined as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

// `usePrefs` short-circuits to DEFAULT_PREFS without a Tauri host, which would
// make assertion 2 pass without ever reaching disk. Mocking the seam is how the
// test gets the host path; `HAS_TAURI` itself is a `window.__TAURI_INTERNALS__`
// probe evaluated at module load, so it cannot be set after the fact.
vi.mock("../src/lib/app-window", () => ({ HAS_TAURI: true, closeApp: async () => {} }));

import * as prefs from "../src/lib/prefs";
import { getPrefsNonce, __resetPrefsNonceForTest } from "../src/lib/prefsNonce";
import { usePrefs, DEFAULT_PREFS } from "../src/lib/use-prefs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The read-only prefs commands, mirroring `scripts/check-prefs-nonce.mjs`'s
 *  `READ_COMMANDS`: they invalidate nothing, so they owe no bump. */
const READ_COMMANDS = new Set(["prefs_read", "device_platform", "ai_provider_has_key"]);

const prefsWritesOf = (calls: unknown[][]) =>
  calls
    .map((c) => c[0])
    .filter((c): c is string => typeof c === "string" && c.startsWith("plugin:prefs|"))
    .map((c) => c.slice("plugin:prefs|".length))
    .filter((c) => !READ_COMMANDS.has(c));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  __resetPrefsNonceForTest();
});

afterEach(() => {
  vi.useRealTimers();
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
        // filter below is what decides that — not this catch.
      }
      const writes = prefsWritesOf(invoke.mock.calls);
      if (writes.length === 0) continue;
      covered.push(name);
      expect(getPrefsNonce(), `${name} wrote ${writes.join(", ")} without bumping the nonce`).toBeGreaterThan(
        before,
      );
    }

    // Non-vacuity: an empty roster satisfies the loop above without asserting
    // anything. 47 writes were routed through the chokepoint by #486; the floor
    // is deliberately below that so adding a setter does not fail this line,
    // while deleting the module's exports still does.
    expect(covered.length).toBeGreaterThanOrEqual(40);
    // The two privacy surfaces the issue separates out, named rather than merely
    // counted: a stale read on either is not just a stale value. Screen-capture
    // protection is a `docs/threat-model.md` §6 mitigation, and reminders govern
    // whether pending times keep leaving the AEAD envelope into OS-owned storage.
    expect(covered).toContain("setScreenCaptureProtection");
    expect(covered).toContain("setRemindersEnabled");
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
