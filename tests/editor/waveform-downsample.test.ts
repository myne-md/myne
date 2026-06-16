// Additional `downsamplePeaks` coverage (`editor/attachments/waveform.ts`,
// MYND-259) beyond `waveform-peaks.test.ts` — fractional block boundaries,
// single-bucket, more-buckets-than-samples (empty trailing buckets), and the
// exact bucket-boundary math. The browser `decodePeaks` (Web Audio) stays
// untested (no AudioContext under Vitest).

import { describe, expect, it } from "vitest";
import { downsamplePeaks } from "../../src/editor/attachments/waveform";

describe("downsamplePeaks — bucket boundary math", () => {
  it("a single bucket is the global absolute peak (normalized to 1)", () => {
    const peaks = downsamplePeaks(new Float32Array([0.2, -0.7, 0.5, 0.1]), 1);
    expect(peaks).toEqual([1]); // max abs is 0.7, normalized to 1
  });

  it("buckets > samples leaves empty buckets at 0", () => {
    // 2 samples, 4 buckets: blockSize 0.5. floor boundaries →
    //   b0: [0,0) empty; b1: [0,1) = 0.4; b2: [1,1) empty; b3: [1,2) = 0.8.
    const peaks = downsamplePeaks(new Float32Array([0.4, 0.8]), 4);
    expect(peaks).toHaveLength(4);
    // Loudest (0.8) normalizes to 1; the 0.4 sample → 0.5; empties → 0.
    expect(peaks[0]).toBe(0);
    expect(peaks[1]).toBeCloseTo(0.5, 5);
    expect(peaks[2]).toBe(0);
    expect(peaks[3]).toBeCloseTo(1, 5);
  });

  it("partitions samples by floor(b*blockSize) — each bucket's max within its slice", () => {
    // 6 samples, 3 buckets → blockSize 2: [0,1]=max(0.1,0.9)=0.9,
    // [2,3]=max(0.2,0.3)=0.3, [4,5]=max(0.6,0.4)=0.6. Normalize by 0.9.
    const samples = new Float32Array([0.1, 0.9, 0.2, 0.3, 0.6, 0.4]);
    const peaks = downsamplePeaks(samples, 3);
    expect(peaks[0]).toBeCloseTo(1, 5);
    expect(peaks[1]).toBeCloseTo(0.3 / 0.9, 5);
    expect(peaks[2]).toBeCloseTo(0.6 / 0.9, 5);
  });

  it("a uniform signal yields all-1 peaks (every bucket equals the max)", () => {
    const peaks = downsamplePeaks(new Float32Array(64).fill(0.3), 8);
    expect(peaks).toHaveLength(8);
    expect(peaks.every((p) => Math.abs(p - 1) < 1e-9)).toBe(true);
  });

  it("never returns NaN for an all-zero (silent) multi-bucket input", () => {
    const peaks = downsamplePeaks(new Float32Array(100), 10);
    expect(peaks.some((p) => Number.isNaN(p))).toBe(false);
    expect(peaks.every((p) => p === 0)).toBe(true);
  });
});
