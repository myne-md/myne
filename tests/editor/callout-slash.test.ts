// @vitest-environment jsdom
//
// `/callout` slash command (MYND-47, task 4). Inserts a note callout header on
// the current line.

import { afterEach, describe, expect, it } from "vitest";
import { slashCommands } from "../../src/editor/slash/commands";
import { type Mounted, mount, teardown } from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("/callout slash command", () => {
  it("is registered", () => {
    const cmd = slashCommands().find((c) => c.id === "callout");
    expect(cmd).toBeDefined();
    expect(cmd!.label).toBe("Callout");
  });

  it("inserts `> [!note] ` on the line, replacing the trigger", () => {
    const cmd = slashCommands().find((c) => c.id === "callout")!;
    m = mount("/callout\n", 8);
    cmd.apply(m.view, 0, "/callout".length);
    expect(m.view.state.doc.toString()).toBe("> [!note] \n");
  });
});
