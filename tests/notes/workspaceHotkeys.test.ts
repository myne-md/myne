// Keymap-collision guard for the MYND-166 tab/pane shortcuts (Task 7).
//
// The window-level WorkspaceHotkeys (Editor.tsx) must not shadow any
// CM6 editor binding. This asserts the workspace shortcut keys are
// disjoint from `myneKeyBindings` and from the reserved palette /
// settings chords. It's a static contract test — the live key handling
// itself is exercised by the `pnpm tauri dev` smoke-test.

import { describe, expect, it } from "vitest";
import { defaultKeymap } from "@codemirror/commands";
import { myneKeyBindings } from "../../src/editor/keymap";

// The chords WorkspaceHotkeys claims (CodeMirror `Mod-` notation).
const WORKSPACE_CHORDS = [
  "Mod-t", // new note
  "Mod-w", // close tab
  "Mod-\\", // split right
  "Mod-Shift-\\", // split down
  "Ctrl-Tab", // next tab
  "Ctrl-Shift-Tab", // prev tab
  "Mod-Alt-ArrowLeft",
  "Mod-Alt-ArrowRight",
  "Mod-Alt-ArrowUp",
  "Mod-Alt-ArrowDown",
];

// Reserved elsewhere (must also stay clear of).
const RESERVED = ["Mod-k", "Mod-p", "Mod-n", "Mod-,"];

describe("MYND-166 tab/pane keymap", () => {
  it("does not collide with any editor (myneKeyBindings) chord", () => {
    const editorKeys = new Set(myneKeyBindings.map((b) => b.key));
    for (const chord of WORKSPACE_CHORDS) {
      expect(editorKeys.has(chord), `collides with editor: ${chord}`).toBe(
        false,
      );
    }
  });

  it("does not reuse a reserved palette/settings/new-note chord", () => {
    const reserved = new Set(RESERVED);
    for (const chord of WORKSPACE_CHORDS) {
      expect(reserved.has(chord), `collides with reserved: ${chord}`).toBe(
        false,
      );
    }
  });

  it("does not touch the section-scoped Cmd+A or wrap chords", () => {
    // Sanity: the editor still owns these; workspace shortcuts avoid them.
    const editorKeys = new Set(myneKeyBindings.map((b) => b.key));
    for (const owned of ["Mod-a", "Mod-b", "Mod-i", "Mod-e"]) {
      expect(editorKeys.has(owned)).toBe(true);
      expect(WORKSPACE_CHORDS.includes(owned)).toBe(false);
    }
  });
});

describe("MYND-260 back/forward bracket chords", () => {
  // Cmd/Ctrl+[ and ] are the ONE deliberate exception to the no-shadowing
  // rule: CM's defaultKeymap binds them to indentLess/indentMore, so Editor's
  // WorkspaceHotkeys intercepts them in the CAPTURE phase and stopPropagation()s
  // to override the indent and navigate note history instead. They are NOT in
  // WORKSPACE_CHORDS because that set models the bubble-phase switch.
  it("are bound by CM defaultKeymap — the reason the capture override exists", () => {
    const keys = new Set(defaultKeymap.map((b) => b.key));
    expect(keys.has("Mod-[")).toBe(true);
    expect(keys.has("Mod-]")).toBe(true);
  });

  it("are kept out of the bubble-phase workspace chord set", () => {
    expect(WORKSPACE_CHORDS.includes("Mod-[")).toBe(false);
    expect(WORKSPACE_CHORDS.includes("Mod-]")).toBe(false);
  });
});
