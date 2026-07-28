// Platform seam — browser history, and the fact that a desktop window has none
// (phase3-web-client task 64).
//
// # Why this is a seam rather than a router
//
// `src/lib/stage.ts` is a pure stage union with no history integration, which is
// exactly right for a desktop window and exactly wrong for a browser tab: there,
// without it, the back button LEAVES the application, forward does nothing,
// reload loses where you were, and no view can be bookmarked.
//
// The fix is not to give the shared tree a router — desktop must keep its
// current in-memory behaviour, and a router that no-ops on one platform is a
// dependency two clients pay for and one uses. It is to name the three things a
// history actually provides and let each platform answer.
//
// # What may appear in a route, and what may never
//
// A `noteId` is permitted: it is a vault-scoped random UUIDv7, meaningless
// without the vault, and it is what makes a note view bookmarkable at all.
//
// **Nothing decrypted may ever reach the address bar, the browsing history or a
// referrer** — no title, no body, no account number, no `account_number_hash`,
// no filesystem path. The `Route` type below is closed for that reason: it can
// carry a stage name and an id, and there is nowhere to put anything else. A
// future field is a review, not an accident.

/** A stage name that a URL can address. */
export type RouteName =
  | "welcome"
  | "create-vault"
  | "unlock"
  | "editor"
  | "recover"
  | "picker"
  | "account-entry"
  | "restore-backup";

/**
 * A bookmarkable location.
 *
 * Deliberately NOT the `Stage` union: a stage carries mount-time payload
 * (`suspicionReason`, `briefing`, `initialStatus`) that is session state, not a
 * location — putting it in a URL would let a bookmark assert a suspicion or
 * re-open a briefing the user already acknowledged.
 */
export interface Route {
  readonly name: RouteName;
  /** The open note, when the route addresses one. Never a title. */
  readonly noteId?: string;
}

/**
 * Read the route the client was opened at, or `null` when the platform has no
 * addressable location.
 *
 * `null` on desktop, and that is the whole desktop implementation: a window
 * opens where the boot probe says, never where a URL says.
 */
export function readRoute(): Route | null {
  return null;
}

/** Record a NEW history entry. No-op on desktop. */
export function pushRoute(route: Route): void {
  void route;
}

/** Replace the current entry (a redirect the user should not have to un-do). */
export function replaceRoute(route: Route): void {
  void route;
}

/**
 * Subscribe to back/forward. Returns an unsubscribe function.
 *
 * Desktop never fires it and unsubscribing is a no-op — there is no back button
 * on a window.
 */
export function onRouteChange(handler: (route: Route) => void): () => void {
  void handler;
  return () => {};
}
