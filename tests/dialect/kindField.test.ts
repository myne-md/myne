// patchKindField (set canonical `drawing` / state-D delete) + value-strict
// readKindFromFmBody.
//
// `kind:` is the 11th Myne-managed canonical FM field (markdown-dialect §3.6.1;
// drawing-notes SF2, MYND-499). Unlike the boolean flags it is a string enum;
// v1 defines exactly `drawing`, which routes the note to the Excalidraw canvas.
// Mirrors `folderIndexField.test.ts`, but the read returns `"drawing" | null`
// (not a boolean) and the collision footgun matters MORE here (a stray `kind:`
// must never force-render a markdown note as a canvas).

import { describe, it, expect } from "vitest";
import {
  patchKindField,
  patchTitleField,
  patchTemplateField,
  patchTrashedField,
  patchUpdatedField,
  readKindFromFmBody,
  readTemplateFromFmBody,
  readTrashedFromFmBody,
  DRAWING_KIND_VALUE,
  TASK_KIND_VALUE,
  CANONICAL_KIND_VALUES,
} from "../../src/dialect/surgery";
import { enc, dec } from "./_helpers";

const TS = "2026-07-14T11:00:00Z";
const apply = (src: string, kind: "drawing" | null): string =>
  dec.decode(patchKindField(enc.encode(src), kind));
const read = (fmBody: string) => readKindFromFmBody(fmBody);
const applyKind = (src: string, kind: "drawing" | "task" | null): string =>
  dec.decode(patchKindField(enc.encode(src), kind));

function fmBodyOf(source: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  return m ? (m[1] ?? "") : "";
}

describe("DRAWING_KIND_VALUE", () => {
  it("is the canonical unquoted drawing", () => {
    expect(DRAWING_KIND_VALUE).toBe("drawing");
  });
});

describe("patchKindField — set (no frontmatter)", () => {
  it("prepends a canonical FM block carrying kind: drawing", () => {
    expect(apply("scene-body\n", "drawing")).toBe(
      "---\nkind: drawing\n---\n\nscene-body\n",
    );
  });
});

describe("patchKindField — set (FM present, kind absent)", () => {
  it("inserts kind before the closing fence, after existing keys", () => {
    expect(apply("---\ntitle: Sketch\n---\n\nbody", "drawing")).toBe(
      "---\ntitle: Sketch\nkind: drawing\n---\n\nbody",
    );
  });
});

describe("patchKindField — set (kind present, replace)", () => {
  it("rewrites a non-canonical value to canonical drawing", () => {
    expect(apply("---\nkind: sketch\n---\n\nbody", "drawing")).toBe(
      "---\nkind: drawing\n---\n\nbody",
    );
  });
  it("preserves a trailing comment on the kind line", () => {
    expect(apply("---\nkind: sketch # k\n---\n\nbody", "drawing")).toBe(
      "---\nkind: drawing # k\n---\n\nbody",
    );
  });
});

describe("patchKindField — clear (state-D delete)", () => {
  it("removes the whole block when kind is the only field (with body)", () => {
    expect(apply("---\nkind: drawing\n---\n\nbody", null)).toBe("body");
  });
  it("drops only the kind line when another key remains", () => {
    expect(apply("---\ntitle: Sketch\nkind: drawing\n---\n\nbody", null)).toBe(
      "---\ntitle: Sketch\n---\n\nbody",
    );
  });
  it("is a no-op when there is no kind field", () => {
    expect(apply("---\ntitle: Sketch\n---\n\nbody", null)).toBe(
      "---\ntitle: Sketch\n---\n\nbody",
    );
  });
});

describe("patchKindField — set→clear round-trip (byte-identity)", () => {
  it("clearing after marking a titled note yields the original bytes", () => {
    const original = "---\ntitle: Sketch\n---\n\n# Note";
    const marked = apply(original, "drawing");
    expect(dec.decode(patchKindField(enc.encode(marked), null))).toBe(original);
  });
});

describe("readKindFromFmBody — value-strict string enum (FM body input)", () => {
  it("returns 'drawing' for the canonical unquoted drawing", () => {
    expect(read("kind: drawing\n")).toBe("drawing");
  });
  it("returns 'drawing' despite a trailing comment", () => {
    expect(read("kind: drawing # mine\n")).toBe("drawing");
  });
  it("returns null for a quoted \"drawing\" (YAML string, not the marker)", () => {
    expect(read('kind: "drawing"\n')).toBe(null);
  });
  it("returns null for capitalized Drawing (case-sensitive)", () => {
    expect(read("kind: Drawing\n")).toBe(null);
  });
  // Was `kind: task` until MYND-613 widened the enum — `task` is now canonical.
  // The property this test guards is unchanged: a value outside the canonical
  // set reads as an ordinary note.
  it("returns null for a non-canonical kind value (kind: chore)", () => {
    expect(read("kind: chore\n")).toBe(null);
  });
  it("returns null for an empty kind value", () => {
    expect(read("kind:\n")).toBe(null);
  });
  it("returns null for an FM body with no kind field", () => {
    expect(read("title: Sketch\n")).toBe(null);
  });
  it("returns null for an empty FM body", () => {
    expect(read("")).toBe(null);
  });
});

