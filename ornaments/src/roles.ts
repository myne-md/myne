// Ornament roles — the contract between a component and the ornament layer
// (deep-customization, myne#394).
//
// A component does not choose an ornament. It declares WHAT IT IS — a surface, a
// box, a piece of chrome — and the active theme decides what that kind of thing
// wears. Three roles instead of per-element control is what keeps the vocabulary
// near thirty keys instead of several hundred: twenty-three callout types alone
// would otherwise each need their own nine (`decisions.md` 2026-08-06 clause (c)).
//
// The role reaches CSS as a data attribute rather than a class, for two reasons:
// the stylesheet can then select on it without owning a class name the app might
// also use, and a role is a *statement about the element*, which is what data
// attributes are for.
//
// **Colour is not role-scoped.** A callout still takes its colour from its own
// type's tone; only ornament is chosen per role. Keeping those two axes separate
// is what lets a theme say "every box wears a frame" without also saying "every
// box is the same colour".

/** The three kinds of thing a themed surface can be. */
export const ORNAMENT_ROLES = ["surface", "box", "chrome"] as const;

/** One of {@link ORNAMENT_ROLES}. */
export type OrnamentRole = (typeof ORNAMENT_ROLES)[number];

/** The attribute the stylesheet selects on. */
export const ROLE_ATTR = "data-ornament";

/** `true` for a value that is a role this build knows. */
export function isOrnamentRole(value: string): value is OrnamentRole {
  return (ORNAMENT_ROLES as readonly string[]).includes(value);
}

/**
 * The props a component spreads to join the ornament layer.
 *
 * ```tsx
 * <div {...ornamentRole("box")} style={{ background: "var(--bg-2)" }} />
 * ```
 *
 * Deliberately returns an object rather than a class string: it composes with
 * the inline-style convention this codebase uses everywhere (`src/AGENTS.md`),
 * and it cannot collide with a class name.
 */
export function ornamentRole(role: OrnamentRole): Record<string, string> {
  return { [ROLE_ATTR]: role };
}

/**
 * Every ornament primitive, with the values it accepts.
 *
 * **Mirrors `theme-validator/src/ornament.rs`'s `PRIMITIVES`.** The Rust side
 * decides whether a theme's value is *recognized*; this side is what the
 * stylesheet and any builder UI enumerate. Neither can be derived from the other
 * at build time, so they are kept in step by review — and by
 * {@link ORNAMENT_PRIMITIVE_NAMES} being asserted against the CSS in this
 * package's tests, which is the half a reviewer would otherwise miss.
 *
 * Values carry no hyphens because the theme value allowlist's bare-keyword arm
 * is ASCII letters only; see the Rust module's header for why that is deliberate
 * rather than incidental. Every primitive here is enumerated — the tint wash is
 * the one non-enumerated value and lives in {@link TINT_KEYS}.
 */
export const ORNAMENT_PRIMITIVES: Readonly<Record<string, readonly string[]>> = {
  frame: ["none", "hairline", "thick", "double", "inset"],
  shadow: ["none", "soft", "hard", "offset"],
  texture: ["none", "paper", "grain", "scanline", "grid"],
  ruled: ["none", "lines", "grid", "dotted"],
  edge: ["plain", "torn", "serrated", "cut"],
  fold: ["none", "folded", "dogear"],
  ribbon: ["none", "corner", "band", "label"],
  perforation: ["none", "left", "top", "both"],
};

/**
 * Which primitives each role accepts — the matrix is SPARSE.
 *
 * Mirrors `theme-validator/src/ornament.rs`'s `ROLE_PRIMITIVES`, which is the
 * side that decides whether a key means anything. Offering every role × every
 * primitive put settings in the vocabulary that describe nothing: a button with
 * a dog-eared corner, a tab with a punched margin, a toolbar with notebook
 * rules. Scoped by what the role IS — `surface` is a sheet of paper, `box` is
 * stationery (the full set), `chrome` is small, dense and repeated, so a torn
 * edge on it reads as damage rather than as style.
 *
 * A pair outside this table is simply not reflected: the attribute never reaches
 * the DOM, exactly as an unknown VALUE is never reflected.
 */
export const ROLE_PRIMITIVES: Readonly<Record<string, readonly string[]>> = {
  surface: ["frame", "shadow", "texture", "ruled", "edge", "fold", "perforation"],
  box: ["frame", "shadow", "texture", "ruled", "edge", "fold", "ribbon", "perforation"],
  chrome: ["frame", "shadow", "texture"],
};

/** `true` when `role` accepts `primitive` (see {@link ROLE_PRIMITIVES}). */
export function roleAccepts(role: string, primitive: string): boolean {
  return ROLE_PRIMITIVES[role]?.includes(primitive) ?? false;
}

/**
 * The tint wash is **not role-scoped**: one `--tint` + `--tint-strength` pair,
 * because that is what the stylesheet composes (on the role-agnostic layer).
 * Declaring it per role would put `--surface-tint` / `--chrome-tint` in every
 * theme file, validated and synced, drawing nothing.
 */
export const TINT_KEYS = ["--tint", "--tint-strength"] as const;

/** The primitive names, in declaration order. */
export const ORNAMENT_PRIMITIVE_NAMES = Object.keys(ORNAMENT_PRIMITIVES);

/**
 * The CSS custom-property name a role/primitive pair reads.
 *
 * One function rather than string concatenation at each call site, so the naming
 * scheme has exactly one definition and the Rust `classify_key` parser has
 * exactly one shape to agree with.
 */
