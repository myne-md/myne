// @vitest-environment jsdom
//
// Spell-check skip registration for task fields (MYND-614 task 11).
//
// Without this, a recurrence rule made of ordinary dictionary words —
// `every 3 days` — is underlined as a spelling error. Visible in source mode,
// which is where a vim user lives by default.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { parser } from "../../src/dialect/lezer/parser";
import { isSpellable } from "@myne/editor/decorations/spell-skip";

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ base: { parser } as never })],
  });
}

/** Every offset inside `needle`'s first occurrence. */
function offsetsIn(doc: string, needle: string): number[] {
  const start = doc.indexOf(needle);
  return Array.from({ length: needle.length }, (_, i) => start + i);
}

describe("task fields are not spell-checked", () => {
  it("a recurrence rule of dictionary words is not squiggled", () => {
    const doc = "- [ ] water plants [repeat:: every 3 days]\n";
    const state = stateOf(doc);
    for (const pos of offsetsIn(doc, "every 3 days")) {
      expect(isSpellable(state, pos)).toBe(false);
    }
  });

  it("a due date is not squiggled", () => {
    const doc = "- [ ] pay rent [due:: 2026-08-01]\n";
    const state = stateOf(doc);
    for (const pos of offsetsIn(doc, "2026-08-01")) {
      expect(isSpellable(state, pos)).toBe(false);
    }
  });

  it("the field key is not squiggled either", () => {
    const doc = "- [ ] x [priority:: high]\n";
    const state = stateOf(doc);
    for (const pos of offsetsIn(doc, "priority")) {
      expect(isSpellable(state, pos)).toBe(false);
    }
  });

  it("the emoji dialect's value is skipped too", () => {
    const doc = "- [ ] water plants 🔁 every 3 days\n";
    const state = stateOf(doc);
    for (const pos of offsetsIn(doc, "every 3 days")) {
      expect(isSpellable(state, pos)).toBe(false);
    }
  });
});

describe("the task's own prose stays checkable", () => {
  it("the description before a field is still spell-checked", () => {
    const doc = "- [ ] watr plants [repeat:: every 3 days]\n";
    const state = stateOf(doc);
    for (const pos of offsetsIn(doc, "watr")) {
      expect(isSpellable(state, pos)).toBe(true);
    }
  });

  it("a trailing #tag keeps its own skip, not the field's", () => {
    const doc = "- [ ] x [due:: 2026-08-01] #chores\n";
    const state = stateOf(doc);
    // `#tag` was already skipped before this change; assert it still is, so the
    // new entries did not disturb the existing set.
    for (const pos of offsetsIn(doc, "chores")) {
      expect(isSpellable(state, pos)).toBe(false);
    }
  });
});
