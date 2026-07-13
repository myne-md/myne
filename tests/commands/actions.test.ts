// Command-palette action registry tests — covers MYND-86 acceptance:
// "actions respect app state guards; palette never exposes actions
// unavailable in the current state."
//
// MYND-40 follow-up: the dedicated "Switch to note…" action + its note-picker
// sub-palette were removed when full-text note search moved INLINE into the
// palette (a NOTES section backed by the `note_search` IPC, tested in
// command-palette.test.tsx). The registry is now four actions; note selection
// is no longer an action. These tests track that shape.

import { describe, expect, it, vi } from "vitest";
import { COMMAND_ACTIONS } from "../../src/commands";
import type {
  AppStageName,
  CommandContext,
  CommandAction,
} from "../../src/commands";

function makeContext(over: Partial<CommandContext> = {}): CommandContext {
  return {
    stageName: "editor",
    selectedNoteId: null,
    aiEnabled: false,
    // Wave-1 toggle/cycle actions read ctx.prefs; the registry/visibility tests
    // never invoke their run(), so an empty stub is enough (defaults fill in).
    prefs: {} as CommandContext["prefs"],
    onOpenAiChat: vi.fn(),
    onSummarizeNote: vi.fn(),
    onSuggestTags: vi.fn(),
    onRewriteSelection: vi.fn(),
    onLock: vi.fn(async () => {}),
    onOpenSettings: vi.fn(),
    onManageTemplates: vi.fn(),
    onNewNoteFromTemplate: vi.fn(),
    onOpenTodayNote: vi.fn(),
    onOpenRandomNote: vi.fn(),
    onOpenAttachments: vi.fn(),
    onExportNoteMarkdown: vi.fn(),
    onExportNotePdf: vi.fn(),
    onExportNoteHtml: vi.fn(),
    onExportNoteTxt: vi.fn(),
    onImportObsidian: vi.fn(),
    onImportBaseView: vi.fn(),
    onExportVaultMarkdown: vi.fn(),
    onShowViews: vi.fn(),
    onToggleStackedTabs: vi.fn(),
    onToggleReading: vi.fn(),
    onToggleSource: vi.fn(),
    onToggleFocus: vi.fn(),
    onSaveWorkspaceAs: vi.fn(),
    onSwitchWorkspace: vi.fn(),
    onRenameWorkspace: vi.fn(),
    onDeleteWorkspace: vi.fn(),
    onSelectNote: vi.fn(async () => {}),
    ...over,
  };
}

function find(id: string): CommandAction {
  const a = COMMAND_ACTIONS.find((x) => x.id === id);
  if (a === undefined) throw new Error(`Action ${id} not found`);
  return a;
}

