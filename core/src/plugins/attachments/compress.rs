// SPDX-License-Identifier: AGPL-3.0-only
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
//! import into a failed one. That includes a **panic** inside the third-party
//! decoder or encoder — [`compress_for_import`] contains one itself rather than
//! relying on its caller's `run_blocking` to catch it, so the contract is a
//! property of this function and not of one call site.
//!
//! ## The one target where that contract cannot hold — and what is done about it
//!
//! `catch_unwind` needs unwinding, and `wasm32-unknown-unknown` has none: a
//! panic aborts the module (`crate::task` says so of `run_blocking`, whose wasm
//! arm runs the closure inline on the Worker's own loop, making the caller's
//! `Err(_) => Unchanged` arm dead code there). A hostile image that panicked
//! the decoder would therefore kill the vault Worker instead of falling back to
//! `Unchanged` — turning a successful import into a dead tab, which is exactly
//! the outcome the contract above forbids.
//!
//! So the transform does not run on wasm at all; see
//! [`is_supported_on_this_target`]. The `attachment_compression_enabled`
//! preference is untouched by this — it is a **shared** vault preference
//! (`decisions.md` 2026-07-30), so a web session still reads, writes and syncs
//! it, and every client that *can* contain a decoder panic keeps honouring it.
//! What the web client declines is performing the decode, not the setting.
//!
//! ## Decode limits are mandatory
//!
//! Compression makes every imported PNG/JPEG/WebP an untrusted decode, where
//! before this the OCR path was the only one decoding images at all. Both go
//! through the one shared rail, [`super::decode::decode_bounded`]: an explicit
//! [`image::Limits`] bounding width, height **and total allocation**, checked
//! by the decoder before it allocates a pixel buffer, with a limits violation
//! treated as
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

use super::decode::{decode_bounded, dimensions};
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
const MAX_LONG_EDGE_PX: u32 = 2400;

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
const JPEG_QUALITY: u8 = 85;

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
const JPEG_LOSSY_FLOOR_BYTES: usize = 256 * 1024;

/// The outcome of [`compress_for_import`].
#[derive(Debug, PartialEq, Eq)]
pub(super) enum CompressOutcome {
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
/// 2. A PNG source is re-encoded to lossless WebP unconditionally — no byte
///    floor, since the lossless path never loses a pixel. A **WebP** source is
///    lossless-eligible too, but is only touched when rule 1 fires: see the
///    gate below for why re-encoding it otherwise is work with a known outcome.
/// 3. A JPEG source is re-encoded lossily at [`JPEG_QUALITY`] only when rule 1
///    will fire, or the input exceeds [`JPEG_LOSSY_FLOOR_BYTES`] —
///    re-encoding an already-small JPEG that does not need to shrink in pixel
///    dimensions is pure generation loss for negligible saving.
///
/// Anything [`is_eligible`] rejects short-circuits to `Unchanged` without a
/// decode attempt, as does a source the header alone settles. Any
/// decode/encode failure — **including a panic inside the decoder or the
/// encoder** — and a result that is not strictly smaller than `bytes`, also
/// fall back to `Unchanged`.
pub(super) fn compress_for_import(bytes: &[u8], content_type: &str) -> CompressOutcome {
    let is_jpeg = match content_type {
        "image/png" | "image/webp" => false,
        "image/jpeg" => true,
        // Unreachable via `attachment_import`, which gates on `is_eligible`
        // first; kept so the transform is total over any content type.
        _ => return CompressOutcome::Unchanged,
    };

    // EVERY parse of `bytes` is inside the guard — the header read in
    // `transform`'s short-circuit as much as the full decode: the third-party
    // parser is the component actually reading hostile bytes, so containing
    // only what runs after it would protect the wrong half, and a header parse
    // (PNG IHDR, JPEG SOF, the VP8 header) is a parser over the same bytes.
    // The same reasoning, and the same shape, as `ocr::extract_image`. Without
    // this the module header's "every failure path returns `Unchanged`" would
    // hold only because `attachment_import` happens to call through
    // `run_blocking`, which is a property of one call site rather than of this
    // function.
    //
    // `AssertUnwindSafe` is sound here because nothing observable survives an
    // unwind: `bytes` is borrowed read-only, and every buffer the closure
    // allocates is local to it.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        transform(bytes, content_type, is_jpeg)
    }))
    .unwrap_or(CompressOutcome::Unchanged)
}

