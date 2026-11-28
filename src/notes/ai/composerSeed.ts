// A one-shot hand-off into the chat composer (myne-md/myne#1074).
//
// ── Why a seed and not a send ───────────────────────────────────────────────
// The home surface's chat bar is a place to start typing, not a thing that sends
// on your behalf. The composer owns the gates that decide what may leave this
// machine — which provider, which scope, and whether the opt-in is even on — and
// a widget that called `sendChatMessage` directly would be a second path around
// exactly those. So the bar hands over TEXT and the composer keeps the decision.
//
// ── Why a module and not a prop ─────────────────────────────────────────────
// The bar and the composer are in different trees (the home item versus the agent
// item, possibly in different panes), so there is no props path between them. A
// module-level one-shot is the smallest thing that crosses that gap, and it is
// deliberately one-shot: `takeComposerSeed` clears on read, so revisiting the
// agent surface never resurrects a prompt the user already sent or abandoned.

let pending: string | null = null;

/** Leave text for the next composer that mounts. Overwrites any earlier seed. */
export function seedComposer(text: string): void {
  pending = text === "" ? null : text;
}

/** The pending seed, consumed. `null` when there is nothing waiting. */
export function takeComposerSeed(): string | null {
  const text = pending;
  pending = null;
  return text;
}
