// @vitest-environment jsdom
//
// The agent run orb (myne-md/myne#771 task 12) — a NAMED motion-canon
// exemption, which is why every one of its bounds is tested rather than
// asserted in a comment.
//
// `PRODUCT.md` principle 4 admits no pulsing state indicator, and
// `docs/decisions/ui/0618` widened that into a named-exemption mechanism rather
// than a general permission. An implementation missing any of the conditions
// below is not covered by that exemption — it is just a loop somebody added.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let running = false;
/**
 * The store's view, INDEPENDENT of `running`.
 *
 * It was `running ? {…} : null`, which made the two facts the same fact — so
 * injecting `agent.view !== null` back in place of `agent.running` passed every
 * test in this file. The fixture could not reach the state the defect needs: a
 * SETTLED run, where the view is still set for the review surface to read and
 * the orb must nonetheless be gone. The default is a view that outlives the
 * run, because that is the shape the bug had.
 */
let view: unknown = { kind: "step" };
vi.mock("../../src/notes/agent/agentStore", () => ({
  useAgent: () => ({ running, view }),
}));

const { AgentRunOrb, ORB_ANIMATING_BUDGET, animatingOrbCount } = await import(
  "../../src/notes/agent/AgentRunOrb"
);

let observers: { cb: IntersectionObserverCallback; el: Element }[] = [];

