// @vitest-environment jsdom
//
// The Documentation page generator (myne-md/myne#847 task 3).
//
// The page's value is that its GENERATED half cannot disagree with the registry
// and its AUTHORED half is labelled as a person's judgement. Both of those are
// asserted here, because a page that quietly mixes the two, or that renders an
// empty section for a surface nobody wrote about, is worse than no page.

import { describe, expect, it } from "vitest";
import { documentationFor, documentationTitle } from "../../stories/src/documentation";
import type { StoryDescriptor, StoryGroup } from "../../stories/src/types";

function story(
  surface: string,
  state: string,
  group: StoryGroup,
  extra: Partial<StoryDescriptor> = {},
): StoryDescriptor {
  return {
    id: `${group}/${surface.toLowerCase()}/${state}`,
    group,
    surface,
    state,
    description: `${surface} in its ${state} state`,
    tags: ["test"],
    render: () => null,
    ...extra,
  };
}

describe("the Documentation page", () => {
  it("lists every state the surface has", () => {
    const sections = documentationFor("Button", [
      story("Button", "default", "primitives"),
      story("Button", "disabled", "primitives"),
      story("Button", "loading", "primitives"),
    ]);
    const states = sections.find((section) => section.heading === "States");
    expect(states?.lines).toHaveLength(3);
    expect(states?.kind).toBe("generated");
  });

  it("names the surface and carries its description in the overview", () => {
    const sections = documentationFor("Button", [story("Button", "default", "primitives")]);
    const overview = sections.find((section) => section.heading === "Overview");
    expect(overview?.lines).toContain("Surface: Button");
    expect(overview?.lines.some((line) => line.includes("default state"))).toBe(true);
  });

  it("counts the declared accessibility levels", () => {
    const sections = documentationFor("Button", [
      story("Button", "default", "primitives"),
      story("Button", "disabled", "primitives", { a11y: "todo" }),
    ]);
    const a11y = sections.find((section) => section.heading === "Accessibility");
    expect(a11y?.lines.some((line) => line.includes("1 story(ies) declared `error`"))).toBe(true);
    expect(a11y?.lines.some((line) => line.includes("1 story(ies) declared `todo`"))).toBe(true);
  });

  it("renders NO authored section for a surface nobody wrote about", () => {
    const sections = documentationFor("Button", [story("Button", "default", "primitives")]);
    expect(sections.filter((section) => section.kind === "authored")).toEqual([]);
    // And no empty section was left behind in its place.
    expect(sections.every((section) => section.lines.length > 0)).toBe(true);
  });

  it("labels the authored half as authored", () => {
    const sections = documentationFor("Button", [
      story("Button", "default", "primitives", {
        docs: {
          whenNotToUse: "Not for a destructive action, which needs the danger variant.",
          content: "Sentence case, a verb first.",
          related: ["IconButton"],
        },
      }),
    ]);
    const authored = sections.filter((section) => section.kind === "authored");
    expect(authored.map((section) => section.heading).sort()).toEqual([
      "Content guidance",
      "Related surfaces",
      "When not to use it",
    ]);
    // The generated half is still there and still labelled generated.
    expect(sections.some((section) => section.kind === "generated")).toBe(true);
  });

  it("takes the title from the story's display name, not the module name", () => {
    expect(documentationTitle("ModalShell", [story("ModalShell", "default", "components")])).toBe(
      "Modal Shell",
    );
  });
});
