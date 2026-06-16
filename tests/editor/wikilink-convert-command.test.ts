// @vitest-environment jsdom
//
// R2 conversion COMMAND runtime (`editor/wikilink/convert-command.ts`, §7.1).
// The pure planning is covered by `wikilink-convert.test.ts`; this drives the
// command layer: the one-transaction buffer rewrite (`applyWikilinkRewrites`),
// the mandatory diff-preview modal (`showWikilinkConvertPreview` — rewrite /
// skipped / ambiguous rows, commit gating, Esc/Enter/cancel/backdrop, the
// ambiguous-picker buildRewrites path) and the `runWikilinkConvert` entry point
// (no-view, empty-plan toast, confirm → apply → toast).

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  applyWikilinkRewrites,
  showWikilinkConvertPreview,
  runWikilinkConvert,
} from "../../src/editor/wikilink/convert-command";
import { noteSetExtension, reconfigureNoteSet } from "../../src/editor/wikilink/note-set";
import { dismissAttachmentToast } from "../../src/editor/attachments/toast";
import { activeViewExtension, getActiveEditorView } from "../../src/editor/active-view";
import type { ConversionRow } from "../../src/editor/wikilink/convert";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

function mountView(doc: string, notes: readonly ResolverNote[] = []): {
  view: EditorView;
  host: HTMLElement;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [noteSetExtension(), activeViewExtension()],
    }),
    parent: host,
  });
  if (notes.length > 0) {
    view.dispatch({ effects: reconfigureNoteSet(notes) });
  }
  return { view, host };
}

const NOTES: readonly ResolverNote[] = [
  { noteUuid: "a", title: "Wednesday", folder: "notes/2025/" },
  { noteUuid: "b", title: "Foo", folder: "Projects/" },
  { noteUuid: "c", title: "Foo", folder: "Archive/" },
];

// A queued microtask + a rAF turn for any deferred dispatch to settle.
const raf = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  dismissAttachmentToast();
  document.body.querySelectorAll(".cm-attach-diff-backdrop").forEach((e) => e.remove());
  document.body.querySelectorAll(".cm-attach-toast").forEach((e) => e.remove());
});

describe("applyWikilinkRewrites", () => {
  it("rewrites two ranges in ONE transaction with descending-from offset safety", () => {
    const { view } = mountView("see [[Foo]] and [[Bar]] end");
    cleanups.push(() => view.destroy());
    const before = view.state.doc.toString();
    const fooStart = before.indexOf("[[Foo]]");
    const barStart = before.indexOf("[[Bar]]");

    // Deliberately pass the rewrites in ASCENDING order — the function must
    // sort descending internally so the first edit doesn't shift the second.
    applyWikilinkRewrites(view, [
      { byteRange: { start: fooStart, end: fooStart + "[[Foo]]".length }, after: "X" },
      { byteRange: { start: barStart, end: barStart + "[[Bar]]".length }, after: "YY" },
    ]);

    expect(view.state.doc.toString()).toBe("see X and YY end");
  });

  it("no-ops on an empty rewrite list (no transaction, doc unchanged)", () => {
    const { view } = mountView("untouched");
    cleanups.push(() => view.destroy());
    applyWikilinkRewrites(view, []);
    expect(view.state.doc.toString()).toBe("untouched");
  });

  it("tags the transaction with the wikilink.convert userEvent", () => {
    let userEvent = false;
    const probe = EditorView.updateListener.of((u) => {
      if (u.transactions.some((t) => t.isUserEvent("wikilink.convert"))) {
        userEvent = true;
      }
    });
    const view = new EditorView({
      state: EditorState.create({ doc: "[[X]]", extensions: [probe] }),
    });
    cleanups.push(() => view.destroy());
    applyWikilinkRewrites(view, [{ byteRange: { start: 0, end: 5 }, after: "Z" }]);
    expect(view.state.doc.toString()).toBe("Z");
    expect(userEvent).toBe(true);
  });
});

