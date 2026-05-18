// @vitest-environment jsdom
//
// jsdom keystroke smoke test for the wikilink chip atomic-range — one
// regression detector that the keymap → command pipeline fires
// `deleteCharBackward` on a real Backspace KeyboardEvent.
//
// Per grill 2026-05-16 Q6 (S2+E3) — this is the single integration test
// that complements the 8 state-machine tests in atomic-range.test.ts.
// Its job is to surface keymap-wiring breakage in future CM6 major bumps;
// it does NOT assert the entire DOM rendering, only that the doc reflects
// atomic-range behavior after a synthetic keystroke.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { wikilinkChipExtensions } from "../../src/editor/wikilink";

describe("Wikilink chip atomic-range — keystroke smoke", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    if (view !== null) view.destroy();
    if (host !== null) host.remove();
    view = null;
    host = null;
  });

  it("synthetic Backspace KeyboardEvent right-of-chip deletes whole wikilink atom", () => {
    const doc = "before [[Note]] after";
    const rightOfChip = doc.indexOf("]]") + 2;

    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: rightOfChip, head: rightOfChip },
        extensions: [
          markdown({
            base: markdownLanguage,
            extensions: [Wikilink],
          }),
          wikilinkChipExtensions(),
          keymap.of(defaultKeymap),
        ],
      }),
      parent: host,
    });

    // Focus so the keymap fires.
    view.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString()).toBe("before  after");
  });
});
