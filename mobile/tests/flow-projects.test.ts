// @vitest-environment node
//
// The flow tier's project roster (myne-md/myne#918).
//
// `mobile/playwright.config.ts` pins `viewport` and `screen` per project because
// the size class reads both. That makes the roster itself a layout input: the
// day somebody adds a project with a 600 to 700 window, that project silently
// starts exercising the folded band instead of the layout it was written for,
// and its specs go green while testing something else.
//
// So the claim "the other clients did not move" is asserted here rather than
// stated in a PR body. The `duo-` prefix is the opt-in: the band's own tier is
// the only place a 600 to 700 window is expected.

import { describe, expect, it } from "vitest";

import config from "../playwright.config";

interface Project {
  name: string;
  use?: {
    viewport?: { width: number; height: number };
    screen?: { width: number; height: number };
  };
}

const projects = (config.projects ?? []) as Project[];
const isDuo = (p: Project) => p.name.startsWith("duo-");

describe("the flow tier's project roster", () => {
  it("keeps every non-duo project out of the folded band", () => {
    for (const project of projects.filter((p) => !isDuo(p))) {
      const width = project.use?.viewport?.width ?? 0;
      expect(
        width >= 600 && width < 700,
        `${project.name} has a ${width}px window, which is the folded band. ` +
          `Name it duo-* if that is intended.`,
      ).toBe(false);
    }
  });

  it("pins screen equal to viewport everywhere outside the duo tier", () => {
    // A mismatch is the signature of a stale folded reading, which is the band's
    // own subject. A non-duo project carrying one would test the foldable path
    // by accident.
    for (const project of projects.filter((p) => !isDuo(p))) {
      const viewport = project.use?.viewport;
      const screen = project.use?.screen;
      if (!viewport || !screen) continue;
      expect(screen.width, project.name).toBe(viewport.width);
      expect(screen.height, project.name).toBe(viewport.height);
    }
  });

  it("carries the five duo projects the band's evidence names", () => {
    expect(projects.filter(isDuo).map((p) => p.name).sort()).toEqual([
      "duo-folded",
      "duo-half-width",
      "duo-landscape",
      "duo-unfolded",
      "duo-unfolded-stale-screen",
    ]);
  });

  it("keeps both possible screen readings for the unfolded device", () => {
    // The design is correct under either answer, so both are held rather than
    // the answer being assumed. Losing one of these projects would drop half the
    // evidence without failing any other test.
    const unfolded = projects.find((p) => p.name === "duo-unfolded");
    const stale = projects.find((p) => p.name === "duo-unfolded-stale-screen");
    expect(unfolded?.use?.viewport?.width).toBe(stale?.use?.viewport?.width);
    expect(stale?.use?.screen?.width).toBeLessThan(stale!.use!.viewport!.width);
  });
});
