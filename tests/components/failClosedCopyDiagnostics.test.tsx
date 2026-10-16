// @vitest-environment jsdom
//
// The Copy-diagnostics affordance on the fail-closed card (myne-md/myne#860).
//
// `FailClosedError`'s `code` prop is what makes the affordance render at all,
// and the branch turned it live at five cards across three screens plus
// `RootErrorBoundary`. Before this spec nothing asserted either half: a card
// rendered WITH a code never had its button checked, and nothing pinned that a
// card WITHOUT one renders no button. The pair matters because the prop is
// optional, so a call site can silently ship the card without the affordance the
// feature exists for. The source-wiring case below holds every call site to
// passing it, because the component pair alone would stay green if the five
// `code=` props were removed.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FailClosedError } from "../../src/components/FailClosedError";

afterEach(() => cleanup());

describe("the fail-closed Copy-diagnostics affordance", () => {
  it("renders the button, carrying the code, when a code is passed", () => {
    render(
      <FailClosedError
        reason={{ kind: "invalid-state" }}
        code="invalid-state"
        onCtaClick={() => {}}
      />,
    );
    const button = screen.getByTestId("fail-closed.copy-diagnostics");
    // The code reaches `data-code`, which is where a user reading the card, and
    // a scenario, can still get it when the clipboard is refused.
    expect(button.getAttribute("data-code")).toBe("invalid-state");
  });

  it("renders no button when no code is passed", () => {
    render(<FailClosedError reason={{ kind: "invalid-state" }} onCtaClick={() => {}} />);
    expect(screen.queryByTestId("fail-closed.copy-diagnostics")).toBeNull();
  });
});

describe("every fail-closed call site passes a code", () => {
  // The three screens and the root boundary are the whole reason the prop
  // exists. Removing one `code=` leaves the card rendering and every other test
  // green, which is exactly the silent regression this feature was opened to
  // fix, so the wiring is held here rather than trusted to review.
  const CALL_SITE_FILES = [
    "src/screens/Editor.tsx",
    "src/screens/Unlock.tsx",
    "src/screens/VaultRecover.tsx",
    "src/components/RootErrorBoundary.tsx",
  ];

  /** The text of each `<FailClosedError ... />` opening tag in a source file.
   *  Comments are stripped first, because several files NAME the surface in
   *  prose (`<FailClosedError reason="invalid-state" />` in a doc comment is not
   *  a call site). Braces are then tracked so a `>` inside a prop (an arrow
   *  function) does not end the tag early, and `/>` ends it only at depth zero. */
  function failClosedTags(source: string): string[] {
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const tags: string[] = [];
    const needle = "<FailClosedError";
    let at = stripped.indexOf(needle);
    while (at !== -1) {
      let depth = 0;
      let end = at + needle.length;
      for (; end < stripped.length; end += 1) {
        const ch = stripped[end];
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
        else if (ch === "/" && stripped[end + 1] === ">" && depth === 0) {
          end += 2;
          break;
        }
      }
      tags.push(stripped.slice(at, end));
      at = stripped.indexOf(needle, end);
    }
    return tags;
  }

  it("passes `code` at every call site", () => {
    let checked = 0;
    for (const rel of CALL_SITE_FILES) {
      const source = readFileSync(resolve(process.cwd(), rel), "utf8");
      for (const tag of failClosedTags(source)) {
        expect(tag, `${rel} has a FailClosedError with no code prop`).toContain(
          "code={failClosedCode(",
        );
        checked += 1;
      }
    }
    // Non-vacuity: the parser found the six call sites rather than an empty
    // list, so a broken walk fails here instead of passing over nothing.
    expect(checked).toBe(6);
  });
});
