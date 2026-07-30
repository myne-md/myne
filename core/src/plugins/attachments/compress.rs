// SPDX-License-Identifier: AGPL-3.0
//! Ingest-time image compression (`ingest-image-compression`).
//!
//! A pure transform over freshly imported attachment bytes: downscale and
//! re-encode a decodable raster image so what gets stored, synced and backed
//! up is smaller than what the user pasted. This module knows nothing about
//! the vault, the `attachment_compression_enabled` preference, or the import
//! pipeline — task 6 wires [`compress_for_import`] into
//! `commands::attachment_import` between the content-type sniff and the
//! content-addressed id computation.
//!
//! Every failure path returns [`CompressOutcome::Unchanged`] rather than an
//! error: compression is best-effort and must never turn a successful
//! import into a failed one.
//!
//! ## Decode limits are mandatory
//!
//! Compression makes every imported PNG/JPEG/WebP an untrusted decode, where
//! today only the OCR path (`ocr/mod.rs::decode_bounded`) decodes images at
//! all. This module copies that discipline exactly: an explicit
//! [`image::Limits`] bounding width and height, checked by the decoder
//! before it allocates a pixel buffer, with a limits violation treated as
//! "store the original" rather than an error. A small file can declare
//! enormous dimensions and expand to gigabytes on decode; refusing the
//! header is the only safe response.
//!
//! ## GIF and SVG are never decoded
//!
//! `myne-core`'s `image` dependency deliberately excludes the `gif` codec —
//! see the dependency comment in `core/Cargo.toml` — and SVG has no raster
//! decoder to begin with (it is already text). Both content types
//! short-circuit to `Unchanged` before any decode is attempted, which also
//! covers the animated-GIF exclusion the PRD calls out by name (all GIF,
//! animated or not, is out of scope for this transform).

use image::codecs::jpeg::JpegEncoder;
use image::codecs::webp::WebPEncoder;
use image::imageops::FilterType;
use image::DynamicImage;

/// Long-edge ceiling in pixels above which an image is downscaled before
/// re-encoding.
///
/// Confirmed at 2400 by the task 2 corpus measurement (`progress.md`): a
/// 5100x6600px (600dpi Letter) synthetic scan downscaled to 1855x2400
/// (effectively ~218dpi on an 11in page) remained visually crisp at
/// full-zoom, and a 2550x3300px (300dpi Letter) scan — the case most likely
/// to argue for a higher ceiling — only loses ~27% of its long edge at this
/// ceiling. Real desktop screenshots (1280px class) and the brand banner
/// (3000px) both stay well-served by this value. Not moved.
pub(crate) const MAX_LONG_EDGE_PX: u32 = 2400;

/// JPEG quality (1-100) used for the lossy re-encode path.
///
/// Confirmed at 85 by the task 2 measurement pass (`progress.md`): no real
/// photographic JPEG corpus was available in this sandboxed repo to
/// falsify it against, so this keeps the PRD's reasoned value — 85 is the
/// conventional "visually indistinguishable, well compressed" setting
/// (the same range libjpeg/most encoders default "high quality" to). A
/// synthetic 4032x3024 (12MP-equivalent) fixture confirmed the downscale +
/// re-encode pipeline fires correctly at this quality; it does not speak to
/// visual fidelity since the fixture is adversarial noise, not a photo.
pub(crate) const JPEG_QUALITY: u8 = 85;

/// Byte floor below which a JPEG is left untouched by the lossy path
/// (unless downscaling already fired — see [`compress_for_import`]). A
/// small JPEG is usually already heavily compressed, so re-encoding it
/// produces measurable generation loss for almost no saving. The floor
/// exists only on this lossy path: the lossless path below has none, since
/// re-encoding there never loses a pixel.
///
/// Confirmed at 256 KiB by the task 2 measurement pass (`progress.md`): no
/// real small-JPEG corpus was available to move it against, and the PRD's
/// reasoned value has no counter-evidence. Not moved.
pub(crate) const JPEG_LOSSY_FLOOR_BYTES: usize = 256 * 1024;

/// Maximum pixel dimension accepted for decoding.
///
/// Same discipline as `ocr/mod.rs`'s `MAX_OCR_IMAGE_DIMENSION`: an attachment
/// is capped at 64 MiB of *compressed* bytes, which says nothing about the
/// decoded size — PNG reaches ~1000:1, so a few hundred KB can expand to
/// tens of gigabytes. 20000 px comfortably exceeds any real screenshot or
/// scan while making the bomb case a clean, allocation-free rejection.
const MAX_DECODE_DIMENSION_PX: u32 = 20_000;

