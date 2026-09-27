// The deboxed pre-unlock page (myne-md/myne#773).
//
// Before this, the vault picker and the unlock screen were each a bordered card
// floating in the middle of an otherwise empty window. Two frames around one
// question, with the app's own name printed inside the inner one — so the
// window looked like a container for a dialog rather than like the app.
//
// Deboxed: the window IS the surface. The wordmark sits top-left, where an
// application's name sits; the actions sit top-right, where an application's
// actions sit; and the middle holds only the thing the user came to do —
// choosing a vault, or opening one.
//
// ── One shell, two screens, because the transition is between them ─────────
// The picker and the unlock screen are separate stages in `App.tsx`, so moving
// from one to the other unmounts the first and mounts the second. That is what
// makes an enter animation the honest shape here rather than a cross-fade: the
// outgoing view is already gone, and holding it alive to fade it out would mean
// keeping a mounted password form on screen after the user has left it.
//
// The direction is the caller's to state, because only the caller knows which
// way the user is going: choosing a vault goes forward, the back link goes
// back, and a shell that guessed from mount order would get the back link
// wrong every time.
//
// ── What it deliberately does not do ───────────────────────────────────────
// It holds no state, reads no prefs and makes no host call. Every screen that
// mounts it is PRE-UNLOCK, where the rule is that nothing on screen may be
// derived from vault content (`src/AGENTS.md`); a shell with a data dependency
// would be the easiest place in the tree to break that without noticing.

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { mountBinaryField } from "@myne/client-core/binaryField";
import { MyneMark } from "../components/primitives/MyneMark";
import { stageRootStyle } from "../components/primitives/stageRoot";

/** Which way the user is travelling, so the entrance moves with them. */
export type AuthEnter = "forward" | "back";

const ROOT_STYLE: CSSProperties = {
  ...stageRootStyle,
  flexDirection: "column",
  // The shell owns the whole window, so it stretches rather than centring; the
  // MAIN region below does the centring.
  alignItems: "stretch",
  justifyContent: "flex-start",
  background: "var(--paper)",
  fontFamily: "var(--font-sans)",
};

// Generous horizontal padding, which is most of what makes a top bar read as
// page chrome rather than as a toolbar: chrome sits at the window's margins,
// a toolbar sits in a band. `--space-7` against the old card's `--space-6`.
const HEADER_STYLE: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-4)",
  padding: "var(--space-5) var(--space-7)",
};

const BRAND_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  minWidth: 0,
};

const WORDMARK_STYLE: CSSProperties = {
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "var(--tracking-tight)",
  color: "var(--fg-1)",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  flexShrink: 0,
};

const MAIN_STYLE: CSSProperties = {
  // The field is absolutely positioned against this region, so it must be the
  // containing block. It also clips the field to the region rather than to the
  // window, which keeps the digits out from under the wordmark.
  position: "relative",
  overflow: "hidden",
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  // Symmetric with the header's inline padding so the centred column lines up
  // with the wordmark's margin at narrow widths.
  padding: "0 var(--space-7) var(--space-7)",
};

/**
 * The two spacers that put a short screen in the UPPER THIRD instead of dead
 * centre, in a `1 : 2` ratio above and below.
 *
 * **Spacers rather than a padding or a `vh` offset**, and the reason is what
 * happens when the screen is NOT short. A `padding-block-end: 33vh` biases the
 * block by taking that height away from the content box — so on a small window,
 * or an unlock carrying a suspicion banner and an error, the column has a third
 * less room to live in and `VIEW_STYLE`'s `max-height: 100%` clips it against a
 * surface that does not scroll. These carry `flex-basis: 0`, so they take only
 * free space: when there is none they collapse to nothing and the view has the
 * whole region, exactly as it does on the centred variant. The bias is a
 * preference, not a reservation.
 */
const SPACER_ABOVE_STYLE: CSSProperties = { flex: 1, minHeight: 0 };
const SPACER_BELOW_STYLE: CSSProperties = { flex: 2, minHeight: 0 };

