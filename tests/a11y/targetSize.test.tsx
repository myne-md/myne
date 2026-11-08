// @vitest-environment jsdom
//
// The 2.5.8 pointer-target floor (myne-md/myne#728, task 11).
//
// What this tier CAN check is the token and its adoption; what it cannot check
// is the rendered geometry, because jsdom has no layout. The real measurement
// is axe's `target-size` in the E2E tier, which task 17 turns on with the
// `wcag22aa` tag. So this spec holds the two things that would silently undo
// the fix between now and then: the token going missing from the canon, and a
// control going back to a hard-coded size.
//
// The floor is applied as a MINIMUM and with `flexShrink: 0` together. Both
// halves matter: a 24px minimum inside a cramped flex row is not a minimum at
// all if the row is allowed to squeeze it back under the floor, and that is
// the one way this can be adopted everywhere and still fail.

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { MIN_TARGET } from "../../src/components/primitives/targetSize";
import { IconButton } from "../../src/components/primitives/IconButton";

afterEach(cleanup);

/** Every `.ts`/`.tsx` under `roots`, recursively. */
function sourceFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full: string = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const root of roots) {
    if (existsSync(root)) walk(root);
  }
  return out;
}

function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the floor is a token, in the canon", () => {
  it("both token sheets declare --target-min: 24px, name-for-name", () => {
    // `client-core/src/tokens.css` is what ships; `agent-tooling/docs/design/colors_and_type.css`
    // is the canon copy the shipped sheet must agree with. A value in one and
    // not the other is exactly the drift `check-token-parity.mjs` exists for.
    for (const sheet of [
      "client-core/src/tokens.css",
      "agent-tooling/docs/design/colors_and_type.css",
    ]) {
      expect(readFileSync(sheet, "utf8"), sheet).toMatch(/--target-min:\s*24px;/);
    }
  });

  it("the shared style reads the token rather than restating 24", () => {
    expect(MIN_TARGET.minWidth).toBe("var(--target-min)");
    expect(MIN_TARGET.minHeight).toBe("var(--target-min)");
  });

  it("refuses to be squeezed back under the floor", () => {
    // Without this a 24px minimum inside a cramped flex row is not a minimum.
    expect(MIN_TARGET.flexShrink).toBe(0);
  });

  it("is a minimum, never a fixed size", () => {
    // A fixed size would grow controls that are already large enough and
    // re-lay out their neighbours around a new box.
    expect(MIN_TARGET).not.toHaveProperty("width");
    expect(MIN_TARGET).not.toHaveProperty("height");
  });
});

describe("the compact controls adopt it", () => {
  it("IconButton renders the token, not a pixel literal", () => {
    render(<IconButton icon="x" label="Close" onClick={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Close" });
    expect(button.style.minWidth).toBe("var(--target-min)");
    expect(button.style.minHeight).toBe("var(--target-min)");
    expect(button.style.width).toBe("");
  });

  it("every control raised in this pass spreads the shared style", () => {
    // Named rather than scanned: adoption is a judgement per control (a glyph
    // inside a button is not a target, and a keycap is display), so a sweep
    // would either miss the judgement or invent it.
    const RAISED = [
      "src/components/primitives/IconButton.tsx",
      "src/notes/components/NoteRow.tsx",
      "src/notes/components/TaskListPanel.tsx",
      "src/components/attachments/AttachmentsLibrary.tsx",
      "src/notes/components/ColorGroupEditor.tsx",
      "src/notes/components/TabStrip.tsx",
    ];
    // `ViewsSection.tsx` left this list when its compact controls moved onto the
    // primitives (`IconButton` carries `MIN_TARGET` itself; the row and the
    // search box are `Button`/`Input`), so the file no longer needs the token
    // spelled at its own call site.
    for (const path of RAISED) {
      expect(code(path), path).toContain("MIN_TARGET");
    }
  });

  it("the colour swatch keeps its 14px paint inside the bigger hit box", () => {
    // Growing the button itself would have turned a small dot into a large one
    // everywhere it appears, which is a redesign rather than a fix.
    const src = code("src/notes/components/ColorGroupEditor.tsx");
    expect(src).toContain("SWATCH_BUTTON_STYLE");
    expect(src).toMatch(/SWATCH_PAINT_STYLE[\s\S]{0,120}width: 14/);
  });

  it("has one definition, and it sits in the tree that consumes it", () => {
    // This replaced an assertion that the definition lived in the shared
    // editor host-lib behind a re-export shim. That arrangement was justified
    // by a second consumer - the task checkbox in `editor/` - which on
    // inspection imports nothing from here (it is sized in `task-row.css`),
    // so the indirection served nobody and the comment explaining it was
    // false. Both are gone.
    //
    // What replaces them is the CONDITION under which the move stays right,
    // checked rather than asserted: the moment a tree that cannot import from
    // `src/` needs the floor, this fails and says to move it back.
    expect(code("src/components/primitives/targetSize.ts")).toContain("minWidth");
    expect(existsSync("editor/src/host/lib/target-size.ts")).toBe(false);

    const outside = sourceFiles(["editor/src", "mobile/src", "client-core/src"]).filter(
      (file) => /\bMIN_TARGET\b/.test(code(file)),
    );
    expect(outside, `MIN_TARGET reached from outside src/: ${outside.join(", ")}`)
      .toHaveLength(0);
  });
});
