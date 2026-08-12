// The device-local beta-terms acceptance record — browser implementation
// (operations#15). The web arm of `src/platform/legal-consent.ts`.
//
// ## Why `localStorage` and not the Worker
//
// Every other device-local thing this client persists goes through OPFS in the
// Worker. This one cannot: **`localStorage` is unreachable from a Worker**, and
// OPFS is where the vault container lives — a record about the person using
// this browser does not belong inside a container that is a cache of an
// account, and would be destroyed by the local-erase path that empties it.
//
// So it stays on the main thread, in the same store as the other
// device-and-browser-scoped UI facts (`viewsEnabled.ts`, `accentColor.ts`,
// the language choice).
//
// ## The private-mode answer is "ask again", and that is correct
//
// Every write here is best-effort: a browser with storage denied throws, and
// the acceptance is not recorded. The consequence is that the terms are shown
// again next session — an annoyance, and the honest one. The alternative, a
// client that treats a failed write as success, would record agreement it
// cannot evidence.
//
// Scoped per browser profile rather than per account, deliberately. The
// question this answers is "did the person at this keyboard read the terms",
// and that does not become true because a different account on the same
// browser once did — nor false when they sign into a second account.

/** Storage key. Namespaced like the other `myne.*` UI keys in this client. */
const KEY = "myne.legal.beta-terms-accepted";

/**
 * Whether `version` has been accepted in this browser.
 *
 * Any failure — storage denied, key absent, a value from an older text —
 * answers `false`, which shows the screen. Same reduction as the desktop arm:
 * an unreadable record is never read as agreement.
 */
export async function betaTermsAccepted(version: string): Promise<boolean> {
  try {
    return window.localStorage.getItem(KEY) === version;
  } catch {
    return false;
  }
}

/** Record that `version` was accepted in this browser. Best-effort (see above). */
export async function acceptBetaTerms(version: string): Promise<void> {
  try {
    window.localStorage.setItem(KEY, version);
  } catch {
    /* Storage denied. The terms will be shown again next session, which is the
       honest outcome — better than reporting a success we cannot evidence. */
  }
}
