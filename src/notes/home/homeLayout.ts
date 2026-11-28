// The home surface's edit operations, as pure functions plus one unit of state.
//
// ── Why an operations module ────────────────────────────────────────────────
// The surface, the card headers and the widget bodies all edit the SAME arranged
// list (reorder, resize, remove, add, and a widget writing back its own text).
// Every one of those is "replace the whole array and write it", so the shape is
// the same five times over, and a widget that wrote its own array would be a
// second writer racing the surface's.
//
// So: the surface owns the array and hands down `patch`; the widgets call it.
// The pure functions below are what `patch` is built from, which is also what
// makes them testable without a React tree.

import type { HomeCard } from "../../lib/prefs";
import { homeCardSpec, minSpanOf, newHomeCard } from "./homeCards";

/** Move the card at `from` to `to`, keeping everything else in order. */
export function moveCard(cards: readonly HomeCard[], from: number, to: number): HomeCard[] {
  if (from === to || from < 0 || to < 0 || from >= cards.length) return [...cards];
  const next = [...cards];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return [...cards];
  next.splice(Math.min(to, next.length), 0, moved);
  return next;
}

/** Set one card's width in quarter steps, clamped to the widget's own range. */
export function resizeCard(cards: readonly HomeCard[], id: string, span: number): HomeCard[] {
  return cards.map((card) => {
    if (card.id !== id) return card;
    const floor = minSpanOf(card.kind);
    const ceiling = 4;
    return { ...card, span: Math.max(floor, Math.min(ceiling, Math.round(span))) };
  });
}

/** Remove one card by id. */
export function removeCard(cards: readonly HomeCard[], id: string): HomeCard[] {
  return cards.filter((card) => card.id !== id);
}

/** Append a card of `kind` at its default width, with a fresh id. */
export function addCard(cards: readonly HomeCard[], kind: string): HomeCard[] {
  if (homeCardSpec(kind) === undefined) return [...cards];
  return [...cards, newHomeCard(kind, cards)];
}

/** Merge options into one card, replacing only the keys given. */
export function setCardOptions(
  cards: readonly HomeCard[],
  id: string,
  options: Readonly<Record<string, string>>,
): HomeCard[] {
  return cards.map((card) =>
    card.id === id ? { ...card, options: { ...(card.options ?? {}), ...options } } : card,
  );
}

/**
 * Whether two arrangements are the same, so a write is skipped when nothing
 * changed. Compared on the fields the codec carries: id, kind, span, options.
 */
export function sameArrangement(a: readonly HomeCard[], b: readonly HomeCard[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((card, index) => {
    const other = b[index];
    if (other === undefined) return false;
    if (card.id !== other.id || card.kind !== other.kind || card.span !== other.span) return false;
    const left = card.options ?? {};
    const right = other.options ?? {};
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      if ((left[key] ?? "") !== (right[key] ?? "")) return false;
    }
    return true;
  });
}
