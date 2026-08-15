// Custom-palette application (mobile, MYND-598) — the SINGLE place that writes
// a vault custom theme's CSS variables onto the document root.
//
// The palettes arrive from `listCustomThemes()` (`themes.ts`), which reads them
// out of the encrypted `vault.themes` blob sync already delivers here. Mobile
// authors none of them; this module only paints one.
//
// Two constraints shape the implementation:
//
//   - **CSSOM, not a `<style>` element.** Writing each property with
//     `root.style.setProperty` keeps custom themes off the CSP's `style-src`
//     surface entirely — no inline stylesheet is created, so no CSP relaxation
//     is needed for a feature whose values are user-supplied. Per-property
//     `setProperty` also cannot smuggle a second declaration the way a
//     concatenated CSS string could.
//   - **Track what was written.** `clearCustomTheme` must remove exactly the
//     keys the last apply wrote — no more (it would clobber inline properties
//     other code owns) and no fewer (a locked screen would keep wearing the
//     vault's palette, which is far more revealing about vault contents than a
//     light/dark attribute; A6).
//
// The built-in light/dark/amoled attribute is `formfactor/theme.ts`'s job. The two
// meet only here: a custom theme OVERRIDES the built-in choice, so applying one
// drops `data-theme`.

import { deriveSyntaxTokensForTheme } from "@myne/syntax-theme";
import { applyOrnamentAttributes, clearOrnamentAttributes } from "@myne/ornaments";
import { clampPalette, readMeasureDefaults } from "@myne/theme-measure";

import { HAS_TAURI } from "./app-window";
import { prefsRead } from "./prefs";
import { listCustomThemes, type CustomThemeEntry, type ThemePalette } from "./themes";

/** The CSS custom-property keys most recently written by `applyCustomTheme`. */
let appliedCustomKeys: string[] = [];

/**
 * How long the unlock path waits for the two vault reads before giving up and
 * letting the editor render under the built-in appearance.
 *
 * This is a deadline on the STAGE TRANSITION, not on the reads: an `invoke`
 * that never settles has no error and no timeout of its own, and the caller
 * awaits this before dispatching, so without a bound the user is left on the
 * unlock screen after a successful unlock with no way forward. Generous
 * relative to two in-process decrypts of already-open blobs — this is the
 * hung-host case, not the slow-host one.
 */
const PAINT_DEADLINE_MS = 2_000;

/**
 * Paint a custom-theme palette onto `:root` via the CSSOM, replacing whatever
 * palette was applied before it. Only `--*` keys are written — a palette map is
 * vault content and may carry non-token bookkeeping keys, which have no business
 * reaching the style attribute.
 *
 * A custom theme supersedes Light/Dark/System, so the built-in `data-theme`
 * attribute is removed; leaving it would let a built-in rule win a specificity
 * contest against the palette on tokens the palette does not define.
 */
export function applyCustomTheme(palette: ThemePalette): void {
  const root = document.documentElement;
  clearCustomTheme();
  // Measure defaults are read BEFORE `data-theme` is dropped and while no custom
  // palette is painted, so what is read is the built-in value rather than the
  // previous theme's. Shared with desktop (`@myne/theme-measure`) because the
  // clamp is a protective envelope: two clients disagreeing about the band would
  // mean one paints a value the other refused (myne#394).
  const measureDefaults = readMeasureDefaults(root);
  root.removeAttribute("data-theme");

  const { applied } = clampPalette(palette, measureDefaults);
  // Ornament selections reach CSS as root attributes (CSS cannot branch on a
  // custom property's value) plus the `data-o-on` flag the layer is scoped
  // under. The shared package owns both, so no client can reflect and forget.
  applyOrnamentAttributes(root, applied);
  const keys: string[] = [];
  for (const [key, value] of Object.entries(applied)) {
    // `--_o-*` is the ornament layer's private namespace — `--_o-ceiling` is the
    // bound the tint wash is clamped by. The key grammar allows `_`, so a palette
    // can carry one; the host filters it on read, and this is the second line of
    // that defence for any path that reaches here without one (myne#394).
    if (key.startsWith("--") && !key.startsWith("--_")) {
      root.style.setProperty(key, value);
      keys.push(key);
    }
  }

  // A dark custom theme that defines no `--syntax-*` role of its own would
  // inherit the built-in LIGHT syntax colors and render code blocks unreadable.
  // The shared derivation (main repo `src/lib/syntaxTheme.ts`, aliased as
  // `@myne/syntax-theme`) aliases each role the palette OMITS to the design-tuned
  // `--_syntax-*-dark` ramp that `styles/tokens.css` defines unconditionally, and
  // returns `{}` for a light theme. Per-role rather than all-or-nothing: the
  // gallery themes define only 5 of the 12, and an all-or-nothing gate leaves the
  // other 7 wrong (desktop's MYND-527).
  //
  // Applied AFTER the palette so it can never clobber a role the theme chose,
  // and tracked in the same key list so the revert below covers it too.
  for (const [key, value] of Object.entries(deriveSyntaxTokensForTheme(palette))) {
    root.style.setProperty(key, value);
    keys.push(key);
  }

  appliedCustomKeys = keys;
}

