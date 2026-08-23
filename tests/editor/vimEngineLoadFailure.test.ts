// @vitest-environment jsdom
//
// A vim engine that fails to load must not read as the app breaking.
// myne-md/myne#556, the `settings.block.vim-mode` bullet:
//
//   > the bundle server is the harness's own, so it can 503 the
//   > `@replit/codemirror-vim` chunk — an honest failed dynamic import.
//   > `editor/src/vim.ts` does `await import(...)` with no catch, so the
//   > rejection currently leaves the toggle on with no indication: the defect a
//   > scenario would name.
//
// # The bullet is right about the import and does not say where it lands
//
// `CMEditor.tsx` called `void reconfigureVim(view, vimMode)`. `void` silences
// the floating-promise lint and swallows nothing — the promise still rejects
// with no handler. On the web client `src/lib/global-failure.ts` listens for
// `unhandledrejection` and records `unhandled-rejection` as a bounded global
// failure code, which `FailClosedError`'s diagnostic block can surface. So an
// offline user toggling vim on, a 503 on that one chunk, or an extension
// blocking it, produced a diagnostic saying the application failed — for a
// download that simply did not happen.
//
// The comment above that call already claimed "errors are swallowed
// deliberately". It was describing behaviour the code did not have. Both call
// sites now `.catch()`, and the second test below is what keeps them there.
//
// # `vi.mock("@replit/codemirror-vim")` from a test in THIS tree is a no-op
//
// Worth knowing before writing the obvious version of this file, because
// nothing reports it. That package is a dependency of the `editor/` workspace
// MEMBER, not of the repo root, so it does not resolve from `tests/` at all —
// Vitest registers the mock against a specifier it can never match, no warning
// is emitted, and `editor/src/vim.ts` goes on importing the real engine. The
// draft that did this reported the engine loading fine while claiming to have
// broken it. (Adding a direct `await import("@replit/codemirror-vim")` to the
// test is what surfaced it, as a Vite resolve error: "Failed to resolve import
// … Does the file exist?")
//
// So the runtime half here does NOT simulate a chunk-load failure. It produces
// a reconfigure that fails on the step AFTER the import, through a module this
// tree can resolve, and asserts the post-condition a user actually experiences:
// the editor still edits, and nothing claims vim is on. The chunk-load cause
// itself belongs to the browser lane, where the harness serves the bundle and
// can 503 that one URL — which is what the bullet asked for and what remains
// owed on the issue.
//
// # And the first draft passed for a third, entirely unrelated reason
//
// It used `vi.doMock` + `vi.resetModules()`. Resetting modules discards the
// graph `tests/setup-editor-host.ts` installed the editor host into, so
// `reconfigureVim` rejected with "setEditorHost() was not called before the
// editor mounted" — the `rejects.toThrow()` was satisfied, and the test would
// have passed against a build whose import was perfectly guarded. Printing the
// rejection reason is what found it. Every rejection assertion below names the
// error it expects.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// `process.cwd()`, the way every other source-reading spec in this tree does it
// (`tests/web/serviceWorkerClaim.test.ts`, `tests/platform/reservedChords.test.ts`
// and three more). `import.meta.dirname` is not typed under this tsconfig.
const REPO_ROOT = process.cwd();

/** The failure the mocked setup step raises. Asserted on by message, so a
 *  rejection from some OTHER cause cannot satisfy the test — see the header. */
const SETUP_FAILURE = "injected vim setup failure";

// `./vim-chords` is a RELATIVE module inside the same package, so unlike the
// engine itself it is resolvable from here and this mock actually takes. It
// stands in for "the reconfigure failed": the real production cause is one step
// earlier (the dynamic import), and the observable consequence is identical —
// the compartment is never reconfigured and no mode is announced.
vi.mock("../../editor/src/vim-chords", async () => {
  const real = await vi.importActual<typeof import("../../editor/src/vim-chords")>(
    "../../editor/src/vim-chords",
  );
  return {
    ...real,
    applyChordPolicy: () => {
      throw new Error(SETUP_FAILURE);
    },
  };
});

describe("a vim engine that fails to load (myne-md/myne#556)", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it("leaves the editor working, with no mode attribute, when the setup fails", async () => {
    const { VIM_MODE_ATTR, reconfigureVim, vimExtension } = await import(
      "../../editor/src/vim"
    );

    const host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({ doc: "hello", extensions: [vimExtension()] }),
      parent: host,
    });

    // The helper's own contract: it rejects, and it rejects with THIS error.
    // Asserting the message is the difference between this test and the draft
    // that passed on a host-setup error — see the header.
    await expect(reconfigureVim(view, true)).rejects.toThrow(SETUP_FAILURE);

    // The editor is still an editor. This is the promise `CMEditor.tsx`'s
    // comment makes ("a failed chunk load must leave the plain editor working,
    // not break the note"), and it is the half a user notices.
    view.dispatch({ changes: { from: 5, insert: " world" } });
    expect(
      view.state.doc.toString(),
      "the document did not take an edit after the vim layer failed to mount, so " +
        "a failure to load an optional engine has cost the user their editor",
    ).toBe("hello world");

    // …and nothing claims vim is on. The bottom-bar mode indicator reads this
    // attribute, so its absence is the only signal the user currently gets —
    // the Settings toggle stays on, which is the gap recorded on the issue.
    expect(
      view.dom.getAttribute(VIM_MODE_ATTR),
      "the editor advertises a vim mode after the layer failed to mount, so the " +
        "bottom bar would show a modal indicator over an editor that is not modal",
    ).toBeNull();
  });

  it("is caught at every CMEditor call site, so no unhandled rejection escapes", () => {
    // A SOURCE check, deliberately. In jsdom `unhandledrejection` is not
    // dispatched, so `void f()` and `f().catch(g)` are behaviourally identical
    // here — the difference exists only in a browser, and it is exactly the
    // difference that recorded a bounded global failure code.
    //
    // Verified by injecting: putting `void` back on either call site fails this
    // by name, quoting the offending line.
    const source = readFileSync(join(REPO_ROOT, "editor/src/CMEditor.tsx"), "utf8");
    const calls = [...source.matchAll(/\breconfigureVim\s*\(/g)];
    expect(
      calls.length,
      "no `reconfigureVim(` call found in CMEditor.tsx. The helper was renamed or " +
        "the call moved, so this test is now checking a file that does not do the " +
        "thing it is about — fix the search, do not delete the test.",
    ).toBeGreaterThanOrEqual(2);

    for (const match of calls) {
      const lineEnd = source.indexOf("\n", match.index);
      const statement = source.slice(match.index, lineEnd === -1 ? undefined : lineEnd);
      expect(
        statement.includes(".catch("),
        `a reconfigureVim call in CMEditor.tsx is not .catch()-guarded:\n\n    ` +
          `${statement.trim()}\n\n` +
          `\`void\` silences the floating-promise lint and swallows nothing. ` +
          `\`vim.ts\` awaits a bare dynamic import, so an offline user or a 503 on ` +
          `that chunk leaves a rejected promise with no handler — and ` +
          `src/lib/global-failure.ts turns an unhandledrejection into the bounded ` +
          `code FailClosedError's diagnostic block shows. A chunk that did not ` +
          `download then reads as the application having failed.`,
      ).toBe(true);
    }
  });
});
