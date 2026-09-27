// The Myne `01` field — the brand's animated character canvas (myne-md/myne#776,
// epic #772 / A3).
//
// Ported from `myne-website`'s hero (`src/pages/index.astro`, the "hero noise
// canvas" block) so the app and the marketing page draw the same thing rather
// than two drawings of the same idea. It lives in `client-core` because all
// three clients render empty states, and the website is a separate repository
// that cannot import from here today — closing that direction is the follow-up
// tracked on the issue.
//
// ── It is a continuous loop, which the canon forbids by default ─────────────
// `PRODUCT.md` principle 4 admits no looping decoration, and
// `design-notes/ui/0618` widened that into a NAMED-exemption mechanism rather
// than a general permission. This is the first entry of the "bounded state
// indication" class, and the conditions below are part of the exemption rather
// than polish on top of it. `scripts/check-motion-canon.mjs` knows it by name.
//
// ── Why the pause conditions are not optional ───────────────────────────────
// The website runs this for the seconds somebody reads a hero. The app runs for
// eight hours, on a laptop, with several empty panels potentially mounted at
// once — a sidebar section, a right-rail tab and a full pane can all be empty
// simultaneously. An unpaused rAF per instance is a measurable battery cost for
// decoration nobody is looking at. So:
//
//   - `document.hidden` stops it;
//   - an `IntersectionObserver` stops it off-screen;
//   - `prefers-reduced-motion` paints ONE frame and never starts a loop (it is
//     decoration, so it does NOT take MYND-630's `data-motion="essential"`
//     exemption, which exists for motion that carries state);
//   - a module-wide budget caps how many instances animate at once; past it,
//     the rest paint one static frame. A field nobody has looked at yet is not
//     worth a frame budget.
//
// ── The glow is on a timer, not on the cursor ──────────────────────────────
// The website's hero lights the digits nearest the pointer. Ported here that
// made the field something you had to poke at, and a zero state is a thing you
// look at: a keyboard user, a screenshot and every idle moment all saw a flat
// grid. It now sweeps on its own orbit, randomized per instance so two fields
// on screen together never move in lockstep, and it advances on the flicker
// tick rather than per frame — so being on all the time costs what being at
// rest used to.

/** Grid cell size in px. The website's value; the density is the look. */
const CELL = 15;
/** Cells re-randomize on this cadence — a calm churn, not a matrix rain. */
const FLICKER_MS = 70;
/** Fraction of cells that change on each flicker tick. */
const FLICKER_RATE = 0.06;
/** Glow radius in px. */
const GLOW_RADIUS = 200;
/**
 * The glow's orbit, one full turn in this many milliseconds, randomized per
 * instance within these bounds and in either direction.
 *
 * It used to track the cursor, which made the field something you had to poke
 * at: a zero state is a thing you look at, not a thing you play with, and a
 * glow that appears only where the pointer is means every screenshot, every
 * keyboard user and every idle moment sees a flat field. An orbit is on all the
 * time, costs the same, and is the same gesture the marketing page's hero makes
 * on a page nobody hovers either.
 *
 * Randomized because empty states cluster and cluster ADJACENTLY — a sidebar
 * section and a pane can be empty at once — and two fields sweeping in lockstep
 * read as one mechanism driving both, which is the thing decoration must never
 * look like. Per INSTANCE rather than per call site: the same component in two
 * places is two mounts, and they should not agree either.
 */
const ORBIT_MS_MIN = 14_000;
const ORBIT_MS_MAX = 26_000;
/**
 * How far the glow's centre travels, as a fraction of the field's half-extent.
 *
 * Under 1 it stays inside the field and sweeps the middle; the value is >1 on
 * purpose, so the centre leaves the box and the lit region enters and exits
 * from the edges rather than circling like a searchlight in a room. What reads
 * well is a wash crossing the field, not an orbit you can trace.
 */