beforeEach(() => {
  running = false;
  view = { kind: "step" };
  observers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      cb: IntersectionObserverCallback;
      observe(el: Element) {
        observers.push({ cb: this.cb, el });
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setHidden(false);
});

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

function conceal(): void {
  act(() => {
    for (const o of observers) {
      o.cb([{ isIntersecting: false } as IntersectionObserverEntry], null as never);
    }
  });
}

function reveal(): void {
  act(() => {
    for (const o of observers) {
      o.cb([{ isIntersecting: true } as IntersectionObserverEntry], null as never);
    }
  });
}

const orb = () => screen.queryByTestId("agent.run-orb");

describe("it indicates a run, and only a run", () => {
  it("renders nothing when no run is in flight", () => {
    render(<AgentRunOrb />);
    expect(orb()).toBeNull();
  });

  it("renders nothing for a SETTLED run whose view is still open", () => {
    // The state the store actually produces after a run finishes, and the one
    // the first version of this file could not express: `view` stays set so the
    // review surface can read it. An orb keyed off the view turns forever over
    // a run that ended — the one state it must never report — and every other
    // case in this file passes while it does.
    running = false;
    view = { kind: "step", outcome: "done" };
    render(<AgentRunOrb />);
    expect(orb(), "a finished run is still being indicated").toBeNull();
  });

  it("animates while a run is running", () => {
    running = true;
    render(<AgentRunOrb />);
    expect(orb()?.getAttribute("data-run")).toBe("active");
  });

  it("stops entirely when the run ends, leaving no residual loop", () => {
    // The distinction the store makes and the orb has to honour: `view` stays
    // set after a run settles so the review surface can read it, so keying off
    // the view would leave the orb turning over a FINISHED run — the one state
    // it must never report.
    running = true;
    const { rerender } = render(<AgentRunOrb />);
    expect(orb()).not.toBeNull();
    running = false;
    rerender(<AgentRunOrb />);
    expect(orb(), "a settled run must not still be indicated").toBeNull();
    expect(animatingOrbCount(), "and it must give its budget slot back").toBe(0);
  });
});

describe("it pauses rather than spending frames nobody sees", () => {
  it("pauses when the document is hidden", () => {
    // jsdom's `document.hidden` never changes on its own, so it is forced —
    // without that this assertion can never reach the state the guard exists
    // for, and would pass against an implementation with no check at all.
    running = true;
    render(<AgentRunOrb />);
    expect(orb()?.getAttribute("data-paused")).toBeNull();
    act(() => {
      setHidden(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(orb()?.getAttribute("data-paused")).toBe("true");
    act(() => {
      setHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(orb()?.getAttribute("data-paused")).toBeNull();
  });

  it("pauses off-screen and resumes on return", () => {
    running = true;
    render(<AgentRunOrb />);
    reveal();
    expect(orb()?.getAttribute("data-paused")).toBeNull();
    conceal();
    expect(orb()?.getAttribute("data-paused")).toBe("true");
    reveal();
    expect(orb()?.getAttribute("data-paused")).toBeNull();
  });

  it("stays on screen while paused", () => {
    // Pausing is `animation-play-state`, not unmounting. An indicator that
    // disappears when you switch tabs is an indicator that says the run
    // stopped — which is exactly the wrong thing to tell somebody who came
    // back to check on it.
    running = true;
    render(<AgentRunOrb />);
    conceal();
    expect(orb(), "a paused orb must still be there").not.toBeNull();
  });
});

describe("a budget caps how many animate at once", () => {
  it("lets the budget through and renders the rest static", () => {
    running = true;
    render(
      <>
        {Array.from({ length: ORB_ANIMATING_BUDGET + 1 }, (_, i) => (
          <AgentRunOrb key={i} />
        ))}
      </>,
    );
    const all = screen.getAllByTestId("agent.run-orb");
    expect(all).toHaveLength(ORB_ANIMATING_BUDGET + 1);
    expect(animatingOrbCount()).toBe(ORB_ANIMATING_BUDGET);
    expect(
      all.filter((o) => o.getAttribute("data-run") === "active"),
      "more orbs animated than the budget allows",
    ).toHaveLength(ORB_ANIMATING_BUDGET);
  });

  it("frees a slot on unmount", () => {
    running = true;
    const { unmount } = render(<AgentRunOrb />);
    expect(animatingOrbCount()).toBe(1);
    unmount();
    expect(animatingOrbCount()).toBe(0);
  });
});

describe("it carries no meaning of its own", () => {
  it("is aria-hidden", () => {
    // The run's status is in words beside it. A decorative indicator that ALSO
    // carries the meaning is a meaning a screen reader hears twice or not at
    // all, depending which it reaches first.
    running = true;
    render(<AgentRunOrb />);
    expect(orb()?.getAttribute("aria-hidden")).toBe("true");
    expect(orb()?.textContent?.trim()).toBe("");
  });
});

describe("the stylesheet holds up the half the component cannot", () => {
  const sheet = readFileSync(
    resolve(process.cwd(), "client-core/src/components.css"),
    "utf8",
  );

  it("animates only under data-run=active, so resting is static by construction", () => {
    // Opt-in rather than opt-out: a rule that animates by default and is turned
    // OFF somewhere is a rule that will one day be on with nothing running.
    expect(sheet).toContain('.myne-orb[data-run="active"] .myne-orb__halo');
    expect(sheet).toContain('.myne-orb[data-run="active"] .myne-orb__ring');
    // Anchored at line start: `.myne-orb[data-run="active"] .myne-orb__halo {`
    // CONTAINS `.myne-orb__halo {`, so an unanchored match finds the gated rule
    // and reports the ungated one. Caught on the first run of this file.
    expect(
      /^\.myne-orb__halo \{[^}]*animation:/m.test(sheet),
      "the halo animates without the run attribute gating it",
    ).toBe(false);
    expect(
      /^\.myne-orb__ring \{[^}]*animation:/m.test(sheet),
      "the ring animates without the run attribute gating it",
    ).toBe(false);
  });

  it("pauses through animation-play-state rather than by removing the animation", () => {
    expect(sheet).toContain("animation-play-state: paused");
  });

  it("holds one static frame under reduced motion", () => {
    const at = sheet.indexOf("@media (prefers-reduced-motion: reduce)", sheet.indexOf(".myne-orb"));
    expect(at, "the orb has no reduced-motion arm").toBeGreaterThan(-1);
    expect(sheet.slice(at, at + 400)).toContain("animation: none");
  });

  it("survives forced colours", () => {
    // Forced colours strips every background, which would leave the orb an
    // empty 14px gap beside its label.
    const at = sheet.indexOf("@media (forced-colors: active)", sheet.indexOf(".myne-orb {"));
    expect(at).toBeGreaterThan(-1);
    const block = sheet.slice(at, at + 400);
    expect(block).toContain("forced-color-adjust: none");
    expect(block).toContain("Highlight");
  });

  it("animates only transform and opacity", () => {
    // The canon's list. Anything else lays out or paints a new box every frame,
    // which is the difference between an indicator and a stutter.
    for (const name of ["myne-orb-breathe", "myne-orb-turn"]) {
      const at = sheet.indexOf(`@keyframes ${name}`);
      expect(at, `${name} is gone`).toBeGreaterThan(-1);
      const body = sheet.slice(at, sheet.indexOf("\n}", at));
      // NOT line-anchored: a keyframe step is commonly written on one line
      // (`0%, 100% { transform: scale(1); opacity: 0.55; }`), and a `^\s*prop:`
      // scan finds nothing in it — so the loop below ran zero times and passed
      // an injection that animated `width`. Found by injection, not by review.
      const props = [...body.matchAll(/[{;]\s*([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(props.length, `${name} has no declarations to check`).toBeGreaterThan(0);
      for (const p of props) {
        expect(["transform", "opacity"], `${name} animates ${p}`).toContain(p);
      }
    }
  });

  it("is named in the motion canon, both keyframes", () => {
    const guard = readFileSync(
      resolve(process.cwd(), "scripts/check-motion-canon.mjs"),
      "utf8",
    );
    for (const name of ["myne-orb-breathe", "myne-orb-turn"]) {
      expect(guard, `${name} is not a named exemption`).toContain(`"${name}"`);
    }
  });
});
