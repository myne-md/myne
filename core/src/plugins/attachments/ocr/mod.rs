// SPDX-License-Identifier: AGPL-3.0
//! On-device OCR for image + scanned-PDF attachments (MYND-441).
//!
//! This module owns model **resolution and loading**; the detection →
//! angle-classification → recognition pipeline lives in [`pipeline`]. It is
//! in `myne-core` rather than the desktop crate because mobile ships the same
//! extractor — the attachment-import path already takes the extractor as an
//! injected parameter, and mobile currently passes a no-op.
//!
//! **Not gated behind `local-inference`.** OCR is search correctness, not an AI
//! feature, so it compiles in every build including `--no-default-features`
//! (`src-tauri/scripts/ai-no-network-check.sh` check 3 asserts this). The
//! models are **bundled**, never side-loaded and never downloaded: `rten` has no
//! network surface and [`OcrModels::load_from_base`] reads only the directory it
//! is handed.
//!
//! Path discipline mirrors `model_store.rs`: a pure `*_from_base(base)` core the
//! tests drive directly, with the platform passing its own resource directory
//! (Tauri's resolved `models/ocr` on desktop, the platform resource dir on
//! mobile).
//!
//! Logging is DENY-list clean: [`OcrLoadError`] carries no path and no raw
//! `io::Error` (whose `Display` can leak OS paths).

pub mod pipeline;

pub use pipeline::{recognize, OcrLine, OcrOutput, MIN_WORD_CONFIDENCE};

use std::path::Path;
// `PathBuf` is reachable ONLY from `bundled_models_dir_for_tests` below, which
// carries this exact gate. Importing it unconditionally makes it an unused
// import in every ordinary build of this crate (the desktop/mobile hosts depend
// on `myne-core` without `test-support`), which `-D warnings` turns into a hard
// compile error — green under `cargo clippy -p myne-core`, red under the host
// build. Keep the gate on the import and the item in lockstep.
#[cfg(any(test, feature = "test-support"))]
use std::path::PathBuf;

use rten::Model;

use super::extract_types::{ExtractStatus, ExtractedText, SourceFormat};

/// Directory name, under whichever resource base the platform resolves, holding
/// the bundled weights. Mirrors the `tauri.conf.json` resources mapping
/// (`resources/models/ocr` → `models/ocr`).
pub const OCR_MODELS_DIR_NAME: &str = "ocr";

/// Text-region detection weights (DB).
pub const DET_MODEL_FILE: &str = "ppocrv5-mobile-det.rten";
/// Text-recognition weights (CTC head).
pub const REC_MODEL_FILE: &str = "ppocrv5-mobile-rec.rten";
/// 0°/180° line-orientation classifier weights.
pub const CLS_MODEL_FILE: &str = "ppocrv5-cls.rten";
/// Recognition charset, one entry per line.
pub const DICT_FILE: &str = "ppocrv5_dict.txt";

/// Why the bundled OCR models could not be loaded. Carries no path (DENY-list
/// logging discipline) — the caller degrades to "OCR unavailable" and records
/// the attachment as unsupported rather than surfacing a filesystem detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum OcrLoadError {
    /// A weights file is absent — e.g. a checkout whose Git-LFS blobs were never
    /// fetched. Not a failure worth breaking the build over: extraction reports
    /// the attachment unsupported and nothing is cached.
    #[error("bundled OCR model file missing")]
    ModelFileMissing,
    /// A weights file is present but `rten` rejected it (truncated LFS pointer,
    /// corrupt download, format from a future converter).
    #[error("bundled OCR model failed to load")]
    ModelUnreadable,
    /// The recognition charset is absent or empty.
    #[error("bundled OCR charset missing or empty")]
    CharsetUnreadable,
}

/// The three loaded models plus the recognition charset — everything the
/// pipeline needs, resolved once and reused for every attachment.
pub struct OcrModels {
    pub detection: Model,
    pub recognition: Model,
    pub orientation: Model,
    /// Index-aligned recognition classes: element 0 is the CTC blank, the dict
    /// lines follow, and the space class is appended last. See
    /// [`load_charset`] for why that trailing entry is load-bearing.
    pub charset: Vec<String>,
}

impl OcrModels {
    /// Resolve and load every bundled artefact from `base` (the platform's
    /// resolved `models/ocr` directory).
    pub fn load_from_base(base: &Path) -> Result<OcrModels, OcrLoadError> {
        let det = load_model(&base.join(DET_MODEL_FILE))?;
        let rec = load_model(&base.join(REC_MODEL_FILE))?;
        let cls = load_model(&base.join(CLS_MODEL_FILE))?;
        let charset = load_charset(&base.join(DICT_FILE))?;
        Ok(OcrModels {
            detection: det,
            recognition: rec,
            orientation: cls,
            charset,
        })
    }
}

