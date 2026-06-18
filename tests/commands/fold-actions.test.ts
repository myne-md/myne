// @vitest-environment jsdom
//
// fold-all / unfold-all command-palette actions (heading-list-folding /
// MYND-300, task 5, stories 4/5). The actions reach the FOCUSED editor view via
// `getActiveEditorView()` (the convertWikilinksAction pattern) and call the CM
// `foldAll` / `unfoldAll` commands — folding is ephemeral CM6 state, so no
// CommandContext callback is threaded through React.
//
// Here we mount a real EditorView with `activeViewExtension()` (which registers
// the view as active) + `myneFolding()`, then drive the registry actions and
// assert the fold state round-trips. The chord choice + reserved-chord
// non-collision is asserted on the metadata.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldedRanges, forceParsing, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { COMMAND_ACTIONS } from "../../src/commands";
import type { CommandAction, CommandContext } from "../../src/commands";
import { myneFolding } from "../../src/editor/folding";
import { activeViewExtension } from "../../src/editor/active-view";

function find(id: string): CommandAction {
  const a = COMMAND_ACTIONS.find((x) => x.id === id);
  if (a === undefined) throw new Error(`Action ${id} not found`);
  return a;
}

// Minimal context — the fold actions ignore it (they use getActiveEditorView()),
// but `run`/`visibility` take a CommandContext.
function ctx(over: Partial<CommandContext> = {}): CommandContext {
  return {
    stageName: "editor",
    selectedNoteId: null,
    onLock: vi.fn(async () => {}),
    onOpenSettings: vi.fn(),
    onManageTemplates: vi.fn(),
    onNewNoteFromTemplate: vi.fn(),
    onOpenTodayNote: vi.fn(),
    onOpenRandomNote: vi.fn(),
    onOpenAttachments: vi.fn(),
    onOpenSnapshots: vi.fn(),
    onExportNoteMarkdown: vi.fn(),
    onExportNotePdf: vi.fn(),
    onExportNoteHtml: vi.fn(),
    onExportNoteTxt: vi.fn(),
    onShowGraph: vi.fn(),
    onShowTags: vi.fn(),
    onShowViews: vi.fn(),
    onImportObsidian: vi.fn(),
    onImportBaseView: vi.fn(),
    onBackupVault: vi.fn(),
    onExportVaultMarkdown: vi.fn(),
    onToggleLeftSidebar: vi.fn(),
    onToggleRightSidebar: vi.fn(),
    onToggleStackedTabs: vi.fn(),
    onSelectNote: vi.fn(async () => {}),
    ...over,
  };
}

const DOC = ["# Alpha", "a body", "## Alpha One", "child", "# Beta", "b body"].join("\n");

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(): EditorView {
  host = document.createElement("div");
  document.body.appendChild(host);
  const v = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [markdown({ base: markdownLanguage }), myneFolding(), activeViewExtension()],
    }),
    parent: host,
  });
  forceParsing(v);
  syntaxTree(v.state);
  v.focus(); // registers as the active view
  view = v;
  return v;
}

function foldCount(v: EditorView): number {
  let n = 0;
  foldedRanges(v.state).between(0, v.state.doc.length, () => {
    n++;
  });
  return n;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

describe("fold-all / unfold-all actions", () => {
  it("the registry exposes both, editor-stage gated", () => {
    for (const id of ["editor.fold-all", "editor.unfold-all"]) {
      const a = find(id);
      expect(a.visibility(ctx({ stageName: "editor" }))).toBe("show");
      for (const stage of ["welcome", "create-vault", "unlock", "recover"] as const) {
        expect(a.visibility(ctx({ stageName: stage }))).toBe("hidden");
      }
    }
  });

  it('"Fold all" collapses every heading section in the active view', () => {
    const v = mount();
    expect(foldCount(v)).toBe(0);
    find("editor.fold-all").run(ctx());
    expect(foldCount(v)).toBeGreaterThan(0);
  });

  it('"Unfold all" expands everything in the active view', () => {
    const v = mount();
    find("editor.fold-all").run(ctx());
    expect(foldCount(v)).toBeGreaterThan(0);
    find("editor.unfold-all").run(ctx());
    expect(foldCount(v)).toBe(0);
  });

  it("both carry the Mod-Alt-[ / Mod-Alt-] chords, colliding with no reserved chord", () => {
    expect(find("editor.fold-all").defaultBinding).toBe("Mod-Alt-[");
    expect(find("editor.unfold-all").defaultBinding).toBe("Mod-Alt-]");
    const reserved = new Set([
      "Mod-1", "Mod-2", "Mod-3", "Mod-4", "Mod-5", "Mod-6",
      "Mod-k", "Mod-Shift-l", "Mod-Shift-h", "Mod-,",
    ]);
    expect(reserved.has(find("editor.fold-all").defaultBinding!)).toBe(false);
    expect(reserved.has(find("editor.unfold-all").defaultBinding!)).toBe(false);
  });

  it("run() is a safe no-op when there is no active view", () => {
    // No view mounted in this test → getActiveEditorView() is null.
    expect(() => find("editor.fold-all").run(ctx())).not.toThrow();
    expect(() => find("editor.unfold-all").run(ctx())).not.toThrow();
  });
});
