// @vitest-environment jsdom
//
// `usePrefs` (MYND-160): lazy disk read on mount, optimistic writes with
// re-read-disk-truth-on-error convergence, and the cross-surface
// prefs-nonce reload subscription. The prefs IPC boundary (`../lib/prefs`)
// is mocked at the module seam; the nonce store is the real one.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// --- Mock the prefs IPC seam. Each setter is an independent spy so we can
//     reject one path at a time; prefsRead returns whatever we queue. ---
const prefsRead = vi.fn();
const setScreenCaptureProtection = vi.fn();
const setAutoLockTimeout = vi.fn();
const setHiddenBarItems = vi.fn();
const setEditorTextSize = vi.fn();
const setEditorLineSpacing = vi.fn();
const setEditorContentWidth = vi.fn();
const setEditorFontFamily = vi.fn();
const setKeymapBinding = vi.fn();
const setReminderHorizonDays = vi.fn();
const mutateAiExcludedFolders = vi.fn();
const mutateCliExcludedFolders = vi.fn();

vi.mock("../../src/lib/prefs", async (importOriginal) => ({
  prefsRead: (...a: unknown[]) => prefsRead(...a),
  setScreenCaptureProtection: (...a: unknown[]) => setScreenCaptureProtection(...a),
  setAutoLockTimeout: (...a: unknown[]) => setAutoLockTimeout(...a),
  setHiddenBarItems: (...a: unknown[]) => setHiddenBarItems(...a),
  setEditorTextSize: (...a: unknown[]) => setEditorTextSize(...a),
  setEditorLineSpacing: (...a: unknown[]) => setEditorLineSpacing(...a),
  setEditorContentWidth: (...a: unknown[]) => setEditorContentWidth(...a),
  setEditorFontFamily: (...a: unknown[]) => setEditorFontFamily(...a),
  setKeymapBinding: (...a: unknown[]) => setKeymapBinding(...a),
  setReminderHorizonDays: (...a: unknown[]) => setReminderHorizonDays(...a),
  mutateAiExcludedFolders: (...a: unknown[]) => mutateAiExcludedFolders(...a),
  mutateCliExcludedFolders: (...a: unknown[]) => mutateCliExcludedFolders(...a),
  // The REAL derivation, not a copy of it. It is what decides whether a
  // stale view can claim a deletion (myne-md/myne#613), so a stub here would
  // test the stub, and a hand-copy would be one more place for the real one
  // to drift away from.
  mutationFrom: (await importOriginal<typeof import("../../src/lib/prefs")>()).mutationFrom,
}));

import { usePrefs } from "../../src/hooks/usePrefs";
import {
  __resetPrefsNonceForTest,
  bumpPrefsNonce,
} from "../../src/notes/prefsNonce";

// A minimal valid PrefsView with the two fields the tests assert on; the
// hook spreads it, so partial-but-typed-enough is fine for behavior checks.
function view(over: Record<string, unknown> = {}) {
  return {
    screen_capture_protection: true,
    show_note_timestamps: true,
    reminders_enabled: true,
    reminder_horizon_days: null,
    show_task_marker: true,
    deliberate_folders: [],
    auto_lock_seconds: null,
    daily_date_format: null,
    daily_folder: null,
    daily_template: null,
    favorites: [],
    item_order: {},
    editor_layout: null,
    editor_content_width: null,
    editor_font_family: null,
    editor_line_spacing: null,
    editor_text_size: null,
    theme: null,
    folder_icons: {},
    hidden_bar_items: [],
    item_colors: {},
    keymap: {},
    label: null,
    last_backup_at: null,
    spell_enabled: null,
    spell_languages: [],
    saved_views: [],
    view_order: [],
    ...over,
  };
}