describe("Command palette action registry", () => {
  it("exposes exactly the v1 actions (note picking moved to inline search, MYND-40; templates.manage MYND-189; templates.new-note MYND-190; snapshots.open MYND-97; graph.show MYND-198; tags.show MYND-46; sidebar toggles MYND-166)", () => {
    expect([...COMMAND_ACTIONS].map((a) => a.id).sort()).toEqual([
      "ai.open-chat",
      "ai.rewrite-selection",
      "ai.suggest-tags",
      "ai.summarize-note",
      "ai.toggle-enabled",
      "app.open-settings",
      "app.toggle-screen-capture",
      "appearance.cycle-theme",
      "appearance.theme-amoled",
      "appearance.theme-dark",
      "appearance.theme-light",
      "appearance.theme-system",
      "appearance.toggle-timestamps",
      "attachments.open",
      "daily.open-today",
      "editor.cycle-content-width",
      "editor.cycle-default-view-mode",
      "editor.cycle-text-size",
      "editor.fold-all",
      "editor.toggle-dim-inactive",
      "editor.toggle-font",
      "editor.toggle-line-numbers",
      "editor.toggle-spell-check",
      "editor.toggle-typewriter",
      "editor.unfold-all",
      "graph.show",
      "note.export-html",
      "note.export-markdown",
      "note.export-pdf",
      "note.export-selection-image",
      "note.export-txt",
      "notes.random",
      "notes.toggle-archiving",
      "snapshots.open",
      "tags.show",
      "templates.manage",
      "templates.new-note",
      "vault.backup",
      "vault.export-markdown",
      "vault.import-obsidian",
      "vault.lock",
      "view.toggle-backlinks-sidebar",
      "view.toggle-focus",
      "view.toggle-notes-sidebar",
      "view.toggle-reading",
      "view.toggle-source",
      "view.toggle-stacked-tabs",
      "views.import-base",
      "views.show",
      "wikilinks.convert-in-this-note",
      "workspace.delete",
      "workspace.rename",
      "workspace.save-as",
      "workspace.switch",
    ]);
  });

  it("workspace.* commands are editor-only and dispatch to their callbacks (MYND-308)", () => {
    const cases = [
      { id: "workspace.save-as", cb: "onSaveWorkspaceAs" },
      { id: "workspace.switch", cb: "onSwitchWorkspace" },
      { id: "workspace.rename", cb: "onRenameWorkspace" },
      { id: "workspace.delete", cb: "onDeleteWorkspace" },
    ] as const;
    for (const { id, cb } of cases) {
      expect(find(id).visibility(makeContext({ stageName: "editor" }))).toBe("show");
      expect(find(id).visibility(makeContext({ stageName: "welcome" }))).toBe(
        "hidden",
      );
      const fn = vi.fn();
      void find(id).run(makeContext({ [cb]: fn }));
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  it("views.import-base is editor-only and dispatches to onImportBaseView (MYND-276 #6)", () => {
    expect(
      find("views.import-base").visibility(makeContext({ stageName: "editor" })),
    ).toBe("show");
    expect(
      find("views.import-base").visibility(makeContext({ stageName: "welcome" })),
    ).toBe("hidden");
    const onImportBaseView = vi.fn();
    void find("views.import-base").run(makeContext({ onImportBaseView }));
    expect(onImportBaseView).toHaveBeenCalledTimes(1);
  });

  it("ai.open-chat gates on editor stage + ai_enabled; DISABLED (not hidden) when AI is off (SYNC-9)", () => {
    const action = find("ai.open-chat");
    expect(
      action.visibility(makeContext({ stageName: "editor", aiEnabled: true })),
    ).toBe("show");
    // AI off in the editor → disabled, NOT hidden (disabled-control discipline:
    // the feature stays discoverable, a toggle away).
    expect(
      action.visibility(makeContext({ stageName: "editor", aiEnabled: false })),
    ).toBe("disabled");
    // Outside the editor stage → hidden regardless of the toggle.
    expect(
      action.visibility(makeContext({ stageName: "welcome", aiEnabled: true })),
    ).toBe("hidden");
    const onOpenAiChat = vi.fn();
    void action.run(makeContext({ onOpenAiChat }));
    expect(onOpenAiChat).toHaveBeenCalledTimes(1);
  });

  it("ai.summarize-note needs editor + a selected note + ai_enabled; disabled when off, hidden without a note (SYNC-9/14)", () => {
    const action = find("ai.summarize-note");
    const note = "n1" as CommandContext["selectedNoteId"];
    expect(
      action.visibility(makeContext({ stageName: "editor", selectedNoteId: note, aiEnabled: true })),
    ).toBe("show");
    // Note selected but AI off → disabled (discoverable).
    expect(
      action.visibility(makeContext({ stageName: "editor", selectedNoteId: note, aiEnabled: false })),
    ).toBe("disabled");
    // AI on but no note → hidden (nothing to summarize).
    expect(
      action.visibility(makeContext({ stageName: "editor", selectedNoteId: null, aiEnabled: true })),
    ).toBe("hidden");
    // Outside the editor → hidden.
    expect(
      action.visibility(makeContext({ stageName: "welcome", selectedNoteId: note, aiEnabled: true })),
    ).toBe("hidden");
    const onSummarizeNote = vi.fn();
    void action.run(makeContext({ onSummarizeNote }));
    expect(onSummarizeNote).toHaveBeenCalledTimes(1);
  });

  it("ai.suggest-tags needs editor + a selected note + ai_enabled; disabled when off, hidden without a note (SYNC-9/14)", () => {
    const action = find("ai.suggest-tags");
    const note = "n1" as CommandContext["selectedNoteId"];
    expect(
      action.visibility(makeContext({ stageName: "editor", selectedNoteId: note, aiEnabled: true })),
    ).toBe("show");
    expect(
      action.visibility(makeContext({ stageName: "editor", selectedNoteId: note, aiEnabled: false })),
    ).toBe("disabled");
    expect(
      action.visibility(makeContext({ stageName: "editor", selectedNoteId: null, aiEnabled: true })),
    ).toBe("hidden");
    expect(
      action.visibility(makeContext({ stageName: "welcome", selectedNoteId: note, aiEnabled: true })),
    ).toBe("hidden");
    const onSuggestTags = vi.fn();
    void action.run(makeContext({ onSuggestTags }));
    expect(onSuggestTags).toHaveBeenCalledTimes(1);
  });

  it("ai.rewrite-selection needs editor + a selected note + ai_enabled; disabled when off, hidden without a note", () => {
    const action = find("ai.rewrite-selection");
    const note = "n1" as CommandContext["selectedNoteId"];
    expect(
      action.visibility(makeContext({ stageName: "editor", selectedNoteId: note, aiEnabled: true })),
    ).toBe("show");
    expect(
      action.visibility(makeContext({ stageName: "editor", selectedNoteId: note, aiEnabled: false })),
    ).toBe("disabled");
    expect(
      action.visibility(makeContext({ stageName: "editor", selectedNoteId: null, aiEnabled: true })),
    ).toBe("hidden");
    const onRewriteSelection = vi.fn();
    void action.run(makeContext({ onRewriteSelection }));
    expect(onRewriteSelection).toHaveBeenCalledTimes(1);
  });

  it("views.show is editor-only and dispatches to onShowViews (MYND-274)", () => {
    expect(find("views.show").visibility(makeContext({ stageName: "editor" }))).toBe(
      "show",
    );
    expect(
      find("views.show").visibility(makeContext({ stageName: "welcome" })),
    ).toBe("hidden");
    const onShowViews = vi.fn();
    void find("views.show").run(makeContext({ onShowViews }));
    expect(onShowViews).toHaveBeenCalledTimes(1);
  });
});

describe("Command palette action visibility per Stage", () => {
  const editorStages: AppStageName[] = ["editor"];
  const nonEditorStages: AppStageName[] = [
    "welcome",
    "create-vault",
    "unlock",
    "recover",
  ];

  for (const stage of nonEditorStages) {
    it(`"Lock vault" is HIDDEN when stage = ${stage}`, () => {
      const ctx = makeContext({ stageName: stage });
      expect(find("vault.lock").visibility(ctx)).toBe("hidden");
    });
    it(`"Open settings…" is HIDDEN when stage = ${stage}`, () => {
      const ctx = makeContext({ stageName: stage });
      expect(find("app.open-settings").visibility(ctx)).toBe("hidden");
    });
    it(`"Convert wikilinks…" is HIDDEN when stage = ${stage}`, () => {
      const ctx = makeContext({
        stageName: stage,
        selectedNoteId: "note-1",
      });
      expect(find("wikilinks.convert-in-this-note").visibility(ctx)).toBe(
        "hidden",
      );
    });
  }

  for (const stage of editorStages) {
    it(`"Lock vault" is SHOWN when stage = ${stage}`, () => {
      const ctx = makeContext({ stageName: stage });
      expect(find("vault.lock").visibility(ctx)).toBe("show");
    });
    it(`"Open settings…" is SHOWN when stage = ${stage}`, () => {
      const ctx = makeContext({ stageName: stage });
      expect(find("app.open-settings").visibility(ctx)).toBe("show");
    });
  }

  // "Export note as Markdown…" visibility matrix (MYND-116 task 2): per-note
  // like snapshots.open — editor stage AND a selected note, else hidden.
  it("\"Export note as Markdown…\" is HIDDEN outside the editor stage (even with a note selected)", () => {
    for (const stage of nonEditorStages) {
      const ctx = makeContext({ stageName: stage, selectedNoteId: "note-1" });
      expect(find("note.export-markdown").visibility(ctx)).toBe("hidden");
    }
  });

  it("\"Export note as Markdown…\" is HIDDEN in the editor when no note is open", () => {
    const ctx = makeContext({ stageName: "editor", selectedNoteId: null });
    expect(find("note.export-markdown").visibility(ctx)).toBe("hidden");
  });

  it("\"Export note as Markdown…\" is SHOWN in the editor with a note open", () => {
    const ctx = makeContext({ stageName: "editor", selectedNoteId: "note-1" });
    expect(find("note.export-markdown").visibility(ctx)).toBe("show");
  });

  // "Export note as PDF…" mirrors the markdown action's visibility matrix
  // exactly (MYND-255, SYNC-5): per-note like snapshots.open — editor stage
  // AND a selected note, else hidden.
  it("\"Export note as PDF…\" is HIDDEN outside the editor stage (even with a note selected)", () => {
    for (const stage of nonEditorStages) {
      const ctx = makeContext({ stageName: stage, selectedNoteId: "note-1" });
      expect(find("note.export-pdf").visibility(ctx)).toBe("hidden");
    }
  });

  it("\"Export note as PDF…\" is HIDDEN in the editor when no note is open", () => {
    const ctx = makeContext({ stageName: "editor", selectedNoteId: null });
    expect(find("note.export-pdf").visibility(ctx)).toBe("hidden");
  });

  it("\"Export note as PDF…\" is SHOWN in the editor with a note open", () => {
    const ctx = makeContext({ stageName: "editor", selectedNoteId: "note-1" });
    expect(find("note.export-pdf").visibility(ctx)).toBe("show");
  });

  it("\"Export note as PDF…\" visibility matches \"Export note as Markdown…\" in every probed context (sibling rule)", () => {
    const contexts = [
      makeContext({ stageName: "editor", selectedNoteId: "note-1" }),
      makeContext({ stageName: "editor", selectedNoteId: null }),
      ...nonEditorStages.map((stage) =>
        makeContext({ stageName: stage, selectedNoteId: "note-1" }),
      ),
    ];
    for (const ctx of contexts) {
      expect(find("note.export-pdf").visibility(ctx)).toBe(
        find("note.export-markdown").visibility(ctx),
      );
    }
  });

  it("\"Convert wikilinks…\" is HIDDEN when no note selected", () => {
    const ctx = makeContext({
      stageName: "editor",
      selectedNoteId: null,
    });
    expect(find("wikilinks.convert-in-this-note").visibility(ctx)).toBe(
      "hidden",
    );
  });

  it("\"Convert imported wikilinks…\" is SHOWN when a note is selected (live, MYND-84)", () => {
    const ctx = makeContext({
      stageName: "editor",
      selectedNoteId: "note-1",
    });
    expect(find("wikilinks.convert-in-this-note").visibility(ctx)).toBe(
      "show",
    );
  });

  it("\"Export vault as Markdown…\" is SHOWN in editor + HIDDEN elsewhere (vault-level — no note needed, MYND-211)", () => {
    for (const stage of editorStages) {
      expect(
        find("vault.export-markdown").visibility(
          makeContext({ stageName: stage, selectedNoteId: null }),
        ),
      ).toBe("show");
    }
    for (const stage of nonEditorStages) {
      expect(
        find("vault.export-markdown").visibility(makeContext({ stageName: stage })),
      ).toBe("hidden");
    }
  });

  it("\"Import Obsidian vault…\" is SHOWN in editor + HIDDEN elsewhere (MYND-53 backend + UI landed)", () => {
    for (const stage of editorStages) {
      expect(find("vault.import-obsidian").visibility(makeContext({ stageName: stage }))).toBe(
        "show",
      );
    }
    for (const stage of nonEditorStages) {
      expect(find("vault.import-obsidian").visibility(makeContext({ stageName: stage }))).toBe(
        "hidden",
      );
    }
  });
});

describe("Command palette action run() side effects", () => {
  it("\"Lock vault\" calls onLock", async () => {
    const onLock = vi.fn(async () => {});
    const ctx = makeContext({ onLock });
    await find("vault.lock").run(ctx);
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it("\"Open settings…\" calls onOpenSettings synchronously", () => {
    const onOpenSettings = vi.fn();
    const ctx = makeContext({ onOpenSettings });
    const result = find("app.open-settings").run(ctx);
    expect(result).toBeUndefined();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("\"Open attachments…\" is SHOWN in editor + HIDDEN elsewhere, and calls onOpenAttachments", () => {
    const onOpenAttachments = vi.fn();
    const action = find("attachments.open");
    expect(action.visibility(makeContext({ stageName: "editor" }))).toBe("show");
    expect(action.visibility(makeContext({ stageName: "welcome" }))).toBe(
      "hidden",
    );
    action.run(makeContext({ onOpenAttachments }));
    expect(onOpenAttachments).toHaveBeenCalledTimes(1);
  });

  it("\"Open random note\" is SHOWN in editor + HIDDEN elsewhere, and calls onOpenRandomNote (MYND-323)", () => {
    const onOpenRandomNote = vi.fn();
    const action = find("notes.random");
    expect(action.visibility(makeContext({ stageName: "editor" }))).toBe("show");
    for (const stage of ["welcome", "create-vault", "unlock", "recover"] as const) {
      expect(action.visibility(makeContext({ stageName: stage }))).toBe(
        "hidden",
      );
    }
    action.run(makeContext({ onOpenRandomNote }));
    expect(onOpenRandomNote).toHaveBeenCalledTimes(1);
  });

  it("\"Export note as Markdown…\" calls onExportNoteMarkdown — the shared-flow callback (MYND-116)", () => {
    const onExportNoteMarkdown = vi.fn();
    find("note.export-markdown").run(makeContext({ onExportNoteMarkdown }));
    expect(onExportNoteMarkdown).toHaveBeenCalledTimes(1);
  });

  it("\"Export note as PDF…\" calls onExportNotePdf — the shared-flow callback (MYND-255)", () => {
    const onExportNotePdf = vi.fn();
    find("note.export-pdf").run(makeContext({ onExportNotePdf }));
    expect(onExportNotePdf).toHaveBeenCalledTimes(1);
  });

  it("\"Export note as HTML…\" calls onExportNoteHtml — the shared-flow callback (MYND-340)", () => {
    const onExportNoteHtml = vi.fn();
    find("note.export-html").run(makeContext({ onExportNoteHtml }));
    expect(onExportNoteHtml).toHaveBeenCalledTimes(1);
  });

  it("\"Export note as Plain Text…\" calls onExportNoteTxt — the shared-flow callback (MYND-340)", () => {
    const onExportNoteTxt = vi.fn();
    find("note.export-txt").run(makeContext({ onExportNoteTxt }));
    expect(onExportNoteTxt).toHaveBeenCalledTimes(1);
  });

  it("note.export-html / note.export-txt are editor-only AND note-selected (MYND-340)", () => {
    const noSel = makeContext({ stageName: "editor", selectedNoteId: null });
    expect(find("note.export-html").visibility(noSel)).toBe("hidden");
    expect(find("note.export-txt").visibility(noSel)).toBe("hidden");
    const sel = makeContext({ stageName: "editor", selectedNoteId: "note-1" });
    expect(find("note.export-html").visibility(sel)).toBe("show");
    expect(find("note.export-txt").visibility(sel)).toBe("show");
    const welcome = makeContext({ stageName: "welcome", selectedNoteId: "note-1" });
    expect(find("note.export-html").visibility(welcome)).toBe("hidden");
    expect(find("note.export-txt").visibility(welcome)).toBe("hidden");
  });

  it("\"Export vault as Markdown…\" calls onExportVaultMarkdown — the same modal as the Settings Export block (MYND-211)", () => {
    const onExportVaultMarkdown = vi.fn();
    find("vault.export-markdown").run(makeContext({ onExportVaultMarkdown }));
    expect(onExportVaultMarkdown).toHaveBeenCalledTimes(1);
  });

  it("\"Import Obsidian vault…\" calls onImportObsidian (MYND-53)", () => {
    const onImportObsidian = vi.fn();
    find("vault.import-obsidian").run(makeContext({ onImportObsidian }));
    expect(onImportObsidian).toHaveBeenCalledTimes(1);
  });

  it("Disabled stubs are no-ops when run directly (defensive — palette UI guards them)", async () => {
    const ctx = makeContext({
      stageName: "editor",
      selectedNoteId: "note-1",
    });
    const convertAction = find("wikilinks.convert-in-this-note");
    expect(await convertAction.run(ctx)).toBeUndefined();
  });
});