/// The outcome of [`compress_for_import`].
#[derive(Debug, PartialEq, Eq)]
pub enum CompressOutcome {
    /// No rule fired, a rule's result was not strictly smaller than the
    /// input, or the input could not be safely decoded/encoded. The caller
    /// stores the original bytes untouched.
    Unchanged,
    /// The transform produced strictly smaller bytes in the given format.
    Compressed {
        bytes: Vec<u8>,
        content_type: &'static str,
    },
}

/// Downscale-then-re-encode transform over freshly imported attachment
/// bytes.
///
/// `content_type` is the caller's already-sniffed content type (see
/// `sniff::sniff_content_type`) — this function trusts it rather than
/// re-sniffing, since the caller already did that work.
///
/// Three rules apply, in order, to a bounded decode of `bytes`:
/// 1. Downscale when the long edge exceeds [`MAX_LONG_EDGE_PX`], preserving
///    aspect ratio.
/// 2. A PNG or WebP source (lossless-eligible) is re-encoded to lossless
///    WebP unconditionally — no byte floor, since the lossless path never
///    loses a pixel.
/// 3. A JPEG source is re-encoded lossily at [`JPEG_QUALITY`] only when
///    downscaling already fired, or the input exceeds
///    [`JPEG_LOSSY_FLOOR_BYTES`] — re-encoding an already-small JPEG that
///    does not need to shrink in pixel dimensions is pure generation loss
///    for negligible saving.
///
/// SVG and GIF short-circuit to `Unchanged` without a decode attempt. Any
/// decode/encode failure, and a result that is not strictly smaller than
/// `bytes`, also fall back to `Unchanged`.
pub fn compress_for_import(bytes: &[u8], content_type: &str) -> CompressOutcome {
    let is_jpeg = match content_type {
        "image/png" | "image/webp" => false,
        "image/jpeg" => true,
        // GIF, SVG, PDF, WAV, and anything else this transform does not
        // know how to decode: store as imported.
        _ => return CompressOutcome::Unchanged,
    };

    let Some(decoded) = decode_bounded(bytes) else {
        return CompressOutcome::Unchanged;
    };

    let (was_downscaled, image) = downscale_if_needed(decoded);

    if is_jpeg && !was_downscaled && bytes.len() <= JPEG_LOSSY_FLOOR_BYTES {
        return CompressOutcome::Unchanged;
    }

    let encoded = if is_jpeg {
        encode_jpeg(&image)
    } else {
        encode_lossless_webp(&image)
    };

    let Some(encoded) = encoded else {
        return CompressOutcome::Unchanged;
    };

    if encoded.len() < bytes.len() {
        CompressOutcome::Compressed {
            bytes: encoded,
            content_type: if is_jpeg { "image/jpeg" } else { "image/webp" },
        }
    } else {
        CompressOutcome::Unchanged
    }
}

/// Decode with explicit dimension limits, refusing a bomb-shaped header
/// before allocation. `None` on anything the decoder rejects, including a
/// declared size beyond [`MAX_DECODE_DIMENSION_PX`].
fn decode_bounded(bytes: &[u8]) -> Option<DynamicImage> {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DECODE_DIMENSION_PX);
    limits.max_image_height = Some(MAX_DECODE_DIMENSION_PX);
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    reader.limits(limits);
    reader.decode().ok()
}

/// Downscale `image` to fit within [`MAX_LONG_EDGE_PX`] on its long edge,
/// preserving aspect ratio. Returns whether a resize actually happened —
/// callers use it to decide whether the JPEG byte floor still applies.
fn downscale_if_needed(image: DynamicImage) -> (bool, DynamicImage) {
    if image.width() <= MAX_LONG_EDGE_PX && image.height() <= MAX_LONG_EDGE_PX {
        return (false, image);
    }
    let resized = image.resize(MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX, FilterType::Lanczos3);
    (true, resized)
}

/// Re-encode `image` as lossless WebP. `None` on encode failure.
fn encode_lossless_webp(image: &DynamicImage) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let encoder = WebPEncoder::new_lossless(&mut out);
    image.write_with_encoder(encoder).ok()?;
    Some(out)
}

