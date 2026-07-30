// @vitest-environment jsdom
//
// The single-undo contract (MYND-615 task 12).
//
// Task 7 states a contract — "one undo restores the original state" — and this
// file is where that stops being an assumption. It exists separately from
// `taskRecurrence.test.ts` because the interesting half is not the recurrence
// code at all: it is what the **autosave mirror** does to the undo stack a
// second later.
//
// The mirror is real and reproduced here rather than imagined. `saveNote`
// stamps `updated:` through `patchUpdatedField` and returns the patched body;
// `useAutosave` hands that back through `onSaved`; `CMEditor`'s controlled-value
// effect turns it into `view.dispatch({ changes: diffDoc(current, next) })` —
// with **no** `Transaction.addToHistory.of(false)` annotation, so it lands in
// undo history like any edit. This test uses the SAME `patchUpdatedField` and
// the SAME `diffDoc` the app uses, so it cannot drift from what actually ships.
//
// The result is asserted, not asserted-to-be-nice: after the save has fired, one
// undo reverses the timestamp and a second reverses the toggle. That is
// pre-existing behaviour for every edit in the app — but this feature is the
// first to make single-undo a *stated* contract, so the scope of that contract
// has to be written down rather than discovered by a user.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { parser } from "../../src/dialect/lezer/parser";
import { diffDoc } from "@myne/editor/doc-diff";
import {
  completeRecurringTask,
  skipOccurrence,
  uncompleteRecurringTask,
  type Clock,
} from "@myne/editor/decorations/task-recurrence";
import { patchUpdatedField } from "../../src/dialect/surgery";

const TODAY: Clock = () => ({ year: 2026, month: 7, day: 28 });

/** A note as it actually exists on disk: frontmatter, then the task. */
const DOC = [
  "---",
  "title: Bills",
  "updated: 2026-07-28T09:00:00.000Z",
  "---",
  "",
  "- [ ] pay rent [due:: 2026-08-01] [repeat:: every month]",
  "",
].join("\n");

function mount(doc: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: { parser } as never }), history()],
    }),
  });
  return { view, host };
}

function teardown(view: EditorView, host: HTMLElement) {
  view.destroy();
  host.remove();
}

function markerAt(view: EditorView): number {
  for (let n = 1; n <= view.state.doc.lines; n++) {
    const line = view.state.doc.line(n);
    const at = line.text.indexOf("[ ]") >= 0 ? line.text.indexOf("[ ]") : line.text.indexOf("[x]");
    if (at >= 0 && /^\s*[-*+]\s*\[/.test(line.text)) return line.from + at;
  }
  throw new Error("no task marker in the document");
}

/**
 * What the autosave round-trip does to the editor, reproduced with the app's own
 * two functions: stamp `updated:`, diff, dispatch. No annotation — that absence
 * IS the behaviour under test.
 */
function fireAutosaveMirror(view: EditorView, at: string): void {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stamped = decoder.decode(patchUpdatedField(encoder.encode(view.state.doc.toString()), at));
  const diff = diffDoc(view.state.doc.toString(), stamped);
  if (diff === null) return;
  view.dispatch({ changes: diff });
}

describe("undo immediately after the toggle (the stated contract)", () => {
  it("one undo restores a recurring completion byte-for-byte", () => {
    const { view, host } = mount(DOC);
    expect(completeRecurringTask(view, markerAt(view), TODAY)).toBe(true);
    // Both halves landed.
    expect(view.state.doc.toString()).toContain("- [x] pay rent");
    expect(view.state.doc.toString()).toContain("[due:: 2026-09-01]");

    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
    teardown(view, host);
  });

  it("one undo restores an un-tick that removed an orphan", () => {
    const { view, host } = mount(DOC);
    completeRecurringTask(view, markerAt(view), TODAY);
    const ticked = view.state.doc.toString();

    expect(uncompleteRecurringTask(view, markerAt(view), TODAY)).toBe(true);
    expect(view.state.doc.toString()).toBe(DOC);

    // The un-tick and the orphan removal rode one transaction, so undoing gets
    // BOTH back — not a half-restored document with a stray occurrence.
    undo(view);
    expect(view.state.doc.toString()).toBe(ticked);
    teardown(view, host);
  });

  it("one undo restores a skip", () => {
    const { view, host } = mount(DOC);
    expect(skipOccurrence(view, markerAt(view), TODAY)).toBe(true);
    expect(view.state.doc.toString()).toContain("[due:: 2026-09-01]");

    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
    teardown(view, host);
  });
});

describe("undo AFTER the autosave mirror has fired", () => {
  // The wrinkle the PRD asked to have asserted rather than assumed.

  it("the mirror is a separate history entry, so the first undo reverses the timestamp", () => {
    const { view, host } = mount(DOC);
    completeRecurringTask(view, markerAt(view), TODAY);
    const afterToggle = view.state.doc.toString();

    fireAutosaveMirror(view, "2026-07-28T09:00:30.000Z");
    const afterSave = view.state.doc.toString();
    expect(afterSave).not.toBe(afterToggle);
    expect(afterSave).toContain("updated: 2026-07-28T09:00:30.000Z");

    // ONE undo: the timestamp goes back, the completion does NOT.
    undo(view);
    expect(view.state.doc.toString()).toBe(afterToggle);
    expect(view.state.doc.toString()).toContain("- [x] pay rent");

    // TWO undos: now the completion reverses too.
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
    teardown(view, host);
  });

  it("the mirror does not fragment the toggle itself — the two halves still share one entry", () => {
    // The failure this rules out: if the marker flip and the insertion had been
    // two dispatches, the post-save sequence would be timestamp → insertion →
    // flip, and the user would see a half-undone document in between.
    const { view, host } = mount(DOC);
    completeRecurringTask(view, markerAt(view), TODAY);
    fireAutosaveMirror(view, "2026-07-28T09:00:30.000Z");

    undo(view); // timestamp
    undo(view); // the whole toggle, both halves at once
    expect(view.state.doc.toString()).toBe(DOC);

    // A third undo has nothing left to reverse.
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
    teardown(view, host);
  });

  it("holds for the skip path too", () => {
    const { view, host } = mount(DOC);
    skipOccurrence(view, markerAt(view), TODAY);
    const afterSkip = view.state.doc.toString();

    fireAutosaveMirror(view, "2026-07-28T09:00:30.000Z");
    undo(view);
    expect(view.state.doc.toString()).toBe(afterSkip);
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
    teardown(view, host);
  });

  it("a save that changes nothing adds no history entry", () => {
    // `diffDoc` returns null when the stamp is identical, so a no-op save cannot
    // silently consume the user's next undo.
    const { view, host } = mount(DOC);
    completeRecurringTask(view, markerAt(view), TODAY);

    fireAutosaveMirror(view, "2026-07-28T09:00:30.000Z");
    fireAutosaveMirror(view, "2026-07-28T09:00:30.000Z"); // same stamp → no diff

    undo(view); // one timestamp entry, not two
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
    teardown(view, host);
  });
});