/// The header short-circuit → decode → downscale → re-encode body of
/// [`compress_for_import`], split out so the panic guard wraps it whole.
///
/// The plaintext intermediates here — the decoded `DynamicImage` pixel buffer,
/// the resize intermediate, and the encoder's output `Vec` before the caller
/// wraps it — are **not** `Zeroizing`, and that is the honest shape rather than
/// a slip (the same statement `commands.rs` makes about its own buffers). Two
/// reasons: they are pixels the WebView already holds in a V8 heap this crate
/// cannot reach (`src-tauri/AGENTS.md`, "Secret-handling logging discipline"),
/// so the retention window is dominated by a copy outside this process; and
/// `image` allocates and reallocates internally, so wrapping the handles this
/// function holds would zero the last buffer while leaving the growth chain
/// behind it untouched — a guarantee that reads stronger than it is.
fn transform(bytes: &[u8], content_type: &str, is_jpeg: bool) -> CompressOutcome {
    // Two sources the HEADER alone settles, decided before paying a full
    // entropy decode into a pixel buffer that would then be discarded:
    //
    // * JPEG under rule 3's floor. Whether rule 1 fires is a function of the
    //   declared dimensions alone, so this is the same gate at a header
    //   parse's cost. That is the common case: a pasted, already-small,
    //   already-screen-sized JPEG.
    // * **Any** WebP. The source is already in the container the lossless path
    //   targets, so the re-encode has no format change to win with: a lossy
    //   WebP inflates when written back losslessly and is discarded by the
    //   not-smaller guard, and an already-lossless one round-trips to roughly
    //   its own size. Either way the outcome is known before the work, and the
    //   only WebP worth decoding is one that must lose pixels regardless.
    let header_settles_it = match content_type {
        "image/jpeg" => bytes.len() <= JPEG_LOSSY_FLOOR_BYTES,
        "image/webp" => true,
        _ => false,
    };
    if header_settles_it && !exceeds_long_edge(bytes) {
        return CompressOutcome::Unchanged;
    }

    let Some(decoded) = decode_bounded(bytes) else {
        return CompressOutcome::Unchanged;
    };

    let image = downscale_if_needed(decoded);

    let encoded = if is_jpeg {
        encode_jpeg(&image, bytes.len())
    } else {
        encode_lossless_webp(&image, bytes.len())
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

/// Whether ingest-time compression may run on this build's target at all.
///
/// `false` on `wasm32` only, and for a containment reason rather than a
/// capability one — the module header states it in full. Separate from
/// [`is_eligible`]'s format question because the two are independent: this one
/// would stay false on the web client even if every format were supported.
pub(super) const fn is_supported_on_this_target() -> bool {
    cfg!(not(target_arch = "wasm32"))
}

/// Whether [`compress_for_import`] can do anything at all with a content type.
///
/// Visible to the plugin so `attachment_import` can ask BEFORE reading the
/// preference and copying the bytes: a PDF, a zip or a voice clip must not pay
/// a `vault.prefs` decrypt and a full-size buffer copy to be told "no". Format
/// knowledge stays here — the caller learns only whether to bother. GIF and SVG
/// are absent for the reasons in this module's header, and so is every format
/// on a target [`is_supported_on_this_target`] rules out.
pub(super) fn is_eligible(content_type: &str) -> bool {
    is_supported_on_this_target()
        && matches!(content_type, "image/png" | "image/webp" | "image/jpeg")
}

/// Whether the declared long edge exceeds [`MAX_LONG_EDGE_PX`], read from the
/// header alone. `false` when the header does not parse — the full decode
/// would fail too, and `Unchanged` is the answer either way.
fn exceeds_long_edge(bytes: &[u8]) -> bool {
    dimensions(bytes).is_some_and(|(w, h)| w.max(h) > MAX_LONG_EDGE_PX)
}

/// Downscale `image` to fit within [`MAX_LONG_EDGE_PX`] on its long edge,
/// preserving aspect ratio. A no-op when it already fits.
fn downscale_if_needed(image: DynamicImage) -> DynamicImage {
    if image.width() <= MAX_LONG_EDGE_PX && image.height() <= MAX_LONG_EDGE_PX {
        return image;
    }
    image.resize(MAX_LONG_EDGE_PX, MAX_LONG_EDGE_PX, FilterType::Lanczos3)
}

/// Re-encode `image` as lossless WebP. `None` on encode failure. `capacity_hint`
/// is the source's byte length: a result at or above it is discarded by the
/// caller, so sizing the buffer there costs nothing and spares the growth
/// realloc chain from zero.
fn encode_lossless_webp(image: &DynamicImage, capacity_hint: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(capacity_hint);
    let encoder = WebPEncoder::new_lossless(&mut out);
    image.write_with_encoder(encoder).ok()?;
    Some(out)
}

/// Re-encode `image` as JPEG at [`JPEG_QUALITY`]. `None` on encode failure.
/// `capacity_hint` as in [`encode_lossless_webp`].
fn encode_jpeg(image: &DynamicImage, capacity_hint: usize) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(capacity_hint);
    let encoder = JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY);
    image.write_with_encoder(encoder).ok()?;
    Some(out)
}