const VIEW_STYLE: CSSProperties = {
  width: "100%",
  maxWidth: 480,
  // Bounded by what the main region was given: the vault list inside is the
  // only thing allowed to scroll, and it cannot if this grows to fit instead.
  maxHeight: "100%",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
};

export function AuthShell({
  actions,
  enter = "forward",
  align = "center",
  children,
  testId,
}: {
  /** Top-right controls. Icon buttons — this is chrome, not a form. */
  actions?: ReactNode;
  enter?: AuthEnter;
  /**
   * Where the content column sits vertically.
   *
   * `center` for a screen whose content can be tall and unbounded — the vault
   * picker, whose list is the only scrolling region on any of these surfaces.
   * `upper` for a short, fixed form: dead-centring five short rows leaves a
   * large empty band above them and reads as a dialog that lost its box, and
   * the optical centre of a block of text is above the geometric one anyway.
   */
  align?: "center" | "upper";
  children: ReactNode;
  testId?: string;
}) {
  const fieldRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const el = fieldRef.current;
    if (el === null) return;
    const handle = mountBinaryField(el);
    // Not optional: the handle owns a rAF loop, an IntersectionObserver, a
    // visibilitychange listener and a slot in the process-wide animation
    // budget. Leaking one leaks all of them and starves every later field.
    return () => handle.destroy();
  }, []);

  return (
    <div style={ROOT_STYLE} data-testid={testId}>
      <header style={HEADER_STYLE}>
        <div style={BRAND_STYLE}>
          <MyneMark size={26} />
          <span style={WORDMARK_STYLE}>Myne</span>
        </div>
        {actions != null && <div style={ACTIONS_STYLE}>{actions}</div>}
      </header>
      <main style={MAIN_STYLE}>
        {/* The brand's `01` field, the same one every zero state in the app
            carries (`design-notes/ui/0625`). Decoration: every word the user
            needs is in the column above it, which is also what keeps these
            screens readable under `forced-colors`, where a canvas paints
            nothing at all. */}
        <canvas ref={fieldRef} className="myne-auth__field" aria-hidden="true" />
        {align === "upper" && <div style={SPACER_ABOVE_STYLE} aria-hidden="true" />}
        {/* The animation is keyed off an attribute rather than a class alone so
            the two directions are one rule pair in `components.css` and the
            reduced-motion arm there covers both without knowing about either. */}
        <div className="myne-auth-view" data-enter={enter} style={VIEW_STYLE}>
          {children}
        </div>
        {align === "upper" && <div style={SPACER_BELOW_STYLE} aria-hidden="true" />}
      </main>
    </div>
  );
}

export const AUTH_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-3xl)",
  lineHeight: "var(--leading-snug)",
  letterSpacing: "var(--tracking-tight)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  color: "var(--fg-1)",
};

export const AUTH_BODY_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-base)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
};

/**
 * A heading and the line under it, as ONE block.
 *
 * They were two siblings of `VIEW_STYLE`, whose `--space-5` is the gap between
 * the screen's SECTIONS — so the subtitle sat as far from the title it
 * explains as the whole form sat from both of them. Everything was 24px apart
 * and nothing on the screen said which pieces belonged together; a title and
 * its subtitle are one thought, and an even stack asserts they are three.
 *
 * The group takes the section gap from outside and spends `--space-1` inside,
 * which is the whole point: unequal spacing is what grouping IS. Anything
 * larger and the pair starts reading as two lines again — at `--text-3xl` the
 * title's own `--leading-snug` already carries most of the separation.
 */
const AUTH_HEADING_GROUP_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  // Chrome, like the title and body it holds: the list below is what absorbs
  // height pressure on a short window.
  flexShrink: 0,
};

export function AuthHeading({
  title,
  children,
  testId,
}: {
  title: ReactNode;
  /** The subtitle. Optional — a screen with only a title still groups, so the
   *  spacing does not change when a subtitle is added or taken away. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div style={AUTH_HEADING_GROUP_STYLE} data-testid={testId}>
      <h1 style={AUTH_TITLE_STYLE}>{title}</h1>
      {children === undefined ? null : <p style={AUTH_BODY_STYLE}>{children}</p>}
    </div>
  );
}
