// @vitest-environment jsdom
//
// Table nested inside a blockquote (MYND-208, task 7). Reproduces the tests.md
// "everything at once" block (593-597): a pipe table inside a `>` quote. Before
// the fix, table.ts's whole-line block-replace swallowed the `> ` prefix and
// collided with blockquote.ts's per-line decoration + QuoteMark replace. The
// fix mirrors the fenced-code-in-quote handling (a `tableLines` set: bars-only,
// skip the marker-hide).

import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  mount,
  query,
  roundTripBytes,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

const QUOTED_TABLE =
  "> intro line\n>\n> | Test | Status |\n> |------|:------:|\n" +
  "> | Headings | ok |\n> | Lists | ok |\n\nafter\n";

describe("table inside a blockquote", () => {
  it("renders the quoted table as a real <table> without a decoration collision", () => {
    // The mount itself would throw a RangeSet overlap error before the fix.
    m = mount(QUOTED_TABLE, 0); // cursor off the table → table renders
    expect(query(m, "table")).not.toBeNull();
  });

  it("round-trips the quoted table byte-identical", () => {
    expect(roundTripBytes(QUOTED_TABLE)).toBe(QUOTED_TABLE);
  });
});