fn load_model(path: &Path) -> Result<Model, OcrLoadError> {
    if !path.is_file() {
        return Err(OcrLoadError::ModelFileMissing);
    }
    Model::load_file(path).map_err(|_| OcrLoadError::ModelUnreadable)
}

/// Build the index-aligned recognition class list.
///
/// Three details are load-bearing and each was established by measurement in the
/// MYND-441 spike. All three fail *silently* — they corrupt recognized text
/// rather than erroring — so none of them may be simplified away:
///
/// 1. **The upstream dict is CRLF.** 18383 of its 18384 lines end with `\r`.
///    Rust's `read_to_string` performs no newline translation (unlike Python's
///    text mode, whose universal-newline handling hides this — which is exactly
///    how the spike's first charset survey mis-reported the file as clean), so
///    each class would otherwise be `"ç\r"` and every recognized character would
///    carry a trailing carriage return into the search index.
/// 2. The file ends with a newline, so a line split leaves a trailing empty
///    entry that is **not** a class. Leaving it in shifts the appended space
///    class one slot up, and every space then decodes as the empty string —
///    words silently run together (`QUARTERLY REVIEW` → `QUARTERLYREVIEW`).
/// 3. The space class is **appended last**, after the dict lines. The model's
///    output width is `1 + dict_len + 1` (blank + classes + space), which
///    `bundled_models_load` pins.
fn load_charset(path: &Path) -> Result<Vec<String>, OcrLoadError> {
    let raw = std::fs::read_to_string(path).map_err(|_| OcrLoadError::CharsetUnreadable)?;
    let mut chars: Vec<String> = raw
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect();
    while chars.last().is_some_and(|c| c.is_empty()) {
        chars.pop();
    }
    if chars.is_empty() {
        return Err(OcrLoadError::CharsetUnreadable);
    }
    let mut classes = Vec::with_capacity(chars.len() + 2);
    classes.push(String::new()); // index 0 = CTC blank, never emitted
    classes.extend(chars);
    classes.push(" ".to_string());
    Ok(classes)
}

/// Process-wide engine. The weights are ~21 MiB and take real time to parse, so
/// they are loaded **once** and shared by every extraction rather than reloaded
/// per attachment.
///
/// A `OnceLock` rather than a lazy initializer because the base directory is not
/// knowable from inside core — the platform resolves its own resource path and
/// calls [`init_from_base`] at startup. Until it does (or if the weights are
/// absent) [`models`] returns `None`, and the extractor records image
/// attachments as unsupported: OCR being unavailable must degrade the feature,
/// never break the app.
static ENGINE: std::sync::OnceLock<Option<OcrModels>> = std::sync::OnceLock::new();

/// Shortest side, in pixels, below which an image is assumed to be decoration
/// rather than a document — an icon, an emoji, a UI chrome sprite, a small logo.
/// Nothing readable lives under this, and skipping before decode means a vault
/// full of small images costs the queue nothing.
///
/// Applied to the **shorter** side so a wide, short banner crop still qualifies.
pub const MIN_OCR_IMAGE_SIDE: u32 = 96;

/// Whether an attachment is a raster image this OCR generation handles.
///
/// The single definition of "an OCR image", shared by the desktop dispatcher and
/// the mobile extractor so the two platforms cannot disagree about which files
/// get read.
///
/// Deliberately NOT `image/*`: GIF is animation and SVG is already text, so both
/// stay unsupported rather than paying a decode plus three model passes.
/// `sniff.rs` accepts all five; this list is the narrower one on purpose.
pub fn is_ocr_image(content_type: &str, filename: &str) -> bool {
    let ct = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if matches!(ct.as_str(), "image/png" | "image/jpeg" | "image/webp") {
        return true;
    }
    // Extension fallback, for attachments stored as `application/octet-stream`
    // (the MYND-173 default for unsniffed types).
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp")
}

/// The extractor **mobile** injects into the shared import path: image OCR only.
///
/// Mobile has no `lopdf`/`zip`/`quick-xml`, so PDF, DOCX and text-like
/// extraction remain desktop-only; everything else reports `Unsupported`
/// unchanged. This is what closes the image half of the desktop/mobile parity
/// gap — the import path already took the extractor as a parameter, and mobile
/// was passing a no-op.
pub fn extract_image_only(content_type: &str, filename: &str, bytes: &[u8]) -> ExtractedText {
    if is_ocr_image(content_type, filename) {
        extract_image(bytes)
    } else {
        ExtractedText::negative(ExtractStatus::Unsupported, SourceFormat::Other)
    }
}