const ORBIT_REACH = 1.15;
/**
 * The rest-alpha multiplier and the glow ceiling, per ink direction.
 *
 * The website draws light digits on a near-black hero and its numbers are tuned
 * for exactly that. Painted in a light theme they are invisible — not faint,
 * invisible, because the ink was a hardcoded near-white on near-white paper.
 * Theming the ink (below) fixes the colour; it does not fix the RAMP, because
 * the two directions are not symmetric: at the same alpha, dark ink on light
 * paper lands a smaller luminance step than light ink on dark paper (measured
 * on `--paper-2`: contrast 1.61 against 1.92 at the top-row `on` alpha), while
 * the CURSOR GLOW goes the other way and turns near-black at the ceiling the
 * dark theme needs to reach a legible grey.
 *
 * So a light-ink field keeps the website's numbers exactly, and a dark-ink one
 * lifts its rest alpha to close that gap and lowers its glow ceiling so the lit
 * digits read as ink rather than as holes.
 */
const DARK_INK_REST_GAIN = 1.34;
/**
 * How much alpha the glow adds at its centre, per ink direction.
 *
 * These were CEILINGS — `clamp(a + …, 0, 0.62 | 0.82)` — and they stopped
 * doing anything the moment the glow came off the cursor. A pointer can rest
 * exactly on a cell, so `d` reached 0 and the clamp bound; the orbit's centre
 * travels outside the field by design, so the nearest cell is always tens of
 * pixels away and the sum never approached either limit. Two constants with a
 * comment explaining their values, reachable by nothing.
 *
 * Expressed as STRENGTH they say the same thing where it now has effect: dark
 * ink lit to the light ink's 0.62 lands near-black on light paper, which reads
 * as holes punched in the card rather than as digits catching a light.
 */
const DARK_INK_GLOW_STRENGTH = 0.45;
const LIGHT_INK_GLOW_STRENGTH = 0.62;
/**
 * How many fields may animate at once, process-wide.
 *
 * Empty states cluster: a fresh vault can show one in the sidebar, one in a
 * right-rail tab and one in the open pane at the same moment.
 *
 * It was 2, on the reasoning that a field past the budget "paints a single
 * static frame, which is what they look like at rest anyway". That stopped
 * being true when the glow came off the cursor: at rest IS the sweep now, so a
 * starved field is visibly a different thing sitting next to a live one. The
 * same change is what makes a higher budget affordable — a field repaints on
 * its flicker tick and on nothing else, roughly 14 times a second over a few
 * hundred `fillText` calls, where the old cursor glow repainted at the full
 * frame rate for as long as a pointer rested on it.
 */
export const ANIMATING_BUDGET = 6;

let animatingCount = 0;

