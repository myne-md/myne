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
    onLock: vi.fn(async () => {}),
    onOpenSettings: vi.fn(),
    onManageTemplates: vi.fn(),
    onNewNoteFromTemplate: vi.fn(),
    onOpenTodayNote: vi.fn(),
    onOpenAttachments: vi.fn(),
    onImportObsidian: vi.fn(),
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
  it("exposes exactly the v1 actions (note picking moved to inline search, MYND-40; templates.manage MYND-189; templates.new-note MYND-190; snapshots.open MYND-97; graph.show MYND-198)", () => {
    expect([...COMMAND_ACTIONS].map((a) => a.id).sort()).toEqual([
      "app.open-settings",
      "attachments.open",
      "daily.open-today",
      "graph.show",
      "snapshots.open",
      "templates.manage",
      "templates.new-note",
      "vault.import-obsidian",
      "vault.lock",
      "wikilinks.convert-in-this-note",
    ]);
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

  it("\"Convert wikilinks…\" is HIDDEN when no note selected", () => {
    const ctx = makeContext({
      stageName: "editor",
      selectedNoteId: null,
    });
    expect(find("wikilinks.convert-in-this-note").visibility(ctx)).toBe(
      "hidden",
    );
  });

  it("\"Convert wikilinks…\" is DISABLED when a note is selected (stub for editor-mvp-wikilinks)", () => {
    const ctx = makeContext({
      stageName: "editor",
      selectedNoteId: "note-1",
    });
    expect(find("wikilinks.convert-in-this-note").visibility(ctx)).toBe(
      "disabled",
    );
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
