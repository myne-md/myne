// Binding tests for the simple `src/lib/prefs.ts` setters (MYND-160 / -137 /
// -110 / -191 / -267 / editor-typography). Mocks the Tauri `invoke` shim AND the
// prefs-nonce store, then pins two load-bearing properties of each binding:
//   1. the exact `plugin:prefs|…` command name + arg-key shape (a drift trap —
//      several setters rename the arg, e.g. setFavorites → `{ order }`,
//      setDailyTemplate → `{ templateId }`);
//   2. that it bumps the prefs nonce on success. Since #251 EVERY setter does:
//      the bump moved into the single `writePref` write path, because as an
//      optional second line it was forgotten in 31 of ~56 setters — favourites
//      silently dropped (and the deletion synced), right-panel tab actions doing
//      nothing, an AI opt-in the open editor never saw. A failed write still
//      bumps nothing; that half is the contract optimistic UIs revert against.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const bumpPrefsNonceMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("../../src/notes/prefsNonce", () => ({
  bumpPrefsNonce: () => bumpPrefsNonceMock(),
}));

import {
  prefsRead,
  setAutoLockTimeout,
  setDailyTemplate,
  setDeliberateFolders,
  setEditorContentWidth,
  setEditorFontFamily,
  setEditorLayout,
  setEditorLineSpacing,
  setEditorTextSize,
  setFavorites,
  setKeymapBinding,
  setScreenCaptureProtection,
  setShowNoteTimestamps,
  setSpellLanguages,
  setTheme,
  toggleFavoriteOnDisk,
  setVaultLabel,
  type EditorLayout,
} from "../../src/lib/prefs";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  bumpPrefsNonceMock.mockReset();
});

afterEach(() => {
  invokeMock.mockReset();
  bumpPrefsNonceMock.mockReset();
});

describe("command name + arg-key shape", () => {
  it("prefsRead calls plugin:prefs|prefs_read and returns the view", async () => {
    const view = { screen_capture_protection: true };
    invokeMock.mockResolvedValueOnce(view);
    await expect(prefsRead()).resolves.toBe(view);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|prefs_read");
  });

  it("setScreenCaptureProtection → { enabled }", async () => {
    await setScreenCaptureProtection(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:prefs|set_screen_capture_protection",
      { enabled: true },
    );
  });

  it("setAutoLockTimeout → { seconds }", async () => {
    await setAutoLockTimeout(120);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_auto_lock_timeout", {
      seconds: 120,
    });
  });

  it("setFavorites renames its arg to { order } (NOT { favorites })", async () => {
    await setFavorites(["n1", "n2"]);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_favorites", {
      order: ["n1", "n2"],
    });
  });

  it("setDailyTemplate renames its arg to { templateId } and passes null through", async () => {
    await setDailyTemplate(null);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_daily_template", {
      templateId: null,
    });
  });

  it("setTheme passes the choice (or null) under { theme }", async () => {
    await setTheme("dark");
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_theme", {
      theme: "dark",
    });
    await setTheme(null);
    expect(invokeMock).toHaveBeenLastCalledWith("plugin:prefs|set_theme", {
      theme: null,
    });
  });

  it("setVaultLabel uses the vault_set_label command name under { label }", async () => {
    await setVaultLabel("Work");
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|vault_set_label", {
      label: "Work",
    });
  });

  it("setEditorLayout passes the full layout under { layout }", async () => {
    const layout: EditorLayout = {
      left_width: 280,
      right_width: 300,
      left_collapsed: false,
      right_collapsed: true,
    };
    await setEditorLayout(layout);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_editor_layout", {
      layout,
    });
  });

  it("setSpellLanguages passes the full set under { languages }", async () => {
    await setSpellLanguages(["en-US", "tr"]);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_spell_languages", {
      languages: ["en-US", "tr"],
    });
  });
});