export interface BinaryFieldHandle {
  /** Stop the loop, release observers and listeners. Idempotent. */
  destroy(): void;
  /**
   * The orbit this instance drew at mount, exposed so the randomization can be
   * OBSERVED rather than inferred from pixels.
   *
   * It is here because the first test of it was vacuous and passed an
   * injection: it compared the painted frames of eight mounts and called them
   * different, but the GRID is randomized too, so two fields sweeping in
   * perfect lockstep still paint different frames. The test measured the thing
   * next to the thing it named. Four numbers on the handle is a smaller price
   * than a test that cannot fail.
   */
  readonly orbit: Readonly<{
    ms: number;
    dir: -1 | 1;
    phase: number;
    squash: number;
  }>;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Mount the field onto a `<canvas>`. Returns a handle whose `destroy` must be
 * called on unmount — the loop, the observer and the listeners all hang off it.
 *
 * The canvas is decoration: the caller marks it `aria-hidden` and keeps the
 * empty state's meaning in text. Under `forced-colors` a canvas paints nothing
 * useful, which is the same requirement stated differently.
 */
export function mountBinaryField(canvas: HTMLCanvasElement): BinaryFieldHandle {
  const ctx = canvas.getContext("2d");

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // The website lifts the base alpha 2.1x on touch devices, because its glow
  // follows a cursor that a phone does not have, leaving the field reading as
  // blank there. This one's glow is on a timer, so every device gets the same
  // sweep and the compensation would only make a phone 2.1x darker than a
  // laptop for no reason. Deliberately dropped rather than carried over.

  // The ink is READ from the theme rather than written here. `components.css`
  // gives the canvas `color: var(--fg-1)`, so `getComputedStyle().color` comes
  // back as a normalized `rgb(r, g, b)` whatever the token's own syntax was —
  // hex, `rgb()`, `hsl()`, a named colour, or a custom theme's value clamped by
  // `applyCustomTheme`. Parsing `--fg-1` directly would mean re-implementing CSS
  // colour parsing here and getting a custom palette wrong; letting the engine
  // resolve it means a custom theme's field follows its own ink for free.
  let ink = "232,231,225";
  let restGain = 1;
  let glowStrength = LIGHT_INK_GLOW_STRENGTH;

  function readInk(): void {
    const c = window.getComputedStyle(canvas).color;
    const m = c.match(/-?[\d.]+/g);
    if (m === null || m.length < 3) return;
    const r = Number(m[0]);
    const g = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return;
    ink = `${r},${g},${b}`;
    // Which direction are we painting? Not "is the theme dark" — a custom
    // palette can put either ink on either paper, and what the ramp depends on
    // is the ink, which is the thing being measured.
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const darkInk = lum < 0.5;
    restGain = darkInk ? DARK_INK_REST_GAIN : 1;
    glowStrength = darkInk ? DARK_INK_GLOW_STRENGTH : LIGHT_INK_GLOW_STRENGTH;
  }

  const GL = "01";
  let w = 0;
  let h = 0;
  let cols = 0;
  let rows = 0;
  let grid: { c: string; on: boolean }[] = [];
  // The orbit, drawn once per instance at mount. `phase` is where in the turn
  // this field starts, so two fields mounted in the same frame still differ.
  const orbitMs = ORBIT_MS_MIN + Math.random() * (ORBIT_MS_MAX - ORBIT_MS_MIN);
  const orbitDir: -1 | 1 = Math.random() < 0.5 ? -1 : 1;
  const orbitPhase = Math.random() * Math.PI * 2;
  // An ellipse rather than a circle, with its own aspect per instance, so the
  // sweep does not read as the same shape at two speeds.
  const orbitSquash = 0.55 + Math.random() * 0.75;
  const orbit = {
    ms: orbitMs,
    dir: orbitDir,
    phase: orbitPhase,
    squash: orbitSquash,
  } as const;
  // Drawn BEFORE this bail-out on purpose: a canvas with no 2D context (jsdom
  // without the `canvas` package) still has to report the orbit it would have
  // used, or the randomization becomes untestable in the only environment the
  // unit tests run in.
  if (ctx === null) return { destroy: () => {}, orbit };

  /** The glow centre, recomputed from elapsed time on every repaint. */
  const glow = { x: -9999, y: -9999 };

  function moveGlow(t: number): void {
    const angle = orbitPhase + orbitDir * ((t / orbitMs) * Math.PI * 2);
    glow.x = w / 2 + Math.cos(angle) * (w / 2) * ORBIT_REACH;
    glow.y = h / 2 + Math.sin(angle) * (h / 2) * ORBIT_REACH * orbitSquash;
  }

  let raf = 0;
  let running = false;
  let onScreen = false;
  let destroyed = false;
  let budgeted = false;
  let flickerLast = 0;

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

  function resize(): void {
    const b = canvas.getBoundingClientRect();
    w = b.width;
    h = b.height;
    if (w === 0 || h === 0) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / CELL);
    rows = Math.ceil(h / CELL);
    grid = new Array(cols * rows);
    for (let i = 0; i < grid.length; i++) {
      grid[i] = { c: GL[(Math.random() * 2) | 0]!, on: Math.random() < 0.5 };
    }
    ctx!.font = "11px 'JetBrains Mono', monospace";
    ctx!.textBaseline = "top";
  }

