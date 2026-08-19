// SPDX-License-Identifier: AGPL-3.0
//! The OCR pipeline: decoded pixels in, confident text out (MYND-441).
//!
//! Three model passes, mirroring the reference implementation validated in the
//! task-1 spike:
//!
//! 1. **Detect** — a DB (differentiable binarization) head emits a per-pixel
//!    text probability map. Post-processing binarizes it, groups pixels into
//!    connected components, scores each by mean probability, and expands the
//!    survivors into text-line boxes.
//! 2. **Orient** — a 2-class head decides whether each line is upside-down.
//! 3. **Recognize** — a CTC head emits per-timestep class probabilities, greedily
//!    decoded into text with a per-character confidence.
//!
//! ## Deliberate simplification: axis-aligned boxes
//!
//! The reference pipeline used rotated rectangles and a perspective warp per
//! line. This one uses **axis-aligned** boxes and a plain crop. That keeps the
//! module free of a contour/min-area-rect/warp implementation (OpenCV's job in
//! the reference) at the cost of skewed input: a page rotated by a degree or two
//! — the realistic scanner/phone case, and what the spike's degraded fixture
//! exercised — reads fine, while a heavily rotated photo degrades. Recovering
//! that is a later improvement, not a correctness bug: a low-quality read lands
//! under the confidence floor and is recorded as "nothing found" rather than as
//! garbage.
//!
//! ## The confidence floor
//!
//! OCR does not decline to answer — it hallucinates plausible text on
//! textureless input. Garbage in an inverted index makes unrelated queries match
//! unrelated notes, so the floor is what separates "search reaches into your
//! documents" from "search got worse". [`MIN_WORD_CONFIDENCE`] carries the
//! measured justification.

use image::{imageops::FilterType, DynamicImage, RgbImage};
use rten_tensor::prelude::*;
use rten_tensor::{NdTensor, NdTensorView};

use super::OcrModels;

/// Longest side the detection input is scaled to. The model is fully
/// convolutional, so this trades accuracy on small text against time; 960 is the
/// upstream default and what the spike measured (77.6 ms/page).
const DET_LIMIT_SIDE: u32 = 960;

/// Detection input dimensions must be a multiple of this (the backbone's total
/// downsampling factor).
const DET_SIZE_MULTIPLE: u32 = 32;

/// ImageNet normalization, as the detection backbone was trained.
const DET_MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const DET_STD: [f32; 3] = [0.229, 0.224, 0.225];

/// Probability above which a detection pixel counts as text.
const DET_BIN_THRESHOLD: f32 = 0.3;

/// Mean-probability floor for a whole candidate region.
const DET_BOX_THRESHOLD: f32 = 0.6;

/// Components smaller than this (in detection-map pixels) are noise.
const DET_MIN_COMPONENT_AREA: usize = 12;

/// How far a detected component is expanded before cropping, as a fraction of
/// its short side. DB shrinks its training targets, so the raw component is
/// tighter than the glyphs; without this, ascenders and descenders are clipped.
const DET_EXPAND_RATIO: f32 = 0.35;

/// Recognition input height. Fixed by the model; only the width is dynamic.
const REC_HEIGHT: u32 = 48;

/// Upper bound on recognition input width. **Not** a crop: the aspect ratio is
/// preserved, so a line wider than this is scaled down rather than cut. Capping
/// too low squashes long lines into unreadability — the spike measured
/// `The quarterly report was reviewed during` → `Thequarers` at a 320 px cap.
const REC_MAX_WIDTH: u32 = 2400;

/// Orientation-classifier input size.
const CLS_HEIGHT: u32 = 48;
const CLS_WIDTH: u32 = 192;

/// Confidence at which the classifier is trusted to flip a line 180°.
const CLS_FLIP_CONFIDENCE: f32 = 0.9;

/// Per-character confidence below which a recognized character is discarded.
///
/// Measured in the MYND-441 spike, not guessed. Real text lines scored
/// **0.82–0.996**; the icon-scale logo negative control scored **0.255**, and the
/// landscape-photo control produced no regions at all. 0.5 sits in the empty
/// middle of that gap, so it discards hallucinated text without touching
/// genuine reads — including the degraded-scan fixture, whose worst real line
/// still scored 0.866.
///
/// Raising this trades recall on blurry scans for precision; lowering it lets
/// noise into the index, which is the more expensive failure because it degrades
/// search for documents that have nothing to do with the image.
pub const MIN_WORD_CONFIDENCE: f32 = 0.5;

