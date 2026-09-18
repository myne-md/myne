// Field parser: three dialects to one typed record (MYND-611, task 2).
//
// The contract this pins is dialect-equivalence: a task written in Obsidian's emoji
// form, in Obsidian's Dataview form, and in Myne's own form must produce the SAME
// record. That is what makes the Obsidian importer honest — an imported vault's
// tasks light up whichever form the user happened to have.
//
// It also pins the two refusals, which are easy to erode later:
//   - `onCompletion` is never interpreted (it is a miniature action language, and
//     interpreting it crosses the no-code-eval line the epic defends elsewhere) —
//     but its bytes are still preserved, or a whole-line rewrite would delete it.
//   - no timezone offset or zone id is ever produced; a value carrying one does not
//     type at all, rather than being silently normalized into local time.

import { describe, expect, it } from "vitest";
import { parseTaskFields } from "../../src/dialect/taskFields";

describe("dialect equivalence", () => {
  const emoji = "- [x] ship the thing ✅ 2026-07-27 📅 2026-08-01 🔁 every week ⏫";
  const obsidianDataview =
    "- [x] ship the thing [completion:: 2026-07-27] [due:: 2026-08-01] [repeat:: every week] [priority:: high]";
  const myne =
    "- [x] ship the thing [done:: 2026-07-27] [due:: 2026-08-01] [repeat:: every week] [priority:: high]";

  it("produces an identical record from all three dialects", () => {
    const a = parseTaskFields(emoji);
    const b = parseTaskFields(obsidianDataview);
    const c = parseTaskFields(myne);

    expect(a.due).toEqual({ date: "2026-08-01" });
    expect(a.done).toEqual({ date: "2026-07-27" });
    expect(a.repeat).toBe("every week");
    expect(a.priority).toBe("high");

    expect(b.due).toEqual(a.due);
    expect(b.done).toEqual(a.done);
    expect(b.repeat).toBe(a.repeat);
    expect(b.priority).toBe(a.priority);

    expect(c.due).toEqual(a.due);
    expect(c.done).toEqual(a.done);
    expect(c.repeat).toBe(a.repeat);
    expect(c.priority).toBe(a.priority);
  });

  it("maps Obsidian's `completion` onto Myne's `done`", () => {
    expect(parseTaskFields("- [x] x [completion:: 2026-07-27]").done).toEqual({
      date: "2026-07-27",
    });
  });
});

describe("due", () => {
  it("parses a date-only due", () => {
    expect(parseTaskFields("- [ ] x [due:: 2026-08-01]").due).toEqual({ date: "2026-08-01" });
  });

  it("parses a due carrying a time of day", () => {
    expect(parseTaskFields("- [ ] x [due:: 2026-08-01 14:30]").due).toEqual({
      date: "2026-08-01",
      time: "14:30",
    });
  });

  it("accepts the T separator as well as a space", () => {
    expect(parseTaskFields("- [ ] x [due:: 2026-08-01T14:30]").due).toEqual({
      date: "2026-08-01",
      time: "14:30",
    });
  });

  it("parses the emoji form with a time", () => {
    expect(parseTaskFields("- [ ] x 📅 2026-08-01 14:30").due).toEqual({
      date: "2026-08-01",
      time: "14:30",
    });
  });
});

describe("remind is independent of due", () => {
  it("parses without a due present", () => {
    const r = parseTaskFields("- [ ] call mother [remind:: 2026-07-29 09:00]");
    expect(r.remind).toEqual({ date: "2026-07-29", time: "09:00" });
    expect(r.due).toBeUndefined();
  });

  it("parses alongside a due with a different date", () => {
    const r = parseTaskFields("- [ ] x [due:: 2026-08-07] [remind:: 2026-08-03 08:00]");
    expect(r.due).toEqual({ date: "2026-08-07" });
    expect(r.remind).toEqual({ date: "2026-08-03", time: "08:00" });
  });

  it("parses the emoji form", () => {
    expect(parseTaskFields("- [ ] x ⏰ 2026-07-29 09:00").remind).toEqual({
      date: "2026-07-29",
      time: "09:00",
    });
  });
});

