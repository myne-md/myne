// The agent run indicator (myne-md/myne#771 task 12).
//
// **This is a named motion-canon exemption**, the second of the
// bounded-state-indication class after the `01` field.
// `scripts/check-motion-canon.mjs` knows both its keyframes by name, and
// `client-core/src/components.css` carries the reasoning beside them.
//
// ── What it indicates, and why that earns a loop ───────────────────────────
// An agent step can run for tens of seconds producing no output at all. With
// nothing moving, a working surface and one that has silently stopped look
// identical — and the user's only recourse is to wait and find out. That is
// the whole justification: it animates while something is happening and not one
// frame longer.
//
// It is NOT a second `<Spinner>`. A spinner says "waiting for IO" and turns at
// IO's pace; this breathes slowly, because what it reports is a model working
// rather than a request outstanding. Two waits, two shapes.
//
// ── The bounds are the exemption, not polish on top of it ──────────────────
//   - it animates only while the store says a run is RUNNING;
//   - `document.hidden` pauses it;
//   - an `IntersectionObserver` pauses it off-screen;
//   - `prefers-reduced-motion` holds one static frame (in CSS, so there is no
//     JS branch that can disagree with the media query);
//   - a module-wide budget caps how many animate at once;
//   - it is `aria-hidden` and the run's status is in words beside it.
//
// Pausing is `animation-play-state`, not unmounting: a paused CSS animation
// holds its current frame and schedules nothing, so the orb stays visible —
// which matters, because an indicator that vanishes when you switch tabs is an
// indicator that says the run stopped.

import { useEffect, useRef, useState } from "react";
import { useAgent } from "./agentStore";

/**
 * How many orbs may animate at once, process-wide.
 *
 * Realistically one: there is one agent pane and one run. The budget is here
 * because the exemption's terms include a cap and a claim nobody can break is
 * a claim nobody has checked — the panel and the pane can both be mounted, and
 * a future surface could add a third. Past the budget an orb renders its static
 * frame, which is what it looks like between breaths anyway.
 */
export const ORB_ANIMATING_BUDGET = 2;

let animatingCount = 0;

/** Test-only: how many orbs currently hold an animation slot. */
export function animatingOrbCount(): number {
  return animatingCount;
}

export function AgentRunOrb() {
  const agent = useAgent();
  // A run is RUNNING, not merely open. The store keeps `view` after a run
  // settles so the review surface can read it, so keying off the view would
  // leave the orb turning over a finished run — the one state it must never
  // report.
  const running = agent.running;

  const ref = useRef<HTMLSpanElement>(null);
  const [paused, setPaused] = useState(false);
  const budgetedRef = useRef(false);
  const [budgeted, setBudgeted] = useState(false);

  // The budget slot. Taken while running, released the moment it stops or the
  // component unmounts — including on the path where a run ends without this
  // ever leaving the screen, which is the common one.
  useEffect(() => {
    if (!running) return;
    if (animatingCount >= ORB_ANIMATING_BUDGET) return;
    animatingCount++;
    budgetedRef.current = true;
    setBudgeted(true);
    return () => {
      if (!budgetedRef.current) return;
      animatingCount--;
      budgetedRef.current = false;
      setBudgeted(false);
    };
  }, [running]);

  useEffect(() => {
    if (!running) return;
    const el = ref.current;
    let onScreen = true;

    const apply = (): void => setPaused(document.hidden || !onScreen);

    const io =
      typeof IntersectionObserver === "function" && el !== null
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((e) => e.isIntersecting);
            apply();
          })
        : null;
    io?.observe(el!);
    document.addEventListener("visibilitychange", apply);
    apply();
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", apply);
      setPaused(false);
    };
  }, [running]);

  if (!running) return null;

  return (
    <span
      ref={ref}
      className="myne-orb"
      // Two separate facts, and the CSS reads them separately: whether there is
      // anything to indicate, and whether it is worth drawing right now.
      data-run={running && budgeted ? "active" : "idle"}
      data-paused={paused ? "true" : undefined}
      data-testid="agent.run-orb"
      // Decoration. The run's status is in words beside it — a decorative
      // indicator that also carries the meaning is a meaning a screen reader
      // hears twice or not at all, depending on which one it reaches first.
      aria-hidden="true"
    >
      <span className="myne-orb__halo" />
      <span className="myne-orb__ring" />
      <span className="myne-orb__core" />
    </span>
  );
}
