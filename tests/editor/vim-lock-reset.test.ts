// @vitest-environment jsdom
//
// vim-keyboard-mode (MYND-313) — clearing vim state on vault lock.
//
// The engine keeps yank registers, recorded macros, the jump list and both
// history buffers in a MODULE-GLOBAL `vimGlobalState`, not on the EditorView.
// Locking a vault unmounts the editor but leaves that global untouched, so
// without an explicit reset this sequence leaks across the vault boundary:
//
//   yank a paragraph in vault A → lock → unlock vault B → `p` → vault A's text
//
// That is a separation Myne promises to keep, which is why the reset sits on the
// lock path next to `resetGraphLayoutOnLock` rather than in a `useEffect`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import {
  reconfigureVim,
  resetVimGenerationForTests,
  resetVimStateOnLock,
  vimApi,
  vimExtension,
} from "../../editor/src/vim";

describe("vim state reset on lock (MYND-313)", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  async function mountWithVim(doc: string): Promise<EditorView> {
    host = document.createElement("div");
    document.body.appendChild(host);
    const v = new EditorView({
      state: EditorState.create({ doc, extensions: [history(), vimExtension()] }),
      parent: host,
    });
    view = v;
    await reconfigureVim(v, true);
    return v;
  }

  beforeEach(() => {
    resetVimGenerationForTests();
  });

  afterEach(() => {
    if (view !== null) view.destroy();
    if (host !== null) host.remove();
    view = null;
    host = null;
  });

  it("clears the yank register, so a later paste cannot surface old text", async () => {
    const v = await mountWithVim("secret paragraph\nsecond line");
    const api = vimApi()!;
    const cm = api.getCM(v)!;

    // Yank the first line — this is the text that must not survive the lock.
    api.Vim.handleKey(cm, "y", "user");
    api.Vim.handleKey(cm, "y", "user");
    const registers = api.Vim.getRegisterController();
    expect(registers.getRegister('"').toString()).toContain("secret paragraph");

    resetVimStateOnLock();

    expect(api.Vim.getRegisterController().getRegister('"').toString()).toBe("");
  });

  it("clears recorded macros too", async () => {
    const v = await mountWithVim("alpha\nbravo");
    const api = vimApi()!;
    const cm = api.getCM(v)!;

    // Record a macro into register `a`, then stop.
    api.Vim.handleKey(cm, "q", "user");
    api.Vim.handleKey(cm, "a", "user");
    api.Vim.handleKey(cm, "x", "user");
    api.Vim.handleKey(cm, "q", "user");

    resetVimStateOnLock();

    expect(api.Vim.getRegisterController().getRegister("a").toString()).toBe("");
  });

  it("is a safe no-op when vim was never enabled", () => {
    // The overwhelmingly common path: the engine is not loaded at all, and the
    // lock path must not care.
    expect(() => resetVimStateOnLock()).not.toThrow();
  });

  it("a freshly mounted editor after a lock starts in normal mode", async () => {
    const first = await mountWithVim("alpha");
    const api = vimApi()!;
    api.Vim.handleKey(api.getCM(first)!, "i", "user");
    expect(first.dom.getAttribute("data-vim-mode")).toBe("insert");

    // Lock: reset global state and tear the editor down.
    resetVimStateOnLock();
    first.destroy();
    host!.remove();

    // Unlock: a new editor mounts. Mode must be normal, never the insert the
    // previous session was left in.
    const second = await mountWithVim("alpha");
    expect(second.dom.getAttribute("data-vim-mode")).toBe("normal");
  });
});
