// Keybind dispatcher core tests (MYND-304; SYNC-2 + SYNC-8). Pins phase routing
// (capture vs bubble), scope gating, most-specific-wins precedence, the
// user-override path, and run-on-dispatch.

import { describe, it, expect, vi } from "vitest";
import {
  resolveKeybind,
  dispatchKeybind,
  type KeybindEntry,
} from "../../src/commands/keybindEngine";
import type { WhenContext } from "../../src/commands/scope";

const editorCtx: WhenContext = {
  stageName: "editor",
  focusKind: "cm-editor",
  hasSelectedNote: true,
  activeModal: null,
};

function entry(over: Partial<KeybindEntry> & Pick<KeybindEntry, "id">): KeybindEntry {
  return { scope: {}, run: () => {}, ...over };
}

describe("resolveKeybind — phase routing", () => {
  const navBack = entry({ id: "nav.back", phase: "capture" });
  const palette = entry({ id: "app.command-palette" }); // bubble (default)
  const entries = [navBack, palette];
  const keymap = { "nav.back": ["Mod-["], "app.command-palette": ["Mod-k"] };

  it("a capture-phase binding fires only in the capture phase", () => {
    const ev = { key: "[", metaKey: true };
    expect(resolveKeybind(ev, "capture", editorCtx, entries, keymap, true)).toBe(navBack);
    expect(resolveKeybind(ev, "bubble", editorCtx, entries, keymap, true)).toBeNull();
  });

  it("a bubble-phase binding fires only in the bubble phase", () => {
    const ev = { key: "k", metaKey: true };
    expect(resolveKeybind(ev, "bubble", editorCtx, entries, keymap, true)).toBe(palette);
    expect(resolveKeybind(ev, "capture", editorCtx, entries, keymap, true)).toBeNull();
  });
});

describe("resolveKeybind — scope + override", () => {
  it("does not resolve a per-note binding with no note selected", () => {
    const perNote = entry({ id: "note.snapshots", scope: { requiresNote: true } });
    const km = { "note.snapshots": ["Mod-y"] };
    const ev = { key: "y", metaKey: true };
    const noNote = { ...editorCtx, hasSelectedNote: false };
    expect(resolveKeybind(ev, "bubble", noNote, [perNote], km, true)).toBeNull();
    expect(resolveKeybind(ev, "bubble", editorCtx, [perNote], km, true)).toBe(perNote);
  });

  it("resolves against the user override chord, not a stale default", () => {
    const e = entry({ id: "graph.show" });
    // User rebound graph.show to Mod-g (override); the old Mod-Shift-g no longer fires.
    const km = { "graph.show": ["Mod-g"] };
    expect(resolveKeybind({ key: "g", metaKey: true }, "bubble", editorCtx, [e], km, true)).toBe(e);
    expect(
      resolveKeybind({ key: "G", metaKey: true, shiftKey: true }, "bubble", editorCtx, [e], km, true),
    ).toBeNull();
  });

  it("most-specific active scope wins on a shared chord", () => {
    const global = entry({ id: "g", scope: {} });
    const scoped = entry({ id: "s", scope: { requiresNote: true } });
    const km = { g: ["Mod-j"], s: ["Mod-j"] };
    const winner = resolveKeybind({ key: "j", metaKey: true }, "bubble", editorCtx, [global, scoped], km, true);
    expect(winner?.id).toBe("s");
  });
});

describe("dispatchKeybind", () => {
  it("runs the resolved entry and reports handled", () => {
    const run = vi.fn();
    const e = entry({ id: "app.command-palette", run });
    const handled = dispatchKeybind(
      { key: "k", metaKey: true },
      "bubble",
      editorCtx,
      [e],
      { "app.command-palette": ["Mod-k"] },
      true,
    );
    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports not-handled and runs nothing when no binding matches", () => {
    const run = vi.fn();
    const e = entry({ id: "x", run });
    const handled = dispatchKeybind(
      { key: "q", metaKey: true },
      "bubble",
      editorCtx,
      [e],
      { x: ["Mod-k"] },
      true,
    );
    expect(handled).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});
