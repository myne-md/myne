// The spell field's ranges survive a document that shrank under them.
//
// The scan is asynchronous: `setSpellErrors` is dispatched from a completed IPC
// round trip, against the document the scan STARTED on. The document can be
// shorter by the time the result lands (a note's body replaced on switch, a
// remote edit applied under the caret), and a range past the end is out of range
// for the NEXT changeset — `ChangeSet.mapPos` then throws `RangeError`, which
// escapes as an uncaught render crash.
//
// Measured 2026-11-03, from the fail-closed card's `data-render-error`:
// `RangeError@mapPos`, both scenarios of `editor-persistent-view`. Both went
// green with the clamp.
//
// Both directions matter and neither sees the other: the first case builds the
// range too far and maps it in the SAME transaction's successor, the second puts
// an already-too-far range into a field whose start state is shorter.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { setSpellErrors, spellField } from "../../src/editor/decorations/spell";

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [spellField] });
}

describe("spellField range clamp", () => {
  it("drops a range the current document cannot hold instead of throwing later", () => {
    // A five-character document, and a scan result measured on a much longer one.
    let state = stateWith("hello");
    state = state.update({
      effects: setSpellErrors.of([
        { word: "hello", from: 0, to: 5 },
        { word: "gone", from: 40, to: 44 },
      ]),
    }).state;

    // The clamp drops the second range: it would be out of range for any edit.
    const value = state.field(spellField);
    expect(value.ranges.map((r) => r.word)).toEqual(["hello"]);

    // And the edit that used to throw now applies.
    expect(() => {
      state.update({ changes: { from: 0, to: 5, insert: "" } });
    }).not.toThrow();
  });

  // An INVARIANT rather than a discriminator, and labelled so: with the clamp
  // removed this case still passes, because the range it carries is legal for the
  // document that maps it. It is here to keep the map path exercised across a
  // shrink, which is the path the first case routes through.
  it("maps a range across a document that shrank under it, without throwing", () => {
    let state = stateWith("hello");
    // `setSpellErrors` is the only public door into the field, so the stale value
    // is built the way production builds it: a valid range on a longer document,
    // then a shrink, then an edit that maps it.
    state = stateWith("hello world");
    state = state.update({
      effects: setSpellErrors.of([{ word: "world", from: 6, to: 11 }]),
    }).state;
    state = state.update({ changes: { from: 0, to: 6, insert: "" } }).state; // "world"
    expect(() => {
      state.update({ changes: { from: 0, to: 5, insert: "x" } });
    }).not.toThrow();
  });
});
