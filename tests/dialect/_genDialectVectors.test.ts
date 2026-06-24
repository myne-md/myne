// Generator for the six dialect parse-recognition vector categories.
//
// This is the TS-side analogue of the protocol crate's `#[ignore]`-gated
// `emit_*_for_paste` generators: regenerating vectors is a deliberate act, so
// the body only runs when GEN_DIALECT_VECTORS=1 is set in the environment;
// otherwise it is a skipped placeholder. It writes one cases.json per category
// into the `myne-test-vectors` companion repo, self-validating each case
// (recognize → at least one span, inert → no spans) before emitting.
//
//   GEN_DIALECT_VECTORS=1 pnpm vitest run tests/dialect/_genDialectVectors.test.ts
//
// The live runner is `dialectParse.test.ts`.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { extractSpans, NODE_SETS, toHex, type DialectSpan } from "./dialectSpans";

type Kind = "recognize" | "inert";
type Spec = { slug: string; kind: Kind; desc: string; source: string };

const VECTORS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../myne-test-vectors/vectors",
);

const SPEC_SECTION: Record<string, string> = {
  footnote: "markdown-dialect.md §3 (footnotes)",
  highlight: "markdown-dialect.md §3 (==highlight==)",
  wikilink: "markdown-dialect.md §3 ([[wikilinks]])",
  "definition-list": "markdown-dialect.md §3 (definition lists)",
  "inline-tag": "markdown-dialect.md §3 (#inline-tags)",
  math: "markdown-dialect.md §3 ($inline math$)",
};

const DESCRIPTION: Record<string, string> = {
  footnote:
    "Pins the Myne dialect footnote parser (src/dialect/lezer/footnote.ts) — which byte ranges are recognized as FootnoteDefinition / FootnoteReference / FootnoteLabel / FootnoteMark. Offsets are UTF-8 byte offsets. recognize cases carry the recognized spans (pre-order); inert cases carry an empty span list (a near-miss the parser must NOT recognize). TS-runner category (no Rust generator).",
  highlight:
    "Pins the Myne dialect highlight parser (src/dialect/lezer/highlight.ts) — which byte ranges are recognized as Highlight / HighlightMark. UTF-8 byte offsets. recognize cases carry the spans; inert cases carry an empty list. TS-runner category.",
  wikilink:
    "Pins the Myne dialect wikilink parser (src/dialect/lezer/wikilink.ts) — which byte ranges are recognized as Wikilink / WikilinkMark / WikilinkTarget / WikilinkAlias / WikilinkHeading / WikilinkBlockId. UTF-8 byte offsets. recognize cases carry the spans; inert cases carry an empty list. TS-runner category.",
  "definition-list":
    "Pins the Myne dialect definition-list parser (src/dialect/lezer/definition-list.ts) — which byte ranges are recognized as DefinitionList / DefinitionTerm / DefinitionDesc / DefinitionMarker. UTF-8 byte offsets. recognize cases carry the spans; inert cases carry an empty list. TS-runner category.",
  "inline-tag":
    "Pins the Myne dialect inline-tag parser (src/dialect/lezer/inline-tag.ts) — which byte ranges are recognized as InlineTag. UTF-8 byte offsets. recognize cases carry the spans; inert cases (ATX heading, hash-with-space) carry an empty list. TS-runner category.",
  math:
    "Pins the Myne dialect inline-math parser (src/dialect/lezer/math.ts) — which byte ranges are recognized as InlineMath / MathMark. UTF-8 byte offsets. recognize cases carry the spans; inert cases (currency, block $$…$$) carry an empty list. TS-runner category.",
};