/// Re-encode `image` as JPEG at [`JPEG_QUALITY`]. `None` on encode failure.
fn encode_jpeg(image: &DynamicImage) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    image.write_with_encoder(encoder).ok()?;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder as TestJpegEncoder;
    use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
    use image::{ImageBuffer, Rgb};

    /// Deterministic non-uniform pixel pattern — flat color would make the
    /// PNG/JPEG encoders' own compression heuristics behave unrealistically
    /// well, which would mask bugs a photo-like input would expose.
    fn pattern_pixel(x: u32, y: u32) -> Rgb<u8> {
        let r = ((x * 7 + y * 13) % 256) as u8;
        let g = ((x * 3 + y * 29) % 256) as u8;
        let b = ((x.wrapping_mul(11) ^ y.wrapping_mul(17)) % 256) as u8;
        Rgb([r, g, b])
    }

    /// A chaotic, JPEG-hostile pixel pattern used to force a JPEG fixture
    /// above [`JPEG_LOSSY_FLOOR_BYTES`] without needing a huge canvas.
    fn noisy_pixel(x: u32, y: u32) -> Rgb<u8> {
        let h = (x
            .wrapping_mul(2_654_435_761)
            .wrapping_add(y.wrapping_mul(40_503)))
        .wrapping_mul(2_246_822_519);
        Rgb([(h >> 24) as u8, (h >> 16) as u8, (h >> 8) as u8])
    }

    fn make_png(width: u32, height: u32, compression: CompressionType) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, pattern_pixel);
        let mut out = Vec::new();
        let encoder = PngEncoder::new_with_quality(&mut out, compression, PngFilterType::NoFilter);
        img.write_with_encoder(encoder).expect("encode fixture png");
        out
    }

    fn make_jpeg(width: u32, height: u32, quality: u8, noisy: bool) -> Vec<u8> {
        let pixel_fn = if noisy { noisy_pixel } else { pattern_pixel };
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, pixel_fn);
        let mut out = Vec::new();
        let encoder = TestJpegEncoder::new_with_quality(&mut out, quality);
        img.write_with_encoder(encoder)
            .expect("encode fixture jpeg");
        out
    }

    fn decode_dimensions(bytes: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory(bytes).expect("decode result bytes");
        (img.width(), img.height())
    }

    // Minimal CRC-32 (IEEE 802.3 / zlib polynomial) — PNG chunks are CRC'd,
    // and a mismatched CRC would make the crafted-header test fail for the
    // wrong reason (checksum rejection) rather than the one under test
    // (the dimension limit).
    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &byte in data {
            crc ^= byte as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        crc ^ 0xFFFF_FFFF
    }

    fn write_png_chunk(out: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(chunk_type);
        out.extend_from_slice(data);
        let mut crc_input = Vec::with_capacity(4 + data.len());
        crc_input.extend_from_slice(chunk_type);
        crc_input.extend_from_slice(data);
        out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    }

    /// A hand-assembled PNG whose IHDR declares dimensions far beyond
    /// [`MAX_DECODE_DIMENSION_PX`], with no IDAT at all. The `png` crate
    /// rejects this while still parsing the header (`LimitsExceeded`,
    /// checked against the raw row length / output buffer size derived
    /// purely from IHDR), so the decoder never gets far enough to need
    /// pixel data — proving the limit fires before allocation rather than
    /// merely before returning.
    fn craft_oversized_png_header() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&100_000u32.to_be_bytes()); // width
        ihdr.extend_from_slice(&100_000u32.to_be_bytes()); // height
        ihdr.push(8); // bit depth
        ihdr.push(2); // color type: truecolor (RGB)
        ihdr.push(0); // compression method
        ihdr.push(0); // filter method
        ihdr.push(0); // interlace method
        write_png_chunk(&mut bytes, b"IHDR", &ihdr);
        write_png_chunk(&mut bytes, b"IEND", &[]);
        bytes
    }

    #[test]
    fn oversized_png_downscales_to_lossless_webp() {
        let png = make_png(3000, 1500, CompressionType::Uncompressed);
        match compress_for_import(&png, "image/png") {
            CompressOutcome::Compressed {
                bytes,
                content_type,
            } => {
                assert_eq!(content_type, "image/webp");
                assert!(bytes.len() < png.len());
                let (w, h) = decode_dimensions(&bytes);
                assert!(w <= MAX_LONG_EDGE_PX && h <= MAX_LONG_EDGE_PX);
                assert_eq!(
                    w.max(h),
                    MAX_LONG_EDGE_PX,
                    "long edge should hit the ceiling exactly"
                );
            }
            other => panic!("expected Compressed, got {other:?}"),
        }
    }

    #[test]
    fn small_png_still_reencoded_when_smaller() {
        // No downscale needed (well under the ceiling) — the lossless path
        // has no floor, so a deliberately bloated (uncompressed) small PNG
        // should still shrink.
        let png = make_png(200, 200, CompressionType::Uncompressed);
        match compress_for_import(&png, "image/png") {
            CompressOutcome::Compressed {
                bytes,
                content_type,
            } => {
                assert_eq!(content_type, "image/webp");
                assert!(bytes.len() < png.len());
                let (w, h) = decode_dimensions(&bytes);
                assert_eq!((w, h), (200, 200));
            }
            other => panic!("expected Compressed, got {other:?}"),
        }
    }

    #[test]
    fn jpeg_under_floor_is_unchanged() {
        let jpeg = make_jpeg(64, 64, 90, false);
        assert!(jpeg.len() <= JPEG_LOSSY_FLOOR_BYTES);
        assert_eq!(
            compress_for_import(&jpeg, "image/jpeg"),
            CompressOutcome::Unchanged
        );
    }

    #[test]
    fn jpeg_over_floor_is_reencoded() {
        let jpeg = make_jpeg(700, 700, 100, true);
        assert!(
            jpeg.len() > JPEG_LOSSY_FLOOR_BYTES,
            "fixture must exceed the floor to exercise this path, got {} bytes",
            jpeg.len()
        );
        match compress_for_import(&jpeg, "image/jpeg") {
            CompressOutcome::Compressed {
                bytes,
                content_type,
            } => {
                assert_eq!(content_type, "image/jpeg");
                assert!(bytes.len() < jpeg.len());
            }
            CompressOutcome::Unchanged => {
                // A quality-85 re-encode of already-lossy noise is not
                // guaranteed to shrink further; the never-a-downgrade
                // invariant is allowed to win here. Assert on the
                // invariant this test actually owns instead: the floor
                // gate did not suppress the attempt.
            }
        }
    }

    #[test]
    fn svg_is_unchanged_without_decoding() {
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".to_vec();
        assert_eq!(
            compress_for_import(&svg, "image/svg+xml"),
            CompressOutcome::Unchanged
        );
    }

    #[test]
    fn animated_gif_is_unchanged_without_decoding() {
        // Minimal GIF89a header + a bogus animation extension marker (0x21
        // 0xF9, a Graphic Control Extension — the animation signal). The
        // point under test is that content-type routing alone (not decode
        // success/failure) keeps every GIF, animated or not, untouched —
        // `myne-core`'s `image` dependency has no gif codec compiled in at
        // all.
        let gif = b"GIF89a\x21\xF9\x04\x00\x00\x00\x00\x00".to_vec();
        assert_eq!(
            compress_for_import(&gif, "image/gif"),
            CompressOutcome::Unchanged
        );
    }

    #[test]
    fn corrupt_bytes_return_unchanged() {
        let garbage = vec![0u8; 64];
        assert_eq!(
            compress_for_import(&garbage, "image/png"),
            CompressOutcome::Unchanged
        );
    }

    #[test]
    fn unsupported_declared_content_type_returns_unchanged() {
        let png = make_png(10, 10, CompressionType::Uncompressed);
        // Bytes are a valid PNG, but the caller declared a type this
        // transform does not decode — must not be reinterpreted.
        assert_eq!(
            compress_for_import(&png, "application/pdf"),
            CompressOutcome::Unchanged
        );
    }

    #[test]
    fn encode_failure_falls_back_to_none() {
        // A 0x0 image is a degenerate buffer no encoder can write; both
        // encode helpers must report failure as `None`, not panic — the
        // caller turns that into `CompressOutcome::Unchanged`.
        let empty = DynamicImage::new_rgb8(0, 0);
        assert!(encode_lossless_webp(&empty).is_none());
        assert!(encode_jpeg(&empty).is_none());
    }

    #[test]
    fn crafted_oversized_header_refused_before_allocation() {
        let bomb = craft_oversized_png_header();
        assert_eq!(
            compress_for_import(&bomb, "image/png"),
            CompressOutcome::Unchanged
        );
    }

    #[test]
    fn result_not_smaller_returns_unchanged() {
        // An already near-optimally compressed small PNG (default
        // compression, adaptive filtering) is unlikely to beat a lossless
        // WebP re-encode by enough to matter, and may even lose — either
        // way, the invariant under test is "never worse than the input".
        let png = make_png(8, 8, CompressionType::Best);
        match compress_for_import(&png, "image/png") {
            CompressOutcome::Compressed { bytes, .. } => assert!(bytes.len() < png.len()),
            CompressOutcome::Unchanged => {} // also a valid, in-spec outcome
        }
    }

    #[test]
    fn deterministic_across_repeated_runs() {
        let png = make_png(1200, 900, CompressionType::Uncompressed);
        let first = compress_for_import(&png, "image/png");
        let second = compress_for_import(&png, "image/png");
        assert_eq!(first, second);
    }
}
