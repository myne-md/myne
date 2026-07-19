# Bundled transcription model (desktop) — voice-to-text (MYND-270)

This directory ships the **default on-device speech-to-text model** with the
desktop app, so transcription works out of the box once the user turns on AI
(Settings → Labs → AI). It is **desktop-only** (mobile stays side-load). A user
who picks their own model in the AI settings **overrides** whatever ships here.

The engine (`src-tauri/src/plugins/local_inference/engine_candle.rs`,
`load_transcription`) loads via candle's `WhisperVarBuilder::from_gguf`, so this
directory MUST contain, with these exact names:

| File | What |
|---|---|
| `model.gguf` | quantized Whisper GGUF (**candle format**, not whisper.cpp) — **Git LFS-tracked** |
| `config.json` | the Whisper config (`num_mel_bins`, `max_position_embeddings`, …) |
| `tokenizer.json` | the Whisper tokenizer |

Until these are present the wiring degrades cleanly to **side-load-only** (the
engine returns `NotReady`, the UI shows "select a model"), so the build never
breaks on a fresh checkout whose LFS blob was not fetched.

## Producing `model.gguf` (candle-format q8_0 whisper-base)

candle's `from_gguf` needs a GGUF that candle's own `tensor-tools` produced — a
whisper.cpp `ggml-base.bin` / whisper.cpp GGUF will **not** load (different
tensor naming). The reference tiny models live at `lmz/candle-whisper`; a **base**
GGUF is not published there, so generate one from the Apache-2.0 upstream weights:

```sh
# 1. Fetch the upstream safetensors weights + config + tokenizer (Apache-2.0):
#    huggingface.co/openai/whisper-base  (model.safetensors, config.json, tokenizer.json)
# 2. Quantize to q8_0 (near-lossless — "kaliteyi bozmadan") with candle tensor-tools:
cargo run --release --example tensor-tools -- \
    quantize --quantization q8_0 model.safetensors --out-file model.gguf
# 3. Copy config.json + tokenizer.json next to model.gguf (same directory).
# 4. Verify it actually loads + transcribes before committing (see below).
```

## Verify before committing

Run the env-gated real-model test in `engine_candle.rs` (it is `#[ignore]` so it
never runs in CI):

```sh
MYNE_TEST_TRANSCRIPTION_MODEL=$(pwd)/model.gguf \
MYNE_TEST_TRANSCRIPTION_AUDIO=/path/to/a/16k-mono.wav \
cargo test -p myne-desktop --features local-inference \
    transcription -- --ignored --nocapture
```

## Commit via Git LFS

`*.gguf` is Git LFS-tracked (repo-root `.gitattributes`). `config.json` /
`tokenizer.json` are small and stay as normal git objects. Confirm the model is
an LFS pointer, not a raw blob, before pushing:

```sh
git lfs track     # should list *.gguf
git add model.gguf config.json tokenizer.json
git lfs ls-files  # model.gguf must appear
```

## License

The bundled weights derive from **OpenAI Whisper (`whisper-base`)**, licensed
**Apache-2.0** — compatible with Myne's AGPL-3.0 and redistributable with
attribution. Attribution is recorded in the repo-root
[`LICENSING.md`](../../../../LICENSING.md) ("Bundled third-party assets"). When
you commit the real model, add the upstream Apache-2.0 `LICENSE` text next to it
as `MODEL-LICENSE` and reference the exact source revision.