  function paint(): void {
    if (w === 0 || h === 0) return;
    ctx!.clearRect(0, 0, w, h);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = grid[y * cols + x];
        if (cell === undefined) continue;
        const px = x * CELL;
        const py = y * CELL;
        // Density falls off downward, so the field fades rather than ending.
        const dens = clamp((1 - y / rows) * 0.8 + 0.2, 0, 1);
        const a =
          (cell.on ? 0.04 + dens * 0.18 : 0.02 + dens * 0.05) * restGain;
        const d = Math.hypot(px - glow.x, py - glow.y);
        const lit =
          d < GLOW_RADIUS ? clamp(a + (1 - d / GLOW_RADIUS) * glowStrength, 0, 1) : a;
        ctx!.fillStyle = `rgba(${ink},${lit.toFixed(3)})`;
        ctx!.fillText(cell.c, px, py);
      }
    }
  }

  function frame(t: number): void {
    if (destroyed) return;
    const flick = t - flickerLast > FLICKER_MS;
    if (flick) {
      flickerLast = t;
      for (let i = 0; i < grid.length; i++) {
        const cell = grid[i];
        if (cell !== undefined && Math.random() < FLICKER_RATE) {
          cell.c = GL[(Math.random() * 2) | 0]!;
        }
      }
    }
    // One repaint per FLICKER tick, and the glow advances on the same tick —
    // so the orbit costs exactly what the field cost at rest before, which is
    // the whole reason it can be on all the time. ~14fps looks continuous here
    // because nothing in the frame has an edge: the glow is a soft radial
    // falloff over a grid that is itself churning.
    if (flick) {
      moveGlow(t);
      paint();
    }
    raf = requestAnimationFrame(frame);
  }

  function start(): void {
    if (running || destroyed) return;
    if (!onScreen || document.hidden) return;
    if (prefersReducedMotion()) return;
    if (!budgeted) {
      if (animatingCount >= ANIMATING_BUDGET) return;
      animatingCount++;
      budgeted = true;
    }
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function stop(): void {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
    running = false;
    if (budgeted) {
      animatingCount--;
      budgeted = false;
    }
  }

  const onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };
  const onResize = (): void => {
    resize();
    paint();
  };
  // A theme switch re-resolves `--fg-1` under the canvas without touching the
  // canvas, and a canvas holds pixels rather than styles — so without this the
  // field keeps the OLD theme's ink until something else forces a repaint, which
  // on a static (past-budget, or reduced-motion) field is never. `data-theme`
  // covers the built-ins and `style` covers a custom palette, which
  // `applyCustomTheme` writes as inline properties on the same element.
  const onThemeChange = (): void => {
    readInk();
    paint();
  };
  const themeObserver =
    typeof MutationObserver === "function"
      ? new MutationObserver(onThemeChange)
      : null;
  themeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "style", "class"],
  });
  // System theme, which flips no attribute at all: `applyTheme(null)` REMOVES
  // `data-theme` and lets the `prefers-color-scheme` block in `tokens.css` decide.
  const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  colorScheme?.addEventListener?.("change", onThemeChange);

  readInk();
  resize();
  // Put the glow somewhere on its orbit before the first paint. Without this a
  // static field — past the budget, or under reduced motion — would draw with
  // the glow parked at (-9999, -9999) and light nothing at all.
  moveGlow(orbitPhase * (orbitMs / (Math.PI * 2)));
  // One static frame up front, unconditionally. Under reduced motion this is
  // the ONLY frame — and it has to be forced, because `frame()` paints on a
  // flicker tick and `t = 0` against `flickerLast = 0` would skip it and leave
  // the field blank. The website records the same trap.
  paint();

  const io =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          onScreen = entries.some((e) => e.isIntersecting);
          if (onScreen) start();
          else stop();
        })
      : null;
  if (io !== null) io.observe(canvas);
  else {
    // No observer (jsdom, an ancient engine): assume on-screen rather than
    // never animating. The visibility and budget guards still apply.
    onScreen = true;
    start();
  }

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("resize", onResize);

  return {
    orbit,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stop();
      io?.disconnect();
      themeObserver?.disconnect();
      colorScheme?.removeEventListener?.("change", onThemeChange);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
    },
  };
}

/** Test-only: how many fields currently hold an animation slot. */
export function animatingFieldCount(): number {
  return animatingCount;
}
