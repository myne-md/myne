// The plain-file tab strip is a horizontal scroller (`overflow-x: auto`), and
// CSS computes an unpaired `overflow-y` to `auto`: the band becomes a vertical
// scroller too, so a vertical scrollbar can paint over the tabs. `SettingsTabs`
// pairs `overflowY: "hidden"` for exactly this reason, and so must this strip
// (myne-md/myne#49 review follow-up). Read as text because the claim is about
// the style that ships in the source, the same way the scroll-fade rule is
// checked against the stylesheet that ships.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/plain/PlainFileScreen.tsx", import.meta.url)),
  "utf8",
);

describe("the plain-file tab strip pairs overflow-x with overflow-y", () => {
  it("declares overflowX auto", () => {
    expect(SOURCE).toContain('overflowX: "auto"');
  });

  it("pairs it with overflowY hidden immediately after", () => {
    expect(SOURCE).toMatch(/overflowX:\s*"auto",\s*\n\s*overflowY:\s*"hidden",/);
  });
});
