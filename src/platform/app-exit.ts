// Platform seam — what the fail-closed screen's primary button actually DOES
// (phase3-web-client task 95).
//
// # The bug this exists to close
//
// `FailClosedError` is the shared dead-end UI for `invalid-state`,
// `corrupted-vault` and `io-error`, and all four of its call sites wired the
// primary CTA to `closeApp()` — a helper that checks for a Tauri runtime and,
// when absent, logs a dev warning and returns. **So in the web build, the only
// button on the screen where the user is most stuck did nothing at all**: no
// navigation, no error, no feedback, not even in production where the dev
// warning is compiled out.
//
// # Why a seam member rather than a branch inside the component
//
// The two platforms do not differ in "how to quit" — they differ in what the
// honest recovery IS, and the label has to match the action or the button lies.
// Bundling the action with its copy key in one seam module makes drift
// impossible: a platform cannot change what the button does without changing
// what it says.
//
// # Why the web answer is a reload, and why that is not a placeholder
//
// On desktop these reasons mean the local vault file is damaged and the honest
// instruction is to quit and restore a backup out of band. On web the local copy
// is an OPFS cache of a server-held vault, so the same conditions mean the local
// copy is unusable — and a reload re-runs the boot probe, which
// `initialStageFromProbe` already routes on web from `Corrupted` to the
// account-number re-bootstrap path (task 85, `decisions.md` 2026-07-26: "TOFU
// re-bootstrap is routine"). For `io-error` a reload is the ordinary remedy for
// a transient OPFS failure. So this is the correct outcome today, not a stub.
//
// # The "Re-download this vault" CTA this file used to promise, and why it is
// # now the WRONG answer here
//
// Task 95 recommended replacing the reload with a destructive CTA — erase the
// container through task 72's implementation, then re-sync — for
// `corrupted-vault` and `io-error`. Tasks 22 and 72 have since landed, and with
// them the reason not to: `corrupted-vault` means `vault.meta` will not parse,
// and **the notes beside it are fine**. Task 85's bootstrap now replaces an
// unparseable meta from the server, so a reload recovers the vault *including
// every unsynced note*, while an erase would discard exactly those. The
// non-destructive path is strictly better, so it stays.
//
// The destructive CTA does exist — it is just owned by a different door.
// `StorageLost` (task 22) offers it for `Evicted` / `Unopenable`, the two states
// where nothing readable is left to preserve, and it lists the unsynced notes it
// would discard before the user commits. That is criterion 3's home; putting a
// second erase behind this button would have made two, on a screen where the
// milder remedy already works.

import { getCurrentWindow } from "./window";

/**
 * The i18n key for the primary CTA's label on this platform.
 *
 * Exported beside [`failClosedExit`] on purpose — see the header. A platform
 * that changed one without the other would ship a button whose words and
 * behaviour disagree, which on a fail-closed screen is worse than either being
 * wrong alone.
 */
export const FAIL_CLOSED_EXIT_LABEL_KEY = "failClosed.exit.quit";

// `failClosed.exit.quit` renders the SAME words the three reasons' own `cta`
// keys already did — "Close app" — and that is a requirement rather than a
// coincidence. Task 95's last criterion is that desktop copy be UNCHANGED, and
// an earlier draft of this seam shipped "Close Myne" instead: a nicer sentence,
// a different one, and one that broke `state-machine.e2e.ts`'s full-literal
// assertion. The seam exists so the label cannot drift from the ACTION; on
// desktop the action did not change, so neither may the label.

/**
 * Perform the platform's fail-closed exit.
 *
 * **Desktop: destroy the window.** `destroy()` rather than `close()` because
 * `core:window:allow-destroy` is already declared and `allow-close` is not
 * (adding it widens the WebView surface against TB6 for an affordance we do not
 * need), and because `destroy()` is non-cancellable: a stale
 * `onCloseRequested` listener cannot `preventDefault()` and silently swallow the
 * user's exit intent. Fail-closed semantics is "only-exit"; cancellation is
 * failure.
 *
 * There is no in-progress work to flush at these call sites: `corrupted-vault`
 * and `io-error` hold no decrypted blobs, and the `invalid-state` path runs
 * `vault_lock` upstream.
 */
export async function failClosedExit(): Promise<void> {
  try {
    await getCurrentWindow().destroy();
  } catch (e) {
    // Swallowed: if the OS refuses to terminate the window (extremely rare) the
    // user can still close it from the title bar. Surfaced in dev so the path
    // is not silently ignored without trace.
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.warn("[app-exit] destroy() rejected:", e);
    }
  }
}
