// Platform seam (web) — real browser history (phase3-web-client task 64).
//
// See `src/platform/history.ts` for why this is a seam and what a route may
// carry. The short version of the second half: a `noteId` is a vault-scoped
// random UUIDv7 and is what makes a note bookmarkable; nothing decrypted may
// ever reach the address bar, the browsing history or a referrer.
//
// # The shape: a path, not a query string
//
// `/editor/<uuid>` rather than `/?stage=editor&note=<uuid>`. Query strings are
// the part of a URL most likely to be copied into logs, analytics and referrer
// headers by intermediaries; a path segment is not immune, but it is the plainer
// choice and it reads as a location instead of as parameters.
//
// # Untrusted input, because a URL is
//
// Anything can be typed into the address bar. `parse` therefore validates rather
// than trusts: an unknown stage name is `null` (the caller falls back to the
// boot probe), and a note id that is not a canonical 36-char lowercase UUID is
// dropped — NOT rejected, so `/editor/<garbage>` opens the editor rather than
// erroring, which is what the task asks for ("resolves to the unlock screen and
// then to that note, never to an error").

import type { Route, RouteName } from "../../../src/platform/history";

export type { Route, RouteName };

const NAMES: ReadonlySet<string> = new Set<RouteName>([
  "welcome",
  "create-vault",
  "unlock",
  "editor",
  "recover",
  "picker",
  "account-entry",
  "restore-backup",
]);

/** Canonical 36-char lowercase hyphenated UUID. Anything else is not a note id. */
const NOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `Route` → path. The inverse of {@link parse}. */
function toPath(route: Route): string {
  return route.noteId ? `/${route.name}/${route.noteId}` : `/${route.name}`;
}

/** Path → `Route`, validating every part. `null` when the path addresses nothing. */
function parse(pathname: string): Route | null {
  const parts = pathname.split("/").filter(Boolean);
  const [name, id] = parts;
  if (!name || !NAMES.has(name)) return null;
  // A malformed id is DROPPED rather than failing the whole route: the user
  // still lands on the view they asked for, which is the difference between a
  // stale bookmark and an error screen.
  return id && NOTE_ID.test(id)
    ? { name: name as RouteName, noteId: id }
    : { name: name as RouteName };
}

export function readRoute(): Route | null {
  return parse(location.pathname);
}

export function pushRoute(route: Route): void {
  const next = toPath(route);
  // Never stack a duplicate: a re-render that re-asserts the same location
  // would otherwise need N back presses to leave one screen.
  if (location.pathname === next) return;
  history.pushState(route, "", next);
}

export function replaceRoute(route: Route): void {
  history.replaceState(route, "", toPath(route));
}

export function onRouteChange(handler: (route: Route) => void): () => void {
  const listener = () => {
    // Read the PATH rather than `event.state`: a `popstate` can arrive for an
    // entry this app never pushed (a manual edit, a restored session), where
    // `state` is null but the path is still meaningful.
    const route = parse(location.pathname);
    if (route) handler(route);
  };
  addEventListener("popstate", listener);
  return () => removeEventListener("popstate", listener);
}