beforeEach(() => {
  prefsRead.mockReset().mockResolvedValue(view());
  // Default: the write lands and the budget refuses nothing.
  mutateAiExcludedFolders.mockReset().mockResolvedValue(0);
  mutateCliExcludedFolders.mockReset().mockResolvedValue(0);
  for (const s of [
    setScreenCaptureProtection,
    setAutoLockTimeout,
    setHiddenBarItems,
    setEditorTextSize,
    setEditorLineSpacing,
    setEditorContentWidth,
    setEditorFontFamily,
    setKeymapBinding,
  ]) {
    s.mockReset().mockResolvedValue(undefined);
  }
});

afterEach(() => __resetPrefsNonceForTest());

describe("usePrefs mount + disk read", () => {
  it("starts at DEFAULT_PREFS, then loads disk truth on mount", async () => {
    prefsRead.mockResolvedValue(view({ auto_lock_seconds: 300 }));
    const { result } = renderHook(() => usePrefs());
    // Synchronous initial render uses defaults.
    expect(result.current.prefs.auto_lock_seconds).toBeNull();
    await waitFor(() =>
      expect(result.current.prefs.auto_lock_seconds).toBe(300),
    );
    expect(prefsRead).toHaveBeenCalled();
  });

  it("keeps DEFAULT_PREFS when the initial read rejects (safer-state)", async () => {
    prefsRead.mockRejectedValue(new Error("SlotNotUnlocked"));
    const { result } = renderHook(() => usePrefs());
    // Let the rejected effect settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.prefs.screen_capture_protection).toBe(true);
    expect(result.current.prefs.deliberate_folders).toEqual([]);
  });
});

describe("optimistic write success", () => {
  it("toggleScreenCapture flips the cache immediately and persists", async () => {
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    await act(async () => {
      await result.current.toggleScreenCapture(false);
    });
    expect(setScreenCaptureProtection).toHaveBeenCalledWith(false);
    expect(result.current.prefs.screen_capture_protection).toBe(false);
  });

  it("setAutoLock persists the chosen seconds and updates cache", async () => {
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    await act(async () => {
      await result.current.setAutoLock(600);
    });
    expect(setAutoLockTimeout).toHaveBeenCalledWith(600);
    expect(result.current.prefs.auto_lock_seconds).toBe(600);
  });

  it("setReminderHorizon persists the chosen days and updates cache", async () => {
    // myne#508: the horizon's setter had no caller anywhere, on either client.
    // It lives here rather than in the settings row so the row holds no state
    // and the panel holds no echo for it, the shape the ~40 setters beside it
    // already have.
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    await act(async () => {
      await result.current.setReminderHorizon(14);
    });
    expect(setReminderHorizonDays).toHaveBeenCalledWith(14);
    expect(result.current.prefs.reminder_horizon_days).toBe(14);
  });

  it("setReminderHorizon converges on disk truth when the write is rejected", async () => {
    // A control still showing the new window after a failed write tells the
    // user a bound is in force that is not. Re-reading rather than rolling back
    // to a captured value is this hook's discipline throughout: the disk is
    // authoritative, and a rollback can invert UI against it.
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    setReminderHorizonDays.mockRejectedValueOnce(new Error("Io"));
    prefsRead.mockResolvedValueOnce(view({ reminder_horizon_days: 30 }));
    await act(async () => {
      await result.current.setReminderHorizon(1);
    });
    expect(result.current.prefs.reminder_horizon_days).toBe(30);
  });

  it("setHiddenBarItems persists the full set optimistically", async () => {
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    await act(async () => {
      await result.current.setHiddenBarItems(["graph", "calendar"]);
    });
    expect(setHiddenBarItems).toHaveBeenCalledWith(["graph", "calendar"]);
    expect(result.current.prefs.hidden_bar_items).toEqual(["graph", "calendar"]);
  });

  it("a typography setter patches just its field and persists", async () => {
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    await act(async () => {
      await result.current.setEditorTextSize("lg");
    });
    expect(setEditorTextSize).toHaveBeenCalledWith("lg");
    expect(result.current.prefs.editor_text_size).toBe("lg");
    // null clears back to default.
    await act(async () => {
      await result.current.setEditorFontFamily(null);
    });
    expect(setEditorFontFamily).toHaveBeenCalledWith(null);
    expect(result.current.prefs.editor_font_family).toBeNull();
  });

  it("setKeymapBinding patches one command's entry optimistically (3-state)", async () => {
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    // Override: assigns the entry.
    await act(async () => {
      await result.current.setKeymapBinding("graph.show", ["Mod-Shift-g"]);
    });
    expect(setKeymapBinding).toHaveBeenCalledWith("graph.show", ["Mod-Shift-g"]);
    expect(result.current.prefs.keymap["graph.show"]).toEqual(["Mod-Shift-g"]);

    // Explicit-unbind: an empty array entry (distinct from absent).
    await act(async () => {
      await result.current.setKeymapBinding("vault.lock", []);
    });
    expect(result.current.prefs.keymap["vault.lock"]).toEqual([]);
    // The earlier override is untouched (per-command patch, not a full replace).
    expect(result.current.prefs.keymap["graph.show"]).toEqual(["Mod-Shift-g"]);

    // Remove: null drops just that entry.
    await act(async () => {
      await result.current.setKeymapBinding("graph.show", null);
    });
    expect(setKeymapBinding).toHaveBeenLastCalledWith("graph.show", null);
    expect("graph.show" in result.current.prefs.keymap).toBe(false);
    expect(result.current.prefs.keymap["vault.lock"]).toEqual([]);
  });
});