/// A single recognized line.
#[derive(Debug, Clone, PartialEq)]
pub struct OcrLine {
    pub text: String,
    /// Mean per-character confidence over the emitted characters.
    pub confidence: f32,
}

/// What the pipeline produced for one image.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OcrOutput {
    /// Lines that cleared [`MIN_WORD_CONFIDENCE`], in reading order.
    pub lines: Vec<OcrLine>,
    /// Regions the detector found, before the confidence floor. Zero here means
    /// "no text-like structure at all" (the landscape-photo case); a positive
    /// count with no lines means "found something, did not believe it" (the
    /// logo case). The distinction is worth keeping for diagnostics.
    pub regions_detected: usize,
}

impl OcrOutput {
    /// The lines joined for indexing. Empty when nothing cleared the floor.
    pub fn text(&self) -> String {
        self.lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Run the full pipeline over a decoded image.
///
/// Never panics and never errors: an image the models cannot make sense of
/// yields an empty [`OcrOutput`], which the caller records as "nothing found" so
/// the attachment is not re-processed at this generation.
pub fn recognize(models: &OcrModels, image: &DynamicImage) -> OcrOutput {
    let rgb = image.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    if w == 0 || h == 0 {
        return OcrOutput::default();
    }

    let (det_input, det_w, det_h) = match preprocess_detection(&rgb) {
        Some(v) => v,
        None => return OcrOutput::default(),
    };
    let prob = match run_detection(models, det_input, det_w, det_h) {
        Some(p) => p,
        None => return OcrOutput::default(),
    };

    let boxes = detect_boxes(&prob, det_w as usize, det_h as usize);
    let regions_detected = boxes.len();
    if boxes.is_empty() {
        return OcrOutput::default();
    }

    // Detection ran on a scaled copy; map boxes back to source pixels.
    let sx = w as f32 / det_w as f32;
    let sy = h as f32 / det_h as f32;

    let mut lines = Vec::new();
    for b in boxes {
        let ib = b.scaled(sx, sy).clamped(w, h);
        if ib.width() < 4 || ib.height() < 4 {
            continue;
        }
        // Borrow-and-crop. The obvious `DynamicImage::ImageRgb8(rgb.clone())`
        // spelling copies the ENTIRE source image once per detected region —
        // hundreds of times on a dense page — which on a phone scan is
        // gigabytes of memcpy for nothing.
        let crop =
            image::imageops::crop_imm(&rgb, ib.x0, ib.y0, ib.width(), ib.height()).to_image();
        let crop = orient(models, crop);
        if let Some(line) = recognize_line(models, &crop) {
            if line.confidence >= MIN_WORD_CONFIDENCE && !line.text.trim().is_empty() {
                lines.push(line);
            }
        }
    }

    OcrOutput {
        lines,
        regions_detected,
    }
}

// ---- detection ------------------------------------------------------------

/// Scale to the detection input size and apply ImageNet normalization.
/// Returns the NCHW tensor plus the dimensions actually used.
fn preprocess_detection(rgb: &RgbImage) -> Option<(NdTensor<f32, 4>, u32, u32)> {
    let (w, h) = (rgb.width(), rgb.height());
    let long = w.max(h) as f32;
    let scale = (DET_LIMIT_SIDE as f32 / long).min(1.0);
    let nw = round_to_multiple((w as f32 * scale) as u32, DET_SIZE_MULTIPLE);
    let nh = round_to_multiple((h as f32 * scale) as u32, DET_SIZE_MULTIPLE);
    if nw == 0 || nh == 0 {
        return None;
    }
    let resized = image::imageops::resize(rgb, nw, nh, FilterType::Triangle);

    let mut t = NdTensor::zeros([1, 3, nh as usize, nw as usize]);
    for y in 0..nh as usize {
        for x in 0..nw as usize {
            let px = resized.get_pixel(x as u32, y as u32);
            for c in 0..3 {
                let v = px[c] as f32 / 255.0;
                t[[0, c, y, x]] = (v - DET_MEAN[c]) / DET_STD[c];
            }
        }
    }
    Some((t, nw, nh))
}

fn round_to_multiple(v: u32, m: u32) -> u32 {
    let r = (v / m) * m;
    r.max(m)
}

/// Forward pass, returning the flattened `h × w` probability map.
fn run_detection(models: &OcrModels, input: NdTensor<f32, 4>, w: u32, h: u32) -> Option<Vec<f32>> {
    let out = models.detection.run_one(input.view().into(), None).ok()?;
    let t: NdTensor<f32, 4> = out.try_into().ok()?;
    let (oh, ow) = (t.size(2), t.size(3));
    if oh != h as usize || ow != w as usize {
        // The head is expected to emit at input resolution; bail rather than
        // silently mis-mapping coordinates.
        return None;
    }
    // One contiguous copy rather than ~1M strided indexed reads.
    Some(t.to_contiguous().to_vec())
}

/// An axis-aligned box in detection-map coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Box {
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
}

impl Box {
    fn width(&self) -> u32 {
        self.x1.saturating_sub(self.x0)
    }
    fn height(&self) -> u32 {
        self.y1.saturating_sub(self.y0)
    }
    fn scaled(self, sx: f32, sy: f32) -> Box {
        Box {
            x0: (self.x0 as f32 * sx) as u32,
            y0: (self.y0 as f32 * sy) as u32,
            x1: (self.x1 as f32 * sx) as u32,
            y1: (self.y1 as f32 * sy) as u32,
        }
    }
    fn clamped(self, w: u32, h: u32) -> Box {
        Box {
            x0: self.x0.min(w.saturating_sub(1)),
            y0: self.y0.min(h.saturating_sub(1)),
            x1: self.x1.min(w),
            y1: self.y1.min(h),
        }
    }
}

/// Binarize the probability map, group text pixels into connected components,
/// score and expand them, and return the survivors in reading order.
fn detect_boxes(prob: &[f32], w: usize, h: usize) -> Vec<Box> {
    // Iterative flood fill over the binarized map. Iterative rather than
    // recursive on purpose: a full-page text region would blow the stack.
    let mut seen = vec![false; w * h];
    let mut out: Vec<Box> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();

    for start in 0..w * h {
        if seen[start] || prob[start] <= DET_BIN_THRESHOLD {
            continue;
        }
        stack.clear();
        stack.push(start);
        seen[start] = true;

        let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
        let mut sum = 0.0f32;
        let mut count = 0usize;

        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
            sum += prob[i];
            count += 1;

            // 8-connectivity: text strokes touch diagonally more often than not.
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                        continue;
                    }
                    let ni = ny as usize * w + nx as usize;
                    if !seen[ni] && prob[ni] > DET_BIN_THRESHOLD {
                        seen[ni] = true;
                        stack.push(ni);
                    }
                }
            }
        }

        if count < DET_MIN_COMPONENT_AREA {
            continue;
        }
        if sum / count as f32 <= DET_BOX_THRESHOLD {
            continue;
        }

        // DB shrinks its training targets, so expand before cropping or the
        // glyph extremes are clipped.
        let short = (x1 - x0).min(y1 - y0) as f32;
        let pad = (short * DET_EXPAND_RATIO).ceil().max(1.0) as usize;
        out.push(Box {
            x0: x0.saturating_sub(pad) as u32,
            y0: y0.saturating_sub(pad) as u32,
            x1: (x1 + pad).min(w - 1) as u32 + 1,
            y1: (y1 + pad).min(h - 1) as u32 + 1,
        });
    }

    // Reading order: banded by vertical position, then left-to-right. The band
    // quantum keeps a slightly tilted line from interleaving with its neighbour.
    out.sort_by_key(|b| {
        let band = (b.y0 + b.height() / 2) / 12;
        (band, b.x0)
    });
    out
}

