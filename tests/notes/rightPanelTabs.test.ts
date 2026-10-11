// Tests for the right-panel tab vocabulary + active-tab self-heal (right-panel
// tabs). The order/reorder math is the shared `barItemsOrder` surface (covered by
// barItemsOrder.test.ts); here we pin the tab-specific pieces: the closed vocab
// invariants and `resolveActiveTab`'s healed-on-read behaviour.

import { describe, expect, it } from "vitest";
import {
  RIGHT_PANEL_TABS,
  RIGHT_PANEL_DEFAULT_ORDER,
  rightPanelTabLabelKey,
  resolveActiveTab,
} from "../../src/notes/rightPanelTabs";
import { resolveBarOrder } from "../../src/notes/barItemsOrder";

describe("RIGHT_PANEL_TABS vocabulary", () => {
  it("default order lists exactly the tab ids", () => {
    expect([...RIGHT_PANEL_DEFAULT_ORDER].sort()).toEqual(
      RIGHT_PANEL_TABS.map((t) => t.id).sort(),
    );
  });

  it("exposes the expected six tabs in canonical order", () => {
    // The AI Chat tab (ai-ux-surface MYND-408) is followed by the "Who's here"
    // live-presence roster (live-collab, `collab-presence-ui`). Tasks (MYND-616)
    // slots in beside the other this-note surfaces — backlinks are this note's
    // links, the outline its headings, tasks its work.
    expect(RIGHT_PANEL_DEFAULT_ORDER).toEqual([
      "backlinks",
      "unlinked",
      "outline",
      "tasks",
      "ai-chat",
      "who-is-here",
    ]);
  });

  it("resolves a label key for a known id and null for an unknown id", () => {
    expect(rightPanelTabLabelKey("backlinks")).toBe("editor.chrome.rightPanel.tabs.backlinks");
    expect(rightPanelTabLabelKey("ghost")).toBeNull();
  });
});

describe("resolveActiveTab", () => {
  const order = [...RIGHT_PANEL_DEFAULT_ORDER];

  it("keeps a stored tab that is known and visible", () => {
    expect(resolveActiveTab("outline", order, [])).toBe("outline");
  });

  it("falls back to the first visible tab when stored is null", () => {
    expect(resolveActiveTab(null, order, [])).toBe("backlinks");
  });

  it("heals a stored tab that is now hidden to the first visible tab", () => {
    expect(resolveActiveTab("outline", order, ["outline"])).toBe("backlinks");
  });

  it("heals an unknown stored tab to the first visible tab", () => {
    expect(resolveActiveTab("ghost", order, [])).toBe("backlinks");
  });

  it("skips hidden leading tabs when picking the fallback", () => {
    expect(resolveActiveTab(null, order, ["backlinks"])).toBe("unlinked");
    expect(resolveActiveTab(null, order, ["backlinks", "unlinked"])).toBe("outline");
  });

  it("returns null when every tab is hidden", () => {
    const allHidden = [...RIGHT_PANEL_DEFAULT_ORDER];
    expect(resolveActiveTab("backlinks", order, allHidden)).toBeNull();
    expect(resolveActiveTab(null, order, allHidden)).toBeNull();
  });

  it("works on a reordered (resolved) order", () => {
    // User dragged outline to the front; backlinks hidden → active heals to the
    // first VISIBLE tab in the resolved order (outline).
    const reordered = resolveBarOrder(["outline", "unlinked", "backlinks"], RIGHT_PANEL_DEFAULT_ORDER);
    expect(resolveActiveTab("backlinks", reordered, ["backlinks"])).toBe("outline");
  });
});
