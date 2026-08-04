// @vitest-environment jsdom
//
// The chip → field-editor wiring (MYND-614 tasks 6 + 7).
//
// This file exists because of a gap that shipped: `task-chip.ts` dispatched
// `myne-open-task-chip` and `task-field-editor.ts` knew how to open, and
// **nothing connected them**. Both halves had thorough unit tests; neither test
// could see the missing wire, because each was testing its own half. The chips
// rendered and did nothing.
//
// So this reproduces the app's listener shape (`src/screens/Editor.tsx`) over a
// real editor and asserts the path end to end: click a chip, get an editor,
// commit, see the FILE change. The one property the unit suites structurally
// cannot cover is exactly the one that was broken.

import { describe, expect, it, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { parser } from "../../src/dialect/lezer/parser";
import { taskChipDecorations } from "@myne/editor/decorations/task-chip";
import { installTaskChipEditor } from "@myne/editor/decorations/task-chip-listener";

const DOC = "- [ ] pay the rent [due:: 2026-08-01] [priority:: high]\n";

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  document.querySelectorAll('[data-testid="editor.task-field-editor"]').forEach((n) => n.remove());
});

/**
 * The listener as the clients install it. This used to be a hand-kept "faithful
 * copy" of the shape buried inside `src/screens/Editor.tsx`, because that copy
 * could not be mounted here. The shape now lives in the shared editor package
 * (`installTaskChipEditor`), imported by BOTH desktop and mobile, so this test
 * exercises the **real** wire rather than a lookalike — and the gap it was
 * written to catch (a client that renders chips but installs no listener) is now
 * one line to get wrong instead of a whole duplicated block.
 */
function installChipListener(): () => void {
  return installTaskChipEditor();
}

function mount(doc = DOC): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: { parser } as never }), taskChipDecorations()],
    }),
  });
  cleanup.push(() => {
    view.destroy();
    host.remove();
  });
  return { view, host };
}

function chip(host: HTMLElement, kind: string): HTMLElement {
  const el = host.querySelector(`[data-testid="editor.task-chip-${kind}"]`);
  if (el === null) throw new Error(`no ${kind} chip rendered`);
  return el as HTMLElement;
}

function surface(): HTMLElement | null {
  return document.querySelector('[data-testid="editor.task-field-editor"]');
}

function fieldInput(): HTMLInputElement | HTMLSelectElement {
  return document.querySelector('[data-testid="editor.task-field-input"]')!;
}

describe("clicking a chip opens its editor", () => {
  it("opens for a due chip, prefilled with the SOURCE value", () => {
    cleanup.push(installChipListener());
    const { host } = mount();
    chip(host, "due").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(surface()).not.toBeNull();
    expect((fieldInput() as HTMLInputElement).value).toBe("2026-08-01");
  });

  it("opens for a priority chip with the five levels", () => {
    cleanup.push(installChipListener());
    const { host } = mount();
    chip(host, "priority").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    const el = fieldInput() as HTMLSelectElement;
    expect(el.tagName).toBe("SELECT");
    expect(el.value).toBe("high");
  });

  it("opens from the keyboard too — the chip is the only route in live mode", () => {
    cleanup.push(installChipListener());
    const { host } = mount();
    const el = chip(host, "due");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(surface()).not.toBeNull();
  });

  it("does nothing when no listener is installed — the gap this file exists for", () => {
    const { host } = mount();
    chip(host, "due").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    // This is what shipped: the event fires into nothing.
    expect(surface()).toBeNull();
  });
});

describe("committing reaches the document", () => {
  it("a committed date lands in the file", () => {
    cleanup.push(installChipListener());
    const { view, host } = mount();
    chip(host, "due").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    (fieldInput() as HTMLInputElement).value = "2026-09-09";
    (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();

    expect(view.state.doc.toString()).toContain("[due:: 2026-09-09]");
    // The untouched field survives the whole-line conversion.
    expect(view.state.doc.toString()).toContain("[priority:: high]");
  });

  it("Escape changes nothing", () => {
    cleanup.push(installChipListener());
    const { view, host } = mount();
    const before = view.state.doc.toString();
    chip(host, "due").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    (fieldInput() as HTMLInputElement).value = "2026-12-31";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(view.state.doc.toString()).toBe(before);
  });

  it("commits against the CURRENT span after an edit above shifted every offset", () => {
    // The stale-offset trap, and it corrupts rather than fails. The popover
    // stays open while the editor is live — a background autosave rewrites the
    // frontmatter stamp about a second after any edit — so the offsets captured
    // at click time no longer point at the field. Writing at them lands the new
    // value in whatever text has moved into that position; here, the heading.
    // The change-mapped StateField is what makes that unrepresentable.
    cleanup.push(installChipListener());
    const { view, host } = mount();
    chip(host, "due").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    view.dispatch({ changes: { from: 0, insert: "# A heading inserted above\n\n" } });

    (fieldInput() as HTMLInputElement).value = "2026-09-09";
    (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();

    const text = view.state.doc.toString();
    expect(text).toContain("# A heading inserted above");
    expect(text).toContain("[due:: 2026-09-09]");
    // Nothing was written into the heading — the failure a stale offset causes.
    expect(text.startsWith("# A heading inserted above\n\n- [ ] pay the rent")).toBe(true);
  });

  it("declines when the field was deleted while the popover was open", () => {
    // The span collapses under mapping, the tracker goes null, and the commit
    // writes nothing. Guessing a position would be the corrupting alternative.
    cleanup.push(installChipListener());
    const { view, host } = mount();
    chip(host, "due").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    // Delete the whole task line out from under the popover.
    const line = view.state.doc.line(1);
    view.dispatch({ changes: { from: line.from, to: line.to, insert: "gone" } });
    const after = view.state.doc.toString();

    (fieldInput() as HTMLInputElement).value = "2026-09-09";
    (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();

    expect(view.state.doc.toString()).toBe(after);
    expect(view.state.doc.toString()).not.toContain("2026-09-09");
  });
});

// ── myne#331: committing a due chip must not delete its time ────────────────
//
// The popover seeded `<input type="date">` with `value.slice(0, 10)` and
// committed exactly what that input held, so a chip carrying `2026-08-01 14:30`
// came back as `2026-08-01`. `applyTaskFieldEdit` re-typed it through
// `parseTaskInstant`, got `{date}` with no `time`, and the writer emitted a real
// edit because the line differed — so the wall-clock time the user wrote was
// deleted from the note and autosaved, with no warning. Chips never open on
// caret entry, so this popover is the ONLY way to touch the value.
describe("a due chip carrying a time (myne#331)", () => {
  it("round-trips the time through open \u2192 commit", () => {
    cleanup.push(installChipListener());
    const { view, host } = mount("- [ ] pay the rent [due:: 2026-08-01 14:30]\n");
    chip(host, "due").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(surface()).not.toBeNull();
    (
      document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement
    ).click();
    expect(view.state.doc.toString()).toContain("[due:: 2026-08-01 14:30]");
  });

  it("still writes a bare date when the chip carries no time", () => {
    cleanup.push(installChipListener());
    const { view, host } = mount("- [ ] pay the rent [due:: 2026-08-01]\n");
    chip(host, "due").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    (
      document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement
    ).click();
    expect(view.state.doc.toString()).toContain("[due:: 2026-08-01]");
    expect(view.state.doc.toString()).not.toMatch(/due:: 2026-08-01 \d/);
  });
});
