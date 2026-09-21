// @vitest-environment jsdom
//
// The region commands' registration contract (myne-md/myne#728, task 2).
//
// A region command that exists in `src/lib/regions.ts` and nowhere else is a
// feature nobody can reach: the Hotkeys panel lists the CATALOG, the palette
// lists the ACTION REGISTRY, and the keybind dispatcher fires whatever chord
// the EFFECTIVE KEYMAP carries. Those three lists are built independently, and
// a command missing from any one of them still typechecks, still passes every
// other spec here, and simply is not there. So all three are asserted, plus the
// one property that makes F6 worth choosing: nothing else claims it.

import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { BINDABLE_COMMANDS, catalogDefaults } from "../../src/commands/bindableCatalog";
import { COMMAND_ACTIONS } from "../../src/commands";
import { commandIdsForChord, normalizeChord } from "../../src/commands/chord";
import { allConflicts, type ConflictDescriptor } from "../../src/commands/conflicts";
import { REGION_ATTR } from "../../src/lib/regions";

/** The four ids task 2 introduces, and the shape of the contract. */
const REGION_COMMAND_IDS = [
  "focus.cycle-region",
  "focus.sidebar",
  "focus.editor",
  "focus.right-panel",
] as const;

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("the region commands are bindable", () => {
  it("every region command has a catalog row", () => {
    const ids = new Set(BINDABLE_COMMANDS.map((c) => c.id));
    for (const id of REGION_COMMAND_IDS) {
      expect(ids.has(id), `catalog missing ${id}`).toBe(true);
    }
  });

  it("every region row is rebindable and carries a real label", () => {
    for (const id of REGION_COMMAND_IDS) {
      const row = BINDABLE_COMMANDS.find((c) => c.id === id);
      expect(row, id).toBeDefined();
      expect(row?.rebindable, `${id} must be rebindable (story 4)`).toBe(true);
      // A missing i18n key resolves to the key itself, which renders in the
      // panel as `commands.hotkeys.command.…` and looks like a bug.
      expect(row?.label).not.toContain("commands.hotkeys");
      expect((row?.label ?? "").length).toBeGreaterThan(0);
    }
  });

  it("only the cycle carries a default chord, and it is F6", () => {
    const defaults = catalogDefaults();
    expect(defaults["focus.cycle-region"]).toEqual(["F6"]);
    expect(defaults["focus.sidebar"]).toEqual([]);
    expect(defaults["focus.editor"]).toEqual([]);
    expect(defaults["focus.right-panel"]).toEqual([]);
  });

  it("F6 belongs to exactly one command in the whole catalog", () => {
    // The reason F6 was picked. A second claimant would make the key
    // nondeterministic and the Hotkeys panel would show both as live.
    expect(commandIdsForChord("F6", catalogDefaults())).toEqual(["focus.cycle-region"]);
  });

  it("introduces no chord conflict anywhere in the default keymap", () => {
    const descriptors: ConflictDescriptor[] = BINDABLE_COMMANDS.map((c) => ({
      id: c.id,
      scope: {},
    }));
    const conflicts: Record<string, string[]> = allConflicts(
      descriptors,
      catalogDefaults(),
    );
    const regionConflicts = Object.entries(conflicts).filter(
      ([id, others]) =>
        (REGION_COMMAND_IDS as readonly string[]).includes(id) ||
        others.some((o) => (REGION_COMMAND_IDS as readonly string[]).includes(o)),
    );
    expect(regionConflicts, JSON.stringify(regionConflicts)).toEqual([]);
  });

  it("normalizes F6 to itself, so a stored override compares equal", () => {
    expect(normalizeChord("F6")).toBe("F6");
  });
});

describe("the region commands are in the palette", () => {
  it("every region command has an action row", () => {
    const ids = new Set(COMMAND_ACTIONS.map((a) => a.id));
    for (const id of REGION_COMMAND_IDS) {
      expect(ids.has(id), `palette missing ${id}`).toBe(true);
    }
  });

  it("each action's label resolves rather than showing its key", () => {
    for (const id of REGION_COMMAND_IDS) {
      const action = COMMAND_ACTIONS.find((a) => a.id === id);
      expect(action?.label).not.toContain("commands.actions");
      expect((action?.label ?? "").length).toBeGreaterThan(0);
    }
  });

  it("running a region action moves focus into that region", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      `<div ${REGION_ATTR}="sidebar"><button id="s">notes</button></div>` +
      `<div ${REGION_ATTR}="editor"><div class="cm-content" contenteditable="true" id="e"></div></div>`;
    const action = COMMAND_ACTIONS.find((a) => a.id === "focus.sidebar");
    expect(action).toBeDefined();
    await action?.run({} as never);
    // Deliberately deferred: a palette row runs while the palette's focus trap
    // is still mounted, and its teardown restores focus after the handler
    // returns. Nothing has moved yet at this point.
    expect(document.activeElement?.id).not.toBe("s");
    vi.runAllTimers();
    expect(document.activeElement?.id).toBe("s");
  });

  it("the cycle action advances rather than re-entering the same region", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      `<div ${REGION_ATTR}="sidebar"><button id="s">notes</button></div>` +
      `<div ${REGION_ATTR}="editor"><div class="cm-content" contenteditable="true" id="e"></div></div>`;
    document.getElementById("s")?.focus();
    const action = COMMAND_ACTIONS.find((a) => a.id === "focus.cycle-region");
    await action?.run({} as never);
    vi.runAllTimers();
    expect(document.activeElement?.id).toBe("e");
  });
});


describe("the third registration list: the keybind dispatcher's own entries", () => {
  // The header above claims all three lists are asserted. For one review
  // round only two were: the CATALOG and the ACTION REGISTRY have specs, and
  // the third list is the `entries` array in `WorkspaceHotkeys`
  // (`src/screens/Editor.tsx`), which is the site that makes F6 actually
  // fire. The reviewer deleted all four entries and every unit test still
  // passed; only AK-1 caught it, and that lane runs on a manual pre-release
  // trigger, so on the push pipeline this feature could be fully unwired and
  // green.
  //
  // A source assertion rather than a render, because `Editor.tsx` cannot be
  // mounted in jsdom. It matches the CALL SITE rather than the bare command
  // id, for the reason `dragAlternatives.test.tsx` records about itself: an
  // id also appears in the catalog import, in comments and in the palette
  // registry, so a name match would survive the deletion it is meant to
  // catch.
  const editor = readFileSync("src/screens/Editor.tsx", "utf8");

  it.each([
    ["focus.cycle-region", 'enterRegion("next")'],
    ["focus.sidebar", 'enterRegion("sidebar")'],
    ["focus.editor", 'enterRegion("editor")'],
    ["focus.right-panel", 'enterRegion("right-panel")'],
  ])("%s is wired into the dispatcher", (id, run) => {
    expect(
      editor,
      `${id} is in the catalog and the registry but not in the dispatcher's entries, so its chord fires nothing`,
    ).toContain(`{ id: "${id}", scope: {}, run: () => ${run} }`);
  });

  it("all four sit in one entries array, not scattered", () => {
    // Cheap structural check that the four above are the SAME list: a
    // regression that moves one behind a condition would still match its
    // own line.
    const first = editor.indexOf('{ id: "focus.cycle-region"');
    const last = editor.indexOf('{ id: "focus.right-panel"');
    expect(first).toBeGreaterThan(-1);
    expect(last).toBeGreaterThan(first);
    expect(
      editor.slice(first, last).split("\n").length,
      "the four region entries are adjacent",
    ).toBeLessThan(8);
  });
});
