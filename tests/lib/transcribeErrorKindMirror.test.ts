// Drift lock for the hand-mirrored `TranscribeErrorKind` union (myne#510).
//
// `editor/src/host.ts` keeps its own copy of the union, and says why: `@myne/editor`
// may not import the desktop `src/` tree, because the shared editor package is
// compiled by the web and mobile clients too (the platform seam). The copy is
// legitimate. Nothing checked that it stayed in step, and `tsc` structurally
// cannot: the editor's `HINT_KEY` is typed over the EDITOR's union, so it is
// complete with respect to a union that is missing a member.
//
// What that cost, once: myne#510 added `"too_long"` to the desktop union, the
// desktop toast, and the Rust enum behind both, and left the editor's copy at five
// members. `editor/src/attachments/transcript.ts` casts the IPC rejection to its
// own union, so `"too_long"` passed the `!== "failed"` test, indexed a `HINT_KEY`
// with no such row, and called `i18n.t(undefined)`, an empty hint under the
// in-note audio player, on exactly the refusal that change existed to surface,
// with the whole tree green.
//
// The unions are PARSED FROM SOURCE rather than imported, because importing the
// editor's type into a desktop test would assert nothing at runtime (types erase)
// and importing the desktop's into the editor is the thing the seam forbids.
//
// `mobile/src/lib/transcribe.ts` declares a THIRD union and is deliberately out
// of scope. It is coarser on purpose (three arms, with `"not_ready"` where
// desktop distinguishes four causes), so equality would be the wrong assertion,
// and it cannot reach `HINT_KEY` today because mobile populates no
// `EditorHost.transcribe` slot. It is named here rather than left silent: if
// that slot is ever wired, `"not_ready"` reaches a hint table with no such row
// and renders the same empty string this file exists to stop.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DESKTOP = fileURLToPath(new URL("../../src/lib/transcribe.ts", import.meta.url));
const EDITOR = fileURLToPath(new URL("../../editor/src/host.ts", import.meta.url));

/** The string-literal members of `export type TranscribeErrorKind = …` in `file`. */
function unionMembers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const at = src.indexOf("export type TranscribeErrorKind =");
  if (at === -1) throw new Error(`no TranscribeErrorKind declaration in ${file}`);
  // Up to the terminating semicolon; doc comments between members are skipped by
  // the literal match itself.
  const decl = src.slice(at, src.indexOf(";", at));
  return [...decl.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
}

/** The causes `HINT_KEY` actually maps, parsed the way {@link unionMembers}
 *  parses a union rather than searched for as a substring. Comment lines are
 *  dropped first, so a commented-out row is absent rather than matching. */
function hintKeyCauses(): string[] {
  const src = readFileSync(
    fileURLToPath(new URL("../../editor/src/attachments/transcript.ts", import.meta.url)),
    "utf8",
  );
  const at = src.indexOf("const HINT_KEY");
  if (at === -1) throw new Error("no HINT_KEY declaration in transcript.ts");
  const block = src.slice(at, src.indexOf("};", at));
  const body = block
    .split("\n")
    .filter((l: string) => !l.trim().startsWith("//"))
    .join("\n");
  return [...body.matchAll(/^\s*([a-z_]+)\s*:\s*"/gm)].map((m) => m[1]).sort();
}

describe("TranscribeErrorKind mirror (myne#510)", () => {
  const desktop = unionMembers(DESKTOP);
  const editor = unionMembers(EDITOR);

  it("parses a non-trivial roster from each side", () => {
    // Guards the guard: a regex that matched nothing would make the comparison
    // below vacuously true, which is the shape this file exists to stop. The
    // floor is applied to BOTH sides; flooring only `desktop` left the editor's
    // parse able to return nothing and still satisfy the equality by dragging
    // desktop's down with it.
    expect(desktop.length).toBeGreaterThanOrEqual(5);
    expect(editor.length).toBeGreaterThanOrEqual(5);
    expect(desktop).toContain("failed");
    expect(editor).toContain("failed");
  });

  it("the editor's copy carries exactly the desktop union", () => {
    expect(
      editor,
      "`editor/src/host.ts::TranscribeErrorKind` has drifted from " +
        "`src/lib/transcribe.ts::TranscribeErrorKind`. tsc cannot see this: the editor's " +
        "HINT_KEY is typed over the editor's own union, so it stays complete while a cause " +
        "the backend really returns renders `i18n.t(undefined)` in the audio widget.",
    ).toEqual(desktop);
  });

  it("HINT_KEY carries exactly the actionable causes, no more and no less", () => {
    // The second half of the same failure: a member can be added to both unions
    // and still have no row in HINT_KEY. That IS caught by tsc today, and it is
    // asserted here anyway because the union is what this file reads and the two
    // are one edit apart.
    //
    // The KEYS are parsed and the sets compared BOTH ways. An earlier version
    // sliced the block's raw source and asserted `toContain("<cause>:")`, which
    // a commented-out row, a mention inside a `//` comment, or a row with an
    // empty value all satisfy, and which could never see a STALE row for a cause
    // the union has dropped. It read like a guard and checked less than it
    // appeared to, which is the shape this file's own header sets out to stop.
    expect(hintKeyCauses()).toEqual(desktop.filter((c) => c !== "failed"));
  });
});
