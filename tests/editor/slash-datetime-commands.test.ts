// @vitest-environment jsdom
//
// `/date` `/day` `/time` `/now` slash commands (MYND-338). Each inserts the
// current LOCAL date/time as frozen plain text at the trigger, replacing the
// `/query`. The clock is faked so the inserted literal is deterministic.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slashCommands } from "../../src/editor/slash/commands";
import { formatLocalWeekday } from "../../src/notes/localDateTime";
import { type Mounted, mount, teardown } from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
  vi.useRealTimers();
});

const cmd = (id: string) => slashCommands().find((c) => c.id === id)!;

describe("/date /day /time /now slash commands", () => {
  beforeEach(() => {
    // Fake only Date so the editor's rAF/timers stay real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 5, 9, 3, 0)); // local 2026-01-05 09:03
  });

  it("registers all four with Notesnook labels", () => {
    expect(cmd("date").label).toBe("Date");
    expect(cmd("day").label).toBe("Day");
    expect(cmd("time").label).toBe("Time");
    expect(cmd("now").label).toBe("Now");
  });

  it("/date inserts YYYY-MM-DD frozen at the trigger", () => {
    m = mount("/date\n", 5);
    cmd("date").apply(m.view, 0, "/date".length);
    expect(m.view.state.doc.toString()).toBe("2026-01-05\n");
  });

  it("/time inserts HH:mm", () => {
    m = mount("/time\n", 5);
    cmd("time").apply(m.view, 0, "/time".length);
    expect(m.view.state.doc.toString()).toBe("09:03\n");
  });

  it("/now inserts 'YYYY-MM-DD HH:mm'", () => {
    m = mount("/now\n", 4);
    cmd("now").apply(m.view, 0, "/now".length);
    expect(m.view.state.doc.toString()).toBe("2026-01-05 09:03\n");
  });

  it("/day inserts the localized weekday", () => {
    m = mount("/day\n", 4);
    cmd("day").apply(m.view, 0, "/day".length);
    expect(m.view.state.doc.toString()).toBe(`${formatLocalWeekday(new Date())}\n`);
  });
});