export function ornamentToken(role: OrnamentRole, primitive: string): string {
  return `--${role}-${primitive}`;
}

/**
 * The `data-*` attribute a role/primitive pair is reflected onto.
 *
 * **Why an attribute at all, when the theme already sets a CSS variable.** CSS
 * cannot branch on the *value* of a custom property: there is no selector that
 * means "when `--box-frame` is `thick`". (`@container style()` would, but its
 * support across the three WebViews this ships on is uneven, and a decoration
 * that silently no-ops on one platform is worse than one that needs a line of
 * JS.) So the host reflects each ornament selection onto the root element as an
 * attribute, and the stylesheet selects on that. One write per theme change, at
 * the root, rather than anything per component.
 */
export function ornamentAttr(role: OrnamentRole, primitive: string): string {
  return `data-o-${role}-${primitive}`;
}

/**
 * The attributes a palette's ornament selections reflect to.
 *
 * The tint wash needs no attribute — the stylesheet reads `--tint` through
 * `var()` directly. A selection this build does not recognize is **skipped**, which is
 * the same degradation the host-side filter already performs: an unknown variant
 * draws nothing rather than drawing something wrong.
 */
export function ornamentAttributes(
  palette: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of ORNAMENT_ROLES) {
    for (const [primitive, values] of Object.entries(ORNAMENT_PRIMITIVES)) {
      if (!roleAccepts(role, primitive)) continue; // meaningless pair → not a setting
      const raw = palette[ornamentToken(role, primitive)];
      if (raw == null) continue;
      const value = raw.trim();
      if (!values.includes(value)) continue; // unknown variant → draw nothing
      out[ornamentAttr(role, primitive)] = value;
    }
  }
  return out;
}

/**
 * The flag that turns the whole layer on.
 *
 * Every unconditional rule in `ornaments.css` is scoped under `:root[data-o-on]`,
 * so a session whose theme selects no ornament — which is every colour-only theme,
 * i.e. every theme published before this vocabulary existed — matches no ornament
 * rule at all rather than paying for a `position`, two pseudo-element style
 * resolutions and a `box-shadow` on every role-bearing element.
 */
export const ORNAMENT_ON_ATTR = "data-o-on";

/**
 * The flag that turns the TINT WASH's layer on.
 *
 * The wash needs an attribute of its own even though the stylesheet reads
 * `--tint` through `var()`, because the `::before` layer is `display: none`
 * until something selects it, and CSS cannot branch on whether a custom
 * property is set. Without this, a tint-only theme raised `data-o-on`, painted
 * its colour into a slot, and rendered NOTHING — the wash only ever appeared if
 * some other `::before` primitive happened to be selected too and opened the
 * layer for it.
 */
export const ORNAMENT_TINT_ATTR = "data-o-tint";

/**
 * Reflect a palette's ornament selections onto `root`, returning whether any
 * were applied.
 *
 * **This owns the whole reflect step, and that is deliberate.** Each client used
 * to hand-assemble it — the same loop, the same module-level "what did I write"
 * array, the same clear — and the half that matters is the clear: a missed
 * attribute leaves the vault's ornament on a locked screen, which is an A6 leak
 * of the same kind as a leftover palette variable. One implementation means the
 * next client cannot get it subtly wrong, and there is nothing for a twin-drift
 * check to fall behind on.
 */
export function applyOrnamentAttributes(
  root: Element,
  palette: Readonly<Record<string, string>>,
): boolean {
  const attrs = ornamentAttributes(palette);
  for (const [attr, value] of Object.entries(attrs)) root.setAttribute(attr, value);
  // The tint wash needs TWO things, and it used to get only the second.
  //
  // Its own attribute, because the `::before` layer is `display: none` until a
  // rule selects it and CSS cannot branch on whether `--tint` is set — so a
  // tint-only theme applied its colour to a layer no rule matched: valid,
  // stored, synced, and invisible. Measured in a browser, not reasoned about.
  //
  // And the flag, because every rule that draws it is scoped under
  // `:root[data-o-on]`. `--tint` is the whole condition; `--tint-strength`
  // without a colour has nothing to wash.
  const tinted = (palette["--tint"] ?? "").trim().length > 0;
  if (tinted) root.setAttribute(ORNAMENT_TINT_ATTR, "");
  // `none` and `plain` are WRITTEN (they reset an inherited slot) but they are
  // not a SELECTION, so they must not raise the flag — a theme whose every
  // ornament key is `none` has to cost an unornamented session nothing. Keying
  // this off the attribute COUNT made that palette pay for the whole layer, and
  // it disagreed with `preview/src/apply.mjs`, which had it right.
  const selected = Object.values(attrs).some((v) => v !== "none" && v !== "plain");
  const any = selected || tinted;
  if (any) root.setAttribute(ORNAMENT_ON_ATTR, "");
  return any;
}

/**
 * Remove every ornament attribute this layer can ever set.
 *
 * Iterates the static roster rather than tracking what was written: the set is
 * fixed at three roles × the enumerated primitives, and `removeAttribute` on an
 * absent attribute is a no-op — so this is exactly as correct as bookkeeping and
 * cannot drift out of step with the apply side.
 */
export function clearOrnamentAttributes(root: Element): void {
  for (const role of ORNAMENT_ROLES) {
    for (const primitive of Object.keys(ORNAMENT_PRIMITIVES)) {
      root.removeAttribute(ornamentAttr(role, primitive));
    }
  }
  root.removeAttribute(ORNAMENT_ON_ATTR);
  root.removeAttribute(ORNAMENT_TINT_ATTR);
}
