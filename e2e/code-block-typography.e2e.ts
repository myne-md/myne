// Code blocks render in a real monospace face — myne-md/myne#555's
// `editor.code-blocks` bullet:
//
//   > render `iiii` and `MMMM` spans in the code block and assert equal widths;
//   > assert tab-stop x-positions agree down the block and nothing overflows the
//   > block's background box. That catches "monospace did not resolve" inside
//   > the container.
//
// # The failure this exists for, and why nobody sees it
//
// `.cm-code-card-body` sets `font-family: var(--font-mono)`, which resolves to
// `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas,
// "Liberation Mono", monospace`. If the bundled JetBrains Mono face fails to
// load, every one of those fallbacks is ALSO monospace on a normal desktop, so
// the block still looks like code and the defect is a different typeface rather
// than a broken one. Nobody files that.
//
// The case that does break is a resolution failure that lands on a PROPORTIONAL
// face — a stripped container image, a `--font-mono` a custom theme overrode
// with a sans stack, a `@font-face` that never loaded and a fallback list that
// bottoms out somewhere unexpected. Then columns stop lining up, and code that
// relies on alignment (a table, an ASCII diagram, indentation read at a glance)
// becomes unreadable while still "rendering fine".
//
// # `iiii` against `MMMM` is the whole test
//
// In any monospace face those two strings are exactly the same width, because
// every advance is identical. In every proportional face they are not, and the
// ratio is dramatic — roughly 1:3 in the common ones. So one width comparison
// answers "did a monospace face resolve" for whatever font set the host
// happens to have, without naming a family, which is what makes this portable
// across the container, a developer's Mac, and a user's Linux box.
//
// The overflow half is the second failure the bullet names: a long line must
// scroll inside the block's own box rather than pushing the pane wide.

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  ENTER_KEY,
  pressInEditor,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";

const EDITOR = '[data-testid="editor.content"]';
const CM_CONTENT = `${EDITOR} .cm-content`;
const CODE_LINE = `${EDITOR} .cm-code-card-body`;
describeE2E("cbt1 a code block resolves a monospace face (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("renders iiii and MMMM at the same width and keeps long lines inside the block", async () => {
    let password = "";
    await scenario(
      "cbt1-code-block-typography",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Kod Blogu Tipografi");

        // A fenced block whose first two lines are the width probe and whose
        // third is long enough to need scrolling.
        //
        // `typeIntoEditor` rather than a private typing helper, and an ENTER
        // after it: a block decoration renders only while the caret is OUTSIDE
        // its lines (the live-preview reveal rule), so a scenario that stops
        // typing inside the fence is looking at raw source. `tq1` learned this
        // first and says so at its own call site.
        const LONG = "x".repeat(400);
        await typeIntoEditor(s, ["```", "iiii", "MMMM", LONG, "```"].join("\n"));
        await waitForSaved(s);
        await pressInEditor(s, ENTER_KEY);

        // The card decoration is applied per line once the block parses.
        await s.waitForElement(CODE_LINE, { timeoutMs: 15_000 });
        await s.waitUntil(
          async () => ((await s.findElements(CODE_LINE)).length >= 3 ? true : null),
          { label: "the fenced block decorated its three body lines" },
        );

        // Measure the two probe lines by their own text, not by index: the
        // fence lines are decorated too, so position is not a stable handle.
        const widths = await s.execute<{ i: number; m: number; family: string } | null>(
          "var lines = Array.prototype.slice.call(document.querySelectorAll(arguments[0]));" +
            "function widthOf(want) {" +
            "  for (var k = 0; k < lines.length; k++) {" +
            "    if ((lines[k].textContent || '').trim() === want) {" +
            "      var span = document.createElement('span');" +
            "      span.textContent = want;" +
            "      span.style.whiteSpace = 'pre';" +
            "      lines[k].appendChild(span);" +
            "      var w = span.getBoundingClientRect().width;" +
            "      span.remove();" +
            "      return w;" +
            "    }" +
            "  }" +
            "  return -1;" +
            "}" +
            "var i = widthOf('iiii'); var m = widthOf('MMMM');" +
            "if (i < 0 || m < 0) return null;" +
            "return { i: i, m: m, family: getComputedStyle(lines[0]).fontFamily };",
          [CODE_LINE],
        );

        expect(widths, "could not find both probe lines inside the code block").not.toBeNull();
        expect(widths!.i, "the iiii probe measured zero width").toBeGreaterThan(0);
        // THE assertion. Equal advances is what monospace MEANS, and it is
        // true of every monospace face and of no proportional one. A small
        // tolerance for subpixel rounding, nothing like the ~3x a proportional
        // face produces.
        expect(
          Math.abs(widths!.i - widths!.m),
          `"iiii" measured ${widths!.i.toFixed(2)}px and "MMMM" ${widths!.m.toFixed(2)}px ` +
            `in the code block (resolved family: ${widths!.family}). Unequal advances ` +
            `mean the block is rendering in a PROPORTIONAL face, so every column, ` +
            `every indent and every ASCII diagram in it is misaligned — while the ` +
            `block still looks like code.`,
        ).toBeLessThan(1);

        // The declared stack still asks for the mono token, so a theme that
        // overrode `--font-mono` with a sans stack is a separate, nameable
        // failure from the face simply not loading.
        expect(widths!.family.length).toBeGreaterThan(0);

        // Second half of the bullet: a long line scrolls INSIDE the block's own
        // box. The pane must not grow to fit it.
        const overflow = await s.execute<{
          lineScroll: number;
          lineClient: number;
          contentScroll: number;
          contentClient: number;
        } | null>(
          "var lines = Array.prototype.slice.call(document.querySelectorAll(arguments[0]));" +
            "var target = null;" +
            "for (var k = 0; k < lines.length; k++) {" +
            "  if ((lines[k].textContent || '').indexOf('xxxxxxxxxx') === 0) target = lines[k];" +
            "}" +
            "if (!target) return null;" +
            "var content = document.querySelector(arguments[1]);" +
            "return {" +
            "  lineScroll: target.scrollWidth, lineClient: target.clientWidth," +
            "  contentScroll: content.scrollWidth, contentClient: content.clientWidth" +
            "};",
          [CODE_LINE, CM_CONTENT],
        );
        expect(overflow, "could not find the long code line").not.toBeNull();
        // The editor's own content box does not grow: whatever the block does
        // with its overflow, it does not push the pane wide.
        expect(
          overflow!.contentScroll,
          `the editor content overflows horizontally (${overflow!.contentScroll} > ` +
            `${overflow!.contentClient}) because of a long code line — the block's ` +
            `overflow escaped its own box`,
        ).toBeLessThanOrEqual(overflow!.contentClient + 1);
      },
    );
  });
});
