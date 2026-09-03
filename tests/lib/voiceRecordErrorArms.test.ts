// Every `VoiceRecordError` variant reaches a mapper arm (myne-md/myne#510).
//
// The Rust enum is the source of truth and the two TypeScript mappers in
// `editor/src/attachments/voiceRecord.ts` are hand-written switches over its
// serialized `kind`. Both switches end in a `default` that returns a generic
// sentence, so a variant nobody added an arm for does not fail to compile, does
// not fail a lint, and does not fail a test. It renders the generic string.
//
// What that cost: `UnsupportedSampleRate` shipped with a doc comment saying it
// is "carried separately from `CaptureFailed` so the user is told what is
// actually wrong", and it was in neither switch. It arrived as "Couldn't save
// the recording", which names no cause, and it arrives on a path that DISCARDS
// the take, so the copy also invited a retry that fails identically on the same
// device. Three layers agreed the variant existed and the one the user reads did
// not know about it.
//
// PARSED from the Rust source rather than imported. There is nothing to import:
// the enum is Rust, and the only shared artefact is the wire string, which is
// what this compares.
//
// Deliberately NOT asserted: that a variant is handled in BOTH switches. Several
// are legitimately generic in one of them, because a start-time cause cannot
// occur at stop time and the reverse. The property that catches the real defect
// is reachability from EITHER, and a variant that should be generic everywhere
// carries its name in `DELIBERATELY_GENERIC` with the reason.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const RUST = fileURLToPath(
  new URL("../../src-tauri/src/plugins/attachments/voice/error.rs", import.meta.url),
);
const MAPPERS = fileURLToPath(
  new URL("../../editor/src/attachments/voiceRecord.ts", import.meta.url),
);

/** `Locked` and friends, as the `rename_all = "camelCase"` wire strings. */
function rustVariants(): string[] {
  const src = readFileSync(RUST, "utf8");
  const at = src.indexOf("pub enum VoiceRecordError {");
  if (at === -1) throw new Error("no VoiceRecordError declaration");
  const decl = src.slice(at, src.indexOf("\n}", at));
  return [...decl.matchAll(/^\s{4}([A-Z][A-Za-z]*)(?:\(|,)/gm)]
    .map((m) => m[1])
    .map((v) => v[0].toLowerCase() + v.slice(1))
    .sort();
}

/** Every `case "…":` label across both mapper switches. */
function handledKinds(): string[] {
  const src = readFileSync(MAPPERS, "utf8");
  return [...src.matchAll(/case "([a-zA-Z]+)":/g)].map((m) => m[1]).sort();
}

/**
 * Variants that correctly land on the generic sentence in both switches, each
 * with the reason. An entry here is an argument somebody made, not a silence.
 */
const DELIBERATELY_GENERIC: Record<string, string> = {
  notRecording:
    "Reachable only from stop/cancel with no active recording, which the UI does not offer: the stop control is not rendered unless a recording is live. A user-facing sentence for it would describe a state they cannot be in.",
  import:
    "A newtype carrying the nested attachment-import error, whose own taxonomy is rendered by the attachment layer. Giving it a second sentence here would say less than the one already shown.",
  internal:
    "A thread-join or equivalent failure with nothing the user can act on. The generic sentence is the honest one.",
};

describe("VoiceRecordError arms", () => {
  it("has a mapper arm, or a stated reason, for every Rust variant", () => {
    const variants = rustVariants();
    // Non-vacuity floor: a parse that returned nothing would pass every
    // assertion below, which is the failure this test exists to catch one level
    // up. Measured at 10 on 2026-08-31.
    expect(variants.length).toBeGreaterThanOrEqual(10);

    const handled = new Set(handledKinds());
    const unreached = variants.filter(
      (v) => !handled.has(v) && !(v in DELIBERATELY_GENERIC),
    );
    expect(unreached).toEqual([]);
  });

  it("keeps no stale entry in the deliberately-generic list", () => {
    const variants = new Set(rustVariants());
    const handled = new Set(handledKinds());
    for (const [name, reason] of Object.entries(DELIBERATELY_GENERIC)) {
      expect(variants.has(name), `${name} is no longer a VoiceRecordError variant`).toBe(true);
      expect(handled.has(name), `${name} now HAS a mapper arm; drop it from the list`).toBe(false);
      // A reason short enough to be a placeholder is not a reason.
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("handles no kind the Rust enum does not declare", () => {
    const variants = new Set(rustVariants());
    const invented = handledKinds().filter((k) => !variants.has(k));
    expect(invented).toEqual([]);
  });
});
