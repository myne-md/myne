// The editor's line-number toggle is wired through to the shared editor
// (myne-md/myne#880).
//
// **Why this is a SOURCE test rather than a behavioural one.** `EditorFlow` is
// the single state owner for the whole editor surface: rendering it in Vitest
// means standing up the stage machine, the prefs mirror, the note list and the
// CodeMirror engine, and the file is the largest in the client. What is under
// test here is not what the editor draws once it has the prop, which is
// `editor/src/CMEditor.tsx`'s own business and is covered there; it is that the
// MOBILE call site passes the pref at all. That is exactly the shape
// `mobile/tests/vault-picker-reset.test.ts` pins the same way, and for the same
// reason: the defect is a MISSING prop, and a missing prop is invisible to
// every compiler because the prop is optional with a default.
//
// What it cost: `editor_line_numbers` was written by the mobile settings sheet
// and read by nothing under `mobile/src`, so the row was rendered, tappable and
// inert. The desktop call site in `src/notes/components/PaneView.tsx` has
// threaded it since the pref existed. Nothing reported the difference: the
// write succeeded, the pref synced, and the toggle simply changed nothing.
//
// The behavioural half lives in the flow tier, which drives the real app in a
// browser and can see the gutter appear; this file pins the wiring that makes
// that possible.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const editorFlow: string = readFileSync(
  fileURLToPath(new URL("../../src/app/flows/EditorFlow.tsx", import.meta.url)),
  "utf8",
);

const sharedEditor: string = readFileSync(
  fileURLToPath(new URL("../../../editor/src/CMEditor.tsx", import.meta.url)),
  "utf8",
);

const prefsMirror: string = readFileSync(
  fileURLToPath(new URL("../../src/lib/prefs.ts", import.meta.url)),
  "utf8",
);

/** The `<CMEditor …>` element's props, from its opening tag to its close.
 *
 * Located by `value={editorText}` rather than by the first `<CMEditor` in the
 * file: the module's own doc comments mention `<CMEditor>` in prose, and a scan
 * that took the first hit would slice a comment and assert nothing. */
function cmEditorProps(): string {
  const candidates = [...editorFlow.matchAll(/<CMEditor[\s\S]*?\/>/g)].map((m) => m[0]);
  const call = candidates.find((c) => c.includes("value={editorText}"));
  expect(
    call,
    "no <CMEditor value={editorText}> call site in EditorFlow, so nothing below checked anything",
  ).toBeDefined();
  return call!;
}

describe("EditorFlow threads editor_line_numbers into the shared editor", () => {
  it("passes the pref at the mobile call site", () => {
    const props = cmEditorProps();
    expect(props).toContain("lineNumbers={prefs.editor_line_numbers === true}");
  });

  it("reads that pref from the live prefs mirror, not from a literal", () => {
    // The prop expression is only a wiring claim if `prefs` is the live object.
    // `usePrefs()` is the mobile mirror, and it re-renders on the prefs nonce,
    // which is what makes the toggle take effect without a vault re-unlock.
    expect(editorFlow).toMatch(/const \{ prefs \} = usePrefs\(\)/);
  });

  it("compares against true, because the pref is nullable and the prop is not", () => {
    // The comparison is load-bearing rather than stylistic: the mirror's field
    // is `boolean | null` (unset is `null`) and the shared editor's prop is
    // `boolean` with a `false` default. A bare `prefs.editor_line_numbers`
    // would hand the editor `null` where it declares a boolean.
    expect(sharedEditor).toMatch(/lineNumbers\?: boolean/);
    expect(sharedEditor).toMatch(/lineNumbers = false/);
    expect(prefsMirror).toMatch(/editor_line_numbers: boolean \| null/);
  });
});
