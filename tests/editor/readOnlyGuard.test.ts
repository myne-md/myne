// @vitest-environment jsdom
//
// myne-md/myne#564: reading view must refuse an editing COMMAND, not just a
// keystroke.
//
// `EditorView.editable.of(false)` stops the user typing into the contentDOM and
// nothing else. CodeMirror's own documentation is explicit that it "doesn't
// affect API calls that change the editor content, even when those are bound to
// keys", and every editing command in `@codemirror/commands` guards on
// `state.readOnly` instead. Nothing in this tree ever set that, so every one of
// those guards was inert on a surface whose whole contract is that the note
// cannot be changed there, and the branch that added two whole-line delete
// chords was about to widen what that costs.
//
// The check is on the STATE rather than on any one command, because that is
// where the fix is: one true statement instead of one guard per caller.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { deleteToLineBoundary } from "@myne/editor/line-boundary";
import { viewModeExtension } from "@myne/editor/view-mode";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { taskListDecorations } from "@myne/editor/decorations/task-list";
import { type EditorHost, setEditorHost, writableHost } from "@myne/editor/host";

function stateFor(mode: "live" | "reading" | "source", readOnly: boolean): EditorState {
  return EditorState.create({
    doc: "- [ ] buy milk\n",
    selection: { anchor: 14, head: 14 },
    extensions: [viewModeExtension(mode, readOnly)],
  });
}

describe("view mode sets EditorState.readOnly, not only EditorView.editable", () => {
  it("is read-only in reading view", () => {
    expect(stateFor("reading", false).readOnly).toBe(true);
  });

  it("is read-only when the host forces it (the companion mirror)", () => {
    expect(stateFor("live", true).readOnly).toBe(true);
  });

  it("is writable in live and source view", () => {
    expect(stateFor("live", false).readOnly).toBe(false);
    expect(stateFor("source", false).readOnly).toBe(false);
  });
});

describe("the new delete chords honour it", () => {
  it("changes nothing in reading view", () => {
    let state = stateFor("reading", false);
    const view = {
      get state() {
        return state;
      },
      moveToLineBoundary: () => ({ head: 0, assoc: 1 }),
      coordsAtPos: () => null,
      dispatch: (tr: { state: EditorState }) => {
        state = tr.state;
      },
    } as unknown as EditorView;

    expect(deleteToLineBoundary(view, false)).toBe(false);
    expect(state.doc.toString()).toBe("- [ ] buy milk\n");
  });
});

describe("the task checkbox honours it too", () => {
  let host: HTMLElement | null = null;
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    host?.remove();
    view = null;
    host = null;
  });

  /** Mount just the task-list decoration in one view mode. */
  function mountIn(mode: "live" | "reading"): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc: "- [ ] milk\n",
        extensions: [
          markdown({ base: markdownLanguage }),
          viewModeExtension(mode, false),
          taskListDecorations(),
        ],
      }),
      parent: host,
    });
    return host;
  }

  it("refuses the click in reading view", () => {
    // `EditorState.readOnly` is consulted by COMMANDS. This widget dispatches
    // into the document from its own DOM handler, so setting the flag bought it
    // nothing: reading mode reported `readOnly === true` and a click still wrote
    // `- [x]`. Worse on the reading COMPANION mirror, whose `onChange` is a
    // no-op: the box flipped on screen and the write was thrown away, so the
    // tick looked like it landed and vanished at the next adoption.
    const el = mountIn("reading");
    const box = el.querySelector<HTMLElement>('[data-testid="editor.task-checkbox"]');
    expect(box, "the checkbox still renders in reading view").not.toBeNull();
    box!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view!.state.doc.toString()).toBe("- [ ] milk\n");
  });

  it("does not advertise itself as operable there", () => {
    // An affordance that looks live and does nothing is worse than none.
    const el = mountIn("reading");
    const box = el.querySelector<HTMLElement>('[data-testid="editor.task-checkbox"]')!;
    expect(box.getAttribute("tabindex")).toBeNull();
    expect(box.getAttribute("aria-disabled")).toBe("true");
  });

  it("still toggles in live view", () => {
    // The other direction, which is the one nobody thinks to try: a guard that
    // refuses everything is also wrong, and green.
    const el = mountIn("live");
    const box = el.querySelector<HTMLElement>('[data-testid="editor.task-checkbox"]')!;
    expect(box.getAttribute("tabindex")).toBe("0");
    box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(view!.state.doc.toString()).toBe("- [x] milk\n");
  });
});

// The seam half of the same rule (myne-md/myne#520's review, generalised).
//
// A widget's DOM handler that calls the HOST is invisible to every mechanism
// that makes an editor read-only: `EditorState.readOnly` is consulted by
// commands, and the reading mirror's `NOOP_ON_CHANGE` intercepts document
// changes. The host re-encrypts the note on disk, so neither is in the path.
// Two cover controls each grew their own `view.state.readOnly` clause; this
// pins the accessor that now holds the rule for both and for the next one.
describe("writableHost gates the host's write-capable members", () => {
  const HOST = {
    cover: { openPicker: () => {}, remove: () => {} },
  } as unknown as EditorHost;

  afterEach(() => {
    setEditorHost(null as unknown as EditorHost);
  });

  const stateWith = (readOnly: boolean) =>
    EditorState.create({ doc: "x", extensions: [EditorState.readOnly.of(readOnly)] });

  it("hides a write member from a read-only state", () => {
    setEditorHost(HOST);
    expect(writableHost(stateWith(true)).cover).toBeUndefined();
  });

  it("passes it through on a writable one, which is the direction nobody tries", () => {
    // A gate that refuses everything is also wrong, and green: the cover
    // controls would simply stop rendering in the live editor.
    setEditorHost(HOST);
    expect(writableHost(stateWith(false)).cover).toBe(HOST.cover);
  });

  it("leaves READ members alone in both states", () => {
    // The gate is not "no host in reading view". A reading surface still
    // resolves attachments, opens links and reads prefs; only the members that
    // write are withheld.
    const withRead = { ...HOST, attachmentUrl: (id: string) => id } as unknown as EditorHost;
    setEditorHost(withRead);
    expect(writableHost(stateWith(true)).attachmentUrl).toBe(withRead.attachmentUrl);
    expect(writableHost(stateWith(false)).attachmentUrl).toBe(withRead.attachmentUrl);
  });

  it("does not mutate the registered host", () => {
    // It returns a copy; a gate that deleted the member from the singleton
    // would turn one read-only render into a permanent loss of the affordance.
    setEditorHost(HOST);
    writableHost(stateWith(true));
    expect(HOST.cover).toBeDefined();
  });
});
