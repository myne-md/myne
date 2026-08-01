// The task index's wire decoder (myne-md/myne-mobile#36).
//
// The decoder is one small function, and every interesting thing about it is a
// case it must NOT touch. `VaultTask` carries three legitimately-nullable fields
// alongside the five `Option<String>` ones, and `lineIndex: null` is the
// note-task discriminator — so "drop the nulls" written one degree too broadly
// turns every note-task into a malformed line-task, silently, on both clients at
// once. Those non-cases are what this file mostly asserts.

import { describe, expect, it } from "vitest";
import { fromWire, type VaultTaskWire } from "../../src/notes/taskWire";

const OPTIONAL_STRINGS = ["due", "repeat", "done", "priority", "remind"] as const;

function wire(over: Partial<VaultTaskWire> = {}): VaultTaskWire {
  return {
    noteId: "n1",
    noteTitle: "Alpha",
    noteFolder: null,
    lineIndex: 3,
    rawLine: "- [ ] pay the rent",
    completed: false,
    oversized: false,
    ...over,
  };
}

describe("the wire decoder", () => {
  it("turns every `Option<String>` null into an absent key, not a present undefined", () => {
    // Both halves matter: a consumer reading `task.due` is satisfied by
    // `undefined`, but a consumer spreading the row, comparing it, or asserting
    // on its keys is not — and `Object.hasOwn` is the only check that tells them
    // apart.
    const row = fromWire(
      wire({ due: null, repeat: null, done: null, priority: null, remind: null }),
    );
    for (const key of OPTIONAL_STRINGS) {
      expect(row[key], `${key} must not be null`).toBeUndefined();
      expect(Object.hasOwn(row, key), `${key} must be absent, not present-undefined`).toBe(false);
    }
  });

  it("passes a present value through untouched", () => {
    const row = fromWire(
      wire({
        due: "2026-08-01 14:30",
        repeat: "every week",
        done: "2026-07-30",
        priority: "high",
        remind: "2026-07-31 09:00",
      }),
    );
    expect(row.due).toBe("2026-08-01 14:30");
    expect(row.repeat).toBe("every week");
    expect(row.done).toBe("2026-07-30");
    expect(row.priority).toBe("high");
    expect(row.remind).toBe("2026-07-31 09:00");
  });

  it("keeps a null `lineIndex` — the locator is the note-task discriminator", () => {
    // The one null this decoder must never touch. `lineIndex: null` means "whole
    // note declared a unit of work", and a write against it is a frontmatter
    // patch rather than line surgery. Stripping it would not merely lose a
    // field, it would re-classify the record.
    const row = fromWire(wire({ lineIndex: null, due: null }));
    expect(row.lineIndex).toBeNull();
    expect(Object.hasOwn(row, "lineIndex")).toBe(true);
    expect(Object.hasOwn(row, "due")).toBe(false);
  });

  it("keeps a null `noteTitle` and `noteFolder` — both are legitimately nullable", () => {
    const row = fromWire(wire({ noteTitle: null, noteFolder: null }));
    expect(row.noteTitle).toBeNull();
    expect(row.noteFolder).toBeNull();
  });

  it("leaves a row that carries no optional fields alone", () => {
    const row = fromWire(wire());
    for (const key of OPTIONAL_STRINGS) {
      expect(Object.hasOwn(row, key), `${key} must stay absent`).toBe(false);
    }
    expect(row.rawLine).toBe("- [ ] pay the rent");
    expect(row.completed).toBe(false);
    expect(row.oversized).toBe(false);
  });
});
