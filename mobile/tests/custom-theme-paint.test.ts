// @vitest-environment jsdom
//
// The unlock-path orchestrator (MYND-598) — `paintSelectedCustomTheme`, the one
// part of the applier module that invokes, and therefore the one part that can
// fail in a way the caller has to survive.
//
// It is split out of `custom-theme-apply.test.ts` because it needs the host
// stubbed (`HAS_TAURI`, the two IPC wrappers), which that file deliberately does
// not do — the CSSOM half is testable with nothing but a document.
//
// What is pinned here is the contract in its docstring, both halves:
//
//   - **Never rejects.** A failed read falls back to the built-in appearance in
//     silence. A cosmetic palette is not load-bearing, and the host already
//     collapses every recoverable `vault.themes` failure to an empty store
//     (`protocol.md` §9.21.4).
//   - **Never hangs.** `AppShell` AWAITS this before it lands the editor stage,
//     so an `invoke` that never settles would leave the user on the unlock
//     screen after a successful unlock — no error, no way forward. `invoke` has
//     no timeout of its own, so the deadline lives here.
//
// The second one is why this file exists: the rejection half was already true
// and the hang half was not, and only one of them is visible from a test that
// resolves its mocks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ prefsRead: vi.fn(), listCustomThemes: vi.fn() }));

vi.mock("../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("../src/lib/prefs", () => ({ prefsRead: host.prefsRead }));
vi.mock("../src/lib/themes", () => ({ listCustomThemes: host.listCustomThemes }));

import { clearCustomTheme, hasCustomTheme, paintSelectedCustomTheme } from "../src/lib/customTheme";

/** Longer than the module's own deadline, so advancing by it always crosses it. */
const PAST_DEADLINE_MS = 5_000;

const ZINC = { name: "Zinc", palette: { "--paper": "#101014", "--accent": "#7aa2f7" } };
const paper = () => document.documentElement.style.getPropertyValue("--paper");

beforeEach(() => {
  vi.useFakeTimers();
  host.prefsRead.mockReset();
  host.listCustomThemes.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  clearCustomTheme();
  document.documentElement.removeAttribute("style");
});

describe("paintSelectedCustomTheme", () => {
  it("paints the selected palette when both reads answer", async () => {
    host.prefsRead.mockResolvedValue({ custom_theme: "Zinc" });
    host.listCustomThemes.mockResolvedValue([ZINC]);

    await paintSelectedCustomTheme();

    expect(paper()).toBe("#101014");
    expect(hasCustomTheme()).toBe(true);
  });

  it("does not decrypt the theme store when no theme is selected", async () => {
    host.prefsRead.mockResolvedValue({ custom_theme: null });
    host.listCustomThemes.mockResolvedValue([ZINC]);

    await paintSelectedCustomTheme();

    // The reads are sequential precisely so this one never happens: listing
    // decrypts every palette in `vault.themes`, and this is now on every route
    // into the editor rather than the unlock one alone.
    expect(host.listCustomThemes).not.toHaveBeenCalled();
    expect(hasCustomTheme()).toBe(false);
  });

  it("resolves without painting when a read rejects", async () => {
    host.prefsRead.mockRejectedValue(new Error("host is gone"));
    host.listCustomThemes.mockResolvedValue([ZINC]);

    await expect(paintSelectedCustomTheme()).resolves.toBeUndefined();
    expect(hasCustomTheme()).toBe(false);
  });

  it("gives up on a read that never settles, instead of hanging the caller", async () => {
    // The hung host: an `invoke` whose promise neither resolves nor rejects.
    host.prefsRead.mockReturnValue(new Promise(() => {}));
    host.listCustomThemes.mockResolvedValue([ZINC]);

    let settled = false;
    const painting = paintSelectedCustomTheme().then(() => {
      settled = true;
    });

    // Nothing yet — the deadline has not been reached, so this is still the
    // ordinary "wait for the vault reads" state, not the bug.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(PAST_DEADLINE_MS);
    await painting;
    expect(settled).toBe(true);
    expect(hasCustomTheme()).toBe(false);
  });

  it("does not fire the deadline after a read that answered in time", async () => {
    host.prefsRead.mockResolvedValue({ custom_theme: "Zinc" });
    host.listCustomThemes.mockResolvedValue([ZINC]);

    await paintSelectedCustomTheme();
    // The timer is cleared on the way out; a leftover one would sit in the
    // queue holding a reference to a resolve nobody is listening to.
    expect(vi.getTimerCount()).toBe(0);
    expect(paper()).toBe("#101014");
  });
});
