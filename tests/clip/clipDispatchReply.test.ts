// desktop-ingest task 6 — `mapResultToOutcome` is the pure projection from the
// rich `ClipIngestResult` to the tiny host-reply outcome string. These pin all
// three arms AND the no-leak rule (the reply is a bare string — no note id, no
// counts can ride out).

import { describe, expect, it } from "vitest";
import { mapResultToOutcome } from "../../src/clip/clipDispatchReply";
import type { ClipIngestResult } from "../../src/clip/assembleClip";
import { emptyMediaByType } from "../../src/notes/import/media";

describe("mapResultToOutcome", () => {
  it("maps an accepted result to \"accepted\"", () => {
    const result: ClipIngestResult = {
      kind: "accepted",
      noteId: "01910000-0000-7000-8000-000000000abc",
      counts: { ingested: emptyMediaByType(), omitted: emptyMediaByType() },
    };
    expect(mapResultToOutcome(result)).toBe("accepted");
  });

  it("maps a locked result to \"locked\"", () => {
    expect(mapResultToOutcome({ kind: "locked" })).toBe("locked");
  });

  it("maps an error result to \"error\"", () => {
    expect(
      mapResultToOutcome({ kind: "error", reason: "PlaintextTooLarge" }),
    ).toBe("error");
  });

  it("returns a bare string (no note id / counts can leak through the reply)", () => {
    const result: ClipIngestResult = {
      kind: "accepted",
      noteId: "secret-note-id",
      counts: { ingested: emptyMediaByType(), omitted: emptyMediaByType() },
    };
    // The mapping yields a primitive string — there is no field for the note id
    // or counts to ride out on (the tiny-reply / no-leak rule by construction).
    expect(typeof mapResultToOutcome(result)).toBe("string");
    expect(mapResultToOutcome(result)).not.toContain("secret-note-id");
  });
});