/// Deterministic non-uniform pixel pattern — flat color would make the
/// PNG/JPEG encoders' own compression heuristics behave unrealistically
/// well, which would mask bugs a photo-like input would expose.
#[cfg(test)]
fn pattern_pixel(x: u32, y: u32) -> image::Rgb<u8> {
    let r = ((x * 7 + y * 13) % 256) as u8;
    let g = ((x * 3 + y * 29) % 256) as u8;
    let b = ((x.wrapping_mul(11) ^ y.wrapping_mul(17)) % 256) as u8;
    image::Rgb([r, g, b])
}

/// A PNG fixture of `pattern_pixel` at the given `compression`. Shared with
/// `commands.rs`'s import tests, which need the same
/// `CompressionType::Uncompressed` trick — a deliberately bloated source, so
/// the re-encode reliably wins instead of depending on the PNG encoder's own
/// compression luck.
#[cfg(test)]
pub(super) fn make_png(
    width: u32,
    height: u32,
    compression: image::codecs::png::CompressionType,
) -> Vec<u8> {
    use image::codecs::png::{FilterType as PngFilterType, PngEncoder};
    use image::{ImageBuffer, Rgb};
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, pattern_pixel);
    let mut out = Vec::new();
    let encoder = PngEncoder::new_with_quality(&mut out, compression, PngFilterType::NoFilter);
    img.write_with_encoder(encoder).expect("encode fixture png");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::codecs::jpeg::JpegEncoder as TestJpegEncoder;
    use image::codecs::png::CompressionType;
    use image::{ImageBuffer, Rgb};

    /// A chaotic, JPEG-hostile pixel pattern used to force a JPEG fixture
    /// above [`JPEG_LOSSY_FLOOR_BYTES`] without needing a huge canvas.
    fn noisy_pixel(x: u32, y: u32) -> Rgb<u8> {
        let h = (x
            .wrapping_mul(2_654_435_761)
            .wrapping_add(y.wrapping_mul(40_503)))
        .wrapping_mul(2_246_822_519);
        Rgb([(h >> 24) as u8, (h >> 16) as u8, (h >> 8) as u8])
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

    fn make_webp(width: u32, height: u32) -> Vec<u8> {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(width, height, pattern_pixel);
        let mut out = Vec::new();
        let encoder = WebPEncoder::new_lossless(&mut out);
        img.write_with_encoder(encoder)
            .expect("encode fixture webp");
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
    /// [`super::super::decode::MAX_IMAGE_DIMENSION_PX`], with no IDAT at all. The `png` crate
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
            // Deliberately fatal rather than tolerated. An `Unchanged` arm
            // that passes would make this test green even if the lossy path
            // were deleted outright — the floor gate is the only thing it
            // owns, and a gate that suppressed the attempt is exactly the
            // failure it exists to catch. The fixture is quality-100 noise,
            // so a quality-85 re-encode at the same dimensions shrinks it by
            // a wide margin; if a future encoder ever makes that untrue, the
            // fixture is what should move.
            CompressOutcome::Unchanged => {
                panic!("an over-floor JPEG must be re-encoded, not suppressed by the floor gate")
            }
        }
    }

    #[test]
    fn svg_is_unchanged_without_decoding() {
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".to_vec();
        assert!(!is_eligible("image/svg+xml"));
        assert_eq!(
            compress_for_import(&svg, "image/svg+xml"),
            CompressOutcome::Unchanged
        );
    }

    /// `is_eligible` is what `attachment_import` gates on before it reads the
    /// preference and copies the bytes, so it must agree exactly with the
    /// set `compress_for_import` can act on — a disagreement in one direction
    /// silently disables the feature for a format, and in the other reinstates
    /// the wasted prefs read + copy this predicate exists to avoid.
    #[test]
    fn eligibility_matches_the_formats_the_transform_handles() {
        for ct in ["image/png", "image/webp", "image/jpeg"] {
            assert!(is_eligible(ct), "{ct} must be eligible");
        }
        for ct in [
            "image/gif",
            "image/svg+xml",
            "application/pdf",
            "audio/wav",
            "application/octet-stream",
        ] {
            assert!(!is_eligible(ct), "{ct} must not be eligible");
            // The transform agrees, given bytes it could otherwise decode.
            let png = make_png(10, 10, CompressionType::Uncompressed);
            assert_eq!(compress_for_import(&png, ct), CompressOutcome::Unchanged);
        }
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
        assert!(!is_eligible("image/gif"));
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
        assert!(encode_lossless_webp(&empty, 0).is_none());
        assert!(encode_jpeg(&empty, 0).is_none());
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

    /// Determinism is the premise dedup rests on, and repeating a call in one
    /// process cannot show it: the interesting question is whether two
    /// PLATFORMS agree, since the same image imported on a laptop and a phone
    /// must land on one attachment id, not two. That cannot be asserted from
    /// inside a single process either — but it can be PINNED, so a divergence
    /// shows up as a red test on whichever platform disagrees instead of as two
    /// blobs nobody looks at.
    ///
    /// **If this fires:** the encoder's output moved. That is not automatically
    /// a bug — an `image` bump may legitimately change it — but it does mean
    /// every attachment imported before the change now dedups separately from
    /// the same image imported after it. Re-pin the literal deliberately and
    /// say so in the commit; do not "fix" it by deleting the assert.
    #[test]
    fn compressed_output_is_byte_stable() {
        use sha2::{Digest, Sha256};

        let png = make_png(1200, 900, CompressionType::Uncompressed);
        let CompressOutcome::Compressed { bytes, .. } = compress_for_import(&png, "image/png")
        else {
            panic!("fixture must compress for this pin to mean anything");
        };
        let digest = Sha256::digest(&bytes)
            .iter()
            .fold(String::new(), |mut s, b| {
                use std::fmt::Write;
                let _ = write!(s, "{b:02x}");
                s
            });
        assert_eq!(
            digest, "509f0f30b880d6d415cd659748b5ddafb2f0171fd7c07c119b15bedc5b7f5cb6",
            "lossless-WebP encoder output moved; see this test's doc comment"
        );
    }

    /// A WebP source is already in the container the lossless path targets, so
    /// the transform has no format change to win with. Below the downscale
    /// ceiling the answer is knowable from the header, and paying a full decode
    /// plus a lossless re-encode to reach the not-smaller guard is work whose
    /// result was never in doubt.
    #[test]
    fn small_webp_is_unchanged_without_a_decode() {
        let webp = make_webp(200, 200);
        assert!(is_eligible("image/webp"));
        assert_eq!(
            compress_for_import(&webp, "image/webp"),
            CompressOutcome::Unchanged
        );
    }

    /// The other half of the gate above: a WebP big enough to need rule 1 IS
    /// worth the decode, because downscaling wins on pixels rather than on
    /// container. Without both tests the skip could be a silent disable.
    ///
    /// The fixture is 6000 px rather than a hair over the ceiling on purpose.
    /// `pattern_pixel` is deliberately incompressible, and Lanczos-resampling
    /// it produces data that costs MORE per pixel losslessly than the original
    /// did — so a marginal downscale can legitimately fail the not-smaller
    /// guard and would make this test assert the gate while actually measuring
    /// the encoder. At 6.25 % of the source's pixel count the pixel saving
    /// dominates any per-pixel loss, which is what makes the `Compressed` arm
    /// a statement about the gate.
    #[test]
    fn oversized_webp_is_still_downscaled() {
        let webp = make_webp(6000, 3000);
        match compress_for_import(&webp, "image/webp") {
            CompressOutcome::Compressed {
                bytes,
                content_type,
            } => {
                assert_eq!(content_type, "image/webp");
                assert!(bytes.len() < webp.len());
                let (w, h) = decode_dimensions(&bytes);
                assert_eq!(w.max(h), MAX_LONG_EDGE_PX);
            }
            other => panic!("expected Compressed, got {other:?}"),
        }
    }

    /// The wasm arm's containment gate, asserted from the side the test suite
    /// runs on. `is_eligible` must fold in the target question, not just the
    /// format one — a refactor that drops the conjunct would silently re-enable
    /// an uncontainable decode in the vault Worker, and nothing else in this
    /// repo's gates would notice (the wasm build compiles either way).
    #[test]
    fn eligibility_folds_in_the_target_support_gate() {
        assert!(
            is_supported_on_this_target(),
            "native targets can contain a decoder panic and must run the transform"
        );
        for ct in ["image/png", "image/webp", "image/jpeg"] {
            assert_eq!(
                is_eligible(ct),
                is_supported_on_this_target(),
                "{ct}'s eligibility must track target support, not only format"
            );
        }
    }
}