describe("priority", () => {
  it("parses every word form", () => {
    const words = ["highest", "high", "medium", "low", "lowest"] as const;
    for (const w of words) {
      expect(parseTaskFields(`- [ ] x [priority:: ${w}]`).priority).toBe(w);
    }
  });

  it("parses every emoji form", () => {
    const pairs: [string, string][] = [
      ["🔺", "highest"],
      ["⏫", "high"],
      ["🔼", "medium"],
      ["🔽", "low"],
      ["⏬", "lowest"],
    ];
    for (const [emoji, word] of pairs) {
      expect(parseTaskFields(`- [ ] x ${emoji}`).priority).toBe(word);
    }
  });

  it("is case-insensitive on the word form", () => {
    expect(parseTaskFields("- [ ] x [priority:: HIGH]").priority).toBe("high");
  });

  it("does not type an unknown priority word", () => {
    const r = parseTaskFields("- [ ] x [priority:: urgent]");
    expect(r.priority).toBeUndefined();
    expect(r.malformed.map((f) => f.key)).toContain("priority");
  });
});

describe("unsupported-but-preserved", () => {
  it("captures every Obsidian key Myne does not type", () => {
    const src =
      "- [ ] x [scheduled:: 2026-08-05] [start:: 2026-08-01] [cancelled:: 2026-08-09] [created:: 2026-07-01] [id:: abc] [dependsOn:: xyz]";
    const keys = parseTaskFields(src).preserved.map((f) => f.key);
    expect(keys).toEqual([
      "scheduled",
      "start",
      "cancelled",
      "created",
      "id",
      "dependsOn",
    ]);
  });

  it("preserves the raw value verbatim", () => {
    const r = parseTaskFields("- [ ] x [scheduled:: 2026-08-05]");
    expect(r.preserved[0]).toMatchObject({ key: "scheduled", value: "2026-08-05" });
  });

  it("captures the emoji forms of unsupported keys under their Obsidian names", () => {
    const keys = parseTaskFields("- [ ] x ⏳ 2026-08-05 🛫 2026-08-01").preserved.map(
      (f) => f.key,
    );
    expect(keys).toEqual(["scheduled", "start"]);
  });

  it("keeps unsupported fields out of the typed slots", () => {
    const r = parseTaskFields("- [ ] x [scheduled:: 2026-08-05]");
    expect(r.due).toBeUndefined();
    expect(r.remind).toBeUndefined();
  });
});

describe("onCompletion is preserved but never interpreted", () => {
  it("does not appear as a typed field", () => {
    const r = parseTaskFields("- [ ] x [onCompletion:: delete]") as Record<string, unknown>;
    expect(r.onCompletion).toBeUndefined();
  });

  it("is preserved verbatim so a whole-line rewrite cannot delete it", () => {
    // Task 4 converts the WHOLE line on edit, so anything absent from the record
    // is lost on the next write. Preservation is what keeps that from being a
    // data-loss bug; refusing to *interpret* it is the separate, deliberate part.
    const r = parseTaskFields("- [ ] x [onCompletion:: delete]");
    expect(r.preserved).toEqual([
      expect.objectContaining({ key: "onCompletion", value: "delete" }),
    ]);
  });

  it("carries no action semantics of any kind", () => {
    const r = parseTaskFields("- [ ] x [onCompletion:: delete]");
    const field = r.preserved[0];
    expect(Object.keys(field).sort()).toEqual(["key", "raw", "value"]);
  });
});

describe("no timezone offset or zone identifier is ever produced", () => {
  it("refuses a value carrying a Z offset rather than normalizing it", () => {
    const r = parseTaskFields("- [ ] x [due:: 2026-08-01T10:00:00Z]");
    expect(r.due).toBeUndefined();
    expect(r.malformed.map((f) => f.key)).toContain("due");
  });

  it("refuses a value carrying a numeric offset", () => {
    const r = parseTaskFields("- [ ] x [due:: 2026-08-01T10:00:00+03:00]");
    expect(r.due).toBeUndefined();
    expect(r.malformed.map((f) => f.key)).toContain("due");
  });

  it("never emits an offset or zone key on a typed value", () => {
    const r = parseTaskFields("- [ ] x [due:: 2026-08-01 14:30] [remind:: 2026-08-01 09:00]");
    for (const v of [r.due, r.remind]) {
      expect(Object.keys(v!).sort()).toEqual(["date", "time"]);
    }
  });
});

