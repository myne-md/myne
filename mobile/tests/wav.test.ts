import { describe, it, expect } from "vitest";
import { encodeWav, floatToMono16, WAV_HEADER_LEN, voiceNoteFilename, fileNameTimestamp } from "../src/lib/wav";

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer).getUint32(at, true);
const u16 = (b: Uint8Array, at: number) => new DataView(b.buffer).getUint16(at, true);
const ascii = (b: Uint8Array, at: number, len: number) =>
  String.fromCharCode(...Array.from(b.slice(at, at + len)));

describe("encodeWav", () => {
  it("writes a canonical RIFF/WAVE/fmt/data header", () => {
    const wav = encodeWav(Int16Array.from([0, 0, 0]), 48_000, 1);
    expect(ascii(wav, 0, 4)).toBe("RIFF");
    expect(ascii(wav, 8, 4)).toBe("WAVE");
    expect(ascii(wav, 12, 4)).toBe("fmt ");
    expect(ascii(wav, 36, 4)).toBe("data");
  });

  it("fmt fields match the inputs (mono 16-bit)", () => {
    const samples = Int16Array.from([1, -1, 2, -2, 3]);
    const wav = encodeWav(samples, 44_100, 1);
    expect(u16(wav, 20)).toBe(1); // PCM
    expect(u16(wav, 22)).toBe(1); // channels
    expect(u32(wav, 24)).toBe(44_100); // sample rate
    expect(u32(wav, 28)).toBe(44_100 * 2); // byte rate (mono 16-bit)
    expect(u16(wav, 32)).toBe(2); // block align
    expect(u16(wav, 34)).toBe(16); // bits per sample
    expect(u32(wav, 40)).toBe(samples.length * 2); // data size
    expect(wav.length).toBe(WAV_HEADER_LEN + samples.length * 2);
  });

  it("round-trips little-endian samples", () => {
    const samples = Int16Array.from([0, 32_767, -32_768, 1234, -4321]);
    const wav = encodeWav(samples, 16_000, 1);
    const decoded: number[] = [];
    for (let i = WAV_HEADER_LEN; i < wav.length; i += 2) {
      decoded.push(new DataView(wav.buffer).getInt16(i, true));
    }
    expect(decoded).toEqual(Array.from(samples));
  });

  it("empty samples yield a header-only buffer", () => {
    const wav = encodeWav(new Int16Array(0), 48_000, 1);
    expect(wav.length).toBe(WAV_HEADER_LEN);
    expect(u32(wav, 40)).toBe(0);
  });
});

describe("floatToMono16", () => {
  it("scales full-range floats to 16-bit and clamps out-of-range", () => {
    const out = floatToMono16([Float32Array.from([0, 1, -1, 2, -2])], 16_000, 16_000);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0x7fff); // +1.0 → max positive
    expect(out[2]).toBe(-0x8000); // -1.0 → min negative
    expect(out[3]).toBe(0x7fff); // +2.0 clamps to +1.0
    expect(out[4]).toBe(-0x8000); // -2.0 clamps to -1.0
  });

  it("downsamples by the source/target ratio", () => {
    // 48k → 16k is a 3:1 decimation → one third of the frames survive.
    const src = new Float32Array(300);
    const out = floatToMono16([src], 48_000, 16_000);
    expect(out.length).toBe(100);
  });

  it("concatenates multiple capture chunks in order", () => {
    const a = Float32Array.from([1, 1]);
    const b = Float32Array.from([-1, -1]);
    const out = floatToMono16([a, b], 16_000, 16_000);
    expect(Array.from(out)).toEqual([0x7fff, 0x7fff, -0x8000, -0x8000]);
  });
});

describe("voiceNoteFilename", () => {
  it("formats Voice note YYYY-MM-DD HH-MM-SS.wav from a fixed date", () => {
    const d = new Date(2026, 6, 12, 9, 5, 3); // 2026-07-12 09:05:03 local
    expect(fileNameTimestamp(d)).toBe("2026-07-12 09-05-03");
    expect(voiceNoteFilename(d)).toBe("Voice note 2026-07-12 09-05-03.wav");
  });
});
