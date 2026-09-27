// @vitest-environment jsdom
//
// Where the run indicator actually is (myne-md/myne#771).
//
// It had two homes, the pane's top row and the tab, and the user's verdict on
// both was the same sentence twice: "orb falan yok burda". Both were true and
// both were peripheral. The one place a user is certainly looking during a run
// is the turn that says "Working" — and that line was grey text with nothing
// moving in it.
//
// Two properties are pinned here and they are not the same property. The orb
// is ON that line (not merely somewhere in the transcript), and the COUNT of
// orbs the app can mount at once fits the budget — because past the budget an
// orb renders its static frame, silently, and which one loses is mount order.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function read(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

describe("the run orb's homes", () => {
  it("sits on the working turn's own line, beside the word", () => {
    const surface = read("src/notes/ai/ConversationSurface.tsx");
    const at = surface.indexOf('data-testid="ai.agent-working"');
    expect(at, "the working line is gone").toBeGreaterThan(-1);
    // The element that line lives in, from its testid to its closing tag.
    const end = surface.indexOf("</p>", at);
    expect(end).toBeGreaterThan(at);
    const line = surface.slice(at, end);
    expect(line, "the orb is not on the working line").toContain("<AgentRunOrb />");
    // And the WORD is still there. An orb that replaced the word would take
    // the motion exemption's own justification with it: the run's status has
    // to be in words a screen reader reaches, and the orb is `aria-hidden`.
    expect(line, "the word went with it").toContain('t("agent.progress.working")');
  });

  it("is mounted in exactly as many places as the budget allows", () => {
    // `ORB_ANIMATING_BUDGET` caps how many animate AT ONCE; past it an orb
    // renders static. Three simultaneous homes and a budget of two is not a
    // failure anyone sees — it is one orb quietly not moving, chosen by mount
    // order. So the roster is counted rather than trusted.
    const orb = read("src/notes/agent/AgentRunOrb.tsx");
    const budget = /ORB_ANIMATING_BUDGET = (\d+)/.exec(orb)?.[1];
    expect(budget, "the budget is gone").toBeTruthy();

    const homes = [
      "src/notes/ai/ConversationSurface.tsx",
      "src/notes/agent/AgentTabIcon.tsx",
      "src/notes/agent/AgentPane.tsx",
      "src/notes/components/AiChatTab.tsx",
      "src/notes/agent/components/AgentProgress.tsx",
    ].filter((f) => /<AgentRunOrb\s*\/>/.test(read(f)));

    // Both directions. Over the budget is the silent-static bug; under it,
    // somebody removed a home and the cap now describes nothing.
    expect(homes.length, `mounted in: ${homes.join(", ")}`).toBe(Number(budget));
    // Named, so a swap of one home for another is a diff a reviewer reads
    // rather than a count that happens to still add up.
    expect(homes).toEqual([
      "src/notes/ai/ConversationSurface.tsx",
      "src/notes/agent/AgentTabIcon.tsx",
    ]);
  });
});
