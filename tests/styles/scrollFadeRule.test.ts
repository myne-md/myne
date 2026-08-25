// The class `useScrollEdges` emits and the rule that DRAWS it are matched by
// nothing: one is a string in TypeScript, the other a selector in CSS, and no
// compiler compares them.
//
// Deleting the whole `.myne-scroll-fade` block from `tokens.css` left the entire
// suite green. The hook keeps measuring, the two attributes keep landing on the
// element, and no fade appears on any screen. That is the shape
// `tests/editor/taskAddLineBox.test.ts` guards for `.cm-task-add`, and it is
// read as text for the same reason: the assertion has to be about the stylesheet
// that ships, not about a value re-declared beside the test.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(
  fileURLToPath(new URL("../../src/styles/tokens.css", import.meta.url)),
  "utf8",
);

/** The literal strings `src/hooks/useScrollEdges.ts` puts in the DOM. */
const CLASS = ".myne-scroll-fade";
const TOP = '[data-fade-top="true"]';
const BOTTOM = '[data-fade-bottom="true"]';

describe("the scroll-fade rule matches what the hook emits", () => {
  it("declares the class the hook sets", () => {
    expect(CSS).toContain(`${CLASS} {`);
  });

  it("keys a mask off each of the two attributes", () => {
    // Both selectors, exactly as the hook spells the attributes. A rule keyed on
    // `data-fade` or `data-fadeTop` would style nothing and look right.
    expect(CSS).toContain(`${CLASS}${TOP}`);
    expect(CSS).toContain(`${CLASS}${BOTTOM}`);
  });

  it("actually paints a mask, prefixed and unprefixed", () => {
    // WKWebView is one of the two engines this ships on and still wants the
    // prefixed property; a rule with only the standard one draws nothing there.
    const block = CSS.slice(CSS.indexOf(`${CLASS}${TOP}`));
    expect(block).toMatch(/-webkit-mask-image:\s*linear-gradient/);
    expect(block).toMatch(/\n\s*mask-image:\s*linear-gradient/);
  });

  it("sizes the fade from a spacing token, not a literal", () => {
    // A number written here is unreachable to a theme that rescales the ramp.
    expect(CSS).toMatch(/--myne-fade:\s*var\(--space-\d\)/);
  });
});