describe("optimistic write failure → re-read disk truth + onError", () => {
  it("re-reads disk on persist failure, converging the cache to disk", async () => {
    const onError = vi.fn();
    // Initial mount read returns capture=true.
    prefsRead.mockResolvedValueOnce(view({ screen_capture_protection: true }));
    const { result } = renderHook(() => usePrefs(onError));
    await waitFor(() =>
      expect(result.current.prefs.screen_capture_protection).toBe(true),
    );

    // The optimistic flip sets false; persist rejects; the post-error re-read
    // returns disk truth = true. UI must converge back to true (not the
    // optimistic false), proving the re-read-on-error path, not a rollback.
    setScreenCaptureProtection.mockRejectedValueOnce(new Error("Io"));
    prefsRead.mockResolvedValueOnce(view({ screen_capture_protection: true }));

    await act(async () => {
      await result.current.toggleScreenCapture(false);
    });

    expect(result.current.prefs.screen_capture_protection).toBe(true);
    expect(onError).toHaveBeenCalledWith("Couldn't save preference. Try again.");
  });

  it("keeps the optimistic value when BOTH persist and the re-read fail", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => usePrefs(onError));
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    setAutoLockTimeout.mockRejectedValueOnce(new Error("Io"));
    prefsRead.mockRejectedValueOnce(new Error("SlotNotUnlocked"));

    await act(async () => {
      await result.current.setAutoLock(120);
    });
    // Re-read failed too → optimistic value is retained so the user can retry.
    expect(result.current.prefs.auto_lock_seconds).toBe(120);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("setKeymapBinding re-reads disk truth on persist failure", async () => {
    const onError = vi.fn();
    // Disk truth has no overrides.
    prefsRead.mockResolvedValueOnce(view({ keymap: {} }));
    const { result } = renderHook(() => usePrefs(onError));
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    // Optimistic assign; persist rejects; post-error re-read returns disk truth
    // (empty keymap). UI converges back to {} (not the optimistic override).
    setKeymapBinding.mockRejectedValueOnce(new Error("Io"));
    prefsRead.mockResolvedValueOnce(view({ keymap: {} }));

    await act(async () => {
      await result.current.setKeymapBinding("graph.show", ["Mod-Shift-g"]);
    });

    expect("graph.show" in result.current.prefs.keymap).toBe(false);
    expect(onError).toHaveBeenCalledWith("Couldn't save preference. Try again.");
  });

  it("does NOT call onError on the happy path", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => usePrefs(onError));
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    await act(async () => {
      await result.current.setEditorLineSpacing("relaxed");
    });
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("reload + cross-surface nonce subscription", () => {
  it("reload() re-reads disk into the cache", async () => {
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    prefsRead.mockResolvedValueOnce(view({ auto_lock_seconds: 900 }));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.prefs.auto_lock_seconds).toBe(900);
  });

  it("reload() keeps the current cache when the read fails (safer-state)", async () => {
    prefsRead.mockResolvedValueOnce(view({ auto_lock_seconds: 42 }));
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(result.current.prefs.auto_lock_seconds).toBe(42));

    prefsRead.mockRejectedValueOnce(new Error("Io"));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.prefs.auto_lock_seconds).toBe(42);
  });

  it("a prefs-nonce bump from a sibling surface triggers a disk re-read", async () => {
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());

    // A sibling-surface saved-view mutation bumps the nonce; the hook's
    // subscription must re-read disk and reflect the new value.
    prefsRead.mockResolvedValue(view({ label: "renamed-via-sibling" }));
    await act(async () => {
      bumpPrefsNonce();
      // store coalesces onto a microtask; flush it, then the async reload.
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(result.current.prefs.label).toBe("renamed-via-sibling"),
    );
  });
});

