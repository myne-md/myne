# Bundled transcription model (mobile) — voice-to-text (MYND-563)

This directory ships the **default on-device speech-to-text model** with the
**mobile** app (myne-mobile), so transcription works out of the box once the user
turns it on (Settings → Transcription; on by default). Mobile bundles a smaller
**whisper-tiny** than desktop's `whisper-base` (`../whisper/`) because App Store /
Play Store bundle-size limits make base's ~80 MB too heavy — whisper-tiny q8_0 is
~40 MB. A user who picks their own model **overrides** whatever ships here.

Bundled into the mobile app via `myne-mobile/src-tauri/tauri.conf.json`
(`"../../src-tauri/resources/models/whisper-tiny": "models/whisper"`), so at
runtime it resolves to `<resource_dir>/models/whisper/model.gguf` — the same path
`model_store::bundled_transcription_model` reads on both clients.

## What ships here

| File | What | Tracking |
|---|---|---|
| `model.gguf` | quantized whisper-tiny GGUF (candle format) — the default STT model | **Git LFS** (`.gitattributes` `*.gguf`) |
| `config.json` | the Whisper config (`num_mel_bins=80`, `d_model=384`, 4+4 layers) | normal git |
| `tokenizer.json` | the Whisper tokenizer | normal git |
| `MODEL-LICENSE` | the Apache-2.0 license text for the weights | normal git |

The engine (`myne-mobile/src-tauri/src/plugins/local_inference/engine_candle.rs`,
`load_transcription`) loads `model.gguf` via candle's `WhisperVarBuilder::from_gguf`
and reads the two siblings. If any file is absent (e.g. a `--no-default-features`
build, or a checkout whose LFS blob was not fetched) resolution degrades cleanly
to side-load-only (`Engine::NotReady`), so the build never breaks.

## Provenance (this model)

- **Source:** [`openai/whisper-tiny`](https://huggingface.co/openai/whisper-tiny)
  `model.safetensors` + `config.json` + `tokenizer.json`. **License: Apache-2.0**
  (see `MODEL-LICENSE`; attribution in the repo-root `LICENSING.md` and
  `myne-mobile/LICENSING.md`).
- **Quantization:** q8_0 (near-lossless), via candle `0.8.4` `tensor-tools`:
  `tensor-tools quantize model.safetensors --out-file model.gguf --quantization q8_0`.
  (llama.cpp policy — 2D weights quantized, norms/biases/conv kept f32.)
- **`model.gguf` SHA-256:** `16a9293d98a8a15b36a5d7f71285bff05eba62142e8094ca5d44c31161bcd57f`
- **Verified end-to-end** on host (same Apple-Silicon ISA + fp16 as the phone):
  `from_gguf` + `Whisper::load` load it and the encoder runs a 30 s window. The
  full on-device transcription is verified with the env-gated `#[ignore]` real-model
  test (`MYNE_TEST_TRANSCRIPTION_MODEL` / `_AUDIO` / `_EXPECT`).

## Regenerating / updating the model

candle's `from_gguf` needs a GGUF that candle's own `tensor-tools` produced — a
whisper.cpp `ggml-*.bin` / whisper.cpp GGUF will **not** load (different tensor
naming). To refresh or swap:

```sh
# 1. Fetch openai/whisper-tiny weights + config + tokenizer (Apache-2.0).
# 2. Quantize to a candle GGUF (q8_0 = near-lossless):
tensor-tools quantize model.safetensors --out-file model.gguf --quantization q8_0
# 3. Keep config.json + tokenizer.json next to model.gguf.
# 4. Verify before committing (env-gated #[ignore] test), then update the SHA-256.
```

Commit via Git LFS (`git lfs ls-files` must list `model.gguf` as a pointer). iOS
builds need `-C target-feature=+fp16` (see `myne-mobile/src-tauri/.cargo/config.toml`).
