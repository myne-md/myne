// The action sink (myne-md/myne#845).
//
// Every story used to pass `noop` for its callbacks, so a control that fired was
// indistinguishable from one that did not: the inspector's Actions tab had
// nothing to observe. A story now passes `action("onClose")` and the call is
// recorded here, which is what makes "the actions are manageable" true rather
// than aspirational.
//
// A module-scope store, deliberately: the sink is the catalogue's, not a
// component's, and it must survive a story re-render. It is cleared whenever the
// story changes, so a log never mixes two surfaces.

import { useSyncExternalStore } from "react";

export interface ActionEvent {
  /** Monotonic id, so React keys and "newest" are stable within a session. */
  id: number;
  /** The callback name the story passed, e.g. `onClose`. */
  name: string;
  /** The arguments the component called it with, JSON-ish for display. */
  args: unknown[];
}

const MAX_EVENTS = 100;

let events: readonly ActionEvent[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Record one callback invocation. Called by the callbacks `action()` builds. */
export function recordAction(name: string, args: unknown[]): void {
  const event: ActionEvent = { id: nextId, name, args };
  nextId += 1;
  events = [...events, event].slice(-MAX_EVENTS);
  emit();
}

/** Clear the log. Called on every story change so surfaces never mix. */
export function clearActions(): void {
  if (events.length === 0) return;
  events = [];
  emit();
}

/** The current log, oldest first. */
export function actionLog(): readonly ActionEvent[] {
  return events;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding for the Actions tab. */
export function useActionLog(): readonly ActionEvent[] {
  return useSyncExternalStore(subscribe, actionLog, actionLog);
}

/**
 * Build a callback that records. `action("onClose")` replaces `noop`, and the
 * returned function carries whatever arguments the component passes.
 */
export function action(name: string): (...args: unknown[]) => void {
  return (...args: unknown[]) => recordAction(name, args);
}
