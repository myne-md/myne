// The home board's edit operations, as pure functions (myne-md/myne#1074).
//
// Every one of these replaces the whole arranged list, so the properties worth
// pinning are the ones a partial write would break: order preserved around a move,
// a width clamped to the widget's own range, and "nothing changed" producing no
// write at all.

import { describe, expect, it } from "vitest";
import type { HomeCard } from "../../src/lib/prefs";
import {
  addCard,
  moveCard,
  removeCard,
  resizeCard,
  sameArrangement,
  setCardOptions,
} from "../../src/notes/home/homeLayout";

const card = (id: string, kind: string, span = 1, options?: Record<string, string>): HomeCard =>
  options === undefined ? { id, kind, span } : { id, kind, span, options };

describe("moveCard", () => {
  it("moves one card and keeps every other in order", () => {
    const cards = [card("a", "favorites"), card("b", "saved-views"), card("c", "storage")];
    expect(moveCard(cards, 0, 2).map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(moveCard(cards, 2, 0).map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("is a no-op for an out-of-range move", () => {
    const cards = [card("a", "favorites")];
    expect(moveCard(cards, 0, 0).map((c) => c.id)).toEqual(["a"]);
    expect(moveCard(cards, 5, 0).map((c) => c.id)).toEqual(["a"]);
  });
});

describe("resizeCard", () => {
  it("clamps to the quarter grid", () => {
    const cards = [card("a", "favorites", 1)];
    expect(resizeCard(cards, "a", 9)[0]?.span).toBe(4);
    expect(resizeCard(cards, "a", 0)[0]?.span).toBe(1);
  });

  it("honours a widget's own floor", () => {
    // `start-chat` is the widest widget and declares a two-quarter floor: a chat
    // bar at a quarter width is a column of one letter per line.
    const cards = [card("chat", "start-chat", 4)];
    expect(resizeCard(cards, "chat", 1)[0]?.span).toBe(2);
  });

  it("leaves other cards alone", () => {
    const cards = [card("a", "favorites", 1), card("b", "storage", 2)];
    const next = resizeCard(cards, "b", 3);
    expect(next[0]?.span).toBe(1);
    expect(next[1]?.span).toBe(3);
  });
});

describe("addCard and removeCard", () => {
  it("adds at the widget's default width with a fresh id", () => {
    const next = addCard([], "storage");
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: "storage", kind: "storage", span: 1 });
  });

  it("gives a second card of one kind its own id", () => {
    // Two markdown blocks are a legitimate arrangement, so the id cannot be the
    // kind: `kind` picks the renderer, `id` identifies the card.
    const next = addCard(addCard([], "markdown"), "markdown");
    expect(next.map((c) => c.id)).toEqual(["markdown", "markdown-2"]);
  });

  it("refuses a kind this build does not know", () => {
    expect(addCard([], "no-such-widget")).toHaveLength(0);
  });

  it("removes by id and nothing else", () => {
    const cards = [card("a", "favorites"), card("b", "storage")];
    expect(removeCard(cards, "a").map((c) => c.id)).toEqual(["b"]);
  });
});

describe("setCardOptions", () => {
  it("merges into one card and leaves its siblings untouched", () => {
    const cards = [card("m", "markdown", 2, { align: "center" }), card("s", "storage")];
    const next = setCardOptions(cards, "m", { markdown: "Be water." });
    expect(next[0]?.options).toEqual({ align: "center", markdown: "Be water." });
    expect(next[1]?.options).toBeUndefined();
  });
});

describe("sameArrangement", () => {
  it("sees no change when only the object identity differs", () => {
    const a = [card("m", "markdown", 2, { markdown: "x" })];
    const b = [card("m", "markdown", 2, { markdown: "x" })];
    expect(sameArrangement(a, b)).toBe(true);
  });

  it("sees a change in order, width and options", () => {
    const base = [card("a", "favorites", 1), card("b", "storage", 2)];
    expect(sameArrangement(base, [base[1]!, base[0]!])).toBe(false);
    expect(sameArrangement(base, resizeCard(base, "a", 2))).toBe(false);
    expect(sameArrangement(base, setCardOptions(base, "a", { markdown: "y" }))).toBe(false);
  });
});
