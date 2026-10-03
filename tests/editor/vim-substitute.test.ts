// @vitest-environment jsdom
//
// vim-keyboard-mode (MYND-313) — `:s` substitution.
//
// The engine ships a vim→JS regex translator, but MEASUREMENT showed it is not
// applied on this code path: `\(…\)` silently matched nothing, `\v` was ignored,
// and `\zs` threw a raw `SyntaxError: Invalid regular expression`. A silent
// no-op and a stack trace are both worse than a clear refusal, so `:s` is owned
// here: the pattern is screened for vim-only syntax, refused with a message if it
// contains any, and otherwise applied with JavaScript semantics in ONE
// transaction (hence one undo step).
//
// The decision recorded in the PRD (refuse rather than translate) therefore holds,
// though for a different reason than it was written for.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import {
  reconfigureVim,
  resetVimGenerationForTests,
  vimApi,
  vimExtension,
} from "../../editor/src/vim";

/** Run an ex command string through the engine, the way `:` would. */
function ex(view: EditorView, command: string): void {
  const api = vimApi()!;
  const cm = api.getCM(view)!;
  // `getCM` types the handle as the base `CodeMirror`, but `handleEx` wants the
  // engine's `CodeMirrorV` (the same object plus the vim fields the engine adds
  // on mount). The runtime value is that object; the cast bridges the package's
  // two imprecise halves without an extra `@replit/codemirror-vim` import in a
  // root-tree test (the package is a dependency of `editor/`, not the root).
  api.Vim.handleEx(cm as Parameters<typeof api.Vim.handleEx>[0], command);
}

describe("vim :s substitution (MYND-313)", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  async function mount(doc: string): Promise<EditorView> {
    host = document.createElement("div");
    document.body.appendChild(host);
    const v = new EditorView({
      // `history()` is part of `myneExtensions()`; without it vim's `u` has
      // nothing to undo through and the undo assertion would be vacuous.
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

  it("plain-text substitution on the current line", async () => {
    const v = await mount("cat dog cat\nsecond line");
    ex(v, "s/cat/bird/");
    expect(v.state.doc.toString()).toBe("bird dog cat\nsecond line");
  });

  it("the g flag replaces every occurrence on the line", async () => {
    const v = await mount("cat dog cat\nsecond line");
    ex(v, "s/cat/bird/g");
    expect(v.state.doc.toString()).toBe("bird dog bird\nsecond line");
  });

  it("%s applies to the whole note", async () => {
    const v = await mount("cat one\ncat two\ncat three");
    ex(v, "%s/cat/bird/g");
    expect(v.state.doc.toString()).toBe("bird one\nbird two\nbird three");
  });

  it("refuses a vim-style group instead of silently matching nothing", async () => {
    const v = await mount("kitten\n");
    ex(v, "%s/\\(kit\\)ten/\\1ty/g");
    // Refused → document byte-identical. Without the screen this was a silent
    // no-op, which reads to the user as "the feature is broken".
    expect(v.state.doc.toString()).toBe("kitten\n");
  });

  it("refuses very-magic mode (\\v) rather than ignoring it", async () => {
    const v = await mount("aaa bbb\n");
    ex(v, "%s/\\v(a+)/X/g");
    expect(v.state.doc.toString()).toBe("aaa bbb\n");
  });

  it("refuses \\zs instead of throwing a raw SyntaxError at the user", async () => {
    const v = await mount("foobar barfoo\n");
    expect(() => ex(v, "%s/foo\\zsbar/X/g")).not.toThrow();
    expect(v.state.doc.toString()).toBe("foobar barfoo\n");
  });

  it("shared syntax that both dialects agree on still works", async () => {
    // Plain JS groups and quantifiers are NOT vim-only, so they pass the screen
    // and run — the refusal is narrow, not a blanket ban on regex.
    const v = await mount("kitten\n");
    ex(v, "%s/(kit)ten/$1ty/g");
    expect(v.state.doc.toString()).toBe("kitty\n");
  });

  it("a substitution is one undo step", async () => {
    const v = await mount("cat one\ncat two");
    const before = v.state.doc.toString();
    ex(v, "%s/cat/bird/g");
    expect(v.state.doc.toString()).not.toBe(before);

    const api = vimApi()!;
    api.Vim.handleKey(api.getCM(v)!, "u", "user");
    expect(v.state.doc.toString()).toBe(before);
  });

  it("a pattern that matches nothing leaves the document untouched", async () => {
    const v = await mount("cat one\ncat two");
    const before = v.state.doc.toString();
    ex(v, "%s/zebra/bird/g");
    expect(v.state.doc.toString()).toBe(before);
  });
});
