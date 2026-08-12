// KaTeX's `trust` option stays off, and the output stays inert (test-audit #16).
//
// WHY THIS EXISTS. Rendered math reaches the DOM through `innerHTML` — that is
// how KaTeX works, and it is not a defect on its own. What makes it a security
// surface is that KaTeX has an option, `trust`, which turns commands like
// `\href`, `\url` and `\includegraphics` from escaped text into real markup and
// real URLs. It defaults to `false`, `editor/src/math/render-math.ts` does not
// set it, and NOTHING pinned that. A future edit adding `trust: true` — or
// `trust: (ctx) => true`, which reads like a convenience — would compile, pass
// every existing test, and turn note content into an HTML-injection channel.
//
// Note bodies are not attacker-controlled in the ordinary case, which is why
// this is a hardening test rather than an active-vulnerability one. But they
// are not purely self-authored either: notes arrive by import, by the browser
// clipper, by share-sheet, and — once a vault is shared — from another device.
// The property worth having is that math NEVER produces a live URL or live
// markup, regardless of where the note came from.
//
// The assertions run through the PRODUCTION renderer — `loadMathRenderer()`
// from `editor/src/math/render-math.ts` — and not through a local
// `katex.renderToString` call with a copy of its options.
//
// That distinction is the whole point, and this test was written the wrong way
// first. A copy of the options passes forever no matter what the real ones say:
// adding `trust: true` to the renderer would leave the copy untouched, the test
// green, and the property gone. It is the same defect the repo's own guard rule
// warns about — a check compared against a second copy of itself. Verified the
// other way too: injecting `trust: true` into the renderer's options makes
// KaTeX emit real `javascript:` hrefs and `<img>` tags, and four of the cases
// below go red.

import { beforeAll, describe, expect, it } from "vitest";
import { loadMathRenderer, type MathRenderer } from "../../src/editor/math/render-math";

let renderer: MathRenderer;
beforeAll(async () => {
  renderer = await loadMathRenderer();
});

/** Render through production. A KaTeX refusal arrives as `error`, not a throw
 *  (the renderer catches), and refusing is the strongest outcome — see below. */
function render(latex: string, displayMode = false): string {
  const { html, error } = renderer(latex, displayMode);
  if (error !== null) return ""; // refused outright
  return html;
}

/** LaTeX whose whole purpose is to become live markup if `trust` is on. */
const HOSTILE = [
  { name: "\\href with a javascript: URL", latex: String.raw`\href{javascript:alert(1)}{x}` },
  { name: "\\href with a data: URL", latex: String.raw`\href{data:text/html,<script>1</script>}{x}` },
  { name: "\\url with a javascript: URL", latex: String.raw`\url{javascript:alert(1)}` },
  { name: "\\includegraphics", latex: String.raw`\includegraphics{https://example.invalid/x.png}` },
];

describe("KaTeX trust (test-audit #16)", () => {
  it.each(HOSTILE)("$name renders no live URL and no anchor", ({ latex }) => {
    // With `trust` off, KaTeX may REFUSE these outright rather than escape
    // them; the renderer reports that as an error and `render` returns "".
    // Refusing is the strongest possible outcome, so an empty string passes
    // every assertion below on its own.
    const html = render(latex);
    // No scheme that executes or embeds, in any form the browser would follow.
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html.toLowerCase()).not.toContain("data:text/html");
    // No anchor and no image element: `trust` off means these commands produce
    // escaped TEXT, never elements with URLs attached.
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toMatch(/<img\s/i);
  });

  it("escapes angle brackets in ordinary math instead of emitting elements", () => {
    // `<` and `>` are legal math. They must arrive as entities, never as tags —
    // the baseline property that stops any of the above from mattering.
    const html = render(String.raw`a < b > c`);
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
    expect(html).not.toMatch(/<script/i);
  });

  it("emits no inline event handler for any input above", () => {
    // A separate axis from URLs: `trust` also gates `\htmlClass` / `\htmlData` /
    // `\htmlId`. None of them may become an on* attribute, and the general form
    // is cheap to assert across the whole hostile set at once.
    for (const { latex } of HOSTILE) {
      expect(render(latex), latex).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });
});