describe("prefs-nonce bump discipline", () => {
  // #251: these five are the setters that used to skip the bump. `setFavorites`
  // is the worst of them — the sidebar's optimistic star survived, the write
  // landed, and the open editor kept the stale list, which the next write
  // persisted back as a DELETION that then synced to every device.
  it("every setter bumps the nonce — the write path does it, not the caller", async () => {
    await setScreenCaptureProtection(true);
    expect(bumpPrefsNonceMock).toHaveBeenCalledTimes(1);
    await setAutoLockTimeout(60);
    expect(bumpPrefsNonceMock).toHaveBeenCalledTimes(2);
    await setFavorites(["n1"]);
    expect(bumpPrefsNonceMock).toHaveBeenCalledTimes(3);
    await setTheme("light");
    expect(bumpPrefsNonceMock).toHaveBeenCalledTimes(4);
    await setVaultLabel(null);
    expect(bumpPrefsNonceMock).toHaveBeenCalledTimes(5);
  });

  it("setShowNoteTimestamps bumps the nonce after the write", async () => {
    await setShowNoteTimestamps(false);
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:prefs|set_show_note_timestamps",
      { enabled: false },
    );
    expect(bumpPrefsNonceMock).toHaveBeenCalledTimes(1);
  });

  it("setDeliberateFolders bumps the nonce so non-sidebar consumers see new empty folders", async () => {
    // The "Move note to folder…" picker reads deliberate_folders from the prefs
    // blob, not the sidebar's local set — without this bump a freshly-created
    // empty folder is invisible to it until an app reload.
    await setDeliberateFolders(["Arsiv/"]);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_deliberate_folders", {
      folders: ["Arsiv/"],
    });
    expect(bumpPrefsNonceMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["setEditorTextSize", setEditorTextSize, "set_editor_text_size"],
    ["setEditorLineSpacing", setEditorLineSpacing, "set_editor_line_spacing"],
    ["setEditorContentWidth", setEditorContentWidth, "set_editor_content_width"],
    ["setEditorFontFamily", setEditorFontFamily, "set_editor_font_family"],
  ] as const)(
    "%s sends { value } and bumps the nonce",
    async (_name, fn, command) => {
      await fn("md");
      expect(invokeMock).toHaveBeenCalledWith(`plugin:prefs|${command}`, {
        value: "md",
      });
      expect(bumpPrefsNonceMock).toHaveBeenCalledTimes(1);
    },
  );

  it("editor-typography setters pass null through (clear-to-default)", async () => {
    await setEditorTextSize(null);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_editor_text_size", {
      value: null,
    });
  });

  it("setKeymapBinding sends { commandId, chords } and bumps the nonce (3 states)", async () => {
    // Override.
    await setKeymapBinding("graph.show", ["Mod-Shift-g"]);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_keymap_binding", {
      commandId: "graph.show",
      chords: ["Mod-Shift-g"],
    });
    // Explicit-unbind ([]).
    await setKeymapBinding("vault.lock", []);
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_keymap_binding", {
      commandId: "vault.lock",
      chords: [],
    });
    // Remove (revert to default).
    await setKeymapBinding("graph.show", null);
    expect(invokeMock).toHaveBeenLastCalledWith("plugin:prefs|set_keymap_binding", {
      commandId: "graph.show",
      chords: null,
    });
    expect(bumpPrefsNonceMock).toHaveBeenCalledTimes(3);
  });
});

// #252: `favorites` is persisted as a WHOLE sequence, so a caller deriving the
// next value from its own `usePrefs` snapshot writes back whatever that
// snapshot was missing. The command palette did exactly that — star A from the
// sidebar, palette-toggle B, and `[B]` was persisted AND synced (the field is
// SequenceLww, so the truncation won everywhere).
describe("toggleFavoriteOnDisk — reads disk before writing", () => {
  it("adds to the STORED sequence, not to a caller's snapshot", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "plugin:prefs|prefs_read" ? { favorites: ["a"] } : undefined,
    );
    await toggleFavoriteOnDisk("b");
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|prefs_read");
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_favorites", {
      order: ["a", "b"],
    });
  });

  it("removes from the STORED sequence and keeps the rest", async () => {
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "plugin:prefs|prefs_read"
        ? { favorites: ["a", "b", "c"] }
        : undefined,
    );
    await toggleFavoriteOnDisk("b");
    expect(invokeMock).toHaveBeenCalledWith("plugin:prefs|set_favorites", {
      order: ["a", "c"],
    });
  });

  it("writes nothing when the read fails — a stale fallback is the defect", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "SlotNotUnlocked" });
    await expect(toggleFavoriteOnDisk("b")).rejects.toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalledWith(
      "plugin:prefs|set_favorites",
      expect.anything(),
    );
  });
});

describe("rejection propagation (optimistic-UI revert contract)", () => {
  it("a rejected write rejects the binding and skips the nonce bump", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "SlotNotUnlocked" });
    await expect(setShowNoteTimestamps(true)).rejects.toEqual({
      kind: "SlotNotUnlocked",
    });
    // The bump runs only AFTER a resolved invoke — a failed write never refreshes.
    expect(bumpPrefsNonceMock).not.toHaveBeenCalled();
  });
});
