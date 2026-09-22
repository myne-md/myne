// @vitest-environment jsdom
//
// Accessible names for the surfaces that had none (myne-md/myne#728, task 4).
//
// Three of the four rule ids in the E2E axe baseline were name failures, and
// they share a shape: a container carries a widget ROLE and nothing carries a
// NAME. Nothing in the tree reports that. It typechecks, it renders, it looks
// finished, and a screen-reader user meets "edit text" or "list box" with no
// indication of what they are standing in. In a split, where two editors are on
// screen at once, an unnamed editor is two indistinguishable ones.
//
// Three tiers here, because each catches something the others cannot:
//   1. the editor's name RULE, as a pure function (the untitled fallback is the
//      case that matters: `aria-label=""` is not a name);
//   2. the extension actually reaching `EditorView.contentAttributes`, and
//      surviving a live reconfigure (a rename must not keep announcing the old
//      title until the pane is rebuilt);
//   3. a source scan over every `role="listbox"` in the shared trees, because
//      the render tests can only reach the listboxes this file renders and the
//      NEXT unnamed one will be in a component nobody thought to render here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  editorAccessibleName,
  editorAccessibleNameExtension,
  reconfigureEditorTitle,
  readEditorTitle,
} from "@myne/editor/accessible-name";
import { QuickPicker } from "../../src/components/QuickPicker";
import i18n from "../../src/i18n";

afterEach(cleanup);

/**
 * `EditorView.contentAttributes` has no `combine`, so reading it gives the
 * INPUTS: one entry per contributing extension, either an attribute object or
 * a view-reading function. This is the one that names the content element.
 */
function contentAriaLabel(state: EditorState): string | undefined {
  for (const entry of state.facet(EditorView.contentAttributes)) {
    if (typeof entry === "object" && entry !== null && "aria-label" in entry) {
      return (entry as Record<string, string>)["aria-label"];
    }
  }
  return undefined;
}

describe("the editor body is named", () => {
  it("names itself after the note", () => {
    expect(editorAccessibleName("Roadmap")).toBe(
      i18n.t("editor.a11y.noteBody", { title: "Roadmap" }),
    );
    expect(editorAccessibleName("Roadmap")).toContain("Roadmap");
  });

  it("falls back to the untitled wording rather than to no name", () => {
    // An `aria-label=""` is treated as absent, which puts the surface back
    // exactly where it started.
    for (const empty of [null, "", "   "]) {
      const name = editorAccessibleName(empty);
      expect(name.trim().length, `title ${JSON.stringify(empty)}`).toBeGreaterThan(0);
      expect(name).toBe(i18n.t("editor.a11y.untitledNoteBody"));
    }
  });

  it("trims the title, so a padded one does not announce padded", () => {
    expect(editorAccessibleName("  Roadmap  ")).toBe(editorAccessibleName("Roadmap"));
  });

  it("puts the name on the content element's attributes", () => {
    const state = EditorState.create({
      extensions: [editorAccessibleNameExtension("Roadmap")],
    });
    expect(contentAriaLabel(state)).toBe(editorAccessibleName("Roadmap"));
    expect(readEditorTitle(state)).toBe("Roadmap");
  });

  it("names an untitled note when the host says nothing", () => {
    const state = EditorState.create({ extensions: [editorAccessibleNameExtension()] });
    expect(contentAriaLabel(state)).toBe(i18n.t("editor.a11y.untitledNoteBody"));
  });

  it("follows a rename without a remount", () => {
    // The pane is long-lived and notes (and titles) are swapped through it. A
    // name that only refreshed on a rebuild would announce the old title for
    // the rest of the session.
    const state = EditorState.create({
      extensions: [editorAccessibleNameExtension("Before")],
    });
    const next = state.update({ effects: reconfigureEditorTitle("After") }).state;
    expect(contentAriaLabel(next)).toBe(editorAccessibleName("After"));
    expect(readEditorTitle(next)).toBe("After");
  });
});

describe("the quick picker's listbox is named", () => {
  it("borrows the picker's subject, which is what the choices are", () => {
    render(
      <QuickPicker
        open
        title="Move to folder"
        placeholder="Search folders…"
        emptyText="No folders"
        items={[{ id: "a", label: "Archive" }]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("listbox", { name: "Move to folder" })).toBeTruthy();
  });
});

// ── The scan ──────────────────────────────────────────────────────────────
//
// Every `role="listbox"` in the shared client trees must carry a name on the
// SAME element. A render test can only reach what it renders; this reaches the
// one that has not been written yet. Comments are stripped first, because two
// primitives describe their own roles in prose and a scanner that reads prose
// is a scanner reporting on prose.

const SCANNED_ROOTS = ["src", "web/src", "mobile/src", "editor/src"] as const;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function tsxFilesUnder(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") tsxFilesUnder(full, out);
    } else if (full.endsWith(".tsx") || full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The opening tag containing the `role="listbox"` at `at`: back to the nearest
 * `<`, forward to the `>` that closes it. Brace depth is tracked forward so a
 * `>` inside a `{...}` expression (an arrow function in a handler) does not end
 * the tag early.
 */
function openingTagAround(source: string, at: number): string {
  const start = source.lastIndexOf("<", at);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

describe("no listbox in the shared trees is unnamed", () => {
  it("every role=listbox carries aria-label or aria-labelledby", () => {
    const unnamed: string[] = [];
    let examined = 0;
    for (const root of SCANNED_ROOTS) {
      for (const file of tsxFilesUnder(root)) {
        const source: string = stripComments(readFileSync(file, "utf8"));
        let at = source.indexOf('role="listbox"');
        while (at !== -1) {
          examined++;
          const tag = openingTagAround(source, at);
          if (!tag.includes("aria-label")) {
            unnamed.push(`${file}: ${tag.slice(0, 120).replace(/\s+/g, " ")}`);
          }
          at = source.indexOf('role="listbox"', at + 1);
        }
      }
    }
    // Non-vacuity floor: this found 9 declarations when it was written. A scan
    // that silently stops matching reports a clean tree.
    expect(examined, "the scan found no listbox at all").toBeGreaterThanOrEqual(7);
    expect(unnamed, unnamed.join("\n")).toEqual([]);
  });
});