/** Remove every custom-theme CSS variable the last `applyCustomTheme` wrote. */
export function clearCustomTheme(): void {
  const root = document.documentElement;
  for (const key of appliedCustomKeys) root.style.removeProperty(key);
  appliedCustomKeys = [];
  // Off with the palette: a leftover attribute would keep a locked screen wearing
  // the vault's ornament (A6), exactly like a leftover variable.
  clearOrnamentAttributes(root);
}

/**
 * Is a custom palette currently painted on the root?
 *
 * The built-in theme applier must not re-assert `data-theme` over a live custom
 * palette — a custom theme supersedes Light/Dark/System, and editor mount runs
 * AFTER the unlock-path paint. This is how that ordering is kept honest without
 * either side importing the other's state.
 */
export function hasCustomTheme(): boolean {
  return appliedCustomKeys.length > 0;
}

/**
 * Which palette, if any, the stored `custom_theme` selection resolves to against
 * the themes this vault currently holds. `null` means "paint the built-in
 * choice" — the answer for no selection, an empty store, and a selection whose
 * theme is gone alike.
 *
 * A dangling selection is the case worth being deliberate about: it happens
 * whenever the theme is deleted on the computer and that deletion syncs here.
 * The caller falls back silently (no toast — nothing broke and the user has no
 * action to take) and, importantly, **leaves the preference alone**. Rewriting
 * it would delete a device-local preference the user never touched on evidence
 * that arrived from another device, and it would destroy the revival property: a
 * desktop re-add clears the deletion tombstone, so the next sync round restores
 * the theme and this resolves again with no user action. The dangling name lives
 * inside the encrypted prefs blob, so keeping it leaks nothing.
 *
 * Names are matched byte-exactly: they are `vault.themes` store keys, not
 * display labels, and the desktop side that authored them treats them the same.
 */
export function resolveCustomPalette(
  selection: string | null | undefined,
  entries: readonly CustomThemeEntry[],
): ThemePalette | null {
  if (!selection) return null;
  return entries.find((e) => e.name === selection)?.palette ?? null;
}

/**
 * Paint the vault's selected custom theme, on every route into the editor
 * (MYND-598; `AppShell.enterStage` is the single caller).
 *
 * Both halves of the answer are vault content — the selection lives in the
 * encrypted `vault.prefs` blob and the palette in `vault.themes` — so neither
 * can be read a moment earlier than this, and neither is ever cached in
 * plaintext device storage to make it possible (`docs/decisions.md` 2026-07-31).
 * Reading here rather than at editor mount is what shrinks the window in which
 * the wrong appearance is on screen; it does not close it, and closing it is
 * exactly what the no-plaintext-cache rule declines to buy.
 *
 * The two reads are SEQUENTIAL rather than concurrent, which costs one IPC
 * round-trip for the users who have a custom theme and saves a whole
 * `vault.themes` decrypt — every palette in the store — for the ones who do
 * not. That trade got better once this moved onto every editor entry rather
 * than the unlock route alone: the common case now runs five times as often.
 *
 * The caller awaits this before dispatching the editor stage, so the editor
 * never renders a frame under the built-in appearance. Failure is silent by
 * design: a cosmetic palette is not load-bearing, the host already collapses
 * every recoverable `vault.themes` read failure to an empty store (protocol.md
 * §9.21.4), and a toast at unlock about a colour scheme would be noise. The
 * built-in choice is applied at editor mount as it always has been, which is the
 * same fall-back a selection naming a since-deleted theme lands on — and the
 * preference is deliberately NOT rewritten in that case (see
 * {@link resolveCustomPalette}, where the revival property is spelled out).
 *
 * Never rejects and never hangs — the caller's stage transition must not be
 * held up by either failure mode, so a rejection is swallowed and a read that
 * does not settle within {@link PAINT_DEADLINE_MS} is abandoned. Both land on
 * the same fall-back: the built-in appearance.
 */
export async function paintSelectedCustomTheme(): Promise<void> {
  if (!HAS_TAURI) return;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const reads = (async () => {
      const prefs = await prefsRead();
      if (!prefs.custom_theme) return null;
      return resolveCustomPalette(prefs.custom_theme, await listCustomThemes());
    })();
    // `Promise.race` attaches a handler to `reads` either way, so a rejection
    // arriving after the deadline won is handled rather than unhandled. The
    // deadline covers BOTH reads — it bounds the stage transition, not a call.
    const palette = await Promise.race([
      reads,
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), PAINT_DEADLINE_MS);
      }),
    ]);
    if (palette) applyCustomTheme(palette);
  } catch {
    /* fall back to the built-in appearance, silently */
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}
