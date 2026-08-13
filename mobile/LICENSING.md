# Licensing

`myne-mobile` application code is licensed under the **GNU Affero General Public
License, version 3** (AGPL-3.0, not "or-later"), matching the main
[`myne`](https://github.com/myne-md/myne) repo. See [`LICENSE`](LICENSE). The
mobile client reuses the main repo's `protocol/` and `core/` crates directly (path
dependencies), which carry their own AGPL-3.0 headers there.

## Bundled third-party assets

Some non-source assets are redistributed inside the mobile app bundle
(`.ipa` / `.apk`). Each is under a license compatible with the application's
AGPL-3.0 and is redistributed with attribution; none is Myne-authored. The asset
files themselves live in the **main repo** (`myne`) under
`src-tauri/resources/models/` (Git LFS) and are pulled into the mobile bundle at
build time via `src-tauri/tauri.conf.json` `bundle.resources`.

| Asset | Where (bundled at) | Upstream | License | AGPL-3.0 compatibility |
|---|---|---|---|---|
| Default speech-to-text model (voice-to-text, MYND-563) | `models/whisper/model.gguf` (from main repo `src-tauri/resources/models/whisper-tiny/`, Git LFS) | [OpenAI Whisper `whisper-tiny`](https://huggingface.co/openai/whisper-tiny) weights, quantized to a candle GGUF | **Apache-2.0** | Compatible (Apache-2.0 → AGPL-3.0 is a one-way-compatible direction per the FSF license list). Redistribution requires only preserving the Apache-2.0 license + attribution — both satisfied here. |
| Text-recognition (OCR) models | `models/ocr/` (from main repo `src-tauri/resources/models/ocr/`, Git LFS) | RapidOCR / PP-OCR models via the `rten` runtime | permissive (per upstream) | Compatible; each model keeps its upstream license. |

**Whisper model provenance + obligations.** The bundled model is a quantized
derivative of the Apache-2.0 `openai/whisper-tiny` weights (the OpenAI Whisper
*code* is MIT; the *weights* are distributed under Apache-2.0 on Hugging Face —
either way permissive and AGPL-3.0-compatible). Quantization (q8_0 via candle
`tensor-tools`) is a format conversion of the same weights and does not change
their license. Obligations under Apache-2.0 §4: (a) ship the Apache-2.0 license
text (kept next to the model as `MODEL-LICENSE` in the main repo), (b) retain
attribution to OpenAI Whisper, and (c) note that the file is a quantized
modification of the upstream weights — all recorded here and in the model's
`README.md`. Mobile bundles **whisper-tiny** (~40 MB) rather than desktop's
**whisper-base** (~80 MB) because App Store / Play Store bundle-size limits make
base too heavy; the per-platform split is deliberate.

See the main repo's [`LICENSING.md`](https://github.com/myne-md/myne/blob/develop/LICENSING.md)
"Bundled third-party assets" section for the desktop bundle's parallel entries.
