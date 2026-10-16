// Whether spell checking can run on THIS client (myne-md/myne#880).
//
// The shared editor draws its squiggles from the host's `spell` slot, and
// `mobile/src/editor-host.ts` deliberately omits it: this client ships no
// dictionary (MYD1) and registers none of the `spell_*` commands, so
// `getHost().spell` resolves to `undefined` and no squiggle can ever be drawn.
// The settings row was nonetheless rendered and wrote `spell_enabled`, so the
// sheet confirmed a choice nothing applied: an inert control that shows up and
// does nothing is worse than one that says it does not work here.
//
// **One predicate rather than a `disabled` literal at the row**, for the reason
// `remindersReachTheOs()` exists in `./reminders.ts`: the row's gating and the
// sentence beside it have to agree, and two literals is how one of them drifts.
// The day a dictionary lands on this client, this returns true and the row and
// its helper sentence move together.
//
// **The value is asserted against the host's own omission**, by
// `mobile/tests/components/SpellRowGate.test.tsx`: installing a `spell` member
// in the host while this still returns false fails that spec, so the wiring and
// the gate cannot part company in either direction.
export function spellCheckingAvailable(): boolean {
  return false;
}
