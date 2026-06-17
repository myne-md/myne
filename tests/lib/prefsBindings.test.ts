// Binding tests for the simple `src/lib/prefs.ts` setters (MYND-160 / -137 /
// -110 / -191 / -267 / editor-typography). Mocks the Tauri `invoke` shim AND the
// prefs-nonce store, then pins two load-bearing properties of each binding:
//   1. the exact `plugin:prefs|…` command name + arg-key shape (a drift trap —
//      several setters rename the arg, e.g. setFavorites → `{ order }`,
//      setDailyTemplate → `{ templateId }`);
//   2. whether it bumps the prefs nonce on success. The live-refresh setters
//      (timestamps + editor-typography) MUST bump; the plain setters MUST NOT —
//      a regression either way silently breaks (or over-fires) cross-surface
//      refresh.

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
  it("plain setters do NOT bump the nonce", async () => {
    await setScreenCaptureProtection(true);
    await setAutoLockTimeout(60);
    await setFavorites(["n1"]);
    await setTheme("light");
    await setVaultLabel(null);
    expect(bumpPrefsNonceMock).not.toHaveBeenCalled();
  });

  it("setShowNoteTimestamps bumps the nonce after the write", async () => {
    await setShowNoteTimestamps(false);
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin:prefs|set_show_note_timestamps",
      { enabled: false },
    );
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