describe("malformed values", () => {
  it("does not type a half-written date", () => {
    const r = parseTaskFields("- [ ] x [due:: 2026-08]");
    expect(r.due).toBeUndefined();
    expect(r.malformed.map((f) => f.key)).toContain("due");
  });

  it("does not silently correct an impossible date", () => {
    const r = parseTaskFields("- [ ] x [due:: 2026-02-31]");
    expect(r.due).toBeUndefined();
    expect(r.malformed[0].value).toBe("2026-02-31");
  });

  it("does not type an out-of-range time", () => {
    expect(parseTaskFields("- [ ] x [due:: 2026-08-01 25:00]").due).toBeUndefined();
  });
});

describe("shape", () => {
  it("returns empty collections for a task with no fields", () => {
    const r = parseTaskFields("- [ ] just a task");
    expect(r).toEqual({ preserved: [], malformed: [] });
  });

  it("returns empty collections for a line that is not a task at all", () => {
    expect(parseTaskFields("ordinary prose")).toEqual({ preserved: [], malformed: [] });
  });

  it("takes the first occurrence when a key repeats", () => {
    const r = parseTaskFields("- [ ] x [due:: 2026-08-01] [due:: 2026-09-01]");
    expect(r.due).toEqual({ date: "2026-08-01" });
  });

  // myne-md/myne#703: a second telling is data, not a duplicate to drop. The
  // writer re-emits the whole line from the record, so a repeat that never
  // reaches the record is deleted by the next write.
  it("preserves a repeated typed key instead of dropping it", () => {
    const r = parseTaskFields("- [ ] x [due:: 2026-08-01] [due:: 2026-09-01]");
    expect(r.due).toEqual({ date: "2026-08-01" });
    expect(r.preserved).toMatchObject([{ key: "due", value: "2026-09-01" }]);
  });

  it("preserves repeated priority markers in both dialects", () => {
    const words = parseTaskFields("- [ ] x [priority:: high] [priority:: low]");
    expect(words.priority).toBe("high");
    expect(words.preserved).toMatchObject([{ key: "priority", value: "low" }]);

    const emoji = parseTaskFields("- [ ] x 🔺 ⏫");
    expect(emoji.priority).toBe("highest");
    expect(emoji.preserved).toMatchObject([{ key: "priority", value: "high" }]);
  });

  it("preserves a repeated repeat rule", () => {
    const r = parseTaskFields("- [ ] x 🔁 every day 🔁 every week");
    expect(r.repeat).toBe("every day");
    expect(r.preserved).toMatchObject([{ key: "repeat", value: "every week" }]);
  });

  it("keeps an empty repeat as malformed instead of dropping it", () => {
    const r = parseTaskFields("- [ ] x [repeat:: ]");
    expect(r.repeat).toBeUndefined();
    expect(r.malformed.map((f) => f.key)).toEqual(["repeat"]);
  });

  it("keeps a bare repeat marker as malformed", () => {
    const r = parseTaskFields("- [ ] x 🔁");
    expect(r.repeat).toBeUndefined();
    expect(r.malformed.map((f) => f.key)).toEqual(["repeat"]);
  });

  it("keeps a repeat value the emitted form cannot carry as preserved", () => {
    // `[repeat:: every ]day]` would terminate the value at the first `]` on
    // re-parse, so the value never reaches the slot — or the writer could not
    // re-emit it. It stays verbatim in the record either way.
    const r = parseTaskFields("- [ ] x 🔁 every ]day");
    expect(r.repeat).toBeUndefined();
    expect(r.preserved).toMatchObject([{ key: "repeat", value: "every ]day" }]);
  });
});
