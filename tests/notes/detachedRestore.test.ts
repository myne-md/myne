import { describe, expect, it } from "vitest";
import { planDetachedRestore } from "../../src/notes/detachedRestore";

const PRIMARY = { x: 0, y: 0, width: 1440, height: 900 };
const SECOND = { x: 1440, y: 0, width: 1920, height: 1080 };

describe("planDetachedRestore", () => {
  it("keeps entries whose geometry still overlaps a connected display, in order", () => {
    const entries = [
      { noteId: "a", geometry: { x: 100, y: 100, width: 700, height: 500 } },
      { noteId: "b", geometry: { x: 1600, y: 200, width: 800, height: 600 } },
    ];
    const plan = planDetachedRestore(entries, [PRIMARY, SECOND], PRIMARY);
    expect(plan.map((p) => p.noteId)).toEqual(["a", "b"]);
    // Both still on a connected display -> geometry unchanged.
    expect(plan[0].geometry).toEqual(entries[0].geometry);
    expect(plan[1].geometry).toEqual(entries[1].geometry);
  });

  it("clamps an entry saved on a now-disconnected monitor onto the primary", () => {
    // Saved on the second monitor, which is now unplugged (only PRIMARY left).
    const entries = [
      { noteId: "a", geometry: { x: 1600, y: 200, width: 800, height: 600 } },
    ];
    const [spawn] = planDetachedRestore(entries, [PRIMARY], PRIMARY);
    expect(spawn.noteId).toBe("a");
    // Pulled back onto the primary, fully on-screen (clampDetachedGeometry).
    expect(spawn.geometry.x).toBe(320);
    expect(spawn.geometry.y).toBe(150);
    expect(spawn.geometry.width).toBe(800);
    expect(spawn.geometry.height).toBe(600);
    expect(spawn.geometry.x + spawn.geometry.width).toBeLessThanOrEqual(PRIMARY.width);
  });

  it("plans nothing for an empty entry list", () => {
    expect(planDetachedRestore([], [PRIMARY], PRIMARY)).toEqual([]);
  });

  it("preserves a duplicate note id (single-instance is the host command's job)", () => {
    const entries = [
      { noteId: "a", geometry: { x: 10, y: 10, width: 400, height: 300 } },
      { noteId: "a", geometry: { x: 20, y: 20, width: 400, height: 300 } },
    ];
    const plan = planDetachedRestore(entries, [PRIMARY], PRIMARY);
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.noteId === "a")).toBe(true);
  });
});
