// Left-ribbon metadata tests (myne-md/myne#699, task 2).
//
// The rail pins registry command ids, so ribbon eligibility is a property of the
// command itself: `CommandAction.ribbon` is the opt-in. These tests hold the two
// claims that make that safe: every declared glyph is a real icon, and the
// curated default rail names only commands that exist and opted in.

import { describe, expect, it } from "vitest";
import { COMMAND_ACTIONS, RIBBON_DEFAULT_IDS } from "../../src/commands";
import { ICON_PATHS } from "../../src/lib/icons";

const byId = new Map(COMMAND_ACTIONS.map((a) => [a.id, a]));

describe("left-ribbon metadata", () => {
  it("every declared ribbon icon exists in the icon vocabulary", () => {
    const eligible = COMMAND_ACTIONS.filter((a) => a.ribbon !== undefined);
    // Non-vacuity floor: the eligible set must not silently empty out.
    expect(eligible.length).toBeGreaterThanOrEqual(8);
    for (const a of eligible) {
      expect(
        Object.prototype.hasOwnProperty.call(ICON_PATHS, a.ribbon!.icon),
        `${a.id} declares unknown icon ${a.ribbon!.icon}`,
      ).toBe(true);
    }
  });

  it("every curated default id exists and is ribbon-eligible", () => {
    expect(RIBBON_DEFAULT_IDS.length).toBeGreaterThan(0);
    for (const id of RIBBON_DEFAULT_IDS) {
      const action = byId.get(id);
      expect(action, `default rail id ${id} is not a registry command`).toBeDefined();
      expect(action?.ribbon, `default rail id ${id} is not ribbon-eligible`).toBeDefined();
    }
  });

  it("destructive commands are not ribbon-eligible", () => {
    // Destructive actions stay opt-out: a one-click rail is the wrong home.
    expect(byId.get("workspace.delete")?.ribbon).toBeUndefined();
    expect(byId.get("app.toggle-screen-capture")?.ribbon).toBeUndefined();
    expect(byId.get("note.remove-cover")?.ribbon).toBeUndefined();
  });
});