/// Run OCR over an encoded image attachment and produce the cache payload.
///
/// Shared with mobile: the desktop extractor dispatches here rather than owning
/// image handling itself.
///
/// The status model is the existing one, used honestly:
/// - [`ExtractStatus::Unsupported`] — OCR is unavailable in this build/checkout,
///   or the image is below [`MIN_OCR_IMAGE_SIDE`]. Nothing was attempted, and a
///   later generation may do better.
/// - [`ExtractStatus::Failed`] — the bytes did not decode as an image.
/// - [`ExtractStatus::Empty`] — decoded fine, but nothing cleared the confidence
///   floor. This is the landscape-photo case, and caching it is the point: the
///   image is never OCR'd again at this `extractor_version`.
/// - [`ExtractStatus::Ok`] — recognized text.
pub fn extract_image(bytes: &[u8]) -> ExtractedText {
    let unsupported = || ExtractedText::negative(ExtractStatus::Unsupported, SourceFormat::Image);

    let Some(models) = models() else {
        return unsupported();
    };

    // Read the header only — an undersized image must cost nothing beyond this.
    let Some((w, h)) = super::decode::dimensions(bytes) else {
        return ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Image);
    };
    if w.min(h) < MIN_OCR_IMAGE_SIDE {
        return unsupported();
    }

    // The DECODE is inside the guard too, not just the pipeline: the third-party
    // decoder is the component actually parsing hostile bytes, so containing
    // only what runs after it would have protected the wrong half.
    let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let decoded = super::decode::decode_bounded(bytes)?;
        Some(pipeline::recognize(models, &decoded))
    }));
    match out {
        Ok(Some(o)) => ExtractedText::finalize(o.text(), SourceFormat::Image),
        Ok(None) | Err(_) => ExtractedText::negative(ExtractStatus::Failed, SourceFormat::Image),
    }
}

/// Load the bundled models from `base` and install them process-wide. Idempotent
/// and cheap after the first call. A failure is recorded as "unavailable" rather
/// than retried, so a checkout without Git-LFS blobs does not re-attempt a
/// 21 MiB parse for every attachment.
///
/// Returns whether OCR is available afterwards.
pub fn init_from_base(base: &Path) -> bool {
    ENGINE
        .get_or_init(|| OcrModels::load_from_base(base).ok())
        .is_some()
}

/// The process-wide models, if OCR is available.
pub fn models() -> Option<&'static OcrModels> {
    ENGINE.get().and_then(|m| m.as_ref())
}

/// Repo-relative location of the bundled models, for TESTS only.
///
/// Gated behind `test`/`test-support` deliberately: it embeds
/// `CARGO_MANIFEST_DIR`, a build-machine absolute path, which has no business in
/// a shipped library (reproducible-build hygiene, `threat-model.md` §6). The
/// `test-support` arm is what lets the desktop crate's own tests reach it — the
/// same gate `core::test_support` uses. At runtime the platform resolves its own
/// resource directory and passes it to [`init_from_base`].
#[cfg(any(test, feature = "test-support"))]
pub fn bundled_models_dir_for_tests() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("src-tauri")
        .join("resources")
        .join("models")
        .join(OCR_MODELS_DIR_NAME)
}

/// Whether this checkout actually HAS the weights, as opposed to the Git-LFS
/// pointers a `GIT_LFS_SKIP_SMUDGE=1` clone leaves in their place.
///
/// A pointer is a short text file whose first line is the LFS spec URL, so the
/// check is the same one `scripts/check-desktop-payload-budget.mjs` makes on the
/// packaging side, in the one place a Rust test can make it.
#[cfg(any(test, feature = "test-support"))]
pub fn bundled_weights_are_real() -> bool {
    const LFS_HEADER: &[u8] = b"version https://git-lfs.github.com/spec/v1";
    let dir = bundled_models_dir_for_tests();
    for f in [DET_MODEL_FILE, REC_MODEL_FILE, CLS_MODEL_FILE, DICT_FILE] {
        let path = dir.join(f);
        let Ok(meta) = std::fs::metadata(&path) else {
            return false;
        };
        // Only a small file can be a pointer; a real weight is megabytes.
        if meta.len() < 1024 {
            match std::fs::read(&path) {
                Ok(bytes) if bytes.starts_with(LFS_HEADER) => return false,
                Err(_) => return false,
                Ok(_) => {}
            }
        }
    }
    true
}

