// @vitest-environment jsdom
//
// Lost-update regression for `<CMEditor>`'s controlled-value mirror
// (myne#167, superseding MYND-625).
//
// Autosave snapshots the doc, writes it, and the parent echoes the SAVED text
// back as `value` — but the user may keep typing during that round trip, so the
// echo can arrive describing a doc the buffer has already moved past. Diffing
// the echo against the LIVE doc describes deleting whatever was typed in the
// meantime, and dispatching it did exactly that: a character vanishing while
// typing fast, a whole line disappearing after leaving a note, the caret
// jumping.
//
// MYND-625 tried to catch this by comparing the live doc against the PREVIOUS
// `value` prop. That baseline does not survive a fully-controlled host: the
// parent feeds `onChange` straight back into `value`, so it re-synced to the
// live doc on every committed keystroke and the check was unsatisfiable exactly
// when it mattered. Its regression test used a parent that dropped `onChange`
// on the floor, which is why it passed while the app stayed unprotected — so
// the host below is deliberately shaped like `PaneView`: `value={buf.text}`,
// `onChange` writes state, and the save echo arrives as `{text, base}`.
//
// The contract these tests pin: `valueBase` states what `value` was derived
// FROM, the mirror verifies it against the live doc it owns, and a value that
// fails that check is rejected WHOLE and the live text re-asserted upward. A
// value carrying no baseline is authoritative and still lands in full.

