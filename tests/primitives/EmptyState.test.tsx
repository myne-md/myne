// @vitest-environment jsdom
//
// `<EmptyState>` — which zero states carry the brand field, and which own their
// surface (myne-md/myne#776, epic #772).
//
// Both are defaults, and a default is exactly the kind of thing that drifts
// back without anybody deciding to change it: the field was opt-in for a round
// and ended up on ONE of four variants, and the panel adapter asked for `sm` on
// the strength of a comment describing callers it did not have.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EmptyState } from "../../src/components/primitives/EmptyState";
import { PanelEmptyState } from "../../src/notes/components/PanelEmptyState";

beforeEach(() => {
  // jsdom ships no 2D context, and `mountBinaryField` bails to a no-op handle
  // without one — which would make every assertion below pass for the wrong
  // reason if it were about the canvas's CONTENT. It is about the element.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const VARIANTS = ["firstRun", "filtered", "error", "loading"] as const;

describe("the field is on for every variant", () => {
  it.each(VARIANTS)("%s draws one", (variant) => {
    // Giving the texture to `firstRun` alone made the other three look like a
    // different product. The variants already differ in the two ways that
    // matter — the words and the action they offer.
    const { container } = render(
      <EmptyState variant={variant} icon="file-text" title="Nothing here" />,
    );
    expect(container.querySelector("canvas.myne-empty__field")).not.toBeNull();
  });

  it.each(["sm", "md", "lg"] as const)("%s draws one too", (size) => {
    // `sm` used to suppress it, which made the first surface a new user sees —
    // an empty note list — the only one with no brand on it.
    const { container } = render(
      <EmptyState variant="firstRun" icon="file-text" title="x" size={size} />,
    );
    expect(container.querySelector("canvas.myne-empty__field")).not.toBeNull();
  });

  it("is still refusable, and then mounts nothing at all", () => {
    // Not merely hidden: a mounted field holds an IntersectionObserver, a
    // MutationObserver, four listeners and a candidate budget slot, so hiding
    // one in CSS would cost everything and draw nothing.
    const { container } = render(
      <EmptyState variant="firstRun" icon="file-text" title="x" field={false} />,
    );
    expect(container.querySelector("canvas.myne-empty__field")).toBeNull();
  });
});

describe("a filled state marks itself so the CSS can drop the card", () => {
  it("sets data-fill only when asked", () => {
    const { container: plain } = render(
      <EmptyState variant="firstRun" icon="file-text" title="x" />,
    );
    expect(plain.querySelector(".myne-empty")?.getAttribute("data-fill")).toBeNull();

    cleanup();
    const { container: filled } = render(
      <EmptyState variant="firstRun" icon="file-text" title="x" fill />,
    );
    expect(filled.querySelector(".myne-empty")?.getAttribute("data-fill")).toBe("true");
  });

  it("is what the Archive and Trash panels ask for", () => {
    // Their shell is a 560 × min(78vh, 720px) modal. Without this the state was
    // a ~200px bordered card at the top of it with the rest of the modal empty,
    // which is the shape the user reported: the box they were looking at and
    // the box the words were in were two different rectangles.
    render(
      <PanelEmptyState
        icon="archive"
        title="Nothing archived"
        body="Archived notes are kept here."
        testId="archive.empty-state"
      />,
    );
    const el = screen.getByTestId("archive.empty-state");
    expect(el.getAttribute("data-fill"), "the panel state must fill its modal").toBe(
      "true",
    );
    expect(
      el.getAttribute("data-size"),
      "and at sidebar size it would leave the words two words per line",
    ).toBe("md");
  });
});

describe("a settings block's zero state carries the field too", () => {
  // It did not, for one round, and the argument was sound at the time: a brand
  // animation inside a column of a dozen settings blocks pulls the eye off the
  // setting above it. What changed is the animation. The glow came off the
  // cursor and onto a slow randomized orbit, so the field no longer flares
  // wherever the pointer happens to go, and there is nothing in it to catch an
  // eye reading past it.
  //
  // A source assertion rather than a render one on purpose: what must hold is
  // that the three blocks agree, and a render test of one would leave the other
  // two free to drift back. Same reasoning the repo's guards use, at the size
  // of three call sites.
  const SETTINGS_ZERO_STATES = [
    "src/components/settings/CustomThemesSection.tsx",
    "src/components/settings/ConnectedExtensions.tsx",
    "src/components/settings/MemorySection.tsx",
  ] as const;

  for (const file of SETTINGS_ZERO_STATES) {
    it(`${file} keeps the 01 field, at the small size`, () => {
      // Resolved from the project root rather than from `import.meta.url`:
      // under the jsdom environment the global `URL` is jsdom's, and node's
      // `fileURLToPath` does not agree with it about a relative base.
      const src: string = readFileSync(resolve(process.cwd(), file), "utf8");
      const at = src.indexOf("<EmptyState");
      expect(at, `${file} no longer uses the shared zero state`).toBeGreaterThan(-1);
      const call = src.slice(at, src.indexOf("/>", at));
      expect(call, `${file} opts out of the field`).not.toContain("field={false}");
      expect(call, `${file} should be the small size in a settings block`).toContain(
        'size="sm"',
      );
    });
  }
});
