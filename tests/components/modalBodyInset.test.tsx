// The modal body gets its inset ONCE (myne-md/myne#945 item 07).
//
// # The defect this pins, and why it needs a machine check
//
// `ModalShell` supplies the body inset (`padding: var(--space-5)` on
// `.myne-modal-body`). Before myne-md/myne#945 every caller supplied its own, and
// the ones that FORGOT sat flush against the card edge: the owner reported it on
// the display-name dialog, and it was the third time the same defect shipped
// (myne-md/myne#843, myne-md/myne#847, and then #945). Moving the inset into the
// primitive is only half the fix; the other half is that a caller which keeps its
// own copy now DOUBLE-insets, which looks like a deliberately generous dialog
// rather than a bug, so nothing points at it. That is a defect nobody reports.
//
// So: a `ModalShell` caller that does not opt into `bodyBleed` may not re-apply
// the same inset inside the body. `bodyBleed` is the sanctioned shape for a body
// that draws its own edge-to-edge chrome (a scrolling region beside a bordered
// footer), and it is a visible decision at the call site.
//
// # Why a source scan rather than a render assertion
//
// jsdom computes no layout, so a rendered dialog cannot be asked whether its
// content is inset twice: the two paddings are on different elements and nothing
// in the DOM says they add up. What IS checkable is the shape of the source,
// which is also how the sibling rule is held (`tests/a11y/accessibleAuth.test.tsx`
// scans credential surfaces the same way).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const TREES = ["src", "web/src", "mobile/src"];
/** The inset `ModalShell` supplies. A caller re-applying it is the defect. */
const INSET_RE = /padding:\s*"(?:var\(--space-5\)[^"]*)"/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    const abs = join(ROOT, rel);
    if (statSync(abs).isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__") continue;
      out.push(...sources(rel));
      continue;
    }
    if ([".tsx", ".ts"].includes(extname(entry))) out.push(rel);
  }
  return out;
}

/** Every `<ModalShell …>…</ModalShell>` block in one source, with its file. */
function modalBlocks(rel: string): Array<{ rel: string; block: string }> {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const blocks: Array<{ rel: string; block: string }> = [];
  const open = /<ModalShell\b/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(src)) !== null) {
    // The opening tag ends at the first `>` that is not inside an expression:
    // every prop value here is simple, and a self-closing shell renders no body.
    const close = src.indexOf("</ModalShell>", match.index);
    if (close < 0) continue;
    blocks.push({ rel, block: src.slice(match.index, close) });
  }
  return blocks;
}

/** The `const NAME … = { … }` body of a style object defined in `rel`. */
function styleObject(rel: string, name: string): string | null {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const start = src.search(new RegExp(`const ${name}\\b[^=]*= \\{`));
  if (start < 0) return null;
  const end = src.indexOf("\n};", start);
  return end < 0 ? null : src.slice(start, end);
}

describe("the modal body inset is applied once", () => {
  const blocks = TREES.flatMap((tree) => sources(tree)).flatMap(modalBlocks);

  it("finds the call sites at all", () => {
    // A scan that finds nothing is green, which is the failure mode every
    // source-scanning guard has to defend against.
    expect(blocks.length).toBeGreaterThan(20);
  });

  it.each(blocks.map((b) => [b.rel, b] as const))(
    "%s does not re-apply the body inset",
    (rel, { block }) => {
      if (/\bbodyBleed\b/.test(block)) return;

      // Inline first: `style={{ padding: "var(--space-5)" }}` inside the body.
      const inline = block.match(INSET_RE);
      expect(
        inline,
        `${rel} applies the modal body inset itself while leaving bodyBleed off, so ` +
          `the dialog is inset twice. Either drop the padding (ModalShell supplies it) ` +
          `or pass bodyBleed if this body draws its own edge-to-edge chrome.`,
      ).toBeNull();

      // Then the style objects the block reaches for. A style that draws its
      // own BOX (a border, a fill, a radius) is padding its own content, which is
      // what a dashed drop zone or a nested panel is for: the inset outside that
      // border is a different inset and the two do not read as one generous gap.
      // It is the plain WRAPPER re-padding the body that this test is about.
      for (const [, name] of block.matchAll(/style=\{([A-Z][A-Z0-9_]*)\}/g)) {
        const body = styleObject(rel, name!);
        if (body === null) continue;
        if (/\b(border|borderRadius|background)\b/.test(body)) continue;
        expect(
          body.match(INSET_RE),
          `${rel} renders style ${name} inside a ModalShell body that does not pass ` +
            `bodyBleed, and ${name} carries padding: var(--space-5), so the dialog is ` +
            `inset twice. Drop the padding, or pass bodyBleed.`,
        ).toBeNull();
      }
    },
  );
});
