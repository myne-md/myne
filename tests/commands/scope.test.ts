// @vitest-environment jsdom
//
// Scope / "when" context model tests (MYND-304; SYNC-2). Pins focus
// classification, context derivation from existing signals, the
// stand-down-in-plain-input + per-note + stage gates, and precedence ordering.

import { describe, it, expect } from "vitest";
import {
  focusKindOf,
  deriveWhenContext,
  isBindingActive,
  scopeSpecificity,
  type WhenContext,
} from "../../src/commands/scope";

describe("focusKindOf", () => {
  it("classifies the CM6 editor surface as cm-editor (shortcuts stay live)", () => {
    const el = document.createElement("div");
    el.classList.add("cm-content");
    expect(focusKindOf(el)).toBe("cm-editor");
  });

  it("classifies a bare input/textarea as plain-input", () => {
    expect(focusKindOf(document.createElement("input"))).toBe("plain-input");
    expect(focusKindOf(document.createElement("textarea"))).toBe("plain-input");
  });

  it("classifies anything else (incl. null) as other", () => {
    expect(focusKindOf(document.createElement("div"))).toBe("other");
    expect(focusKindOf(null)).toBe("other");
  });
});

describe("deriveWhenContext", () => {
  it("builds the context from stageName + selectedNoteId + focus + modal", () => {
    const input = document.createElement("input");
    const ctx = deriveWhenContext(
      { stageName: "editor", selectedNoteId: "note-1" },
      input,
      null,
    );
    expect(ctx).toEqual({
      stageName: "editor",
      focusKind: "plain-input",
      hasSelectedNote: true,
      activeModal: null,
    });
  });

  it("hasSelectedNote is false when selectedNoteId is null", () => {
    const ctx = deriveWhenContext(
      { stageName: "editor", selectedNoteId: null },
      null,
      null,
    );
    expect(ctx.hasSelectedNote).toBe(false);
  });
});

const editorCtx: WhenContext = {
  stageName: "editor",
  focusKind: "other",
  hasSelectedNote: true,
  activeModal: null,
};

describe("isBindingActive", () => {
  it("a global binding is active in the editor context", () => {
    expect(isBindingActive({}, editorCtx)).toBe(true);
  });

  it("stands down while a plain input is focused (unless allowInPlainInput)", () => {
    const typing = { ...editorCtx, focusKind: "plain-input" as const };
    expect(isBindingActive({}, typing)).toBe(false);
    expect(isBindingActive({ allowInPlainInput: true }, typing)).toBe(true);
  });

  it("stays live inside the CM6 editor (cm-editor is not plain-input)", () => {
    const cm = { ...editorCtx, focusKind: "cm-editor" as const };
    expect(isBindingActive({}, cm)).toBe(true);
  });

  it("a per-note binding does not fire with no note selected", () => {
    const noNote = { ...editorCtx, hasSelectedNote: false };
    expect(isBindingActive({ requiresNote: true }, noNote)).toBe(false);
    expect(isBindingActive({ requiresNote: true }, editorCtx)).toBe(true);
  });

  it("stands down while a modal is open (unless allowInModal)", () => {
    const modal = { ...editorCtx, activeModal: "settings" };
    expect(isBindingActive({}, modal)).toBe(false);
    expect(isBindingActive({ allowInModal: true }, modal)).toBe(true);
  });

  it("a stage-scoped binding only fires in its stage", () => {
    expect(isBindingActive({ stage: "editor" }, editorCtx)).toBe(true);
    expect(
      isBindingActive({ stage: "unlock" }, editorCtx),
    ).toBe(false);
  });
});

describe("scopeSpecificity (precedence)", () => {
  it("ranks per-note > stage-scoped > global", () => {
    const perNote = scopeSpecificity({ requiresNote: true, stage: "editor" });
    const stageScoped = scopeSpecificity({ stage: "editor" });
    const global = scopeSpecificity({});
    expect(perNote).toBeGreaterThan(stageScoped);
    expect(stageScoped).toBeGreaterThan(global);
  });
});
