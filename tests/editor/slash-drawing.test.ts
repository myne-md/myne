// @vitest-environment jsdom
//
// The `/drawing` slash command (#213 / MYND-634). Exercises the headless half:
// it clears the trigger, asks the injected IO seam to create a sibling drawing,
// and splices the `![[Title]]` embed at the caret. The thumbnail / canvas render
// is Excalidraw + a live DOM, so it is verified at runtime, not here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { slashCommands } from "../../editor/src/slash/commands";
import {
  drawingEmbedIoExtension,
  reconfigureDrawingEmbedIo,
  type DrawingEmbedIo,
} from "../../editor/src/drawing/embed-io";

function drawingCommand() {
  const cmd = slashCommands().find((c) => c.id === "drawing");
  if (cmd === undefined) throw new Error("no /drawing slash command");
  return cmd;
}

let host: HTMLElement | null = null;
let view: EditorView | null = null;

function mount(doc: string, io: DrawingEmbedIo | null): EditorView {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [drawingEmbedIoExtension()] }),
    parent: host,
  });
  if (io !== null) view.dispatch({ effects: reconfigureDrawingEmbedIo(io) });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("/drawing slash command (#213)", () => {
  it("clears the trigger, creates a sibling drawing, and inserts ![[Title]]", async () => {
    const createSibling = vi.fn(async () => "Drawing 1");
    const io: DrawingEmbedIo = {
      readScene: async () => null,
      saveScene: async () => {},
      createSibling,
    };
    const v = mount("/drawing", io);
    // Trigger occupies [0, 8).
    drawingCommand().apply(v, 0, "/drawing".length);
    // Trigger is cleared synchronously; the embed is spliced after createSibling.
    expect(createSibling).toHaveBeenCalledTimes(1);
    await flush();
    expect(v.state.doc.toString()).toContain("![[Drawing 1]]");
    // The raw `/drawing` trigger text is gone.
    expect(v.state.doc.toString()).not.toContain("/drawing");
  });

  it("is a no-op beyond clearing the trigger when no IO seam is provided", async () => {
    const v = mount("/drawing", null);
    drawingCommand().apply(v, 0, "/drawing".length);
    await flush();
    // Trigger cleared, nothing embedded (host cannot create the note).
    expect(v.state.doc.toString()).toBe("");
  });
});
