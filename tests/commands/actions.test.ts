// Command-palette action registry tests — covers MYND-86 acceptance:
// "actions respect app state guards; palette never exposes actions
// unavailable in the current state."

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
    noteTitles: new Map(),
    selectedNoteId: null,
    onLock: vi.fn(async () => {}),
    onOpenSettings: vi.fn(),
    onSelectNote: vi.fn(async () => {}),
    ...over,
  };
}

function find(id: string): CommandAction {
  const a = COMMAND_ACTIONS.find((x) => x.id === id);
  if (a === undefined) throw new Error(`Action ${id} not found`);
  return a;
}

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
    it(`"Switch to note…" is HIDDEN when stage = ${stage}`, () => {
      const ctx = makeContext({
        stageName: stage,
        noteTitles: new Map([["note-1", "Foo"]]),
      });
      expect(find("note.switch").visibility(ctx)).toBe("hidden");
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

  it("\"Switch to note…\" is HIDDEN when cache is empty (no notes to pick)", () => {
    const ctx = makeContext({
      stageName: "editor",
      noteTitles: new Map(),
    });
    expect(find("note.switch").visibility(ctx)).toBe("hidden");
  });

  it("\"Switch to note…\" is SHOWN when cache has at least one note", () => {
    const ctx = makeContext({
      stageName: "editor",
      noteTitles: new Map([["note-1", "Foo"]]),
    });
    expect(find("note.switch").visibility(ctx)).toBe("show");
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

  it("\"Convert wikilinks…\" is DISABLED when a note is selected (stub for editor-mvp-wikilinks)", () => {
    const ctx = makeContext({
      stageName: "editor",
      selectedNoteId: "note-1",
    });
    expect(find("wikilinks.convert-in-this-note").visibility(ctx)).toBe(
      "disabled",
    );
  });

  it("\"Import Obsidian vault…\" is always DISABLED in v1.0 (stub for Phase 1.x)", () => {
    for (const stage of [...editorStages, ...nonEditorStages]) {
      const ctx = makeContext({ stageName: stage });
      expect(find("vault.import-obsidian").visibility(ctx)).toBe("disabled");
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

  it("Disabled stubs are no-ops when run directly (defensive — palette UI guards them)", async () => {
    const ctx = makeContext({
      stageName: "editor",
      selectedNoteId: "note-1",
    });
    const importAction = find("vault.import-obsidian");
    const convertAction = find("wikilinks.convert-in-this-note");
    expect(await importAction.run(ctx)).toBeUndefined();
    expect(await convertAction.run(ctx)).toBeUndefined();
  });
});
