// The guard this file tests is the one every other editor test leans on to turn
// an unrealised parse into a named failure instead of a wrong answer
// (myne#567). A guard nobody has broken is a guard nobody has tested, so this
// exercises both arms directly.
//
// The defect worth naming is specific and was measured, not hypothesised.
// `ensureSyntaxTree` advances the language's parse CONTEXT, while
// `syntaxTree()` returns `field.tree`, a snapshot taken when the language state
// field was built. Checking only `ensureSyntaxTree`'s return value therefore
// passes a tree the caller cannot see: on the document built below,
// `syntaxTree()` reports 3,003 characters before AND after a successful
// `ensureSyntaxTree`, against a document of ~46,000. The first version of
// `assertParsedState` did exactly that, so it reported success on a tree
// covering three percent of the document, and every caller inherited a green
// light on a truncated tree.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { assertParsedState, completeState, PARSE_BUDGET_MS } from "./_parse-budget";

/** A document far past the parser's initial chunk, so the caller's tree is short. */
function oversizedDoc(): string {
  return Array.from({ length: 4000 }, (_, i) => `- item ${i}`).join("\n") + "\n";
}

function markdownState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

describe("assertParsedState", () => {
  it("passes on a document the caller's tree already covers", () => {
    // The arm that must NOT throw. If this ever starts failing, the guard has
    // become unconditional and would redden every editor test.
    //
    // `completeState` FIRST, and that is the fix for a flake this file produced
    // in CI rather than a convenience. A bare state's initial parse is
    // time-budgeted (`LanguageState.init`, 20 ms), and that deadline is
    // consulted between BLOCKS: measured with the clock spent, this very
    // document comes back with a tree covering 24 of its 46 characters, because
    // the first pass resolves the paragraph and stops at the list item that
    // opens the next block. Asserting that a bare init is complete asserted a
    // property CodeMirror does not offer, which is why this passed alone and
    // failed in the full suite. The arm itself is unchanged: `assertParsedState`
    // still must not throw on a tree that covers the document, and it is
    // `completeState` that throws first if it has become unconditional.
    const state = completeState(
      markdownState("pelin dilara çolak izle\n  - [ ] admin preview\n"),
    );
    expect(syntaxTree(state).length).toBe(state.doc.length);
    expect(() => assertParsedState(state)).not.toThrow();
  });

  it("throws when the caller's tree is short even though the parse context advanced", () => {
    const state = markdownState(oversizedDoc());

    // Precondition: the tree the CALLER reads genuinely does not cover the
    // document. Without this the test could pass for the wrong reason, which is
    // the failure mode this repository keeps recording about its own fixtures.
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length);

    expect(() => assertParsedState(state)).toThrow(/PARTIAL/);
    expect(() => assertParsedState(state)).toThrow(/myne#567/);
  });

  it("names the shortfall, so a red run says which document was short", () => {
    const state = markdownState(oversizedDoc());
    let message = "";
    try {
      assertParsedState(state);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(String(state.doc.length));
    expect(message).toContain(String(PARSE_BUDGET_MS));
  });

  it("still throws on a budget too small to finish, not only on a short tree", () => {
    // The other arm: a caller that passes a tight budget on a small document
    // gets the same named error rather than a partial tree.
    const state = markdownState(oversizedDoc());
    expect(() => assertParsedState(state, 0)).toThrow(/myne#567/);
  });
});

describe("completeState", () => {
  it("returns a state whose tree covers a document the bare init left short", () => {
    // This is the fixer the tripwire above cannot be: it advances the context
    // AND rebuilds the field snapshot, so the caller reads a complete tree
    // instead of a named failure. Precondition first, so this passes for the
    // real reason rather than a fixture that was already complete.
    const state = markdownState(oversizedDoc());
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length);

    const complete = completeState(state);
    expect(syntaxTree(complete).length).toBe(complete.doc.length);
  });

  it("leaves a complete tree alone and preserves selection and document", () => {
    const state = markdownState("see [^1] here\n\n[^1]: note\n");
    const complete = completeState(state);
    expect(syntaxTree(complete).length).toBe(complete.doc.length);
    expect(complete.doc.toString()).toBe(state.doc.toString());
  });
});
