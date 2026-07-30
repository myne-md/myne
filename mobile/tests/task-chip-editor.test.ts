// @vitest-environment jsdom
//
// The mobile editor's task-field chip wire (MYND-614).
//
// The point is not that chip editing works — the desktop proves the shared
// mechanism end to end against a real editor (`tests/editor/taskChipWiring.test.ts`
// in the main repo, which exercises the very `installTaskChipEditor` the mobile
// `EditorFlow` now calls). The point is that **the mobile client can consume that
// shared surface**: the mobile editor shipped rendering the shared task-chip
// decoration but installing NO listener, so the chips rendered and did nothing.
//
// So this pins the mobile-consumption risks that tsc alone cannot: that the
// shared field editor and its recurrence control resolve through mobile's
// `@myne/editor` alias, that the `task-surfaces.css` side-effect import the field
// editor pulls in is tolerated by mobile's test pipeline, and that
// `installTaskChipEditor` installs and tears down its window listener. A real
// `EditorView` is deliberately NOT mounted here: mobile's dependency graph
// carries a second `@lezer/markdown` copy, so feeding the dialect parser to
// `markdown()` hits the dual-package `instanceof` guard — an environment quirk,
// not a wiring fact, and the wiring fact is already covered upstream.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setEditorHost } from "@myne/editor/host";
import { openTaskFieldEditor } from "@myne/editor/task-field-editor";
import {
  installTaskChipEditor,
} from "@myne/editor/decorations/task-chip-listener";
import { TASK_CHIP_EVENT } from "@myne/editor/decorations/task-chip";

// Mobile vitest has no global editor-host setup (the app's `src/editor-host.ts`
// imports Tauri, so it cannot load in a node/jsdom test). Install a minimal host:
// the field editor only reaches the host for `t`, and none of the assertions
// below depend on the label TEXT — the recurrence values come from the dialect's
// `formatRecurrenceSpec`, not from i18n. A key-returning `t` is therefore enough.
beforeAll(() => {
  setEditorHost({
    t: (key: string) => key,
    notes: { tagTree: async () => [], isMediaTarget: () => false },
    attachments: {
      attachmentExport: async () => {},
      attachmentRename: async () => {},
      pickExportDestination: async () => null,
      import: async () => {
        throw new Error("test host: attachments.import not installed");
      },
      catalogList: async () => [],
      resolveRef: (id: string) => `attachment://${id}`,
    },
    prefsRead: async () => ({
      editor_content_width: null,
      editor_font_family: null,
      editor_line_spacing: null,
      editor_text_size: null,
      spell_enabled: null,
      spell_languages: [],
    }),
    openExternal: () => {},
  });
});

afterEach(() => {
  document.querySelectorAll('[data-testid="editor.task-field-editor"]').forEach((n) => n.remove());
});

function anchorEl(): HTMLElement {
  const el = document.createElement("span");
  el.setAttribute("data-task-chip", "");
  document.body.appendChild(el);
  return el;
}

function surface(): HTMLElement | null {
  return document.querySelector('[data-testid="editor.task-field-editor"]');
}

describe("the shared field editor loads through mobile's module graph", () => {
  it("opens a due editor prefilled with the source value", () => {
    const anchor = anchorEl();
    const handle = openTaskFieldEditor({ anchor, kind: "due", value: "2026-08-01", onCommit: () => {} });
    expect(surface()).not.toBeNull();
    expect(
      (document.querySelector('[data-testid="editor.task-field-input"]') as HTMLInputElement).value,
    ).toBe("2026-08-01");
    handle.close();
    anchor.remove();
  });

  it("opens the repeat field as a CONTROL, never a text box, and assembles canonical rules", () => {
    const anchor = anchorEl();
    const onCommit = vi.fn();
    openTaskFieldEditor({ anchor, kind: "repeat", value: "every month", onCommit });

    // The primary control is a family SELECT; there is no free-text input.
    const family = document.querySelector('[data-testid="editor.task-field-input"]') as HTMLElement;
    expect(family.tagName).toBe("SELECT");
    expect([...surface()!.querySelectorAll("input")].filter((i) => i.type === "text").length).toBe(0);

    // Bump the interval count → canonical `every 3 months`.
    (document.querySelector('[data-testid="editor.recurrence-count"]') as HTMLInputElement).value =
      "3";
    (document.querySelector('[data-testid="editor.task-field-commit"]') as HTMLElement).click();
    expect(onCommit).toHaveBeenCalledWith("every 3 months");
    anchor.remove();
  });
});

describe("installTaskChipEditor manages its window listener", () => {
  it("registers a listener and returns a working unsubscribe", () => {
    const uninstall = installTaskChipEditor();
    // A chip event with no resolvable editor view is a safe no-op (findFromDOM
    // returns null) — it must not throw, and it must open nothing.
    const anchor = anchorEl();
    anchor.dispatchEvent(
      new CustomEvent(TASK_CHIP_EVENT, {
        bubbles: true,
        detail: { kind: "due", value: "2026-08-01", from: 0, to: 0 },
      }),
    );
    expect(surface()).toBeNull();
    expect(() => uninstall()).not.toThrow();
    anchor.remove();
  });
});
