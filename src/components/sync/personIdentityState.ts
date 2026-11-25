// SPDX-License-Identifier: AGPL-3.0-only

import { useSyncExternalStore } from "react";

export interface PersonIdentityState {
  ready: boolean;
  ownerCode: string | null;
}

let state: PersonIdentityState = { ready: false, ownerCode: null };
let generation = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribePersonIdentityState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPersonIdentityState(): PersonIdentityState {
  return state;
}

export function setPersonIdentityState(next: PersonIdentityState): void {
  generation += 1;
  setPersonIdentityStateForGeneration(generation, next);
}

export function getPersonIdentityGeneration(): number {
  return generation;
}

export function setPersonIdentityStateForGeneration(
  expectedGeneration: number,
  next: PersonIdentityState,
): boolean {
  if (generation !== expectedGeneration) return false;
  if (next.ready === state.ready && next.ownerCode === state.ownerCode) return true;
  state = next;
  emit();
  return true;
}

export function usePersonIdentityState(): PersonIdentityState {
  return useSyncExternalStore(
    subscribePersonIdentityState,
    getPersonIdentityState,
    getPersonIdentityState,
  );
}

export function resetPersonIdentityState(): void {
  setPersonIdentityState({ ready: false, ownerCode: null });
}
