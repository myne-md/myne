import { describe, expect, it } from "vitest";
import { shouldDetachOnDrop } from "../../src/notes/detachDrop";

const WIN = { x: 100, y: 100, width: 800, height: 600 }; // covers x 100..900, y 100..700

describe("shouldDetachOnDrop", () => {
  it("does not detach when the drag was consumed by a valid target", () => {
    // A pane/folder drop reports "move"/"copy", never "none".
    expect(shouldDetachOnDrop("move", { x: 5000, y: 5000 }, WIN)).toBe(false);
    expect(shouldDetachOnDrop("copy", { x: 5000, y: 5000 }, WIN)).toBe(false);
  });

  it("does not detach when the drop had no target but stayed inside the window", () => {
    expect(shouldDetachOnDrop("none", { x: 500, y: 400 }, WIN)).toBe(false); // centre
    expect(shouldDetachOnDrop("none", { x: 100, y: 100 }, WIN)).toBe(false); // top-left corner
    expect(shouldDetachOnDrop("none", { x: 900, y: 700 }, WIN)).toBe(false); // bottom-right corner
  });

  it("detaches when the pointer left the window bounds in any direction", () => {
    expect(shouldDetachOnDrop("none", { x: 99, y: 400 }, WIN)).toBe(true); // left of the window
    expect(shouldDetachOnDrop("none", { x: 901, y: 400 }, WIN)).toBe(true); // right (second monitor)
    expect(shouldDetachOnDrop("none", { x: 500, y: 99 }, WIN)).toBe(true); // above
    expect(shouldDetachOnDrop("none", { x: 500, y: 701 }, WIN)).toBe(true); // below
    expect(shouldDetachOnDrop("none", { x: -50, y: -50 }, WIN)).toBe(true); // off-screen
  });

  it("does not detach when the platform gave no screen coordinates", () => {
    expect(shouldDetachOnDrop("none", null, WIN)).toBe(false);
  });
});
