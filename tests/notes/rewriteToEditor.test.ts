// @vitest-environment jsdom
//
// `rewriteSelectionToEditor` (ai-backend-degradation myne#191 task 6).
//
// The bug this covers was not a missing message — it was that **nothing
// happened at all**: the orchestration was an un-`catch`ed IIFE inside
// `Editor.tsx`, so an engine rejection became an unhandled promise rejection
// with no toast, no error and no document change. On a stock install, with no
// generation model side-loaded, that was the outcome every single time.
//
// So every case below asserts BOTH halves — what the user was told, and what
// happened to their text. A version that toasted correctly while mutating the
// document, or mutated correctly while staying silent, fails here.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { rewriteSelectionToEditor } from "../../src/notes/ai/rewriteToEditor";

const DOC = "the quick brown fox";

function harness(infer: (prompt: string) => Promise<string>) {
  const view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: 4, head: 9 },
    }),
  });
  const toasts: string[] = [];
  // Snapshotted HERE, not inside `run`: the whole point of the staleness guard
  // is that the pre-inference state is immutable while the document moves on,
  // and reading `view.state` lazily would silently defeat the test.
  const stateAtStart = view.state;
  return {
    view,
    toasts,
    run: () =>
      rewriteSelectionToEditor({
        view,
        stateAtStart,
        activeView: () => view,
        stillSameNote: () => true,
        infer,
        showToast: (m) => toasts.push(m),
        t: (key) => key,
      }),
  };
}

describe("rewriteSelectionToEditor", () => {
  it("applies the rewrite on the happy path — the extraction did not change it", async () => {
    const h = harness(() => Promise.resolve("SLOW"));
    await expect(h.run()).resolves.toBe(true);
    expect(h.view.state.doc.toString()).toBe("the SLOW brown fox");
    expect(h.toasts).toEqual([]);
  });

  it("says a provider is missing, and leaves the document alone", async () => {
    for (const rejection of ["NotReady", { kind: "NoModel" }, "no_credential"]) {
      const h = harness(() => Promise.reject(rejection));
      await expect(h.run()).resolves.toBe(false);
      expect(h.toasts).toEqual(["editor.flow.aiRewriteNoProvider"]);
      // The user's first worry on a failed rewrite is what happened to their
      // text, which is why the copy says "unchanged" and why this asserts it.
      expect(h.view.state.doc.toString()).toBe(DOC);
    }
  });

  it("distinguishes a generic failure from a missing provider", async () => {
    const h = harness(() => Promise.reject({ kind: "InferenceFailed" }));
    await expect(h.run()).resolves.toBe(false);
    expect(h.toasts).toEqual(["editor.flow.aiRewriteFailed"]);
    expect(h.view.state.doc.toString()).toBe(DOC);
  });

  it("never swallows a rejection — every failure answers", async () => {
    // An unrecognized rejection shape is still an answer, not silence. The old
    // code's whole defect was that some path could produce nothing at all.
    const h = harness(() => Promise.reject(new Error("something else entirely")));
    await expect(h.run()).resolves.toBe(false);
    expect(h.toasts).toHaveLength(1);
  });

  it("drops a stale result rather than corrupting the document", async () => {
    const h = harness(() => Promise.resolve("SLOW"));
    // The user edits while the multi-second infer is in flight: the target
    // range no longer holds the text that was rewritten.
    h.view.dispatch({ changes: { from: 0, to: 3, insert: "THE LONGER" } });
    await expect(h.run()).resolves.toBe(false);
    expect(h.view.state.doc.toString()).toBe("THE LONGER quick brown fox");
    // Silent on purpose: nothing failed, the answer simply no longer applies.
    expect(h.toasts).toEqual([]);
  });

  it("drops a result for a note the user has navigated away from", async () => {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, selection: { anchor: 4, head: 9 } }),
    });
    const toasts: string[] = [];
    const changed = await rewriteSelectionToEditor({
      view,
      stateAtStart: view.state,
      activeView: () => view,
      stillSameNote: () => false,
      infer: () => Promise.resolve("SLOW"),
      showToast: (m) => toasts.push(m),
      t: (key) => key,
    });
    expect(changed).toBe(false);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it("is silent when the pipeline declines — an empty rewrite is not a failure", async () => {
    const h = harness(() => Promise.resolve(""));
    await expect(h.run()).resolves.toBe(false);
    expect(h.toasts).toEqual([]);
    expect(h.view.state.doc.toString()).toBe(DOC);
  });
});
