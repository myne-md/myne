// Peak-extraction tests for the inline audio-player waveform (voice notes,
// MYND-259). Covers the PURE `downsamplePeaks` — the browser `decodePeaks`
// (fetch + Web Audio decode) is not unit-tested (no Web Audio under Vitest).

import { describe, expect, it } from "vitest";
import { downsamplePeaks } from "../../src/editor/attachments/waveform";

describe("downsamplePeaks", () => {
  it("returns [] for empty input", () => {
    expect(downsamplePeaks(new Float32Array(0), 8)).toEqual([]);
  });

  it("returns [] for a non-positive bucket count", () => {
    expect(downsamplePeaks(new Float32Array([0.5, 0.5]), 0)).toEqual([]);
    expect(downsamplePeaks(new Float32Array([0.5, 0.5]), -3)).toEqual([]);
  });

  it("produces exactly `buckets` peaks", () => {
    const samples = new Float32Array(1000).fill(0.2);
    expect(downsamplePeaks(samples, 16)).toHaveLength(16);
  });

  it("yields all-zero peaks for silence (no divide-by-zero)", () => {
    const peaks = downsamplePeaks(new Float32Array(256), 8);
    expect(peaks).toHaveLength(8);
    expect(peaks.every((p) => p === 0)).toBe(true);
  });

  it("normalizes so the loudest bucket is 1", () => {
    // First half quiet (0.1), second half loud (0.8).
    const samples = new Float32Array(200);
    samples.fill(0.1, 0, 100);
    samples.fill(0.8, 100, 200);
    const peaks = downsamplePeaks(samples, 2);
    expect(peaks[0]).toBeCloseTo(0.1 / 0.8, 5);
    expect(peaks[1]).toBeCloseTo(1, 5);
  });

  it("takes the absolute-value peak within each bucket", () => {
    // A bucket containing a large negative sample peaks at its magnitude.
    const samples = new Float32Array([-0.9, 0.1, 0.2, 0.3]);
    const peaks = downsamplePeaks(samples, 2);
    // bucket 0 = max(|-0.9|, |0.1|) = 0.9 ; bucket 1 = max(0.2, 0.3) = 0.3
    // normalized by 0.9 → [1, 0.333…]
    expect(peaks[0]).toBeCloseTo(1, 5);
    expect(peaks[1]).toBeCloseTo(0.3 / 0.9, 5);
  });
});
