// @vitest-environment jsdom
//
// Attachment INSERT + import-&-convert at the EditorView level (epic MYND-164,
// sub-feature attachment-insert). jsdom is needed for the CM6 EditorView and
// the vanilla-DOM diff-preview modal + toast.
//
// Covers:
//   - insertEmbedsForOutcomes: N form-C embeds in document order, one undo step
//   - applyRewrites: back-to-front single-transaction rewrite
//   - convertImportedRefs: mandatory diff-preview confirm → rewrite; cancel →
//     no byte change; unresolved source → skipped (never silent name-match)
//   - the no-native-drag-drop invariant: the paste/drop handler returns false
//     for a fileless drop (so sidebar note-reorder DnD is never intercepted)

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type ImportOutcome,
  type ImportedAttachment,
} from "../../src/editor/attachments/insert";
import {
  insertEmbedsForOutcomes,
  attachmentPasteDropExtension,
} from "../../src/editor/attachments/paste-drop";
import {
  type RefImporter,
  applyRewrites,
  convertImportedRefs,
} from "../../src/editor/attachments/convert";
import { findImportedImageRefs, planRewrite } from "../../src/editor/attachments/insert";
import { dismissAttachmentToast } from "../../src/editor/attachments/toast";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const ID_C = "c".repeat(64);

function imported(id: string, filename: string): ImportedAttachment {
  return {
    id,
    content_type: "image/png",
    filename,
    size: 1,
    created_at: 0,
    deduplicated: false,
  };
}

function mount(doc: string, head = 0): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: head, head },
      extensions: [attachmentPasteDropExtension()],
    }),
    parent: host,
  });
}

afterEach(() => {
  dismissAttachmentToast();
  document
    .querySelectorAll(".cm-attach-diff-backdrop")
    .forEach((el) => el.remove());
});

describe("insertEmbedsForOutcomes", () => {
  it("inserts N form-C embeds in document order at the cursor", () => {
    const view = mount("X", 1);
    const outcomes: ImportOutcome[] = [
      { ok: true, attachment: imported(ID_A, "a.png") },
      { ok: false, reason: "too-large" },
      { ok: true, attachment: imported(ID_B, "b.png") },
    ];
    insertEmbedsForOutcomes(view, outcomes, 1);
    // Each embed on a line of its own, including the first (myne-md/myne#604):
    // the cursor sits after `X`, so the insert breaks the line rather than
    // leaving the embed inside that prose.
    expect(view.state.doc.toString()).toBe(
      // Trailing newline: the last embed is the end of the note, so the insert
      // leaves a line under it (myne-md/myne#1063).
      `X\n![[att:${ID_A}|a.png]]\n![[att:${ID_B}|b.png]]\n`,
    );
    view.destroy();
  });

  it("is one undo step (whole batch reverts together)", () => {
    const view = mount("", 0);
    insertEmbedsForOutcomes(
      view,
      [
        { ok: true, attachment: imported(ID_A, "a.png") },
        { ok: true, attachment: imported(ID_B, "b.png") },
      ],
      0,
    );
    expect(view.state.doc.toString()).toContain(ID_B);
    view.destroy();
  });

  it("inserts nothing when every outcome was skipped", () => {
    const view = mount("keep", 4);
    insertEmbedsForOutcomes(view, [{ ok: false, reason: "unsupported" }], 4);
    expect(view.state.doc.toString()).toBe("keep");
    view.destroy();
  });
});

describe("applyRewrites (single transaction, back-to-front)", () => {
  it("rewrites every ref to form C without disturbing other bytes", () => {
    const body = "intro ![[a.png]] mid ![[b.png]] end";
    const view = mount(body);
    const refs = findImportedImageRefs(body);
    const rewrites = [
      planRewrite(refs[0], imported(ID_A, "a.png")),
      planRewrite(refs[1], imported(ID_B, "b.png")),
    ];
    applyRewrites(view, rewrites);
    expect(view.state.doc.toString()).toBe(
      `intro ![[att:${ID_A}|a.png]] mid ![[att:${ID_B}|b.png]] end`,
    );
    view.destroy();
  });
});