// ---------------------------------------------------------------------------
// myne-md/myne#613: the two EGRESS controls must not read as fail-open.
//
// `ai_excluded_folders` and `cli_excluded_folders` are named in
// `docs/threat-model.md` A17 and promised absolutely by the shipped interface.
// The setters patch the cache optimistically, so a budget refusal would leave
// the user looking at a folder marked excluded from the AI or the CLI that is
// not excluded on disk. Written after the guard was verified by BREAKING it:
// swallowing the refusal count passed the whole suite, which is how it was found
// to be untested.
// ---------------------------------------------------------------------------

describe.each([
  ["ai", "ai_excluded_folders", () => mutateAiExcludedFolders] as const,
  ["cli", "cli_excluded_folders", () => mutateCliExcludedFolders] as const,
])("usePrefs: %s excluded folders", (which, field, binding) => {
  const call = (
    p: ReturnType<typeof usePrefs>,
    mutation: { add: string[]; remove: string[] },
    next: string[],
  ) =>
    which === "ai"
      ? p.setAiExcludedFolders(mutation, next)
      : p.setCliExcludedFolders(mutation, next);

  /** The field under test, read off the typed view rather than through a cast:
   *  `PrefsView` does not overlap `Record<string, unknown>`, so indexing it that
   *  way needs a double assertion, which is three recorded type errors bought to
   *  save one line. */
  const held = (p: ReturnType<typeof usePrefs>): readonly string[] =>
    which === "ai" ? p.prefs.ai_excluded_folders : p.prefs.cli_excluded_folders;

  it("keeps the optimistic value when nothing was refused", async () => {
    const { result } = renderHook(() => usePrefs());
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    await act(async () => {
      await call(result.current, { add: ["Private/"], remove: [] }, ["Private/"]);
    });
    expect(held(result.current)).toEqual(["Private/"]);
    expect(binding()).toHaveBeenCalledWith({ add: ["Private/"], remove: [] });
  });

  it("converges to disk truth and reports when the budget refused an addition", async () => {
    const onError = vi.fn();
    binding().mockResolvedValueOnce(1);
    const { result } = renderHook(() => usePrefs(onError));
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    // Disk says the exclusion did NOT land.
    prefsRead.mockResolvedValue(view({ [field]: [] }));
    await act(async () => {
      await call(result.current, { add: ["Private/"], remove: [] }, ["Private/"]);
    });
    // The cache must not go on claiming an exclusion that is not on disk. This
    // is the assertion the injected defect (swallowing the count) fails.
    expect(held(result.current)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("converges and reports when the write threw", async () => {
    const onError = vi.fn();
    binding().mockRejectedValueOnce(new Error("disk"));
    const { result } = renderHook(() => usePrefs(onError));
    await waitFor(() => expect(prefsRead).toHaveBeenCalled());
    prefsRead.mockResolvedValue(view({ [field]: [] }));
    await act(async () => {
      await call(result.current, { add: ["Private/"], remove: [] }, ["Private/"]);
    });
    expect(held(result.current)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
