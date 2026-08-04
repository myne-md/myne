// @vitest-environment jsdom
//
// myne#336 — the modal gate the keybind engine documents must actually engage.
//
// The one production call site hardcoded `activeModal: null`, so "window
// shortcuts stand down under a modal" was never true. Under a modal the user
// believes is exclusive, window chords silently acted on the workspace behind
// it: tabs closed, notes were created into an unreachable inline rename, the
// center view changed, pane history moved. Nothing is overwritten — the user
// simply comes back to a workspace that is not the one they left, with no record
// of what changed.
//
// `selectedNoteId: null` was hardcoded at the same site, making
// `ctx.hasSelectedNote` permanently false, so any entry declaring
// `scope.requiresNote` would silently never fire. Inert only because no entry
// uses the flag yet — which is how it would have stayed until the first one did.
//
// Driven at `isBindingActive`, which is the gate itself: the wiring above it is
// two props, and what has to be true is that a non-null `activeModal` and a real
// `selectedNoteId` change the answer.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isBindingActive } from "../../src/commands/scope";
import type { WhenContext } from "../../src/commands/scope";

const ctx = (over: Partial<WhenContext> = {}): WhenContext => ({
  focusKind: "none",
  hasSelectedNote: true,
  activeModal: null,
  stageName: "editor",
  ...over,
});

describe("the modal gate", () => {
  it("stands an ordinary window binding down under a modal", () => {
    expect(isBindingActive({}, ctx({ activeModal: "settings" }))).toBe(false);
    expect(isBindingActive({}, ctx({ activeModal: "palette" }))).toBe(false);
  });

  it("lets a binding that opted in through — the close chords", () => {
    // `palette.toggle` and `app.open-settings` ARE how the user closes those
    // modals; gating them would trap the user inside.
    expect(
      isBindingActive({ allowInModal: true }, ctx({ activeModal: "palette" })),
    ).toBe(true);
  });

  it("leaves an ordinary binding alone with no modal open", () => {
    expect(isBindingActive({}, ctx())).toBe(true);
  });
});

describe("the selected-note gate", () => {
  it("stands a requiresNote binding down with no note selected", () => {
    expect(isBindingActive({ requiresNote: true }, ctx({ hasSelectedNote: false }))).toBe(
      false,
    );
  });

  it("lets it through when a note IS selected", () => {
    expect(isBindingActive({ requiresNote: true }, ctx({ hasSelectedNote: true }))).toBe(
      true,
    );
  });
});

// The gate itself was always correct — what shipped broken was the WIRING, and
// a test that only drives `isBindingActive` would not have caught it. This reads
// the call site.
describe("the dispatcher's wiring (myne#336)", () => {
  const editorSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "screens", "Editor.tsx"),
    "utf8",
  );

  it("does not hardcode activeModal to null", () => {
    expect(editorSrc).not.toMatch(/activeModal:\s*null\s*,/);
  });

  it("does not hardcode selectedNoteId to null", () => {
    expect(editorSrc).not.toMatch(/selectedNoteId:\s*null\s*,/);
  });

  it("passes a real modal identity into the hotkeys host", () => {
    expect(editorSrc).toMatch(/activeModal=\{/);
  });
});
