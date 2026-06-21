// desktop-ingest task 6 — the inbound-dispatch → `RawClipEnvelope` adapter. These
// pin the byte→`Uint8Array` lift and the per-image filename synthesis (the v1
// resolution of the Rust↔TS per-image-filename gap), and that scalar fields ride
// through verbatim (the boundary gate `validateClipEnvelope` owns validation).

import { describe, expect, it } from "vitest";
import {
  buildRawEnvelopeFromDispatch,
  synthName,
  type ClipDispatchPayload,
} from "../../src/clip/clipDispatchEnvelope";

function payload(
  overrides: Partial<ClipDispatchPayload> = {},
): ClipDispatchPayload {
  return {
    requestId: "req-1",
    markdownBody: "# Title\n\nbody",
    captureKind: "full-article",
    sourceUrl: "https://example.com/post",
    clipDate: "2026-06-18T12:00:00Z",
    imageBytes: [],
    ...overrides,
  };
}

describe("synthName", () => {
  it("synthesizes a 1-based display name", () => {
    expect(synthName(0)).toBe("clipped-image-1");
    expect(synthName(1)).toBe("clipped-image-2");
    expect(synthName(41)).toBe("clipped-image-42");
  });
});

describe("buildRawEnvelopeFromDispatch", () => {
  it("carries the scalar fields through verbatim (no validation here)", () => {
    const env = buildRawEnvelopeFromDispatch(payload());
    expect(env.markdownBody).toBe("# Title\n\nbody");
    expect(env.captureKind).toBe("full-article");
    expect(env.sourceUrl).toBe("https://example.com/post");
    expect(env.clipDate).toBe("2026-06-18T12:00:00Z");
  });

  it("passes empty-string sourceUrl / clipDate through untouched", () => {
    const env = buildRawEnvelopeFromDispatch(
      payload({ sourceUrl: "", clipDate: "" }),
    );
    expect(env.sourceUrl).toBe("");
    expect(env.clipDate).toBe("");
  });

  it("lifts each wire byte-array to a Uint8Array, preserving bytes + order", () => {
    const env = buildRawEnvelopeFromDispatch(
      payload({
        imageBytes: [
          [137, 80, 78, 71],
          [255, 216, 255],
        ],
      }),
    );
    expect(env.imageBytes).toHaveLength(2);
    expect(env.imageBytes[0].bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(env.imageBytes[0].bytes)).toEqual([137, 80, 78, 71]);
    expect(Array.from(env.imageBytes[1].bytes)).toEqual([255, 216, 255]);
  });

  it("synthesizes a per-image display filename (1-based, by index)", () => {
    const env = buildRawEnvelopeFromDispatch(
      payload({ imageBytes: [[1], [2], [3]] }),
    );
    expect(env.imageBytes.map((img) => img.filename)).toEqual([
      "clipped-image-1",
      "clipped-image-2",
      "clipped-image-3",
    ]);
  });

  it("produces an empty image list when no images are dispatched", () => {
    const env = buildRawEnvelopeFromDispatch(payload({ imageBytes: [] }));
    expect(env.imageBytes).toEqual([]);
  });
});