// ---- orientation ----------------------------------------------------------

/// Flip a line 180° when the classifier is confident it is upside-down.
fn orient(models: &OcrModels, crop: RgbImage) -> RgbImage {
    let resized = image::imageops::resize(&crop, CLS_WIDTH, CLS_HEIGHT, FilterType::Triangle);
    let mut t: NdTensor<f32, 4> = NdTensor::zeros([1, 3, CLS_HEIGHT as usize, CLS_WIDTH as usize]);
    for y in 0..CLS_HEIGHT as usize {
        for x in 0..CLS_WIDTH as usize {
            let px = resized.get_pixel(x as u32, y as u32);
            for c in 0..3 {
                t[[0, c, y, x]] = (px[c] as f32 / 255.0 - 0.5) / 0.5;
            }
        }
    }
    let Ok(out) = models.orientation.run_one(t.view().into(), None) else {
        return crop;
    };
    let Ok(p): Result<NdTensor<f32, 2>, _> = out.try_into() else {
        return crop;
    };
    if p.size(1) < 2 {
        return crop;
    }
    let (upright, flipped) = (p[[0, 0]], p[[0, 1]]);
    if flipped > upright && flipped > CLS_FLIP_CONFIDENCE {
        image::imageops::rotate180(&crop)
    } else {
        crop
    }
}

