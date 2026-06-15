// Tests for the saved-view reorder seam (Saved Views #4, MYND-274, task 6).

import { describe, expect, it } from "vitest";
import { moveInOrder } from "../../src/notes/reorderViewOrder";

describe("moveInOrder", () => {
  it("moves an id up (earlier)", () => {
    expect(moveInOrder(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
  });

  it("moves an id down (later)", () => {
    expect(moveInOrder(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op at the top boundary (move up)", () => {
    expect(moveInOrder(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op at the bottom boundary (move down)", () => {
    expect(moveInOrder(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op for an absent id", () => {
    expect(moveInOrder(["a", "b"], "ghost", 1)).toEqual(["a", "b"]);
  });

  it("returns a fresh array (no mutation of the input)", () => {
    const input = ["a", "b"];
    const out = moveInOrder(input, "a", 1);
    expect(out).not.toBe(input);
    expect(input).toEqual(["a", "b"]);
    expect(out).toEqual(["b", "a"]);
  });
});
