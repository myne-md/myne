// Correction menu item model (MYND-265, SYNC-14): ≤5 suggestions + 3 standing
// actions always present, including the zero-suggestion case.

import { describe, expect, it } from "vitest";
import {
  buildMenuItems,
  MAX_SUGGESTIONS,
  type MenuItem,
} from "../../src/editor/spell/correction-menu";

const actions = (items: MenuItem[]) =>
  items.filter((i) => i.kind === "action").map((i) => (i as { action: string }).action);

describe("buildMenuItems (SYNC-14)", () => {
  it("caps suggestions at MAX_SUGGESTIONS and appends the 3 actions", () => {
    const many = Array.from({ length: 9 }, (_, i) => `sug${i}`);
    const items = buildMenuItems(many);
    const suggestions = items.filter((i) => i.kind === "suggestion");
    expect(suggestions).toHaveLength(MAX_SUGGESTIONS);
    expect(actions(items)).toEqual(["add", "ignore-vault", "ignore-session"]);
  });

  it("shows the 3 actions even with zero suggestions", () => {
    const items = buildMenuItems([]);
    expect(items.filter((i) => i.kind === "suggestion")).toHaveLength(0);
    expect(actions(items)).toEqual(["add", "ignore-vault", "ignore-session"]);
  });

  it("preserves suggestion order under the cap", () => {
    const items = buildMenuItems(["color", "colour", "collar"]);
    const labels = items
      .filter((i) => i.kind === "suggestion")
      .map((i) => (i as { label: string }).label);
    expect(labels).toEqual(["color", "colour", "collar"]);
  });
});
