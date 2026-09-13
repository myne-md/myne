// Task-surface display settings (myne-md/myne#656 item 4).
//
// The security-relevant property is here on purpose: the stored value is a
// closed enum that SELECTS a token, and this suite proves a tampered descriptor
// cannot land an arbitrary string in a style position - it decodes to the
// default and the field is dropped on the next write.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_DISPLAY,
  TASK_CHIP_COLORS,
  TASK_CHIP_INK,
  decodeTaskDisplay,
  encodeTaskDisplay,
} from "../../src/notes/taskDisplay";
import {
  emptyNamedWorkspaces,
  type NamedWorkspaces,
} from "../../src/notes/workspaceState";
import {
  deserializeWorkspaces,
  serializeWorkspaces,
} from "../../src/lib/workspace-persist";

describe("the chip colour enum", () => {
  it("maps every colour to a token this module owns", () => {
    for (const color of TASK_CHIP_COLORS) {
      expect(TASK_CHIP_INK[color]).toMatch(/^var\(--/);
    }
  });

  it("is omit-when-default", () => {
    expect(encodeTaskDisplay(DEFAULT_TASK_DISPLAY)).toBeUndefined();
    expect(encodeTaskDisplay({ ...DEFAULT_TASK_DISPLAY, chipColor: "accent" })).toEqual({
      chipColor: "accent",
    });
    expect(encodeTaskDisplay({ ...DEFAULT_TASK_DISPLAY, iconOnly: true })).toEqual({
      iconOnly: true,
    });
  });

  it("decodes anything unknown to the default", () => {
    for (const junk of [
      undefined,
      null,
      "accent",
      7,
      {},
      { chipColor: "url(javascript:alert(1))" },
      { chipColor: "#ff0000" },
      { chipColor: ["accent"] },
    ]) {
      expect(decodeTaskDisplay(junk)).toEqual(DEFAULT_TASK_DISPLAY);
    }
    expect(decodeTaskDisplay({ chipColor: "muted" })).toEqual({
      chipColor: "muted",
      iconOnly: false,
    });
    expect(decodeTaskDisplay({ iconOnly: true })).toEqual({
      chipColor: "theme",
      iconOnly: true,
    });
  });
});

describe("the container round-trip", () => {
  const container = (over: Partial<NamedWorkspaces> = {}): NamedWorkspaces => ({
    ...emptyNamedWorkspaces("p1", "slot-1", "Default"),
    ...over,
  });

  it("persists a non-default colour and round-trips it", () => {
    const back = deserializeWorkspaces(
      serializeWorkspaces(container({ taskDisplay: { chipColor: "accent", iconOnly: true } })),
    );
    expect(back?.taskDisplay).toEqual({ chipColor: "accent", iconOnly: true });
  });

  it("stays byte-neutral (no key) for the default", () => {
    const json = serializeWorkspaces(container());
    expect(json).not.toContain("taskDisplay");
    expect(deserializeWorkspaces(json)?.taskDisplay).toBeUndefined();
  });

  it("drops a tampered colour rather than carrying it", () => {
    const json = JSON.stringify({
      slots: [
        {
          id: "slot-1",
          name: "Default",
          state: { root: { kind: "leaf", id: "p1", tabs: [], activeTab: null }, focusedPaneId: "p1" },
        },
      ],
      activeId: "slot-1",
      taskDisplay: { chipColor: "expression(alert(1))" },
    });
    const back = deserializeWorkspaces(json);
    expect(back).not.toBeNull();
    expect(back?.taskDisplay).toBeUndefined();
    expect(serializeWorkspaces(back!)).not.toContain("expression");
  });
});
