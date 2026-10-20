// Platform seam — the capability descriptor (phase3-web-client task 27).
//
// # Why this is a seam module rather than a runtime probe
//
// Every other module here re-exports a Tauri module; this one does not, and the
// reason it still belongs is the substitution mechanism. The UI needs to know
// what the platform can do **before rendering** — a menu that briefly shows a
// clipper entry and then removes it is worse than one that never showed it — so
// the answer must be a build-time constant, not an `await`. `src/platform/` is
// the one directory swapped at build time, which is exactly that.
//
// # Absent, not disabled
//
// `decisions.md` 2026-07-26 ("Web capability set") makes this normative rather
// than a UX preference: an unavailable feature is **omitted**, never greyed out.
// A disabled control is an offer the platform cannot honour — it tells the user
// the feature exists here and they are doing something wrong.
//
// # One descriptor, not gating re-derived per call site
//
// The failure this prevents is a feature that is hidden from the menu, still
// reachable from the command palette, and still bound to a keyboard shortcut.
// Every surface consults `has()`; none re-derives the answer.

/**
 * The capability set. Each name is a **product** capability, not a command:
 * `clipper` is absent because the whole feature is, not because some particular
 * IPC call is unported.
 *
 * The VOCABULARY is closed and now lives in `@myne/client-core/capabilities`,
 * which is what makes the closure real for every client: the union and the keyed
 * record sit in a file all three compile, and this module holds only the
 * desktop ANSWERS. Before that move the closure was a claim about one client
 * (myne-md/myne#849, `docs/decisions/clients/0716`).
 */
export type { Capability } from "@myne/client-core/capabilities";
import { CAPABILITY_KEYS } from "@myne/client-core/capabilities";
import type { Capability } from "@myne/client-core/capabilities";

/**
 * The keyed record that makes a missing capability a compile error. It lives in
 * `@myne/client-core/capabilities`; this module keeps the desktop ANSWERS.
 *
 * **This used to be a bare array, and the comment above it claimed a missing
 * entry was "a compile error rather than a silent `undefined`". It was not.**
 * `readonly Capability[]` checks that every element IS a capability; nothing
 * checked that every capability is an element. Adding `spellCheck` (task 47) and
 * `pdfExport` (task 48) to the union while missing this list did exactly what
 * the comment promised could not happen: `DESKTOP` is built from these values,
 * so both features silently went ABSENT ON DESKTOP — a working feature hidden by
 * a list, which is the precise failure the comment named.
 *
 * A `Record<Capability, true>` is what actually enforces it: a missing key is a
 * TS2739 naming the capability, at the file that forgot it.
 */

/** Every capability, derived from the keyed record so it cannot fall behind. */
export const ALL_CAPABILITIES: readonly Capability[] = Object.freeze(
  Object.keys(CAPABILITY_KEYS) as Capability[],
);
/**
 * The desktop client has every capability.
 *
 * Spelled out rather than `() => true` so that adding a capability which
 * desktop *also* lacks (a future mobile-only feature, say) has an obvious place
 * to say so, instead of being invisible behind a blanket yes.
 */
const DESKTOP: ReadonlySet<Capability> = new Set(ALL_CAPABILITIES);

/** Whether this platform provides `cap`. Synchronous by design — see the header. */
export function has(cap: Capability): boolean {
  return DESKTOP.has(cap);
}
