// Platform seam — which key chords the HOST takes for itself
// (phase3-web-client task 66).
//
// # Why this is a seam and not a lookup table in `src/commands/`
//
// "Cmd+W closes the tab" is not a fact about Myne's keymap; it is a fact about
// the process the UI is running inside. A desktop window reserves nothing — the
// application receives every chord the OS delivers — while a browser keeps a
// large part of the modifier space for its own chrome and will not hand it over,
// no matter what the page's event listeners do.
//
// Putting the answer here means the shared tree asks one question ("is this
// chord mine to bind?") and each host answers for itself, AND it means the
// browser table is not shipped in the desktop bundle at all.
//
// # Presentational only — the stored keymap is never rewritten
//
// The keymap lives in `vault.prefs` (`MYP1`) and **syncs between desktop and
// web**. So a web session that "fixed" a reserved binding by deleting it would
// silently reach across and break the user's desktop. Reconciliation is
// therefore strictly at the point of BINDING and DISPLAY: web refuses to create
// a new reserved binding and marks the existing ones as unavailable *here*,
// while the stored value stays exactly as desktop wrote it.

/** A browser this client targets. Edge is proxied by Chromium (`prd.md` §Risks). */
export type TargetBrowser = "chromium" | "firefox" | "safari";

/**
 * How firmly the host holds the chord.
 *
 * The distinction is worth carrying because the honest UI copy differs: one is
 * "this will never reach Myne", the other is "this reaches Myne in some
 * browsers and not others", and flattening them would make one of the two
 * messages a lie.
 */
export type ReservedTier =
  /** The host acts on it and the page cannot stop it. Binding it is dead weight. */
  | "hard"
  /** Interceptable in some target browsers, not in others (or version-dependent). */
  | "unreliable";

/** What the host does with a chord it reserves. */
export interface ReservedChord {
  /** Canonical chord string, as `src/commands/chord.ts` normalizes it. */
  readonly chord: string;
  readonly tier: ReservedTier;
  /** The browsers this applies to. Never empty. */
  readonly browsers: readonly TargetBrowser[];
  /** i18n key naming what the host does with it (e.g. "closes the tab"). */
  readonly actionKey: string;
}

/**
 * The chord's reservation, or `null` when the host leaves it to the app.
 *
 * **`null` for everything on desktop, and that is the whole desktop
 * implementation.** A window gets the keystrokes the OS gives it; the few chords
 * the OS itself keeps (Cmd+Tab, Cmd+Space) never reach any application and are
 * not this seam's business — no client can bind them, so there is nothing to
 * reconcile and nothing to explain.
 */
export function reservedChord(chord: string): ReservedChord | null {
  void chord;
  return null;
}

/** Every reservation this host declares. Empty on desktop. */
export function allReservedChords(): readonly ReservedChord[] {
  return [];
}