/// Install the bundled models for a test, reporting whether OCR is available —
/// and PANICKING when the weights are present and still will not load.
///
/// **The distinction is the whole point, and its absence hid a real failure.**
/// Every OCR test opened with `Err(_) => return` or an equivalent bare `return`,
/// which skips on a checkout without Git-LFS blobs and skips identically on a
/// genuine load failure, saying nothing either way. CI fetches the blobs, and
/// `check-desktop-payload-budget.mjs` already fails there on a pointer, so in CI
/// a failed load is a real failure that was being swallowed by the same line
/// that makes these tests convenient on a laptop.
///
/// What that cost: `image-ocr-search`'s io1 measured an EMPTY extraction against
/// the production binary while `cargo test` was green on the very tests that
/// claim OCR reads this exact fixture. A suite that reports success for a
/// component it never exercised is the failure `AGENTS.md` calls a silent-green
/// skip, and this is the shape of it.
///
/// Returns `false` only for the honest case: this checkout has no weights.
#[cfg(any(test, feature = "test-support"))]
pub fn init_bundled_models_for_tests() -> bool {
    if !bundled_weights_are_real() {
        return false; // no Git-LFS blobs here — nothing to exercise
    }
    assert!(
        init_from_base(&bundled_models_dir_for_tests()),
        "the OCR weights are present and are not Git-LFS pointers, so failing to \
         load them is a real failure rather than a checkout without blobs",
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The packaging contract: every artefact named in `tauri.conf.json` is
    /// actually present in the tree at the mapped path. Catches a missing
    /// Git-LFS fetch and a typo'd resources entry alike.
    #[test]
    fn every_bundled_artefact_is_present() {
        let dir = bundled_models_dir_for_tests();
        for f in [DET_MODEL_FILE, REC_MODEL_FILE, CLS_MODEL_FILE, DICT_FILE] {
            assert!(dir.join(f).is_file(), "bundled OCR artefact missing: {f}");
        }
    }

    /// The models load through `rten` from the bundled path, with no network.
    #[test]
    fn bundled_models_load() {
        // Degrades like its siblings on a checkout whose Git-LFS blobs were
        // never fetched. `every_bundled_artefact_is_present` is the one test
        // that SHOULD hard-fail there — it is the packaging contract.
        let Ok(models) = OcrModels::load_from_base(&bundled_models_dir_for_tests()) else {
            return;
        };
        // The recognition head's class count must equal the charset length, or
        // CTC decoding is silently off by one (the trailing-newline trap).
        assert_eq!(
            models.charset.len(),
            18385,
            "charset must be blank + 18383 dict entries + space"
        );
        assert_eq!(models.charset[0], "", "index 0 is the CTC blank");
        assert_eq!(
            models.charset.last().map(String::as_str),
            Some(" "),
            "the space class is appended last"
        );
    }

    /// The upstream dict is CRLF, and Rust does not translate newlines on read.
    /// Without the `\r` strip every class would be `"x\r"` and every recognized
    /// character would carry a carriage return into the search index — a silent
    /// corruption, not an error. Guard it directly.
    #[test]
    fn charset_entries_carry_no_carriage_return() {
        let Ok(models) = OcrModels::load_from_base(&bundled_models_dir_for_tests()) else {
            return;
        };
        assert!(
            !models.charset.iter().any(|c| c.contains('\r')),
            "a charset class still carries a CR — the CRLF strip regressed"
        );
        // And the file really is CRLF, so the strip is load-bearing rather than
        // defensive: if upstream ever ships LF this assertion documents why the
        // code looks redundant.
        let raw =
            std::fs::read(bundled_models_dir_for_tests().join(DICT_FILE)).expect("dict readable");
        assert!(
            raw.contains(&b'\r'),
            "bundled dict is no longer CRLF — the strip is now a no-op, keep it \
             anyway or re-verify against the new file"
        );
    }

    /// A missing directory degrades cleanly instead of panicking — the path a
    /// checkout without LFS blobs takes.
    #[test]
    fn missing_models_report_cleanly() {
        // `rten::Model` is not `Debug`, so `OcrModels` cannot be either —
        // match rather than `expect_err`.
        match OcrModels::load_from_base(Path::new("/nonexistent/myne/ocr")) {
            Err(e) => assert_eq!(e, OcrLoadError::ModelFileMissing),
            Ok(_) => panic!("loading from a nonexistent directory must not succeed"),
        }
    }

    /// The Turkish limitation is a measured property of the bundled charset, not
    /// a rumour: `Ğ` and `İ` are absent, which is why diacritic-folded indexing
    /// exists. If a future model swap fixes this, THIS TEST SHOULD FAIL — that is
    /// the signal to revisit the folding rationale in `decisions.md`.
    #[test]
    fn bundled_charset_documents_its_turkish_gap() {
        let Ok(models) = OcrModels::load_from_base(&bundled_models_dir_for_tests()) else {
            return;
        };
        let has = |c: char| models.charset.iter().any(|s| s == &c.to_string());
        for c in ['ç', 'Ç', 'ğ', 'ı', 'ö', 'Ö', 'ş', 'Ş', 'ü', 'Ü'] {
            assert!(has(c), "expected {c:?} in the bundled charset");
        }
        for c in ['Ğ', 'İ'] {
            assert!(
                !has(c),
                "{c:?} is now in the charset — the Turkish gap may be closed; \
                 revisit the diacritic-folding rationale before changing behaviour"
            );
        }
    }
}