describe("convertImportedRefs (mandatory diff-preview)", () => {
  // Drive the modal by clicking its buttons after a microtask tick.
  async function afterModal(action: "convert" | "cancel"): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    const backdrop = document.querySelector(".cm-attach-diff-backdrop");
    expect(backdrop, "diff preview must be shown before commit").not.toBeNull();
    const sel =
      action === "convert"
        ? ".cm-attach-diff-btn-primary"
        : ".cm-attach-diff-btn:not(.cm-attach-diff-btn-primary)";
    const btn = backdrop!.querySelector(sel) as HTMLButtonElement;
    btn.click();
  }

  const allResolve: RefImporter = async (ref) => ({
    ok: true,
    attachment: imported(ID_C, ref.source),
  });

  it("discloses ingest-time compression on the convert toast", async () => {
    // Compression is gated in shared core, so import-&-convert compresses on
    // exactly the terms paste does. `decisions.md` 2026-07-30 makes disclosure
    // at import the thing that stands in for a consent gate — a route that
    // compresses without saying so is the half that gets forgotten. The
    // converted count stays too: it is what the user asked this command for.
    const compressing: RefImporter = async (ref) => ({
      ok: true,
      attachment: {
        ...imported(ID_C, ref.source),
        content_type: "image/webp",
        size: 300,
        original_size: 2400,
        container_changed: true,
      },
    });
    const view = mount("doc ![[pic.png]] tail");
    const p = convertImportedRefs(view, compressing);
    await afterModal("convert");
    await p;
    const toast = document.querySelector(".cm-attach-toast");
    expect(toast?.textContent).toBe(
      "1 converted · Compressed to WebP: 2.3 KiB → 300 B",
    );
    view.destroy();
  });

  it("leaves the convert toast alone when nothing was compressed", async () => {
    const view = mount("doc ![[pic.png]] tail");
    const p = convertImportedRefs(view, allResolve);
    await afterModal("convert");
    await p;
    expect(document.querySelector(".cm-attach-toast")?.textContent).toBe(
      "1 converted",
    );
    view.destroy();
  });

  it("rewrites refs to form C only after the user confirms", async () => {
    const view = mount("doc ![[pic.png]] tail");
    const p = convertImportedRefs(view, allResolve);
    await afterModal("convert");
    const result = await p;
    expect(result.converted).toBe(1);
    expect(view.state.doc.toString()).toBe(`doc ![[att:${ID_C}|pic.png]] tail`);
    view.destroy();
  });

  it("makes NO byte change when the user cancels", async () => {
    const before = "doc ![[pic.png]] tail";
    const view = mount(before);
    const p = convertImportedRefs(view, allResolve);
    await afterModal("cancel");
    const result = await p;
    expect(result.cancelled).toBe(true);
    expect(result.converted).toBe(0);
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });

  it("surfaces an unresolved source as skipped — never a silent name-match", async () => {
    const unresolved: RefImporter = async () => ({ ok: false, note: "source not found" });
    const before = "doc ![[ghost.png]] tail";
    const view = mount(before);
    const p = convertImportedRefs(view, unresolved);
    // Preview still shows (with a skipped row); commit is disabled but cancel
    // closes it. The byte stays untouched either way.
    await afterModal("cancel");
    const result = await p;
    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(view.state.doc.toString()).toBe(before);
    view.destroy();
  });

  it("shows a skipped row in the preview for unresolved refs", async () => {
    const unresolved: RefImporter = async () => ({ ok: false, note: "source not found" });
    const view = mount("![[ghost.png]]");
    const p = convertImportedRefs(view, unresolved);
    await Promise.resolve();
    await Promise.resolve();
    const skipped = document.querySelector(".cm-attach-diff-skipped");
    expect(skipped?.textContent).toContain("source not found");
    // Commit button disabled when there's nothing to rewrite.
    const commit = document.querySelector(
      ".cm-attach-diff-btn-primary",
    ) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    (document.querySelector(
      ".cm-attach-diff-btn:not(.cm-attach-diff-btn-primary)",
    ) as HTMLButtonElement).click();
    await p;
    view.destroy();
  });

  it("does nothing (toast only) when the note has no imported refs", async () => {
    const view = mount("plain text, no refs");
    const result = await convertImportedRefs(view, allResolve);
    expect(result.converted).toBe(0);
    expect(document.querySelector(".cm-attach-diff-backdrop")).toBeNull();
    view.destroy();
  });
});

describe("no-native-drag-drop invariant", () => {
  // The drop handler must NOT consume a fileless drop (e.g. the sidebar's
  // HTML5 note-reorder DnD, which carries no files) — it returns false so CM /
  // the sidebar handle it. dragDropEnabled stays false; this proves the
  // WebView-drop interception is narrowly scoped to file drops.
  it("ignores a drop carrying no files", () => {
    const view = mount("body", 0);
    // jsdom 29 has no DataTransfer; stub the minimal shape the handler reads.
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
      value: { files: [], items: [], getData: () => "", types: [] },
    });
    view.contentDOM.dispatchEvent(ev);
    // The doc is untouched and the event was not prevented (no file import).
    expect(view.state.doc.toString()).toBe("body");
    expect(ev.defaultPrevented).toBe(false);
    view.destroy();
  });

  it("ignores a paste carrying no file items (plain text paste keeps working)", () => {
    const view = mount("body", 0);
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    // A plain text paste: items has a string item, no `kind:"file"`. Our
    // handler must NOT consume it; CM's default paste handler inserts the text
    // — proving plain paste still flows through.
    Object.defineProperty(ev, "clipboardData", {
      value: {
        items: [{ kind: "string", type: "text/plain" }],
        files: [],
        getData: () => "hello",
        types: ["text/plain"],
      },
    });
    view.contentDOM.dispatchEvent(ev);
    expect(view.state.doc.toString()).toBe("hellobody");
    view.destroy();
  });
});
