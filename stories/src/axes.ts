// The review axes, and the URL contract that carries them (myne-md/myne#847).
//
// The research was unambiguous about the model: a mature catalogue's axes are
// not story arguments, they are GLOBAL inputs to how the story is rendered, and
// the toolbar is only the way they are set. That distinction is what lets one
// link reproduce what a reviewer saw, which is the whole reason this catalogue
// has a URL contract at all.
//
// So the fragment is not a bare story id any more. It is a story id plus the
// view state, and this module is the ONE place that parses and serialises it:
// a second parser is how a key gets written by one path and dropped by another.
//
// RTL is the only axis this module ships so far, deliberately. It is the one
// built end to end first because it proves the mechanism (control, key, apply,
// round-trip) and the remaining axes are then wiring rather than design.
//
// The measure overlay is NOT here on purpose: it is transient state, and a
// shared link to a measurement is a link to nothing.

/** The axes a reviewer can turn on. */
export const AXES = ["rtl"] as const;
export type Axis = (typeof AXES)[number];

/** The built-in palettes, which are also part of the view. */
export const VIEW_THEMES = ["light", "dark", "amoled"] as const;
export type ViewTheme = (typeof VIEW_THEMES)[number];

/** Everything about the view that a link should reproduce. */
export interface View {
  /** The story the fragment names, or `undefined` for the first story. */
  storyId: string | undefined;
  /** Whether the stage renders right to left. */
  rtl: boolean;
  /** The active palette. */
  theme: ViewTheme;
}

/** The default view: no story named, no axis on, the light palette. */
export const DEFAULT_VIEW: View = { storyId: undefined, rtl: false, theme: "light" };

/**
 * Parse a URL fragment into a view.
 *
 * Tolerant by contract: an unknown key is IGNORED rather than fatal, because a
 * link written by an older catalogue (or by hand) must still open the story it
 * names. A fragment with no `?` is a bare story id, which is what every link
 * written before this change looks like.
 */
export function parseView(fragment: string): View {
  const raw = fragment.replace(/^#/, "");
  const [id, query] = raw.split("?");
  const params = new URLSearchParams(query ?? "");
  const theme = params.get("theme");
  return {
    storyId: id === undefined || id.length === 0 ? undefined : id,
    rtl: params.get("rtl") === "1",
    theme: (VIEW_THEMES as readonly string[]).includes(theme ?? "")
      ? (theme as ViewTheme)
      : DEFAULT_VIEW.theme,
  };
}

/**
 * Serialise a view back into a fragment.
 *
 * The defaults are omitted, so a link to a story in the light palette with no
 * axis on stays exactly as short as it was before this change. That matters:
 * every story link in every issue and note already in existence keeps resolving,
 * and a diff of a link shows what actually changed.
 */
export function serialiseView(view: View): string {
  const params = new URLSearchParams();
  if (view.rtl) params.set("rtl", "1");
  if (view.theme !== DEFAULT_VIEW.theme) params.set("theme", view.theme);
  const query = params.toString();
  return query.length === 0 ? (view.storyId ?? "") : `${view.storyId ?? ""}?${query}`;
}

/**
 * The `dir` attribute the stage should carry, or `undefined` for the default.
 *
 * Returned rather than applied, so the decision is testable without a DOM.
 */
export function dirFor(view: View): "rtl" | undefined {
  return view.rtl ? "rtl" : undefined;
}