const SPECS: Record<string, Spec[]> = {
  footnote: [
    { slug: "reference-and-definition", kind: "recognize", desc: "An inline footnote reference plus its matching block definition.", source: "See[^1].\n\n[^1]: The cited note." },
    { slug: "reference-only", kind: "recognize", desc: "A bare footnote reference with no definition in the document.", source: "A claim[^src] stands." },
    { slug: "two-references", kind: "recognize", desc: "Two footnote references in one paragraph.", source: "a[^1] then b[^2]" },
    { slug: "inert-plain-brackets", kind: "inert", desc: "Ordinary square brackets with no caret are not a footnote.", source: "an [example] in brackets" },
    { slug: "inert-caret-space", kind: "inert", desc: "A space after the caret breaks footnote recognition.", source: "x [^ y] z" },
  ],
  highlight: [
    { slug: "basic", kind: "recognize", desc: "A simple ==highlight== span.", source: "==important==" },
    { slug: "midsentence", kind: "recognize", desc: "A highlight embedded in a sentence.", source: "a ==marked== word" },
    { slug: "inert-single-equals", kind: "inert", desc: "A lone equals sign is not a highlight.", source: "a = b" },
    { slug: "inert-unterminated", kind: "inert", desc: "An unterminated ==open span is not recognized.", source: "==open and never closed" },
  ],
  wikilink: [
    { slug: "target-only", kind: "recognize", desc: "A plain [[Page]] wikilink.", source: "[[Page]]" },
    { slug: "with-alias", kind: "recognize", desc: "A wikilink with a |Alias.", source: "[[Page|Display]]" },
    { slug: "with-heading", kind: "recognize", desc: "A wikilink targeting a #Heading.", source: "[[Page#Section]]" },
    { slug: "with-block-id", kind: "recognize", desc: "A wikilink targeting a ^block id (caret delimiter, distinct from the # heading form).", source: "[[Page^b12]]" },
    { slug: "inert-markdown-link", kind: "inert", desc: "A normal [text](url) markdown link is not a wikilink.", source: "[text](http://x)" },
  ],
  "definition-list": [
    { slug: "single", kind: "recognize", desc: "A term with one definition.", source: "Term\n: Definition" },
    { slug: "two-definitions", kind: "recognize", desc: "A term with two definitions.", source: "Term\n: One\n: Two" },
    { slug: "inert-plain-paragraph", kind: "inert", desc: "A paragraph with no colon-led line is not a definition list.", source: "Just an ordinary paragraph." },
  ],
  "inline-tag": [
    { slug: "basic", kind: "recognize", desc: "A simple #tag.", source: "a #project here" },
    { slug: "nested", kind: "recognize", desc: "A nested #parent/child tag.", source: "see #area/sub today" },
    { slug: "inert-atx-heading", kind: "inert", desc: "An ATX heading hash is not an inline tag.", source: "# Heading" },
    { slug: "inert-hash-space", kind: "inert", desc: "A hash followed by a space is not an inline tag.", source: "a # b" },
  ],
  math: [
    { slug: "inline-basic", kind: "recognize", desc: "A simple $inline math$ span.", source: "$E=mc^2$" },
    { slug: "inline-midsentence", kind: "recognize", desc: "Inline math embedded in a sentence.", source: "the value $x_0$ holds" },
    { slug: "inert-currency", kind: "inert", desc: "Currency amounts are not inline math.", source: "it cost $5 and $10" },
    { slug: "inert-block-math", kind: "inert", desc: "Block $$…$$ math is not an InlineMath node.", source: "$$x=y$$" },
  ],
};

function buildCategory(category: string): string {
  const specs = SPECS[category];
  const cases = specs.map((s) => {
    const spans: DialectSpan[] = extractSpans(s.source, category);
    // Self-validation at mint, mirroring the Rust generators.
    if (s.kind === "recognize" && spans.length === 0) {
      throw new Error(`[${category}/${s.slug}] recognize case produced no spans`);
    }
    if (s.kind === "inert" && spans.length !== 0) {
      throw new Error(
        `[${category}/${s.slug}] inert case produced spans: ${JSON.stringify(spans)}`,
      );
    }
    return {
      vector_id: `${category}/v0.1/${s.slug}`,
      description: s.desc,
      case_kind: s.kind,
      input_markdown_utf8_hex: toHex(s.source),
      informational_markdown: s.source,
      expected_dialect_spans: spans,
    };
  });
  const doc = {
    schema: category,
    protocol_version: "v0.1",
    spec_section: SPEC_SECTION[category],
    description: DESCRIPTION[category],
    cases,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

const ENABLED = process.env.GEN_DIALECT_VECTORS === "1";
const maybe = ENABLED ? describe : describe.skip;

maybe("regenerate dialect parse-recognition vectors", () => {
  for (const category of Object.keys(SPECS)) {
    it(`writes ${category}/v0.1/cases.json`, () => {
      const out = buildCategory(category);
      const dir = path.join(VECTORS_DIR, category, "v0.1");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "cases.json"), out);
      console.warn(`[ok] wrote ${category}/v0.1/cases.json`);
    });
  }
});
