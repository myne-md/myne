// The YAML half of the move destination (myne-md/myne#848).
//
// **The excluded-folder clamp and the app must read the same folder**, and they
// did not. The app parses frontmatter with js-yaml, where an unquoted `#` starts a
// comment; the Rust clamp reads the same line with `fm_scalar`, which strips
// quotes but knows none of YAML's plain-scalar rules. So a destination of
// `Private #x` was read as `Private #x` by the clamp (not excluded) and as
// `Private` by the app (excluded): a crafted value walked a note INTO a folder the
// user had excluded from AI, and on the read side let the agent read a note the
// user excluded.
//
// The Rust side of the pair (`a_destination_with_a_hash_is_written_so_both_readers
// _agree`) pins the WRITTEN SHAPE and what the clamp makes of it. This file pins
// the other reader, against the real js-yaml the app parses with, so the two
// cannot drift apart again without one of them going red.

import { describe, expect, it } from "vitest";
import { load } from "js-yaml";

/** Parse a frontmatter BODY (the lines between the fences), as the app does. */
function parseFm(body: string): Record<string, unknown> {
  return (load(body) ?? {}) as Record<string, unknown>;
}

describe("a move destination carrying a hash", () => {
  it("reads the SAME folder in js-yaml once it is quoted", () => {
    // The shape `yaml_folder_scalar` writes when the value needs it.
    expect(parseFm('folder: "Private #x"').folder).toBe("Private #x");
  });

  it("and is the reason it had to be quoted: unquoted, js-yaml drops the tail", () => {
    // The pre-fix shape. Asserted rather than described, because this is the
    // divergence itself: `Private` is a folder the user may have excluded, and
    // the note lands in it while the clamp was told `Private #x`.
    expect(parseFm("folder: Private #x").folder).toBe("Private");
  });

  it("leaves an ordinary folder unquoted, byte-identical to the app's own writer", () => {
    // The reason the fix quotes only what needs it: `folder: Projects` is what
    // `patchFolderField` writes, and a quoted form everywhere would make the
    // agent's notes differ from every other note's for no gain.
    expect(parseFm("folder: Projects").folder).toBe("Projects");
  });
});

// The OTHER divergence, from the review of this change: the `#` half above asks
// whether js-yaml drops part of the value, and this half asks whether it changes
// the value's TYPE. It does, because the app parses with js-yaml and the clamp
// reads the line as text, so a folder named after a year or a date is the shape
// that walks a note into (or out of) an excluded folder. The Rust side quotes
// these now (`yaml_folder_scalar`); these cases are the reason it must.
describe("a move destination YAML would read as another type", () => {
  it("is a NUMBER or a Date unquoted, which is the divergence itself", () => {
    expect(parseFm("folder: 2026").folder).toBe(2026);
    expect(parseFm("folder: 2026-08-16").folder).toBeInstanceOf(Date);
    expect(parseFm("folder: true").folder).toBe(true);
    expect(parseFm("folder: ~").folder).toBeNull();
  });

  it("reads as the folder's own name once quoted, which is what the Rust writer emits", () => {
    expect(parseFm('folder: "2026"').folder).toBe("2026");
    expect(parseFm('folder: "2026-08-16"').folder).toBe("2026-08-16");
    expect(parseFm('folder: "2026-8-6"').folder).toBe("2026-8-6");
    expect(parseFm('folder: "true"').folder).toBe("true");
  });

  it("leaves a hash YAML does not read as a comment unquoted", () => {
    // `#` opens a comment only after a space, so `a#b` is a plain scalar. Quoting
    // it would be a second answer for the same value, different from
    // `dialect/src/surgery.ts::needsYamlQuoting`, which the app writes `folder:`
    // through; the Rust writer mirrors that rule now.
    expect(parseFm("folder: a#b").folder).toBe("a#b");
    expect(parseFm("folder: Private #x").folder).toBe("Private");
  });
});
