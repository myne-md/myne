// @vitest-environment jsdom
//
// Lost-update regression for `<CMEditor>`'s controlled-value mirror (MYND-625).
//
// Autosave snapshots the doc, writes it, and the parent echoes the SAVED text
// back as `value` — but the user keeps typing during that round trip, so the
// echo arrives describing a doc that is already behind the live one. The mirror
// used to diff the echo against the LIVE doc, which describes deleting whatever
// was typed in the meantime, and then dispatched it. That single bug produced
// all three field reports: a character vanishing while typing fast, a whole
// line disappearing after leaving a note, and the caret jumping.
//
// These tests pin the contract that fixes it: a `value` the live doc has
// already moved past is DROPPED, so a stale echo can never remove local edits,
// while a genuine external replacement (no local edits pending) still lands in
// full.

import { describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";
import type { EditorView } from "@codemirror/view";
import { CMEditor } from "../../editor/src/CMEditor";

afterEach(cleanup);

/** The live CodeMirror document text inside the rendered editor. */
function docText(container: HTMLElement): string {
  const content = container.querySelector(".cm-content");
  if (content === null) throw new Error("editor content not mounted");
  return (content.textContent ?? "").replace(/​/g, "");
}

describe("CMEditor — controlled-value mirror drops a stale save echo", () => {
  it("keeps text typed while a save was in flight when the echo arrives", () => {
    const initial = "---\nupdated: 1\n---\n\nhello";
    let latest = initial;
    let view: EditorView | null = null;
    const { container, rerender } = render(
      <CMEditor
        value={initial}
        onChange={(next) => (latest = next)}
        onReady={(v) => (view = v)}
      />,
    );

    // The user types ` world` — the editor emits it upward. This is the text a
    // save would snapshot.
    expect(view, "onReady should hand back the live view").not.toBeNull();
    const type = (text: string) => {
      const end = view!.state.doc.length;
      view!.dispatch({ changes: { from: end, to: end, insert: text } });
    };
    type(" world");
    expect(latest).toContain("hello world");

    // …then types one more character BEFORE the save's echo comes back.
    type("!");

    // The echo: the saved text (as of " world"), with autosave's refreshed
    // frontmatter timestamp. It does NOT know about the "!".
    rerender(
      <CMEditor
        value={"---\nupdated: 2\n---\n\nhello world"}
        onChange={(next) => (latest = next)}
        onReady={(v) => (view = v)}
      />,
    );

    // The echo is dropped: the buffer is ahead of it, and it cannot describe
    // the user's document. Their text is intact, and the next save carries it
    // (with a fresh timestamp), so nothing is permanently lost.
    expect(
      docText(container),
      "the character typed during the save must survive",
    ).toContain("hello world!");
  });

  it("applies a genuine external replacement in full", () => {
    const initial = "original body";
    const { container, rerender } = render(
      <CMEditor value={initial} onChange={() => {}} />,
    );

    // No local edits: the baseline IS the live doc, so this reduces to the
    // previous behaviour — the whole replacement lands.
    rerender(<CMEditor value="replaced by sync" onChange={() => {}} />);

    expect(docText(container)).toContain("replaced by sync");
    expect(docText(container)).not.toContain("original body");
  });
});