// ---- recognition ----------------------------------------------------------

/// Recognize one cropped line. `None` when the model cannot be run at all.
fn recognize_line(models: &OcrModels, crop: &RgbImage) -> Option<OcrLine> {
    let (cw, ch) = (crop.width(), crop.height());
    if cw == 0 || ch == 0 {
        return None;
    }
    // Preserve aspect ratio at the fixed height; the width axis is dynamic.
    let target_w =
        ((cw as f32 * REC_HEIGHT as f32 / ch as f32).round() as u32).clamp(8, REC_MAX_WIDTH);
    let resized = image::imageops::resize(crop, target_w, REC_HEIGHT, FilterType::Triangle);

    let mut t: NdTensor<f32, 4> = NdTensor::zeros([1, 3, REC_HEIGHT as usize, target_w as usize]);
    for y in 0..REC_HEIGHT as usize {
        for x in 0..target_w as usize {
            let px = resized.get_pixel(x as u32, y as u32);
            for c in 0..3 {
                t[[0, c, y, x]] = (px[c] as f32 / 255.0 - 0.5) / 0.5;
            }
        }
    }

    let out = models.recognition.run_one(t.view().into(), None).ok()?;
    let logits: NdTensor<f32, 3> = out.try_into().ok()?;
    Some(ctc_decode(logits.view(), &models.charset))
}

/// Greedy CTC decode: take the argmax class per timestep, drop the blank
/// (class 0) and collapse runs of the same class, and average the winning
/// probabilities over the emitted characters.
fn ctc_decode(logits: NdTensorView<f32, 3>, charset: &[String]) -> OcrLine {
    let steps = logits.size(1);
    let classes = logits.size(2);

    let mut text = String::new();
    let mut conf_sum = 0.0f32;
    let mut emitted = 0usize;
    let mut prev = usize::MAX;

    for t in 0..steps {
        // The head already emits probabilities; renormalize defensively so a
        // logits-emitting model swap does not silently skew confidences.
        let mut best = 0usize;
        let mut best_v = f32::MIN;
        let mut sum = 0.0f32;
        for c in 0..classes {
            let v = logits[[0, t, c]];
            sum += v;
            if v > best_v {
                best_v = v;
                best = c;
            }
        }
        let p = if (0.99..=1.01).contains(&sum) {
            best_v
        } else {
            // `best_v` IS the row max, so pass it rather than re-scanning.
            softmax_at(logits, t, best, classes, best_v)
        };

        if best != 0 && best != prev {
            if let Some(ch) = charset.get(best) {
                text.push_str(ch);
                conf_sum += p;
                emitted += 1;
            }
        }
        prev = best;
    }

    OcrLine {
        text,
        confidence: if emitted == 0 {
            0.0
        } else {
            conf_sum / emitted as f32
        },
    }
}

/// Softmax probability of class `k` at timestep `t`, computed stably. `max` must
/// be the row maximum — the caller already computed it while finding the argmax,
/// so re-deriving it here would walk the row a third time.
fn softmax_at(logits: NdTensorView<f32, 3>, t: usize, k: usize, classes: usize, max: f32) -> f32 {
    let mut denom = 0.0f32;
    for c in 0..classes {
        denom += (logits[[0, t, c]] - max).exp();
    }
    if denom == 0.0 {
        return 0.0;
    }
    (logits[[0, t, k]] - max).exp() / denom
}

#[cfg(test)]
mod tests {
    use super::*;

    fn charset() -> Vec<String> {
        // blank + three characters
        vec![
            String::new(),
            "a".to_string(),
            "b".to_string(),
            " ".to_string(),
        ]
    }