/// Ingest compression must not cost the image its searchability.
///
/// **This is the property `image-ocr-search`'s io1 measured to be broken, from
/// the outside and without being able to say where.** That scenario imports a
/// scanned-document fixture through the real IPC and then cannot find the note
/// by a word only the pixels contain; the gate added to it reported an EMPTY
/// MYE1 entry, and the OCR pipeline's own test reads the same fixture correctly.
/// The one thing between them is this module: `attachment_import` compresses
/// FIRST and extracts from the compressed bytes, so whatever compression does to
/// a page of text is what OCR sees.
///
/// The rule under test is the composition, not either half. Both halves have
/// tests and both pass; a lossless-by-design re-encode that OCR then cannot read
/// would satisfy every one of them.
#[cfg(test)]
mod ocr_survives_compression {
    use super::*;

    #[test]
    fn a_compressed_scan_is_still_readable_by_ocr() {
        // Skips only on a checkout without Git-LFS blobs, never on a real
        // failure — see `ocr::init_bundled_models_for_tests`.
        if !super::super::ocr::bundled_weights_are_real() {
            return;
        }
        assert!(super::super::ocr::init_bundled_models_for_tests());

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr-sample.png");
        let original = std::fs::read(&path).expect("fixture reads");

        // Sanity: the fixture is readable BEFORE compression, so a failure below
        // is attributable to this module rather than to the fixture or the
        // weights.
        let before = super::super::ocr::extract_image(&original);
        assert!(
            before.text.to_lowercase().contains("invoice"),
            "precondition: OCR reads the uncompressed fixture, got {:?}",
            before.text
        );

        // **Non-vacuity, asserted rather than assumed.** `Unchanged` is a
        // legitimate outcome of this transform and it preserves searchability
        // trivially, so an early return there would leave this test green while
        // exercising nothing — which is the same silent-skip shape the OCR tests
        // above were just fixed for. This fixture is a PNG, and rule 2 re-encodes
        // a PNG unconditionally, so a no-op here means the transform stopped
        // doing what its own documentation says.
        let stored = match compress_for_import(&original, "image/png") {
            CompressOutcome::Compressed { bytes, .. } => bytes,
            CompressOutcome::Unchanged => panic!(
                "a PNG must be re-encoded by rule 2, so an unchanged result means \
                 this test would have proved nothing about the composition"
            ),
        };

        let after = super::super::ocr::extract_image(&stored);
        assert!(
            after.text.to_lowercase().contains("invoice"),
            "ingest compression destroyed the text OCR could read before it: \
             {} bytes in, {} bytes stored, extracted {:?}",
            original.len(),
            stored.len(),
            after.text
        );
    }

