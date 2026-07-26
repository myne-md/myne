# Bundled OCR model — image + scanned-PDF text extraction (MYND-441)

This directory ships the **on-device OCR models** with the app so that searching
inside images and scanned PDFs works out of the box, with no user action.

Unlike the bundled transcription model next door, OCR is **not** behind the AI
opt-in and **not** side-loadable. It is search correctness, not an AI feature: an
extraction that only runs after the user finds a Labs toggle and picks a model
file would never have run by the time they search. It also ships on **mobile**,
not desktop-only — the attachment-import path injects the extractor, and mobile
passes the same one.

## What ships here

| File | What | Tracking |
|---|---|---|
| `ppocrv5-mobile-det.rten` | text-region detection (DB) | **Git LFS** (`.gitattributes` `*.rten`) |
| `ppocrv5-mobile-rec.rten` | text recognition (CTC head) | **Git LFS** |
| `ppocrv5-cls.rten` | 0°/180° line-orientation classifier | **Git LFS** |
| `ppocrv5_dict.txt` | recognition charset, 18384 entries | normal git |
| `MODEL-LICENSE` | Apache-2.0 license text for the weights | normal git |

The extractor (`core/src/plugins/attachments/ocr/`) loads all three through
`rten::Model::load_file`. If a file is absent — a checkout whose LFS blobs were
not fetched, say — resolution degrades cleanly to "OCR unavailable" and image
attachments record `Unsupported`, so the build never breaks and no cached result
is poisoned.

**No network path exists.** `rten` does not fetch models, the loader only ever
reads this directory, and `src-tauri/scripts/ai-no-network-check.sh` scans for
any regression. Cloud OCR is a standing anti-feature.

## Provenance

- **Source:** [`bukuroo/PPOCRv5-ONNX`](https://huggingface.co/bukuroo/PPOCRv5-ONNX)
  — the PP-OCRv5 **mobile** ONNX exports plus `ppocrv5_dict.txt`.
  **License: Apache-2.0** (see `MODEL-LICENSE`; attribution in the repo-root
  `LICENSING.md`).
- **Conversion:** one-shot, offline, with `rten-convert` (the Python tool that
  ships with `rten`; **build-time only — it is never in the shipped build
  graph**):

  ```
  rten-convert ppocrv5-mobile-det.onnx ppocrv5-mobile-det.rten
  rten-convert ppocrv5-mobile-rec.onnx ppocrv5-mobile-rec.rten
  rten-convert ppocrv5-cls.onnx        ppocrv5-cls.rten
  ```

- **Source ONNX SHA-256:**
  - det `d7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924`
  - rec `bf66820f48fa99f779974c4df78e5274a9d8e0458c4137e8c5357e40e2c3faf2`
  - cls `f4bb53707100c5f3d59ba834eb05bb400369f20aed35d4b26807b1bfadd2a70e`
- **Shipped artefact SHA-256:**
  - `ppocrv5-mobile-det.rten` `3ade1f7474ebbcd72b105618018456f48570ed9b4bcc10952b97222132fdd4fd`
  - `ppocrv5-mobile-rec.rten` `10baed9456f708af2b1377fc58bcb58ded84168a3177c4aeec51a11a6f5ba834`
  - `ppocrv5-cls.rten` `f4e35e6ca3d36e2dec0d5b2646f32b37caaf982fbe445b2c876ddc245bcdeff9`
  - `ppocrv5_dict.txt` `1ea29636956177e400af712d9782e7693f3fb25f98617bed10479d2965a836fd`

## Size and speed (measured, MYND-441 task-1 spike)

| artefact | size |
|---|---|
| `ppocrv5-mobile-rec.rten` | 15.80 MiB |
| `ppocrv5-mobile-det.rten` | 4.57 MiB |
| `ppocrv5-cls.rten` | 0.59 MiB |
| `ppocrv5_dict.txt` | 0.09 MiB |
| **total** | **21.05 MiB** |

Forward-pass cost under `rten` 0.24 on an aarch64 laptop: det 77.6 ms
(`[1,3,544,960]`), cls 2.7 ms (`[1,3,48,192]`), rec 40.9 ms (`[1,3,48,800]`).
A seven-line page ≈ **383 ms**.

## Known limitation — Turkish diacritics

The spike measured this and the design accounts for it, so do not treat a report
of it as a new bug:

- `ppocrv5_dict.txt` **does not contain** `Ğ` (U+011E) or `İ` (U+0130).
- Characters that *are* in the dict — `ş`, `ç`, `ı`, `Ü`, `Ş` — are still emitted
  unreliably, because the model's training distribution is Chinese+English
  dominant. `İSTANBUL BÜYÜKŞEHİR BELEDİYESİ` reads back as
  `iSTANBUL BUYUKSEHiR BELEDiYESi`.
- This is not fixable by swapping the dict or the model: PaddleOCR ships no
  Turkish recognizer, its `latin_PP-OCRv3_rec` is worse (185-entry dict, no
  `ğ`/`Ğ`/`ş`/`Ş`/`İ`), and `ocrs` is English/Latin-only.

It is therefore handled on the **search** side: OCR-derived attachment documents
are indexed under a diacritic-folded token variant so a query spelled correctly
still finds them. The text stored in the `MYE1` cache is whatever OCR produced —
flattened — which constrains any future surface that displays it.

## Replacing these models

The `extractor_version` byte in the `MYE1` cache (`protocol.md` §9.15.1) is what
tells a client its cached extractions are stale. It does **not** encode which
weights produced them, and OCR deliberately leaves the payload's `model_hash`
unset because the model is bundled rather than user-chosen.

**So: changing any file in this directory REQUIRES bumping `extractor_version`.**
Without the bump, every existing vault keeps serving text from the old model and
the improvement is invisible. Update the checksums above in the same change.
