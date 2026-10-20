// The appearance canon: the built-in values a custom theme INHERITS for the
// tokens it does not set.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// A theme file is a PARTIAL palette. `theme-validator` guarantees the 21
// `REQUIRED_KEYS` and accepts any other token name, so every token outside those
// 21 may be omitted. Measured over the twelve shipped gallery themes: 27 of the
// 44 colour tokens on average, and the dark ones omit every label colour and
// every highlight.
//
// `applyCustomTheme` drops `data-theme` (a custom theme supersedes
// Light/Dark/System), so a token the palette omits resolved to the built-in
// LIGHT value of `:root`. A dark theme therefore came out with pale label chips,
// light highlight washes, light graph group dots and light shadow scrims.
// `deriveSyntaxTokensForTheme` patched the syntax family of that bug only, which
// is how the rest stayed invisible.
//
// The rule is now: paint `{ ...canon, ...palette }`, where `canon` is the
// built-in values for the appearance THE THEME DECLARES. The appearance is
// measured from the theme's own `--paper` rather than taken from whichever
// built-in happened to be active, because a dark theme applied while Light was
// on still needs the dark canon.
//
// The canon is READ off the live stylesheet, never hardcoded, the same rule
// `readMeasureDefaults` follows: a table of VALUES here would drift from
// `client-core/src/tokens.css` with nothing to report it. The table of NAMES
// below is held to that sheet by `tests/lib/themeCanon.test.ts`, which parses the
// sheet and the validator's `REQUIRED_KEYS` and compares both ways, so a family
// added to the sheet fails by name until it is seeded here.
//
// **Twin note.** Desktop (`src/lib/theme.ts`) and mobile
// (`mobile/src/lib/customTheme.ts`) both call this through the `@myne/theme-canon`
// alias, deliberately: two copies of the seeding rule is precisely how the app
// and the phone would come to disagree about what a partial theme looks like.

import { SYNTAX_TOKEN_ROLES, isDarkBackground } from "./syntaxTheme";

/**
 * The tokens `client-core/src/tokens.css` re-points per appearance, minus the 21
 * `REQUIRED_KEYS` a theme must always carry (those are painted by the palette
 * itself, so seeding them would only be overwritten).
 *
 * These are exactly the tokens a theme may omit AND whose built-in value depends
 * on the background: the 12 code-syntax roles, the 13 highlight washes, the 6
 * label colours, the 8 graph group colours, the three shadows, the scrim, the
 * selection wash and `--danger-solid`.
 *
 * `--info` is the one token whose dark declaration is an ALIAS (`var(--accent)`),
 * and a computed-style read substitutes an alias with the value it had at read
 * time. Seeding that would freeze the BUILT-IN accent into a theme whose own
 * `--accent` differs. The alias is resolved against the caller's palette
 * instead, in {@link readAppearanceCanon}, which is the value the dark block
 * means on a custom theme.
 */
export const APPEARANCE_VARYING_TOKENS: readonly string[] = [
  // Code syntax (the role list lives in `syntaxTheme.ts`, so there is one copy)
  ...SYNTAX_TOKEN_ROLES.map((role) => `--syntax-${role}`),
  // Highlight washes (13 since MYND-632; `--highlight` is the default one)
  "--highlight",
  "--highlight-blue",
  "--highlight-brown",
  "--highlight-cyan",
  "--highlight-green",
  "--highlight-grey",
  "--highlight-indigo",
  "--highlight-lime",
  "--highlight-orange",
  "--highlight-pink",
  "--highlight-purple",
  "--highlight-red",
  "--highlight-teal",
  // Label colours
  "--label-clay",
  "--label-moss",
  "--label-ochre",
  "--label-plum",
  "--label-slate",
  "--label-stone",
  // Graph colour groups
  "--group-denim",
  "--group-fern",
  "--group-indigo",
  "--group-olive",
  "--group-orchid",
  "--group-rose",
  "--group-teal",
  "--group-violet",
  // Feedback, chrome and washes
  "--danger-solid",
  "--info",
  "--scrim",
  "--selection-bg",
  "--shadow-1",
  "--shadow-2",
  "--shadow-3",
];

/**
 * Read the built-in canon for the appearance a palette declares.
 *
 * `tokens.css` states these tokens once per appearance (`:root`,
 * `:root[data-theme="dark"]`, `:root[data-theme="amoled"]`), so the canon is
 * whichever block is active. This borrows the `data-theme` attribute for the
 * duration of the read (forcing the appearance the THEME declares) and puts it
 * back exactly as it found it, so the caller can then drop it and paint
 * `{ ...canon, ...palette }`.
 *
 * Must be called while no custom palette is painted (the callers clear first),
 * or the previous theme's inline properties would be read back as the canon.
 *
 * @param root the document element
 * @param palette the theme's own palette, whose `--paper` decides the appearance
 * @returns the canon values, or `{}` when no stylesheet declares them (a test
 *          environment with no token sheet, in which case only the palette lands
 *          and the behaviour is what it was before this seed existed)
 */
export function readAppearanceCanon(
  root: Element,
  palette: Record<string, string>,
): Record<string, string> {
  // An absent or unparseable `--paper` is NOT dark, so it takes the light canon
  // rather than throwing. `isDarkBackground` owns that fallback.
  const dark = isDarkBackground(palette["--paper"] ?? "");
  const previous = root.getAttribute("data-theme");
  root.setAttribute("data-theme", dark ? "dark" : "light");
  const computed = getComputedStyle(root);
  const canon: Record<string, string> = {};
  for (const key of APPEARANCE_VARYING_TOKENS) {
    const value = computed.getPropertyValue(key).trim();
    if (value !== "") canon[key] = value;
  }
  // `--info`'s dark declaration aliases `--accent`, so the canon read resolves it
  // to the BUILT-IN accent. On a custom theme the alias means the theme's own.
  if (dark) {
    const accent = palette["--accent"] ?? canon["--accent"];
    if (accent !== undefined && accent.trim() !== "") canon["--info"] = accent;
  }
  if (previous === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", previous);
  return canon;
}