    /// One-hot probabilities over timesteps: blanks separate repeats.
    fn logits_from(seq: &[usize], classes: usize) -> NdTensor<f32, 3> {
        let mut t: NdTensor<f32, 3> = NdTensor::zeros([1, seq.len(), classes]);
        for (i, &c) in seq.iter().enumerate() {
            t[[0, i, c]] = 1.0;
        }
        t
    }

    #[test]
    fn ctc_collapses_repeats_and_drops_blanks() {
        // Sequence: a a <blank> a b. CTC collapses the leading `a a` run to a
        // single 'a'; the blank then RE-ARMS, so the following 'a' is emitted
        // again rather than collapsed into the first. Expected read: "aab".
        // (Without the re-arm rule the answer would be "ab" — that is the whole
        // point of the blank symbol.)
        let l = logits_from(&[1, 1, 0, 1, 2], 4);
        let line = ctc_decode(l.view(), &charset());
        assert_eq!(line.text, "aab");
    }

    #[test]
    fn ctc_emits_nothing_for_an_all_blank_sequence() {
        let l = logits_from(&[0, 0, 0], 4);
        let line = ctc_decode(l.view(), &charset());
        assert_eq!(line.text, "");
        assert_eq!(line.confidence, 0.0, "no emission → no confidence");
    }

    #[test]
    fn ctc_confidence_is_the_mean_over_emitted_characters_only() {
        // Two confident characters and a long blank tail: the blanks must not
        // dilute the score, or every short line would look uncertain.
        // Rows sum to 1 — the recognition head ships with softmax baked in, so
        // this is the shape the decoder actually sees.
        let mut l: NdTensor<f32, 3> = NdTensor::zeros([1, 5, 4]);
        l[[0, 0, 1]] = 0.9;
        l[[0, 0, 0]] = 0.1;
        l[[0, 1, 0]] = 1.0;
        l[[0, 2, 2]] = 0.7;
        l[[0, 2, 0]] = 0.3;
        l[[0, 3, 0]] = 1.0;
        l[[0, 4, 0]] = 1.0;
        let line = ctc_decode(l.view(), &charset());
        assert_eq!(line.text, "ab");
        assert!(
            (line.confidence - 0.8).abs() < 1e-5,
            "expected mean(0.9, 0.7) = 0.8, got {}",
            line.confidence
        );
    }

    #[test]
    fn ctc_renormalizes_a_head_that_emits_raw_logits() {
        // The bundled head emits probabilities, but a future model swap might
        // not. Rows that do not sum to 1 are softmaxed rather than read as
        // confidences directly — otherwise a logit of 8.0 would be reported as
        // a confidence of 8.0 and every floor comparison would pass.
        let mut l: NdTensor<f32, 3> = NdTensor::zeros([1, 1, 4]);
        l[[0, 0, 0]] = -2.0;
        l[[0, 0, 1]] = 8.0;
        l[[0, 0, 2]] = -1.0;
        l[[0, 0, 3]] = -3.0;
        let line = ctc_decode(l.view(), &charset());
        assert_eq!(line.text, "a");
        assert!(
            line.confidence > 0.99 && line.confidence <= 1.0,
            "a dominant logit must normalize into (0,1], got {}",
            line.confidence
        );
    }

    #[test]
    fn ctc_ignores_a_class_outside_the_charset() {
        // A model/charset mismatch must drop the class, never panic or index
        // out of bounds — the charset is loaded from a separate file and could
        // in principle disagree with the weights.
        let l = logits_from(&[9], 12);
        let line = ctc_decode(l.view(), &charset());
        assert_eq!(line.text, "");
    }

    #[test]
    fn reading_order_is_banded_top_to_bottom_then_left_to_right() {
        // Two boxes on the same visual line (within the band quantum) must come
        // out left-to-right, and a lower line must follow both regardless of x.
        let w = 100usize;
        let h = 60usize;
        let mut prob = vec![0.0f32; w * h];
        let mut fill = |x0: usize, y0: usize, x1: usize, y1: usize| {
            for y in y0..y1 {
                for x in x0..x1 {
                    prob[y * w + x] = 1.0;
                }
            }
        };
        fill(60, 4, 80, 12); // top-right
        fill(5, 4, 25, 12); // top-left
        fill(5, 40, 25, 48); // bottom-left
        let boxes = detect_boxes(&prob, w, h);
        assert_eq!(boxes.len(), 3, "three components expected");
        assert!(boxes[0].x0 < boxes[1].x0, "top line ordered left-to-right");
        assert!(boxes[2].y0 > boxes[1].y0, "lower line comes last");
    }

