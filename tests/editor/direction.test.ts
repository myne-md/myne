// @vitest-environment jsdom
//
// Per-line text direction (RTL/bidi, myne#172). Every editor line carries
// `dir="auto"` so the browser resolves each line's base direction from its
// content — the mixed RTL+LTR fix. Combined with `perLineTextDirection`, this is
// what makes CodeMirror's caret/selection bidi-aware per line.

import { afterEach, describe, expect, it } from "vitest";
import { type Mounted, mount, teardown } from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("per-line text direction", () => {
  it("stamps dir=auto on every rendered line (LTR + RTL content alike)", () => {
    m = mount("hello world\nمرحبا بالعالم\n1. list item\n");
    const lines = m.host.querySelectorAll(".cm-line");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of Array.from(lines)) {
      expect(line.getAttribute("dir")).toBe("auto");
    }
  });

  it("keeps dir=auto in a single-line doc", () => {
    m = mount("solo");
    const line = m.host.querySelector(".cm-line");
    expect(line).not.toBeNull();
    expect(line!.getAttribute("dir")).toBe("auto");
  });
});
