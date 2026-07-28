// Platform seam (web) — the fail-closed screen's primary action
// (phase3-web-client task 95).
//
// See `src/platform/app-exit.ts` for why this is a seam member and why the label
// key travels with the action. The short version: the desktop arm quits, this
// arm reloads, and a button whose words and behaviour disagree is worse on a
// fail-closed screen than either being wrong alone.
//
// # Why a reload is the honest web answer
//
// A browser tab cannot close itself — `window.close()` is refused for any tab
// the script did not open — so the desktop CTA has no web translation at all.
// But it also should not have one: on desktop these reasons mean the local vault
// file is damaged and the instruction is to quit and restore a backup out of
// band; on web the local copy is an OPFS cache of a server-held vault, and every
// byte is recoverable from the server.
//
// A reload re-runs the boot probe, and `initialStageFromProbe` already routes a
// web `Corrupted` to the account-number re-bootstrap rather than to a dead end
// (task 85; `decisions.md` 2026-07-26 "TOFU re-bootstrap is routine"). For
// `io-error` it is the ordinary remedy for a transient OPFS failure. So the user
// lands somewhere they can act, which is the entire property the desktop CTA has
// and the web build previously did not.
//
// **`closeApp` is deliberately not imported here.** Task 95's criterion is that
// it be ABSENT from the web bundle, not present-and-unreachable: a no-op quit
// button is exactly what this replaces.

/** The i18n key for this platform's CTA label. Reload, not quit. */
export const FAIL_CLOSED_EXIT_LABEL_KEY = "failClosed.exit.reload";

/**
 * Reload the page.
 *
 * Returns a promise that never settles in practice — navigation tears the
 * document down — and that is deliberate rather than sloppy: a caller that
 * `await`ed this and then rendered something would be racing the unload. The
 * signature matches the desktop arm so the call sites cannot tell them apart.
 */
export async function failClosedExit(): Promise<void> {
  location.reload();
}