    #[test]
    fn tiny_and_low_probability_components_are_discarded() {
        let w = 40usize;
        let h = 40usize;
        let mut prob = vec![0.0f32; w * h];
        // A 2x2 speck: above the binarization threshold but below the area floor.
        for y in 2..4 {
            for x in 2..4 {
                prob[y * w + x] = 1.0;
            }
        }
        // A large but weakly-scored blob: passes the area floor, fails the mean.
        for y in 20..32 {
            for x in 20..32 {
                prob[y * w + x] = 0.35;
            }
        }
        assert!(
            detect_boxes(&prob, w, h).is_empty(),
            "neither speck nor weak blob is a text region"
        );
    }

    #[test]
    fn output_text_joins_lines_and_is_empty_without_any() {
        let empty = OcrOutput::default();
        assert_eq!(empty.text(), "");
        let two = OcrOutput {
            lines: vec![
                OcrLine {
                    text: "first".into(),
                    confidence: 0.9,
                },
                OcrLine {
                    text: "second".into(),
                    confidence: 0.9,
                },
            ],
            regions_detected: 2,
        };
        assert_eq!(two.text(), "first\nsecond");
    }

    #[test]
    fn a_blank_image_yields_nothing_and_never_panics() {
        // Skips ONLY on a checkout without Git-LFS blobs; a load failure where
        // the weights are real is a panic, not a silent pass. See
        // `init_bundled_models_for_tests`.
        if !super::super::bundled_weights_are_real() {
            return;
        }
        let models = OcrModels::load_from_base(&super::super::bundled_models_dir_for_tests())
            .expect("weights are present and not pointers, so this load must succeed");
        let white =
            DynamicImage::ImageRgb8(RgbImage::from_pixel(64, 64, image::Rgb([255, 255, 255])));
        let out = recognize(&models, &white);
        assert!(out.lines.is_empty(), "a blank page has no text");
    }

    /// The one test that proves the pipeline actually reads text, rather than
    /// merely not crashing. Everything above exercises a stage in isolation;
    /// this drives detect → orient → recognize over a committed fixture and
    /// asserts the words come back.
    ///
    /// Deliberately unambiguous, high-contrast text: OCR *accuracy* is measured
    /// in the spike, not asserted here, because a tight accuracy assertion would
    /// encode today's model and fail on any future swap for no good reason.
    #[test]
    fn reads_known_text_from_a_fixture_image() {
        // Skips ONLY on a checkout without Git-LFS blobs; a load failure where
        // the weights are real is a panic, not a silent pass. See
        // `init_bundled_models_for_tests`.
        if !super::super::bundled_weights_are_real() {
            return;
        }
        let models = OcrModels::load_from_base(&super::super::bundled_models_dir_for_tests())
            .expect("weights are present and not pointers, so this load must succeed");
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("ocr-sample.png");
        let img = image::open(&path).expect("fixture decodes");
        let out = recognize(&models, &img);

        assert!(out.regions_detected > 0, "detector found no text at all");
        let text = out.text().to_lowercase();
        for want in ["invoice", "4200", "raporu"] {
            assert!(
                text.contains(want),
                "expected {want:?} in the recognized text, got {:?}",
                out.text()
            );
        }
        for line in &out.lines {
            assert!(
                line.confidence >= MIN_WORD_CONFIDENCE,
                "a line below the floor must not have been kept: {line:?}"
            );
        }
    }

    #[test]
    fn a_zero_sized_image_is_handled() {
        // Skips ONLY on a checkout without Git-LFS blobs; a load failure where
        // the weights are real is a panic, not a silent pass. See
        // `init_bundled_models_for_tests`.
        if !super::super::bundled_weights_are_real() {
            return;
        }
        let models = OcrModels::load_from_base(&super::super::bundled_models_dir_for_tests())
            .expect("weights are present and not pointers, so this load must succeed");
        let empty = DynamicImage::ImageRgb8(RgbImage::new(0, 0));
        assert_eq!(recognize(&models, &empty), OcrOutput::default());
    }
}
