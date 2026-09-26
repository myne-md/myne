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
// `docs/decisions/ui/0616` widened that into a NAMED-exemption mechanism rather
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

/** Grid cell size in px. The website's value; the density is the look. */
const CELL = 15;
/** Cells re-randomize on this cadence — a calm churn, not a matrix rain. */
const FLICKER_MS = 70;
/** Fraction of cells that change on each flicker tick. */
const FLICKER_RATE = 0.06;
/** Cursor-glow radius in px. */
const GLOW_RADIUS = 200;
/** Per-frame easing of the glow toward the pointer. */
const GLOW_EASE = 0.25;
/**
 * How many fields may animate at once, process-wide.
 *
 * Empty states cluster: a fresh vault can show one in the sidebar, one in a
 * right-rail tab and one in the open pane at the same moment, and three rAF
 * loops for background texture is three too many. Instances past the budget
 * paint a single static frame, which is what they look like at rest anyway.
 */
const ANIMATING_BUDGET = 2;

let animatingCount = 0;

export interface BinaryFieldHandle {
  /** Stop the loop, release observers and listeners. Idempotent. */
  destroy(): void;
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
  if (ctx === null) return { destroy: () => {} };

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // Touch devices never get the cursor glow that reveals the field on desktop,
  // so the faint base alpha reads as blank on a phone. Lift the base contrast
  // where there is no hover, exactly as the website does.
  const noHover = window.matchMedia?.("(hover: none)").matches === true;
  const fieldBoost = noHover ? 2.1 : 1;

  const GL = "01";
  let w = 0;
  let h = 0;
  let cols = 0;
  let rows = 0;
  let grid: { c: string; on: boolean }[] = [];
  const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, active: false };

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
        const a = (cell.on ? 0.04 + dens * 0.18 : 0.02 + dens * 0.05) * fieldBoost;
        const d = Math.hypot(px - mouse.x, py - mouse.y);
        if (d < GLOW_RADIUS) {
          const lit = clamp(a + (1 - d / GLOW_RADIUS) * 0.62, 0, 0.82);
          ctx!.fillStyle = `rgba(236,235,231,${lit.toFixed(3)})`;
        } else {
          ctx!.fillStyle = `rgba(232,231,225,${a.toFixed(3)})`;
        }
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
    if (mouse.active) {
      mouse.x += (mouse.tx - mouse.x) * GLOW_EASE;
      mouse.y += (mouse.ty - mouse.y) * GLOW_EASE;
    }
    // Repaint every frame only while the pointer is over it (so the glow
    // tracks); otherwise only on the flicker tick. The website's own
    // optimisation, and it is most of why this is cheap at rest.
    if (mouse.active || flick) paint();
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
  const onMove = (e: MouseEvent): void => {
    const b = canvas.getBoundingClientRect();
    mouse.tx = e.clientX - b.left;
    mouse.ty = e.clientY - b.top;
    // Snap on first entry so the glow does not glide in from off-canvas.
    if (!mouse.active) {
      mouse.x = mouse.tx;
      mouse.y = mouse.ty;
      mouse.active = true;
    }
  };
  const onLeave = (): void => {
    mouse.active = false;
    mouse.x = mouse.y = mouse.tx = mouse.ty = -9999;
    paint();
  };

  resize();
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
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", onLeave);

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      stop();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    },
  };
}

/** Test-only: how many fields currently hold an animation slot. */
export function animatingFieldCount(): number {
  return animatingCount;
}
