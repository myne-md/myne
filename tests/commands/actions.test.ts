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
import { sidebarCommands } from "../../src/notes/sidebarCommands";

function makeContext(over: Partial<CommandContext> = {}): CommandContext {
  return {
    stageName: "editor",
    selectedNoteId: null,
    aiEnabled: false,
    // Wave-1 toggle/cycle actions read ctx.prefs; the registry/visibility tests
    // never invoke their run(), so an empty stub is enough (defaults fill in).
    // `developer_mode: true` by default so the pre-existing ai.* visibility
    // tests below keep exercising the aiEnabled-driven show/disabled behavior
    // they were written for; the developer-mode-off tests override it
    // explicitly (developer-mode feature, MYND-593).
    prefs: { developer_mode: true } as CommandContext["prefs"],
    onOpenAiChat: vi.fn(),
    onSummarizeNote: vi.fn(),
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
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onClosePane: vi.fn(),
    onCloseTab: vi.fn(),
    onNextTab: vi.fn(),
    onPrevTab: vi.fn(),
    onFocusNextPane: vi.fn(),
    onFocusPrevPane: vi.fn(),
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onTogglePreview: vi.fn(),
    onNewNote: vi.fn(),
    onDuplicateNote: vi.fn(),
    onArchiveNote: vi.fn(),
    onRenameNote: vi.fn(),
    onTrashNote: vi.fn(),
    onEmptyTrash: vi.fn(),
    onToggleFavorite: vi.fn(),
    onShowBacklinks: vi.fn(),
    onShowOutline: vi.fn(),
    onShowUnlinked: vi.fn(),
    onRestoreBackup: vi.fn(),
    onMoveNote: vi.fn(),
    onSetNoteCover: vi.fn(),
    onRemoveNoteCover: vi.fn(),
    onApplyCustomTheme: vi.fn(),
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
  it("exposes exactly the v1 actions (note picking moved to inline search, MYND-40; templates.manage MYND-189; templates.new-note MYND-190; snapshots.open MYND-97; graph.show MYND-198; graph.show-isolated myne-md/myne#727; tags.show MYND-46; tasks.show MYND-616; sidebar toggles MYND-166)", () => {
    expect([...COMMAND_ACTIONS].map((a) => a.id).sort()).toEqual([
      "ai.open-agent-note",
      "ai.open-agent-vault",
      "ai.open-chat",
      "ai.rewrite-selection",
      "ai.summarize-note",
      "ai.toggle-enabled",
      "app.open-settings",
      "app.toggle-screen-capture",
      "appearance.apply-custom-theme",
      "appearance.cycle-theme",
      "appearance.theme-amoled",
      "appearance.theme-dark",
      "appearance.theme-light",
      "appearance.theme-system",
      "appearance.toggle-timestamps",
      "archive.open",
      "attachments.attach-file",
      "attachments.convert-imported",
      "attachments.open",
      "daily.open-today",
      "editor.cycle-content-width",
      "editor.cycle-default-view-mode",
      "editor.cycle-heading",
      "editor.cycle-text-size",
      "editor.find",
      "editor.find-replace",
      "editor.fold-all",
      "editor.toggle-dim-inactive",
      "editor.toggle-font",
      "editor.toggle-line-numbers",
      "editor.toggle-spell-check",
      "editor.toggle-typewriter",
      "editor.toggle-vim-mode",
      "editor.unfold-all",
      // The three-region keyboard model (myne#728): the editor body's keyboard
      // exit, plus a direct command per region.
      "focus.cycle-region",
      "focus.editor",
      "focus.right-panel",
      "focus.sidebar",
      "folder.new",
      "graph.show",
      "graph.show-isolated",
      "meeting.summarize",
      "nav.back",
      "nav.forward",
      "note.archive",
      "note.duplicate",
      "note.export-html",
      "note.export-markdown",
      "note.export-pdf",
      "note.export-selection-image",
      "note.export-txt",
      "note.move",
      "note.new",
      // myne-md/myne#678 (epic #173): pop the active note out into its own
      // OS window. Desktop-only (gated on the `detachedWindows` capability).
      "note.open-in-new-window",
      "note.remove-cover",
      "note.rename",
      "note.set-cover",
      "note.toggle-favorite",
      "note.trash",
      "notes.random",
      "notes.toggle-archiving",
      // myne-md/myne#773: the palette's own entry. It had none — `palette.toggle`
      // was a keybinding only, and the left rail derives its roster from actions
      // carrying a `ribbon` block, so the palette could not be pinned to it.
      "palette.open",
      "pane.close",
      "pane.focus-next",
      "pane.focus-prev",
      "pane.split-down",
      "pane.split-right",
      // myne#177: the weekly and monthly siblings of daily.open-today.
      "periodic.open-this-month",
      "periodic.open-this-week",
      "snapshots.open",
      "tab.close",
      "tab.next",
      "tab.prev",
      "tags.show",
      "tasks.show",
      "templates.manage",
      "templates.new-note",
      "trash.empty",
      "trash.open",
      "vault.backup",
      "vault.export-markdown",
      "vault.import-obsidian",
      "vault.lock",
      "vault.restore",
      "vault.reveal-folder",
      "view.show-backlinks",
      "view.show-outline",
      "view.show-unlinked",
      "view.toggle-backlinks-sidebar",
      "view.toggle-focus",
      "view.toggle-notes-sidebar",
      "view.toggle-preview",
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

  it("ai.open-chat is HIDDEN (not disabled) while Developer mode is off, even with AI enabled (MYND-593)", () => {
    // Developer mode off means the AI panel isn't reachable in Settings at
    // all — a keyboard shortcut must not offer a door onto it either.
    const action = find("ai.open-chat");
    expect(
      action.visibility(
        makeContext({
          stageName: "editor",
          aiEnabled: true,
          prefs: { developer_mode: false } as CommandContext["prefs"],
        }),
      ),
    ).toBe("hidden");
    expect(
      action.visibility(
        makeContext({
          stageName: "editor",
          aiEnabled: false,
          prefs: { developer_mode: false } as CommandContext["prefs"],
        }),
      ),
    ).toBe("hidden");
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

  it("ai.summarize-note is HIDDEN while Developer mode is off, even with AI enabled + a note selected (MYND-593)", () => {
    const action = find("ai.summarize-note");
    const note = "n1" as CommandContext["selectedNoteId"];
    expect(
      action.visibility(
        makeContext({
          stageName: "editor",
          selectedNoteId: note,
          aiEnabled: true,
          prefs: { developer_mode: false } as CommandContext["prefs"],
        }),
      ),
    ).toBe("hidden");
  });

  it("registers NO ai.suggest-tags action — the inline band is the only tag surface (MYND-651)", () => {
    expect(COMMAND_ACTIONS.some((a) => a.id === "ai.suggest-tags")).toBe(false);
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

  it("ai.rewrite-selection is HIDDEN while Developer mode is off, even with AI enabled + a note selected (MYND-593)", () => {
    const action = find("ai.rewrite-selection");
    const note = "n1" as CommandContext["selectedNoteId"];
    expect(
      action.visibility(
        makeContext({
          stageName: "editor",
          selectedNoteId: note,
          aiEnabled: true,
          prefs: { developer_mode: false } as CommandContext["prefs"],
        }),
      ),
    ).toBe("hidden");
  });

  it("ai.toggle-enabled requires editor stage + Developer mode; hidden otherwise (MYND-593)", () => {
    const action = find("ai.toggle-enabled");
    expect(action.visibility(makeContext({ stageName: "editor" }))).toBe("show");
    expect(
      action.visibility(
        makeContext({
          stageName: "editor",
          prefs: { developer_mode: false } as CommandContext["prefs"],
        }),
      ),
    ).toBe("hidden");
    expect(
      action.visibility(
        makeContext({
          stageName: "welcome",
          prefs: { developer_mode: true } as CommandContext["prefs"],
        }),
      ),
    ).toBe("hidden");
  });

  it("editor.toggle-vim-mode requires editor stage + Developer mode; hidden otherwise (#181)", () => {
    // Settings hides the vim toggle while the mode is off; leaving the palette
    // entry reachable would let a keystroke flip a setting the UI no longer
    // offers — the same hole the AI actions above are gated to close.
    const action = find("editor.toggle-vim-mode");
    expect(action.visibility(makeContext({ stageName: "editor" }))).toBe("show");
    expect(
      action.visibility(
        makeContext({
          stageName: "editor",
          prefs: { developer_mode: false } as CommandContext["prefs"],
        }),
      ),
    ).toBe("hidden");
    expect(
      action.visibility(
        makeContext({
          stageName: "welcome",
          prefs: { developer_mode: true } as CommandContext["prefs"],
        }),
      ),
    ).toBe("hidden");
  });

  it("views.show is editor-only and dispatches to onShowViews (MYND-274)", () => {
    // Also behind the Views feature toggle since myne-md/myne#762, and the
    // toggle's back-compat default is "on when the vault already has views", so
    // a vault WITH a saved view is the `show` case. This file runs on the node
    // environment, where `readViewsEnabledPref` catches the missing
    // localStorage and answers `null` — exactly the untouched-pref state.
    expect(
      find("views.show").visibility(
        makeContext({
          stageName: "editor",
          prefs: {
            saved_views: [{ id: "v1", name: "V", view_type: "cards", filters: { kind: "all" } }],
          } as CommandContext["prefs"],
        }),
      ),
    ).toBe("show");
    expect(
      find("views.show").visibility(makeContext({ stageName: "welcome" })),
    ).toBe("hidden");
    // Views off (no saved views, pref untouched) → no entry point on the rail.
    expect(
      find("views.show").visibility(makeContext({ stageName: "editor" })),
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

  // note.archive mirrors the sidebar context menu's gate: the archive entries
  // are omitted while the archive feature is disabled (`archive_disabled`).
  it("\"Archive note\" is HIDDEN when the archive-disabled pref is on", () => {
    const base = { stageName: "editor" as const, selectedNoteId: "note-1" };
    expect(
      find("note.archive").visibility(
        makeContext({
          ...base,
          prefs: { archive_disabled: true } as CommandContext["prefs"],
        }),
      ),
    ).toBe("hidden");
    expect(
      find("note.archive").visibility(
        makeContext({
          ...base,
          prefs: { archive_disabled: false } as CommandContext["prefs"],
        }),
      ),
    ).toBe("show");
    // Unset pref (fresh vault) defaults to archive-enabled.
    expect(find("note.archive").visibility(makeContext(base))).toBe("show");
    // Still per-note: no selection → hidden regardless of the pref.
    expect(
      find("note.archive").visibility(
        makeContext({ stageName: "editor", selectedNoteId: null }),
      ),
    ).toBe("hidden");
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

  it("\"Set note cover…\" calls onSetNoteCover, and is the feature's only keyboard door (myne-md/myne#410)", () => {
    const onSetNoteCover = vi.fn();
    find("note.set-cover").run(makeContext({ onSetNoteCover }));
    expect(onSetNoteCover).toHaveBeenCalledTimes(1);
  });

  it("\"Remove note cover\" exists, because the banner's Remove is unreachable by keyboard", () => {
    // The banner control lives inside CodeMirror content where Tab indents, and
    // the picker's own Remove is gated on a `hasCover` neither non-pointer entry
    // point can determine. Without this action a cover can be added and changed
    // without a pointer but never removed.
    const onRemoveNoteCover = vi.fn();
    find("note.remove-cover").run(makeContext({ onRemoveNoteCover }));
    expect(onRemoveNoteCover).toHaveBeenCalledTimes(1);
  });

  it("\"Set note cover…\" is hidden without a selected note", () => {
    // Same rule as the export siblings: an action that needs a note must not
    // offer itself when there is none.
    expect(
      find("note.set-cover").visibility?.(
        makeContext({ stageName: "editor", selectedNoteId: null }),
      ),
    ).toBe("hidden");
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


  it("\"Empty trash\" dispatches to onEmptyTrash — the Editor host opens the count-aware confirm; the purge only runs on confirm", () => {
    const onEmptyTrash = vi.fn();
    void find("trash.empty").run(makeContext({ onEmptyTrash }));
    expect(onEmptyTrash).toHaveBeenCalledTimes(1);
  });

  it("Wave-4 sidebar actions expand the collapsed sidebar first, and skip their surface when expansion is impossible (MYND-192)", () => {
    const cases = [
      { id: "folder.new", handler: "newFolder" },
      { id: "trash.open", handler: "openTrash" },
      { id: "archive.open", handler: "openArchive" },
    ] as const;
    for (const { id, handler } of cases) {
      const reveal = vi.fn(() => true);
      const surface = vi.fn();
      sidebarCommands.revealSidebar = reveal;
      sidebarCommands[handler] = surface;
      try {
        void find(id).run(makeContext());
        expect(reveal).toHaveBeenCalledTimes(1);
        expect(surface).toHaveBeenCalledTimes(1);
        // Width-forced collapse (reveal reports false) → the surface is skipped
        // rather than ghost-opened inside the inert pane.
        reveal.mockReturnValue(false);
        void find(id).run(makeContext());
        expect(surface).toHaveBeenCalledTimes(1);
      } finally {
        sidebarCommands.revealSidebar = undefined;
        sidebarCommands[handler] = undefined;
      }
    }
  });
});

describe("app.toggle-screen-capture visibility", () => {
  // The two callers of `screenCaptureOverrideIsActive` had contradicting rules
  // on the identical state (myne-md/myne#482, found by review). `PrivacyPanel`
  // renders its switch inert on an UNREAD override, because a failed read left
  // as "no override" makes a control live on a device whose window may be
  // capturable; this predicate answered `false`, so `Cmd+K` offered the toggle
  // in exactly that state and the palette reopened the door the panel closed.
  //
  // The asserted direction is the security-relevant one: hidden while the
  // override is UNREAD on a client that has the capability. The opposite
  // overreach (answering `true` unconditionally, which would hide the action
  // forever on a client with no override to read) is guarded by the
  // capability consultation in `screenCaptureOverrideIsActive`.
  it("is hidden while the override has not been read on a client that has one", async () => {
    const { resetScreenCaptureOverrideForTest } = await import(
      "../../src/hooks/useScreenCaptureOverride"
    );
    resetScreenCaptureOverrideForTest();
    // The palette action reaches the same prefs setter the Privacy switch
    // guards, so it must be hidden in exactly the state where that switch is
    // inert: an UNREAD override on a client that HAS the capability. This is
    // the security-relevant half (`actions.ts:263-264`), not the predicate's
    // post-reset default.
    expect(
      find("app.toggle-screen-capture").visibility(makeContext({ stageName: "editor" })),
    ).toBe("hidden");
  });
});

describe("attachment palette actions (audit T6.13 item 1)", () => {
  // Both functions were exported and had NO palette entry, so "attach a file"
  // was reachable only from `/attach` and "convert imported attachments" from
  // nothing at all. Registry presence is what makes either reachable.
  const ids = ["attachments.attach-file", "attachments.convert-imported"];
  for (const id of ids) {
    it(`${id} is registered, editor-categorised and editor-only`, () => {
      const action = COMMAND_ACTIONS.find((a) => a.id === id);
      expect(action, `${id} is missing from COMMAND_ACTIONS`).toBeTruthy();
      expect(action?.category).toBe("Editor");
      expect(action?.visibility(makeContext({ stageName: "editor" }))).toBe("show");
      expect(action?.visibility(makeContext({ stageName: "unlock" }))).toBe("hidden");
    });
  }
});
