// @vitest-environment jsdom
//
// The agent tab's live glyph (myne-md/myne#771).
//
// The run indicator had one home — the agent pane's own top row — which is the
// place it is least needed and, for a run that settles in a second, a place
// nobody ever saw it in. The tab is where a multi-minute wait is worth
// reporting, because it is visible from every other tab in the pane.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { AgentTabIcon } from "../../src/notes/agent/AgentTabIcon";
import {
  beginRun,
  clearAgent,
  failRun,
  openRun,
  currentRunEpoch,
} from "../../src/notes/agent/agentStore";
import { TabStrip } from "../../src/notes/components/TabStrip";

beforeEach(() => clearAgent());
afterEach(() => cleanup());

describe("AgentTabIcon", () => {
  it("rests as the tab's ordinary glyph", () => {
    render(<AgentTabIcon />);
    // No orb, and something IS drawn: an empty slot would satisfy "no orb"
    // while leaving the tab with no glyph at all.
    expect(screen.queryByTestId("agent.run-orb")).toBeNull();
    expect(document.querySelector("svg"), "the resting glyph is missing").toBeTruthy();
  });

  it("becomes the orb while a run is in flight", () => {
    render(<AgentTabIcon />);
    act(() => {
      beginRun();
    });
    const orb = screen.getByTestId("agent.run-orb");
    // Mounted AND animating: a static orb over a live run is the one thing the
    // motion exemption is for, and presence alone cannot tell them apart.
    expect(orb.getAttribute("data-run")).toBe("active");
  });

  it("goes back to the glyph when the run ENDS, not when the view closes", () => {
    // The store keeps `view` after a run settles so the review surface can read
    // it. An orb keyed on the view would keep turning over a finished run —
    // exactly the state it must never report — and every assertion above would
    // still pass.
    render(<AgentTabIcon />);
    act(() => {
      beginRun();
      openRun(
        {
          runId: "r1",
          scopeTotal: 1,
          userGrants: 1,
          modelGrants: 0,
          cancelled: false,
        },
        currentRunEpoch(),
      );
    });
    expect(screen.getByTestId("agent.run-orb")).toBeTruthy();
    act(() => {
      failRun("nope");
    });
    expect(screen.queryByTestId("agent.run-orb"), "still turning after the run ended")
      .toBeNull();
    expect(document.querySelector("svg")).toBeTruthy();
  });
});

describe("TabStrip: the live glyph slot", () => {
  function strip(node: React.ReactNode) {
    return render(
      <TabStrip
        paneId="p1"
        tabs={["agent:hub"]}
        activeTab="agent:hub"
        titleOf={() => "Agent"}
        iconOf={() => "message-square"}
        iconNodeOf={() => node}
        onActivate={() => {}}
        onClose={() => {}}
        onNewTab={() => {}}
        onMoveTab={() => {}}
      />,
    );
  }

  it("renders the node in the glyph slot instead of the icon", () => {
    strip(<span data-testid="live-glyph" />);
    // Scoped to the GLYPH SLOT rather than the tab, and an injection is why:
    // a tab also draws its close ×, and the strip draws a `+` and an overflow
    // chevron, so anything wider found one of those and passed with the tab's
    // own glyph deleted.
    const slot = screen.getByTestId("tab.glyph");
    expect(slot.querySelector("[data-testid=\"live-glyph\"]")).toBeTruthy();
    // And it REPLACES the icon rather than joining it: two glyphs in a 14px
    // slot is the other way this can go wrong.
    expect(slot.querySelector("svg"), "the icon is still drawn beside it").toBeNull();
  });

  it("falls through to the icon when there is no node", () => {
    // `undefined` is the ordinary case — every tab kind but one — so a slot
    // that rendered the override unconditionally would blank every other tab's
    // glyph, and a test that only ever passes a node would never find out.
    //
    // Scoped to the TAB, and an injection is why: the strip also draws a `+`
    // and an overflow chevron, both of them icons, so a document-wide
    // `querySelector("svg")` found one of those and passed with the tab's own
    // glyph deleted.
    strip(undefined);
    const slot = screen.getByTestId("tab.glyph");
    expect(slot.querySelector("svg"), "the fallback icon is missing").toBeTruthy();
  });
});
