# Bundled transcription model (desktop) — voice-to-text (MYND-270)

This directory ships the **default on-device speech-to-text model** with the
desktop app, so transcription works out of the box once the user turns on AI
(Settings → Labs → AI). It is **desktop-only** (mobile stays side-load). A user
who picks their own model in the AI settings **overrides** whatever ships here.

## What ships here

| File | What | Tracking |
|---|---|---|
| `model.gguf` | quantized Whisper GGUF (candle format) — the default STT model | **Git LFS** (`.gitattributes` `*.gguf`) |
| `config.json` | the Whisper config (`num_mel_bins`, `d_model`, …) | normal git |
| `tokenizer.json` | the Whisper tokenizer | normal git |
| `MODEL-LICENSE` | the Apache-2.0 license text for the weights | normal git |

The engine (`src-tauri/src/plugins/local_inference/engine_candle.rs`,
`load_transcription`) loads `model.gguf` via candle's `WhisperVarBuilder::from_gguf`
and reads the two siblings. If any file is absent (e.g. an `--no-default-features`
AI-free build, or a checkout whose LFS blob was not fetched) resolution degrades
cleanly to **side-load-only** (`NotReady`), so the build never breaks.

## Provenance (this model)

- **Source:** [`openai/whisper-base`](https://huggingface.co/openai/whisper-base)
  `model.safetensors` + `config.json` + `tokenizer.json`, revision
  `e37978b90ca9030d5170a5c07aadb050351a65bb`. **License: Apache-2.0** (see
  `MODEL-LICENSE`; attribution in the repo-root `LICENSING.md`).
- **Quantization:** q8_0 (near-lossless), via candle `0.8.4` `tensor-tools`:
  `tensor-tools quantize model.safetensors --out-file model.gguf --quantization q8_0`.
- **`model.gguf` SHA-256:** `dd96b06f89f0ffe4a146a80835a846004688a5bc709768a47a0a13301f52b4a9`
- **Verified end-to-end** with the `#[ignore]` real-model test
  (`transcribe_with_a_real_model_streams_a_transcript`): a 16 kHz-mono WAV of
  *"The quick brown fox jumps over the lazy dog. Myne keeps your notes encrypted
  on your own device."* transcribed near-verbatim.

## Regenerating / updating the model

candle's `from_gguf` needs a GGUF that candle's own `tensor-tools` produced — a
whisper.cpp `ggml-base.bin` / whisper.cpp GGUF will **not** load (different tensor
naming). To refresh or swap the bundled model:

```sh
# 1. Fetch openai/whisper-base weights + config + tokenizer (Apache-2.0).
# 2. Quantize to a candle GGUF (q8_0 = near-lossless):
cargo run --release --example ... tensor-tools -- \
    quantize model.safetensors --out-file model.gguf --quantization q8_0
# 3. Keep config.json + tokenizer.json next to model.gguf.
# 4. Verify before committing (see below), then update the SHA-256 above.
```

Verify with the env-gated `#[ignore]` test (never runs in CI):

```sh
MYNE_TEST_TRANSCRIPTION_MODEL=$(pwd)/model.gguf \
MYNE_TEST_TRANSCRIPTION_AUDIO=/path/to/a/16k-mono.wav \
MYNE_TEST_TRANSCRIPTION_EXPECT=fox \
cargo test -p myne-desktop --features local-inference \
    transcribe_with_a_real_model_streams_a_transcript -- --ignored --nocapture
```

Commit via Git LFS (`git lfs ls-files` must list `model.gguf` as a pointer, not
a raw blob).
