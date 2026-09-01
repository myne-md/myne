// @vitest-environment jsdom
//
// The mobile date/time display publisher (myne-md/myne#609).
//
// `scripts/check-datetime-display-publisher.mjs` is the static half: it proves a
// client tree that READS the shared display store also contains a
// `setDateTimeDisplay(` call. It cannot prove the call ever RUNS, and that gap
// is not hypothetical. The first version of this hook was keyed on the prefs
// nonce alone, which nothing bumps on unlock, while the hook mounts above the
// stage machine: the first `prefsRead()` hit a locked slot, the rejection was
// swallowed, and the store held its defaults for the whole session with the
// guard green over it. That is the inert-on-mobile defect this feature was filed
// to fix, reproduced inside the fix.
//
// So this file asserts the three things the guard structurally cannot:
//
//  1. a successful read reaches the store,
//  2. a nonce advance (which the editor stage raises on unlock and on a vault
//     switch) causes a re-read, and
//  3. a FAILED read publishes defaults rather than leaving the previous vault's
//     format and zone resident in a module-scope store.
//
// `tests/` sits outside `tsc`'s `include`, so the loose shapes here are untyped
// by design, exactly as `prefs-nonce.test.ts` records for the same reason.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

// Same reason `prefs-nonce.test.ts` mocks it: without a Tauri host the prefs
// layer short-circuits and the test would pass without reaching the read path
// it exists to exercise.
vi.mock("../src/lib/app-window", () => ({ HAS_TAURI: true, closeApp: async () => {} }));

import { useDateTimeDisplaySync } from "../src/lib/useDateTimeDisplaySync";
import { bumpPrefsNonce, __resetPrefsNonceForTest } from "../src/lib/prefsNonce";
import {
  dateTimeDisplay,
  __resetDateTimeDisplayForTest,
} from "@myne/editor/host/lib/datetimeFormat";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  useDateTimeDisplaySync();
  return null;
}

/** Mount the hook and let its effect's promise settle. */
async function mount(): Promise<{ unmount: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Harness));
  });
  return {
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  invoke.mockReset();
  __resetPrefsNonceForTest();
  __resetDateTimeDisplayForTest();
});

afterEach(() => {
  __resetDateTimeDisplayForTest();
});

describe("the mobile display publisher", () => {
  it("publishes what it read into the shared store", async () => {
    invoke.mockResolvedValue({ date_format: "dmy", time_format: "12h", timezone: null });
    const m = await mount();
    expect(dateTimeDisplay().dateFormat).toBe("dmy");
    expect(dateTimeDisplay().timeFormat).toBe("12h");
    m.unmount();
  });

  it("re-reads when the prefs nonce advances, which is what an unlock raises", async () => {
    // The defect this pins directly. The editor stage bumps the nonce when a
    // vault becomes open, so a hook mounted above that stage learns prefs became
    // readable. Without the re-read, a boot into a locked vault leaves the store
    // at its defaults for the session.
    // The shape `PrefsReadError` actually serializes: a tagged OBJECT, not an
    // `Error` whose message happens to contain the variant name. Written the
    // second way first, which made the hook's discriminator pass a test it
    // could never pass in production.
    invoke.mockRejectedValueOnce({ kind: "SlotNotUnlocked" });
    const m = await mount();
    expect(dateTimeDisplay().dateFormat).toBe("system");

    invoke.mockResolvedValue({ date_format: "mdy", time_format: "24h", timezone: null });
    await act(async () => {
      bumpPrefsNonce();
    });
    expect(dateTimeDisplay().dateFormat).toBe("mdy");
    m.unmount();
  });

  it("stays quiet on a locked slot and SHOUTS on anything else", async () => {
    // The distinction the string match could not make. A locked slot is the
    // ordinary boot case; `Io`, `InvalidVaultMeta` and a missing ACL row all
    // produce the same silent wrong-format outcome this issue was filed about,
    // so they may not be swallowed with it.
    const errors: unknown[][] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => void errors.push(args));

    invoke.mockRejectedValue({ kind: "SlotNotUnlocked" });
    const locked = await mount();
    expect(errors).toHaveLength(0);
    locked.unmount();

    invoke.mockRejectedValue({ kind: "InvalidVaultMeta" });
    await act(async () => {
      bumpPrefsNonce();
    });
    const broken = await mount();
    expect(errors).toHaveLength(1);
    broken.unmount();

    spy.mockRestore();
  });

  it("publishes DEFAULTS on a failed read, not the previous vault's values", async () => {
    // The store is module-scope and outlives every unmount, so "keep what is
    // there" means keeping the previous vault's format and zone across a lock or
    // a vault switch. The zone in particular is a coarse-location datum kept per
    // vault everywhere else.
    invoke.mockResolvedValue({ date_format: "dmy", time_format: "12h", timezone: "Europe/Berlin" });
    const first = await mount();
    expect(dateTimeDisplay().dateFormat).toBe("dmy");
    expect(dateTimeDisplay().timeZone).toBe("Europe/Berlin");
    first.unmount();

    invoke.mockRejectedValue({ kind: "SlotNotUnlocked" });
    await act(async () => {
      bumpPrefsNonce();
    });
    const second = await mount();
    expect(dateTimeDisplay().dateFormat).toBe("system");
    expect(dateTimeDisplay().timeZone).toBeNull();
    second.unmount();
  });
});