describe("kind composes with the other managed fields (no clobbering)", () => {
  it("marking a titled note preserves title, and reads back drawing", () => {
    const out = apply("---\ntitle: Sketch\n---\n\nbody", "drawing");
    const body = fmBodyOf(out);
    expect(read(body)).toBe("drawing");
    expect(out).toContain("title: Sketch");
  });
  it("a title rewrite (rename) leaves kind: drawing intact", () => {
    const src = "---\ntitle: Old\nkind: drawing\n---\n\nscene";
    const renamed = dec.decode(patchTitleField(enc.encode(src), "New name"));
    expect(read(fmBodyOf(renamed))).toBe("drawing");
    expect(renamed).toContain("title: New name");
  });
  it("an updated: stamp (autosave) leaves kind: drawing intact", () => {
    const src = "---\nkind: drawing\n---\n\nscene edited";
    const saved = dec.decode(patchUpdatedField(enc.encode(src), TS));
    expect(read(fmBodyOf(saved))).toBe("drawing");
    expect(saved).toContain(`updated: ${TS}`);
  });
  it("template + trashed on a drawing keep all three fields", () => {
    let out = apply("---\nkind: drawing\n---\n\nscene", "drawing");
    out = dec.decode(patchTemplateField(enc.encode(out), "true"));
    out = dec.decode(patchTrashedField(enc.encode(out), TS));
    const body = fmBodyOf(out);
    expect(read(body)).toBe("drawing");
    expect(readTemplateFromFmBody(body)).toBe(true);
    expect(readTrashedFromFmBody(body)).toBe(TS);
  });
});

// === MYND-613 task 2: the task class marker ===
//
// `kind:` becomes a TWO-value enum. The widening must not loosen value-strictness:
// a user's own `kind:` still never files their note as a task.

describe("TASK_KIND_VALUE (MYND-613)", () => {
  it("is the canonical unquoted task", () => {
    expect(TASK_KIND_VALUE).toBe("task");
  });

  it("CANONICAL_KIND_VALUES is exactly the canonical values", () => {
    // Widened to three by the calendar (myne-md/myne#1037, §3.10): `event` is a
    // note class, not a fourth kind of marker, so this list stays the ONE place
    // that says how many classes exist. A new value added to the enum without a
    // row here fails this test on purpose.
    expect([...CANONICAL_KIND_VALUES]).toEqual(["drawing", "task", "event"]);
  });
});

describe("readKindFromFmBody — task value", () => {
  it("marks a note as a task on the canonical unquoted value", () => {
    expect(read("title: A\nkind: task")).toBe("task");
  });

  it("still reads drawing unchanged", () => {
    expect(read("title: A\nkind: drawing")).toBe("drawing");
  });

  it("rejects a quoted value", () => {
    expect(read('kind: "task"')).toBeNull();
    expect(read("kind: 'task'")).toBeNull();
  });

  it("rejects a capitalized value", () => {
    expect(read("kind: Task")).toBeNull();
    expect(read("kind: TASK")).toBeNull();
  });

  it("rejects an unknown value", () => {
    expect(read("kind: chore")).toBeNull();
    expect(read("kind: tasks")).toBeNull();
  });

  it("tolerates a trailing comment", () => {
    expect(read("kind: task # note to self")).toBe("task");
  });

  it("resolves first-line-wins on a note carrying two class lines", () => {
    expect(read("kind: task\nkind: drawing")).toBe("task");
    expect(read("kind: drawing\nkind: task")).toBe("drawing");
    // A bogus first line does NOT fall through to a valid later one — the first
    // `kind:` decides, which is what "deterministically" means here.
    expect(read("kind: bogus\nkind: task")).toBeNull();
  });
});

describe("patchKindField — task value", () => {
  it("writes the canonical task marker", () => {
    const out = applyKind("---\ntitle: A\n---\n\nbody\n", "task");
    expect(read(fmBodyOf(out))).toBe("task");
    expect(out).toContain("kind: task");
  });

  it("changes drawing to task in place", () => {
    const first = applyKind("---\ntitle: A\n---\n\nbody\n", "drawing");
    const second = applyKind(first, "task");
    expect(read(fmBodyOf(second))).toBe("task");
    expect(second).not.toContain("drawing");
  });

  it("deletes the marker on null", () => {
    const set = applyKind("---\ntitle: A\n---\n\nbody\n", "task");
    expect(read(fmBodyOf(applyKind(set, null)))).toBeNull();
  });

  it("leaves every other managed field, user field and the body byte-identical", () => {
    const source =
      "---\ntitle: A\nfolder: Projects/\ntemplate: true\nstatus: open\n---\n\n# Body\n\ntext\n";
    const out = applyKind(source, "task");
    expect(out).toContain("title: A");
    expect(out).toContain("folder: Projects/");
    expect(out).toContain("template: true");
    expect(out).toContain("status: open");
    expect(out).toContain("# Body\n\ntext\n");
  });
});
