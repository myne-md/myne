// @vitest-environment jsdom
//
// HTML→markdown CONFORMANCE CORPUS runner (MYND-580, grill R1/O4).
//
// This is the divergence gate between the TWO HTML→markdown implementations in the
// project: this repo's importer converter and `myne-clipper/src/content/capture.ts`.
// The grill (Q3) deliberately did not merge them, so instead both are pinned against
// these fixture pairs. See `html-fixtures/README.md` for the corpus contract.
//
// Table-driven by DIRECTORY SCAN: adding an `NN-name.html` +
// `NN-name.expected.md` pair needs no edit to this file.
//
// Regenerate expected output after an intentional emit change:
//   UPDATE_HTML_FIXTURES=1 npx vitest run tests/notes/import/html-fixtures.test.ts

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../../src/notes/import/html";

const DIR = join(__dirname, "html-fixtures");
const UPDATE = process.env["UPDATE_HTML_FIXTURES"] === "1";

const cases = readdirSync(DIR)
  .filter((f) => f.endsWith(".html"))
  .sort();

describe("HTML→markdown conformance corpus", () => {
  it("has fixtures to run", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const htmlFile of cases) {
    it(`matches expected markdown — ${htmlFile}`, async () => {
      const html = readFileSync(join(DIR, htmlFile), "utf8");
      const expectedPath = join(DIR, htmlFile.replace(/\.html$/, ".expected.md"));
      const { markdown } = await htmlToMarkdown(html);

      if (UPDATE) {
        writeFileSync(expectedPath, `${markdown}\n`, "utf8");
        return;
      }
      const expected = readFileSync(expectedPath, "utf8").replace(/\n$/, "");
      expect(markdown).toBe(expected);
    });
  }
});

describe("corpus security expectations", () => {
  it("the hostile fixture yields no script, handler, or unsafe URL", async () => {
    const html = readFileSync(join(DIR, "08-hostile-markup.html"), "utf8");
    const { markdown } = await htmlToMarkdown(html);
    for (const forbidden of [
      "script",
      "steal",
      "onclick",
      "javascript:",
      "data:text/html",
      "iframe",
      "evil.test",
      "display: none",
    ]) {
      expect(markdown.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // …while the legitimate surrounding text survives.
    expect(markdown).toContain("Before.");
    expect(markdown).toContain("After.");
  });
});