describe("showWikilinkConvertPreview — DOM modal", () => {
  it("renders rewrite + skipped + ambiguous rows and gates commit on the ambiguous choice", async () => {
    const rows: ConversionRow[] = [
      { kind: "rewrite", byteRange: { start: 0, end: 5 }, before: "[[A]]", after: "[[A.md|A]]" },
      { kind: "skipped", byteRange: { start: 6, end: 11 }, before: "[[B]]", reason: "no match" },
      {
        kind: "ambiguous",
        byteRange: { start: 12, end: 17 },
        before: "[[Foo]]",
        ref: {
          raw: "[[Foo]]",
          byteRange: { start: 12, end: 17 },
          embed: false,
          target: "Foo",
          targetKind: "title",
          alias: null,
          heading: null,
          blockId: null,
        },
        candidates: [NOTES[1]!, NOTES[2]!],
      },
    ];

    const promise = showWikilinkConvertPreview(rows);

    const modal = document.body.querySelector(".cm-attach-diff");
    expect(modal).not.toBeNull();
    const rowEls = modal!.querySelectorAll(".cm-attach-diff-row");
    expect(rowEls).toHaveLength(3);
    // The rewrite row shows the after-line; the skipped row shows the reason.
    expect(modal!.querySelector(".cm-attach-diff-after")?.textContent).toBe("[[A.md|A]]");
    expect(modal!.querySelector(".cm-attach-diff-skipped")?.textContent).toContain("no match");
    // Subtitle counts rewriteable (rewrite + ambiguous = 2) + needs-a-choice.
    expect(modal!.querySelector(".cm-attach-diff-subtitle")?.textContent).toContain("2 links");
    expect(modal!.querySelector(".cm-attach-diff-subtitle")?.textContent).toContain("needs a choice");

    const commit = Array.from(modal!.querySelectorAll("button")).find(
      (b) => b.textContent === "Convert",
    ) as HTMLButtonElement;
    // Commit is disabled until the ambiguous row gets a choice.
    expect(commit.disabled).toBe(true);

    const select = modal!.querySelector("select") as HTMLSelectElement;
    select.value = "c";
    select.dispatchEvent(new Event("change"));
    expect(commit.disabled).toBe(false);

    commit.click();
    const result = await promise;
    expect(result.confirmed).toBe(true);
    // The ambiguous row's chosen candidate ("c" → Archive/Foo) is in the rewrites.
    expect(result.rewrites).toHaveLength(2);
    const ambiguousRewrite = result.rewrites.find((r) => r.byteRange.start === 12);
    expect(ambiguousRewrite?.after).toBe("[[Archive/Foo.md|Foo]]");
  });

  it("Cancel resolves confirmed:false with no rewrites", async () => {
    const rows: ConversionRow[] = [
      { kind: "rewrite", byteRange: { start: 0, end: 5 }, before: "[[A]]", after: "[[A.md|A]]" },
    ];
    const promise = showWikilinkConvertPreview(rows);
    const cancel = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    ) as HTMLButtonElement;
    cancel.click();
    const result = await promise;
    expect(result).toEqual({ confirmed: false, rewrites: [] });
  });

  it("Escape key dismisses as a cancel", async () => {
    const rows: ConversionRow[] = [
      { kind: "rewrite", byteRange: { start: 0, end: 5 }, before: "[[A]]", after: "[[A.md|A]]" },
    ];
    const promise = showWikilinkConvertPreview(rows);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const result = await promise;
    expect(result.confirmed).toBe(false);
  });

  it("Enter confirms when commit is enabled (all-rewrite plan)", async () => {
    const rows: ConversionRow[] = [
      { kind: "rewrite", byteRange: { start: 0, end: 5 }, before: "[[A]]", after: "[[A.md|A]]" },
    ];
    const promise = showWikilinkConvertPreview(rows);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const result = await promise;
    expect(result.confirmed).toBe(true);
    expect(result.rewrites).toHaveLength(1);
    expect(result.rewrites[0]?.after).toBe("[[A.md|A]]");
  });

  it("an all-skipped plan disables Convert and shows the 'nothing to convert' subtitle", async () => {
    const rows: ConversionRow[] = [
      { kind: "skipped", byteRange: { start: 0, end: 5 }, before: "[[A]]", reason: "no match" },
    ];
    const promise = showWikilinkConvertPreview(rows);
    const modal = document.body.querySelector(".cm-attach-diff")!;
    expect(modal.querySelector(".cm-attach-diff-subtitle")?.textContent).toContain(
      "Nothing to convert",
    );
    const commit = Array.from(modal.querySelectorAll("button")).find(
      (b) => b.textContent === "Convert",
    ) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    // Enter must NOT confirm while disabled.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // Cancel to settle the promise.
    (Array.from(modal.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    ) as HTMLButtonElement).click();
    const result = await promise;
    expect(result.confirmed).toBe(false);
  });
});

describe("runWikilinkConvert — entry point", () => {
  it("no-ops when there is no active editor view", async () => {
    // Mount + destroy so the active-view registry is null.
    const { view } = mountView("hello");
    view.destroy();
    expect(getActiveEditorView()).toBeNull();
    await expect(runWikilinkConvert()).resolves.toBeUndefined();
  });

  it("shows a toast and makes no change when the plan is empty", async () => {
    const { view } = mountView("plain text, no wikilinks", NOTES);
    cleanups.push(() => view.destroy());
    view.focus();
    await runWikilinkConvert();
    expect(view.state.doc.toString()).toBe("plain text, no wikilinks");
    expect(document.body.querySelector(".cm-attach-toast")?.textContent).toContain(
      "No imported wikilinks",
    );
  });

  it("on confirm, applies the rewrites to the active buffer and toasts the count", async () => {
    const { view } = mountView("see [[Wednesday]] today", NOTES);
    cleanups.push(() => view.destroy());
    view.focus();

    const promise = runWikilinkConvert();
    await raf();
    // The mandatory preview modal is up; confirm it (single-rewrite → enabled).
    const commit = Array.from(document.body.querySelectorAll(".cm-attach-diff button")).find(
      (b) => b.textContent === "Convert",
    ) as HTMLButtonElement;
    expect(commit).toBeDefined();
    expect(commit.disabled).toBe(false);
    commit.click();
    await promise;

    expect(view.state.doc.toString()).toBe("see [[notes/2025/Wednesday.md|Wednesday]] today");
    expect(document.body.querySelector(".cm-attach-toast")?.textContent).toContain(
      "1 wikilink converted",
    );
  });
});
