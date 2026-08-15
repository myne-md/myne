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
// The whole module namespace, for the roster block at the bottom: it iterates
// every export rather than a remembered list.
import * as allPrefs from "../../src/lib/prefs";
// @ts-expect-error: a .mjs guard script with no type declarations. Imported
// rather than mirrored so the read/write classification cannot drift between the
// guard and this spec.
import { READ_COMMANDS as READ_COMMANDS_UNTYPED } from "../../scripts/check-prefs-nonce.mjs";

const READ_COMMANDS = READ_COMMANDS_UNTYPED as Set<string>;

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

// ── the roster ──────────────────────────────────────────────────────────────
//
// The named cases above pin ARG-KEY SHAPE, which has to be written out per
// setter because only a human knows that `setFavorites` renames its argument to
// `order`. Property 2 (every write bumps) needs no such knowledge, and pinning it
// through a hand-maintained import list covered 17 of this module's ~71 exports:
// a setter added tomorrow was behaviourally uncovered unless somebody remembered
// to extend the list.
//
// This block closes that by construction. It is the twin of
// `mobile/tests/prefs-nonce.test.ts`'s roster loop and landed in the same change
// (myne-md/myne#486) for a reason worth stating: inventing a stronger shape and
// applying it to ONE half of a twin pair is the exact drift that change is about.
//
// Keyed off what each binding actually sent to `invoke`, never off its name, so
// a rename covers itself.
describe("the roster: every export that writes vault.prefs bumps the nonce", () => {
  /** Sanctioned `writePref(cmd, args, { bump: false })` users. Landed EMPTY:
   *  without it the first legitimate use of the documented hatch fails here with
   *  a message that reads like a defect rather than like "record it". */
  const BUMPLESS = new Set<string>();

  const prefsWritesOf = (calls: unknown[][]) =>
    calls
      .map((c) => c[0])
      .filter((c): c is string => typeof c === "string" && c.startsWith("plugin:prefs|"))
      .map((c) => c.slice("plugin:prefs|".length))
      .filter((c) => !READ_COMMANDS.has(c));

  it("covers every write-emitting export, not a remembered subset", async () => {
    const covered: string[] = [];

    for (const [name, fn] of Object.entries(allPrefs)) {
      if (typeof fn !== "function") continue;
      invokeMock.mockReset();
      // `prefs_read` answers with a usable view, not `undefined`. A READ-then-write
      // binding (`toggleFavoriteOnDisk` reads the fresh favourites before writing
      // them back) otherwise throws on `fresh.favorites` before reaching its
      // write, lands at `writes.length === 0`, and is skipped by the very loop
      // that claims to cover every write-emitting export. It was, until this
      // line: the one setter whose #251 defect this file calls the worst of them
      // was the one silently outside the roster.
      invokeMock.mockImplementation(async (cmd: unknown) =>
        cmd === "plugin:prefs|prefs_read" ? { favorites: [] } : undefined,
      );
      bumpPrefsNonceMock.mockReset();
      // Two positional arguments cover every setter's arity, and a binding that
      // reaches no prefs WRITE command (a pure normalizer, a read) is skipped by
      // the filter below.
      try {
        await (fn as (...a: unknown[]) => unknown)("probe", "probe");
      } catch {
        // A throw is not a verdict. Whether the binding wrote is decided by what
        // reached `invoke`, which the filter below reads, so a binding that threw
        // AFTER its write is still covered. What a throw can do is hide a write
        // that never happened, which is why the floor is pinned at the real count
        // rather than under it.
      }
      const writes = prefsWritesOf(invokeMock.mock.calls);
      if (writes.length === 0) continue;
      if (BUMPLESS.has(name)) continue;
      covered.push(name);
      expect(
        bumpPrefsNonceMock,
        `${name} wrote ${writes.join(", ")} without bumping the nonce`,
      ).toHaveBeenCalled();
    }

    // Non-vacuity, pinned at the REAL count rather than under it. A floor fires
    // when the number drops, and an addition raises it, so slack below reality
    // buys nothing and costs coverage: a setter that starts early-returning
    // before its `invoke` leaves the loop through `writes.length === 0` and
    // silently stops being tested. This number is measured, and it is also the
    // guard against the read-then-write exclusion the mock above fixed.
    expect(covered.length).toBeGreaterThanOrEqual(68);
    expect(covered).toContain("toggleFavoriteOnDisk");
    // Two names pinned rather than left to the count, because these two toggles
    // are the ones a user reads as a privacy promise, so a surface showing the
    // old value is worse here than a stale font size. What §6 of
    // `docs/threat-model.md` actually covers on this client is narrower than
    // "screen-capture exclusion": Windows 10 build 19041+ is the one platform
    // where the layer earns its place, macOS makes the call and claims nothing
    // (Apple documents `NSWindowSharingNone` as a legacy constant macOS no
    // longer uses), and Linux applies no protection on any display server. That
    // per-platform split is not pedantry: one unqualified sentence is what made
    // this item overclaim for a year, and §6 says in its own text that no
    // compiler warning, lint or repo guard signals the drift, so a comment is
    // exactly the surface where it creeps back. The mobile twin of this
    // assertion carries no §6 citation at all, because §6 describes no mobile
    // platform. What this assertion pins is true on every platform and needs no
    // §6 claim: the displayed state of these toggles must match disk.
    expect(covered).toContain("setScreenCaptureProtection");
    expect(covered).toContain("setRemindersEnabled");
  });
});
