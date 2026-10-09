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

/**
 * The axes a reviewer can turn on.
 *
 * `compact density` and `text scale` are deliberately ABSENT, and the reasons are
 * different. Compact density is not a flag in this app: `settingsCompact` is a
 * width to boolean function over a `ResizeObserver`, so what exercises it is a
 * narrow VIEWPORT rather than an axis (myne-md/myne#847, task 7). Text scale is
 * not a global mechanism either: `editor_text_size` is the editor's own base
 * size, which a story's fixture can set, and forcing it on every story would be
 * a claim the app does not make.
 */
export const AXES = ["rtl", "reduced-motion", "forced-colors"] as const;
export type Axis = (typeof AXES)[number];

/**
 * The media query each mirrored axis stands for, and the marker attribute the
 * mirrored rules are scoped to.
 *
 * The marker lives on the STAGE, so the catalogue's own chrome keeps rendering
 * as it normally does: a reviewer reads the rail and the story at once, and
 * forcing the axis on the chrome too would make the chrome the thing under
 * review.
 */
export const MIRRORED_AXES: Readonly<Record<string, { condition: string; marker: string }>> = {
  "reduced-motion": {
    condition: "prefers-reduced-motion: reduce",
    marker: "data-axis-reduced-motion",
  },
  "forced-colors": { condition: "forced-colors: active", marker: "data-axis-forced-colors" },
};

/** The built-in palettes, which are also part of the view. */
export const VIEW_THEMES = ["light", "dark", "amoled"] as const;
export type ViewTheme = (typeof VIEW_THEMES)[number];

/** Everything about the view that a link should reproduce. */
export interface View {
  /** The story the fragment names, or `undefined` for the first story. */
  storyId: string | undefined;
  /**
   * The direction mode. `both` renders the story twice, once per direction, so a
   * mirroring mistake is visible as a difference rather than as something a
   * reviewer has to hold in their head (myne-md/myne#847 task 6).
   */
  rtl: "off" | "on" | "both";
  /** Whether the outline overlay marks containers and leaves. */
  outline: boolean;
  /** Whether the canvas fills the window and the chrome is hidden. */
  fullscreen: boolean;
  /** The width preset. `fit` honours the story's own `viewport`. */
  viewport: Viewport;
  /** Whether the reduced-motion rules are mirrored onto the stage. */
  reducedMotion: boolean;
  /** Whether the forced-colors rules are mirrored onto the stage. */
  forcedColors: boolean;
  /** The active palette. */
  theme: ViewTheme;
}

/** The default view: no story named, no axis on, the light palette. */
export const DEFAULT_VIEW: View = {
  storyId: undefined,
  rtl: "off",
  outline: false,
  fullscreen: false,
  viewport: "fit",
  reducedMotion: false,
  forcedColors: false,
  theme: "light",
};

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
    rtl: params.get("rtl") === "both" ? "both" : params.get("rtl") === "on" ? "on" : "off",
    outline: params.get("outline") === "1",
    fullscreen: params.get("fullscreen") === "1",
    viewport: (VIEWPORTS as readonly string[]).includes(params.get("viewport") ?? "")
      ? (params.get("viewport") as Viewport)
      : "fit",
    reducedMotion: params.get("reduced-motion") === "1",
    forcedColors: params.get("forced-colors") === "1",
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
  if (view.rtl !== "off") params.set("rtl", view.rtl);
  if (view.outline) params.set("outline", "1");
  if (view.fullscreen) params.set("fullscreen", "1");
  if (view.viewport !== "fit") params.set("viewport", view.viewport);
  if (view.reducedMotion) params.set("reduced-motion", "1");
  if (view.forcedColors) params.set("forced-colors", "1");
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
  return view.rtl === "off" ? undefined : "rtl";
}

// Task 7: viewport presets.
//
// A preset OVERRIDES a story's own `viewport`, and `Fit` honours it. The story
// keeps the one piece of information only it can carry (a surface that is narrow
// by nature) and any other width becomes a deliberate override
// (myne-md/myne#847 task 7).

/** The named widths, in the order the toolbar lists them. */
export const VIEWPORTS = ["fit", "mobile-390", "mobile-360", "tablet-768", "desktop-1280", "wide-1440"] as const;
export type Viewport = (typeof VIEWPORTS)[number];

const VIEWPORT_PX: Readonly<Record<Exclude<Viewport, "fit">, number>> = {
  "mobile-390": 390,
  "mobile-360": 360,
  "tablet-768": 768,
  "desktop-1280": 1280,
  "wide-1440": 1440,
};

/** The label the toolbar shows for a preset. */
export function viewportLabel(viewport: Viewport): string {
  if (viewport === "fit") return "Fit";
  return `${viewport.replace("-", " ")} px`;
}

/**
 * The width the stage should apply, as a CSS value.
 *
 * Pure, so the resolution between a preset and a story's own pin is asserted
 * directly rather than through a rendered stage. `Fit` is the default and is what
 * makes the story's `viewport` field mean something.
 */
export function stageWidth(viewport: Viewport, storyViewport: number | undefined): string {
  if (viewport !== "fit") return `${VIEWPORT_PX[viewport]}px`;
  return storyViewport === undefined ? "100%" : `${storyViewport}px`;
}
