// SPDX-License-Identifier: AGPL-3.0-only
//! Bounded image decode — the decompression-bomb rail every untrusted
//! attachment-image decode in this plugin goes through.
//!
//! Two callers decode attachment bytes: the OCR extractor (`ocr`) and the
//! ingest-time compression transform (`compress`). Both face the same
//! adversary and both answer it the same way, so the answer lives here once.
//! Two copies of a security decision is the shape that drifts, and the one
//! that drifts is the one nobody is watching — the same argument
//! `sniff::served_content_type` makes for existing as a named function.

/// Maximum pixel dimension accepted for decoding.
///
/// An attachment is capped at 64 MiB of *compressed* bytes, which says nothing
/// about the decoded size — PNG reaches ~1000:1, so a few hundred KB can expand
/// to tens of gigabytes. `image`'s default limits leave width and height
/// unbounded (only a 512 MiB allocation ceiling), and an allocation abort is not
/// something `catch_unwind` recovers from. 20000 px comfortably exceeds any real
/// screenshot or scan (a 600 dpi A4 page is ~7000 px) while making the bomb case
/// a clean, allocation-free rejection.
pub(super) const MAX_IMAGE_DIMENSION_PX: u32 = 20_000;

/// Maximum bytes the decoder may allocate while decoding.
///
/// Stated explicitly rather than inherited. `image::Limits::default()` carries a
/// ~512 MiB allocation ceiling today, and a default is exactly the kind of
/// security-relevant number that moves under you on a dependency bump without a
/// line of this repo's diff to review. The dimension cap above does not subsume
/// it either: 20000 px is a per-axis bound, and the product of two legal axes is
/// what actually reaches the allocator.
///
/// 256 MiB admits a ~64-megapixel RGBA decode — comfortably above any real
/// screenshot, scan or phone photo (a 48 MP camera is ~192 MiB decoded), and
/// far below the point where a browser Worker or a phone would be killed for
/// asking. Both callers share it for the reason this module exists: one rail,
/// not two that drift.
///
/// **This TIGHTENED the OCR path.** Before the rail was shared, `ocr` decoded
/// under `Limits::default()` and inherited its ~512 MiB ceiling; an
/// extraordinarily large scan that OCR'd before this may now come back
/// `Failed`. That is the intended direction — the number is stated rather than
/// inherited — but it is a behaviour change to a pre-existing feature, so it is
/// written down here and pinned by `real_photo_sized_buffers_still_pass` rather
/// than left for whoever next debugs an OCR failure on a big scan.
const MAX_DECODE_ALLOC_BYTES: u64 = 256 * 1024 * 1024;

/// The limits every decode on this rail runs under. Named rather than inlined so
/// a test can assert against the same object the decoder is handed — a test that
/// rebuilt its own would only pin its own copy.
fn limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION_PX);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION_PX);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    limits
}

/// Decode with explicit dimension and allocation limits, refusing a bomb-shaped
/// header before allocation. `None` on anything the decoder rejects, including a
/// declared size beyond [`MAX_IMAGE_DIMENSION_PX`] or a decode that would exceed
/// [`MAX_DECODE_ALLOC_BYTES`].
// `pub`, not `pub(super)` (myne#309): the desktop PDF extractor decodes images
// embedded in a scanned PDF, and those are exactly as untrusted as an attached
// one. It used `image::load_from_memory` — `Limits::default()` — because this
// rail was not reachable from there. One rail, not two that drift, is the whole
// point of this module.
pub fn decode_bounded(bytes: &[u8]) -> Option<image::DynamicImage> {
    let mut reader = reader(bytes)?;
    reader.limits(limits());
    reader.decode().ok()
}

/// The declared `(width, height)` read from the header alone — no pixel data is
/// touched and nothing proportional to the image is allocated. `None` when the
/// format is unrecognized or the header does not parse.
///
/// Deliberately unbounded: a caller uses this to decide whether a full
/// [`decode_bounded`] is worth attempting at all, and that decode applies the
/// limit itself. Rejecting here too would only duplicate the rail.
pub(super) fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    reader(bytes)?.into_dimensions().ok()
}

fn reader(bytes: &[u8]) -> Option<image::ImageReader<std::io::Cursor<&[u8]>>> {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ColorType;

    /// The allocation ceiling is not subsumed by the dimension cap, and this is
    /// the case that proves it: both axes are inside [`MAX_IMAGE_DIMENSION_PX`],
    /// so only `max_alloc` can refuse the ~549 MiB buffer their product implies.
    /// `reserve_buffer` is the call a decoder itself makes before allocating.
    #[test]
    fn allocation_ceiling_refuses_a_buffer_the_axis_bounds_would_admit() {
        const SIDE: u32 = 12_000;
        const { assert!(SIDE < MAX_IMAGE_DIMENSION_PX) };
        assert!(limits()
            .reserve_buffer(SIDE, SIDE, ColorType::Rgba8)
            .is_err());
    }

    /// The other side of the same number, and the one that matters for the OCR
    /// path this rail tightened: a 48 MP phone photo (~183 MiB decoded) and a
    /// 600 dpi A4 scan must still decode. A ceiling that fails these would turn
    /// a working extraction into `Failed`.
    #[test]
    fn real_photo_sized_buffers_still_pass() {
        assert!(limits()
            .reserve_buffer(8_000, 6_000, ColorType::Rgba8)
            .is_ok());
        assert!(limits()
            .reserve_buffer(7_016, 4_961, ColorType::Rgba8)
            .is_ok());
    }

    /// A dependency bump that moves `Limits::default()` must not silently move
    /// this rail with it — the whole reason the ceiling is stated rather than
    /// inherited. Both facts are asserted: the value itself, and that it is
    /// strictly tighter than what the crate would have given us.
    #[test]
    fn allocation_ceiling_is_stated_not_inherited() {
        assert_eq!(MAX_DECODE_ALLOC_BYTES, 256 * 1024 * 1024);
        let inherited = image::Limits::default().max_alloc;
        assert!(
            inherited.is_none_or(|d| d > MAX_DECODE_ALLOC_BYTES),
            "the crate default ({inherited:?}) is no longer looser than this rail's ceiling"
        );
    }
}
