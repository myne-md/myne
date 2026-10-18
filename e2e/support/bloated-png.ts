// A deliberately bloated PNG, built here rather than read off disk.
//
// WHY THIS EXISTS AT ALL. `e2e/image-compression.e2e.ts` needs an image whose
// re-encode is GUARANTEED to come out smaller, because that is what makes the
// compression notice appear and what the scenario asserts. It used to read
// `.github/banner.png`, on the stated reasoning that "one binary with two
// consumers beats a duplicate" — and that sharing is exactly what broke it:
// the banner was redrawn in `e98353fd` (2026-10-17, "the README banner, redrawn
// from the field component"), and the new 570 767-byte PNG losslessly
// re-encodes to 606 954 bytes. The compressor's own not-smaller guard
// (`core/src/plugins/attachments/compress.rs`, `if encoded.len() < bytes.len()`)
// then correctly returns `Unchanged`, so no notice was raised and the scenario
// failed reporting "a row with the ORIGINAL size => import worked and
// compression did not". Nothing was wrong with the product: a shared asset
// changed, and a test had pinned its bytes and its compressibility.
//
// The same reasoning the Rust unit tests already use applies here, and this
// module is that helper's TS twin: `compress.rs::make_png` builds its fixture
// with `CompressionType::Uncompressed` — "a deliberately bloated source, so the
// re-encode reliably wins instead of depending on the PNG encoder's own
// compression luck". A source whose deflate blocks are STORED is the most
// reliable version of that: its size is the raw pixel count plus a few hundred
// bytes, whatever the pixels contain, so the comparison the compressor makes is
// decided by the encoder's ratio rather than by how well a particular PNG
// happened to compress.
//
// The `image` crate's lossless WebP (`encode_lossless_webp` in the same module —
// the encoder that actually ships, NOT `cwebp`) reaches roughly 0.70x of raw on
// this pattern, which is a comfortable margin either way.
//
// Everything here is pure and deterministic: no clock, no locale, no canvas, no
// WebView. `zlib.deflateSync(buf, { level: 0 })` is what produces the stored
// blocks, and it is Node's own zlib, so the bytes are identical on every machine.

import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** RGB, 8 bits per channel, no alpha — the `Rgb8` shape every path in
 *  `compress.rs`'s tests uses. */
const COLOR_TYPE_RGB = 2;
const BIT_DEPTH_8 = 8;

/** The CRC-32 table, built once. PNG's chunk CRC is CRC-32/ISO-HDLC. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One `length + type + data + crc` chunk. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * Deterministic non-flat pixel — the same shape as `compress.rs::pattern_pixel`.
 *
 * Flat colour is deliberately avoided for the reason that helper states: it
 * makes an encoder's own heuristics behave unrealistically well, and a fixture
 * that compresses too easily would stop exercising the transform.
 */
function patternPixel(x: number, y: number): [number, number, number] {
  return [
    (x * 7 + y * 13) % 256,
    (x * 3 + y * 29) % 256,
    ((x * 11) ^ (y * 17)) % 256,
  ];
}

/**
 * A PNG of `width` x `height` whose IDAT stream is STORED, so its size is
 * `height * (1 + width * 3)` plus a few hundred bytes of chunk framing.
 *
 * `filter: 0` (None) on every scanline for the same reason: a sub/up filter
 * would let deflate find structure in the image, which is exactly the
 * dependence on encoder luck this file exists to remove.
 */
export function bloatedPng(width: number, height: number): Buffer {
  const stride = 1 + width * 3;
  const raw = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = patternPixel(x, y);
      const at = rowStart + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = BIT_DEPTH_8;
  ihdr[9] = COLOR_TYPE_RGB;
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    // Level 0 is the whole point: stored blocks, so the file is raw-sized.
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