    /// **What the test above cannot answer, and photo-to-note needed answered.**
    ///
    /// `a_compressed_scan_is_still_readable_by_ocr` asserts that a WORD
    /// survives. A page full of words can lose a third of them and still satisfy
    /// it, so it cannot decide whether reading the ORIGINAL bytes instead of the
    /// stored ones would be worth moving the extraction step (myne-md/myne#926,
    /// task 1). This test prints the character-level agreement between the two
    /// readings and holds a floor under it.
    ///
    /// **The fixture is a RENDERED page, not a scan and not a photograph.**
    /// `ocr-page-photo.png` is a 3000 px render (437 KB) that trips BOTH compression rules: the long edge
    /// exceeds `MAX_LONG_EDGE_PX`, and the PNG is above the lossy floor, so it
    /// is downscaled to 2400 px AND re-encoded at `JPEG_QUALITY`. That is the
    /// exact composition a phone photograph goes through at import.
    ///
    /// **And the number is a LOWER bound on the cost to a real photograph**,
    /// which is why it is recorded rather than treated as the answer. Crisp,
    /// evenly lit, high-contrast glyphs compress far better than the same page
    /// photographed by hand: no shadow, no perspective, no sensor noise, no
    /// pen. If crisp text loses this much, paper loses at least as much.
    #[test]
    fn the_accuracy_cost_of_compression_is_measured() {
        if !super::super::ocr::bundled_weights_are_real() {
            return;
        }
        assert!(super::super::ocr::init_bundled_models_for_tests());

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr-page-photo.png");
        let original = std::fs::read(&path).expect("fixture reads");

        let stored = match compress_for_import(&original, "image/png") {
            CompressOutcome::Compressed { bytes, .. } => bytes,
            CompressOutcome::Unchanged => panic!(
                "the fixture is chosen to trip both compression rules, so an \
                 unchanged result means this test measured nothing"
            ),
        };

        let before = super::super::ocr::extract_image(&original);
        let after = super::super::ocr::extract_image(&stored);
        assert!(
            !before.text.trim().is_empty(),
            "precondition: OCR reads the uncompressed page photo"
        );
        assert!(
            !after.text.trim().is_empty(),
            "ingest compression left nothing readable: {} bytes in, {} stored",
            original.len(),
            stored.len()
        );

        // Whitespace is collapsed before comparing: mean newlines are a
        // presentation difference between two runs of the same detector, not an
        // accuracy loss, and letting them count would make the figure move when
        // the layout heuristic changes rather than when the pixels do.
        let a = collapse_ws(&before.text);
        let b = collapse_ws(&after.text);
        let similarity = char_agreement(&a, &b);
        println!(
            "MEASURE ocr-compression original_bytes={} stored_bytes={} \
             original_chars={} stored_chars={} char_agreement={:.4}",
            original.len(),
            stored.len(),
            a.chars().count(),
            b.chars().count(),
            similarity
        );
        println!("MEASURE before={:?}", before.text);
        println!("MEASURE after={:?}", after.text);

        // The floor sits close to what this fixture measures, with room only for
        // the run-to-run wobble of the detector itself. It exists so a future
        // change to the compression constants, the JPEG encoder or the model has
        // to face the number it moved rather than only the two texts it printed:
        // at 0.93 a change costing five points would have passed green while the
        // printed figure stayed nobody's gate.
        assert!(
            similarity >= 0.97,
            "ingest compression cost more character accuracy than this fixture \
             measured when the floor was set ({similarity:.4} < 0.97)"
        );
    }

    /// Every run of whitespace becomes one space, so two readings of the same
    /// page differ only by their words.
    fn collapse_ws(text: &str) -> String {
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// `1 - levenshtein(a, b) / max(len(a), len(b))` over characters.
    ///
    /// A dependency-free DP rather than a crate: this is a measurement, and
    /// adding a similarity crate to the crate graph to compute one number in a
    /// test would be a bigger change than the measurement.
    fn char_agreement(a: &str, b: &str) -> f64 {
        let a: Vec<char> = a.chars().collect();
        let b: Vec<char> = b.chars().collect();
        let longest = a.len().max(b.len());
        if longest == 0 {
            return 1.0;
        }
        let mut prev: Vec<usize> = (0..=b.len()).collect();
        let mut cur = vec![0usize; b.len() + 1];
        for (i, ca) in a.iter().enumerate() {
            cur[0] = i + 1;
            for (j, cb) in b.iter().enumerate() {
                let cost = usize::from(ca != cb);
                cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
            }
            std::mem::swap(&mut prev, &mut cur);
        }
        1.0 - (prev[b.len()] as f64 / longest as f64)
    }
}
