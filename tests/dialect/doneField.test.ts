// `done:` — the completion field (MYND-613, task 3).
//
// The twelfth Myne-managed canonical field (§3.6.1), an exact twin of the
// `trashed:` / `archived:` / `deleted:` date-valued trio. A thin named wrapper
// over the generic patcher, with a bespoke value-strict read.
//
// The load-bearing case here is the **quoting asymmetry**: quoting demotes
// checkbox and number values but never dates, so `done: "2026-…Z"` must be
// accepted by this reader AND typed as a date by the derived property index.
// A divergence between the two would mean a note reading complete on one surface
// and incomplete on another — which is why the agreement is asserted directly
// rather than assumed.

import { describe, expect, it } from "vitest";
import { patchDoneField, readDoneFromFmBody } from "../../src/dialect/surgery";
import { coerceValue } from "@myne/editor/host/notes/propertyTyping";
import { MANAGED_FRONTMATTER_FIELDS } from "../../src/dialect/managedFields";
import { enc, dec } from "./_helpers";

const TS = "2026-08-01T09:00:00Z";
const apply = (src: string, value: string | null): string =>
  dec.decode(patchDoneField(enc.encode(src), value));

function fmBodyOf(source: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  return m ? (m[1] ?? "") : "";
}

describe("the managed set", () => {
  it("carries `done` — the field cannot be forgeable by an importer", () => {
    // Task 1 closed a six-field forgery hole and left a note demanding this.
    // Without it, an imported note with `done: <valid ISO date>` reads complete.
    expect([...MANAGED_FRONTMATTER_FIELDS]).toContain("done");
  });
});

describe("the writer", () => {
  it("sets the field on a note with frontmatter", () => {
    const out = apply("---\ntitle: A\n---\n\nbody\n", TS);
    expect(readDoneFromFmBody(fmBodyOf(out))).toBe(TS);
  });

  it("sets the field on a note with no frontmatter at all", () => {
    const out = apply("# Just a body\n", TS);
    expect(readDoneFromFmBody(fmBodyOf(out))).toBe(TS);
  });

  it("changes an existing value in place", () => {
    const first = apply("---\ntitle: A\n---\n\nbody\n", "2026-07-01T00:00:00Z");
    const second = apply(first, TS);
    expect(readDoneFromFmBody(fmBodyOf(second))).toBe(TS);
    expect(second).not.toContain("2026-07-01");
  });

  it("deletes the field on null — un-completion removes the marker", () => {
    const set = apply("---\ntitle: A\n---\n\nbody\n", TS);
    const cleared = apply(set, null);
    expect(readDoneFromFmBody(fmBodyOf(cleared))).toBeNull();
    // Never a falsy value left behind.
    expect(cleared).not.toContain("done:");
  });

  it("collapses the block when deleting the only field", () => {
    const set = apply("# Body\n", TS);
    const cleared = apply(set, null);
    expect(cleared).not.toContain("---");
    expect(cleared).toContain("# Body");
  });

  it("preserves every other managed field, user field and comment byte-for-byte", () => {
    const source =
      "---\ntitle: A\nfolder: Projects/\ntemplate: true\nkind: task\nstatus: open # a comment\n---\n\n# Body\n\ntext\n";
    const out = apply(source, TS);
    for (const fragment of [
      "title: A",
      "folder: Projects/",
      "template: true",
      "kind: task",
      "status: open # a comment",
      "# Body\n\ntext\n",
    ]) {
      expect(out).toContain(fragment);
    }
  });
});

describe("the value-strict reader", () => {
  it("accepts a bare RFC 3339 value", () => {
    expect(readDoneFromFmBody(`done: ${TS}`)).toBe(TS);
  });

  it("accepts a QUOTED RFC 3339 value — quoting must not demote a date", () => {
    expect(readDoneFromFmBody(`done: "${TS}"`)).toBe(TS);
    expect(readDoneFromFmBody(`done: '${TS}'`)).toBe(TS);
  });

  it("leaves the note incomplete on a non-parseable value", () => {
    for (const value of ["yes", "true", "soon", "2026-13-45", "", "tomorrow"]) {
      expect(readDoneFromFmBody(`done: ${value}`)).toBeNull();
    }
  });

  it("leaves the note incomplete when the field is absent", () => {
    expect(readDoneFromFmBody("title: A\nkind: task")).toBeNull();
  });

  it("takes the first `done:` line when a note carries two", () => {
    expect(readDoneFromFmBody(`done: ${TS}\ndone: 2027-01-01T00:00:00Z`)).toBe(TS);
  });

  it("tolerates a trailing comment", () => {
    expect(readDoneFromFmBody(`done: ${TS} # finished early`)).toBe(TS);
  });
});

describe("the strict reader and the property index agree", () => {
  // The divergence this guards against is subtle and would be a real bug: a
  // value one layer calls a completion stamp and the other calls a string.
  const fixtures = [
    { value: TS, quoted: false },
    { value: TS, quoted: true },
    { value: "2026-12-31T23:59:59Z", quoted: false },
    { value: "2026-12-31T23:59:59Z", quoted: true },
  ];

  for (const { value, quoted } of fixtures) {
    it(`agree on ${quoted ? "a quoted" : "a bare"} ${value}`, () => {
      const strict = readDoneFromFmBody(`done: ${quoted ? `"${value}"` : value}`);
      const typed = coerceValue(value);
      expect(strict).toBe(value);
      expect(typed.type).toBe("date");
    });
  }

  it("agree that a non-date is not a completion stamp", () => {
    expect(readDoneFromFmBody("done: soon")).toBeNull();
    expect(coerceValue("soon").type).toBe("string");
  });
});