import { describe, expect, it, afterEach } from "vitest";
import { useEffect, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { EditorView } from "@codemirror/view";
import { CMEditor } from "../../editor/src/CMEditor";
import {
  type CatalogRow,
  setCatalogLoader,
} from "../../src/editor/attachments/catalog";
import { setEmojiLoader } from "../../src/editor/decorations/emoji";
import { setSanitizerLoader } from "../../src/editor/html/sanitize";
import { setMathRendererLoader } from "../../src/editor/math/render-math";
import { setMermaidLoader } from "../../src/editor/mermaid/render-mermaid";

// `<CMEditor>` mounts the FULL `myneExtensions()` stack, and five of those
// extensions lazy-load through a dynamic import that ends in an async
// `view.dispatch(...)`. In jsdom that dispatch can land mid-update — "Calls to
// EditorView.update are not allowed while an update is in progress" — or after
// this file's views are torn down. This file mounts one editor per test, so
// stub the five loaders to never resolve, exactly as `_conformance.ts` does for
// the same reason. None of them is relevant here: this spec is about the
// controlled-value mirror, not about rendering.
setEmojiLoader(() => new Promise<Readonly<Record<string, string>>>(() => {}));
setSanitizerLoader(() => new Promise<never>(() => {}));
setMathRendererLoader(() => new Promise<never>(() => {}));
setMermaidLoader(() => new Promise<never>(() => {}));
setCatalogLoader(() => new Promise<ReadonlyMap<string, CatalogRow>>(() => {}));

afterEach(cleanup);

/** The live CodeMirror document text inside the rendered editor. */
function docText(container: HTMLElement): string {
  const content = container.querySelector(".cm-content");
  if (content === null) throw new Error("editor content not mounted");
  return (content.textContent ?? "").replace(/​/g, "");
}

type Buffer = { text: string; base?: string };
type Push = (next: Buffer) => void;

/**
 * The production host shape (`src/notes/components/PaneView.tsx`): fully
 * controlled, `onChange` feeds `value`, and the autosave echo arrives as a
 * `{text, base}` pair. `onChange` clears the baseline — every authoritative
 * writer does, which is what makes an unset `base` mean "apply this".
 */
function EchoingHost(props: {
  initial: string;
  onReady: (v: EditorView | null) => void;
  hand: (push: Push) => void;
  seen: (text: string) => void;
}) {
  const { initial, onReady, hand, seen } = props;
  const [buf, setBuf] = useState<Buffer>({ text: initial });
  useEffect(() => {
    hand(setBuf);
  }, [hand]);
  seen(buf.text);
  return (
    <CMEditor
      noteId={null}
      value={buf.text}
      valueBase={buf.base}
      onChange={(next) => setBuf({ text: next })}
      onReady={onReady}
    />
  );
}

/** Mount `EchoingHost` and return handles for driving both sides. */
function mountHost(initial: string) {
  let view: EditorView | null = null;
  let push: Push = () => {};
  /** What the host believes the body is — its own React state. */
  let hostSeen = initial;
  const { container } = render(
    <EchoingHost
      initial={initial}
      onReady={(v) => (view = v)}
      hand={(p) => (push = p)}
      seen={(t) => (hostSeen = t)}
    />,
  );
  if (view === null) throw new Error("onReady should hand back the live view");
  const live = view as EditorView;
  return {
    container,
    /** The BUFFER. Assertions belong here, not on the rendered text: the
     *  frontmatter block is a replace-decoration (the Properties widget), so
     *  `updated:` never appears in `.cm-content`'s textContent at all. */
    raw: () => live.state.doc.toString(),
    /** The rendered text, for the one assertion that is about rendering. */
    doc: () => docText(container),
    host: () => hostSeen,
    /** Type at the end of the doc, the way a keystroke reaches the buffer. */
    type: (text: string) =>
      act(() => {
        const end = live.state.doc.length;
        live.dispatch({ changes: { from: end, to: end, insert: text } });
      }),
    /** Deliver a new `value` (+ optional baseline) from the host side. */
    push: (next: Buffer) => act(() => push(next)),
    view: live,
  };
}

const FM_1 = "---\nupdated: 1\n---\n\n";
const FM_2 = "---\nupdated: 2\n---\n\n";

describe("CMEditor — the controlled-value mirror decides on causality", () => {
  it("rejects a save echo the buffer has already moved past", () => {
    const h = mountHost(`${FM_1}hello`);

    // The user types " world" — the text a save would snapshot…
    h.type(" world");
    expect(h.host()).toContain("hello world");

    // …then types one more character BEFORE the echo comes back.
    h.type("!");

    // The echo: the saved text (as of " world") with autosave's refreshed
    // frontmatter stamp, carrying the body it was derived from as its baseline.
    // It does NOT know about the "!".
    h.push({ text: `${FM_2}hello world`, base: `${FM_1}hello world` });

    expect(
      h.raw(),
      "the character typed during the save must survive",
    ).toContain("hello world!");
    expect(h.doc(), "and it must be on screen").toContain("hello world!");
    // Rejected WHOLE, not partially applied: the stamp does not land either.
    // `diffDoc` collapses a frontmatter difference and a body-tail difference
    // into ONE replacement spanning the user's text, so there is no correct
    // way to take "just the stamp" from a value that fails the check.
    expect(h.raw()).toContain("updated: 1");
    expect(h.raw()).not.toContain("updated: 2");
  });

  it("re-asserts the live text upward when it rejects", () => {
    const h = mountHost(`${FM_1}hello`);
    h.type(" world");
    h.type("!");
    h.push({ text: `${FM_2}hello world`, base: `${FM_1}hello world` });

    // Rejecting silently would leave the host holding a body the buffer never
    // adopted, and an autosave that believes it is clean — so the surviving
    // keystroke would never reach disk. The mirror re-converges the host on
    // what it actually holds.
    expect(h.host()).toBe(h.view.state.doc.toString());
    expect(h.host()).toContain("hello world!");
  });

  it("still adopts the stamp when the buffer has NOT moved on", () => {
    const h = mountHost(`${FM_1}hello`);
    h.type(" world");
    const beforeCaret = h.view.state.selection.main.head;

    // No typing since the save fired → the baseline matches the live doc.
    h.push({ text: `${FM_2}hello world`, base: `${FM_1}hello world` });

    // The echo channel is deliberate (`src/notes/saveNote.ts`): without it the
    // editor's `updated:` only refreshes on close-reopen, and it is a visible
    // row in the frontmatter Properties widget.
    expect(h.raw()).toContain("updated: 2");
    expect(h.raw()).toContain("hello world");
    // And `diffDoc`'s whole reason for existing: a minimal change, so the
    // caret is not yanked to position 0 by every autosave.
    expect(h.view.state.selection.main.head).toBe(beforeCaret);
  });

  it("applies an authoritative replacement in full, even over local edits", () => {
    const h = mountHost("original body");
    h.type(" plus local edits");

    // No baseline → note switch / sync pull / §11.3 keep-both adopt. Those
    // legitimately replace the whole body while the user has just typed (the
    // keep-both handler has already preserved the edits into a conflict copy),
    // so any "refuse a large diff while focused" heuristic would break them.
    h.push({ text: "replaced by sync" });

    expect(h.doc()).toContain("replaced by sync");
    expect(h.doc()).not.toContain("original body");
  });

  it("does not latch: a rejection never swallows the NEXT authoritative value", () => {
    const h = mountHost(`${FM_1}hello`);
    h.type(" world");
    h.type("!");
    h.push({ text: `${FM_2}hello world`, base: `${FM_1}hello world` });
    expect(h.raw()).toContain("hello world!");

    // The MYND-625 guard poisoned its own baseline with the text it had just
    // dropped, so the next value — possibly a sync pull — was swallowed too.
    h.push({ text: "pulled from sync" });
    expect(h.raw()).toBe("pulled from sync");
  });

  it("a host that sets no baseline behaves exactly as it did before", () => {
    // Mobile's contract (`myne-mobile` mounts this same component and never
    // echoes a derived value). `valueBase` is optional; leaving it unset keeps
    // the plain controlled mirror.
    let view: EditorView | null = null;
    const { container, rerender } = render(
      <CMEditor noteId={null} value="one" onChange={() => {}} onReady={(v) => (view = v)} />,
    );
    if (view === null) throw new Error("onReady should hand back the live view");
    const live = view as EditorView;

    act(() => {
      const end = live.state.doc.length;
      live.dispatch({ changes: { from: end, to: end, insert: " local" } });
    });
    rerender(<CMEditor noteId={null} value="two" onChange={() => {}} />);

    expect(docText(container)).toContain("two");
  });
});
