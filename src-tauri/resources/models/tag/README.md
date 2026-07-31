# Bundled auto-tag model (desktop) — tag suggestion (MYND-651)

This directory is where the **dedicated on-device tag-suggestion model** ships
with the desktop app, so the inline tag-suggestion band works out of the box
once the user turns on AI (Settings → Developer → AI) *and* the dedicated
auto-tag toggle. It is **desktop-only** (no Candle on web; mobile is deferred to
MYND-653).

Unlike the transcription model next door, this one has **no user-override
picker** — there is no "choose a tag model" setting, no `tag.path` marker, and
no IPC role string that names it (`model_store::ModelRole::TagSuggestion` is
bundled-only by construction). That is deliberate: `threat-model.md` §7 records
that auto-tag therefore never re-enters the untrusted-model case, and a picker
would walk that back. Adding one is a threat-model change first and a code
change second.

## What ships here

| File | What | Tracking | In the tree? |
|---|---|---|---|
| `model.gguf` | quantized Qwen2.5-0.5B-Instruct GGUF (llama.cpp layout) — the tag model | **Git LFS** (`.gitattributes` `*.gguf`) | ✅ yes |
| `tokenizer.json` | the Qwen2.5 tokenizer | normal git | ✅ yes |
| `MODEL-LICENSE` | the Apache-2.0 license text for the weights | normal git | ✅ yes |

The engine (`src-tauri/src/plugins/local_inference/engine_candle.rs`, `load_tag`)
loads `model.gguf` through the **same** `Qwen2::from_gguf` path
(`candle_transformers::models::quantized_qwen2`) as the side-loaded generation
model — same architecture family, so the second model costs no new runtime and
no new dependency. If `model.gguf` is absent (an `--no-default-features` AI-free
build, or a checkout whose LFS blob was not fetched) `infer_tags` returns
`NotReady` and the feature is simply unavailable; there is no fallback to the
generation model, and nothing panics.

## Provenance (this model)

- **Source:** [`Qwen/Qwen2.5-0.5B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF),
  file `qwen2.5-0.5b-instruct-q4_k_m.gguf`, revision
  `9217f5db79a29953eb74d5343926648285ec7e67` — the **first-party GGUF Qwen
  publishes** for `Qwen2.5-0.5B-Instruct`. `tokenizer.json` is the matching
  tokenizer from [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct),
  revision `7ae557604adf67be50417f59c2c2f167def9a775`. **License: Apache-2.0**
  (see `MODEL-LICENSE`; attribution in the repo-root `LICENSING.md`).
- **Quantization:** `Q4_K_M` (llama.cpp k-quant), as published by Qwen — not
  re-quantized locally.
- **`model.gguf` SHA-256:**
  `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`
- **Verified end-to-end** with the env-gated `#[ignore]` real-model test
  (`infer_tags_with_a_real_model_returns_tag_text`) — it produced a short,
  multi-item tag list from a sample note.

## Producing / updating the model

**Use a GGUF in the llama.cpp layout.** `candle_transformers`'
`quantized_qwen2::ModelWeights::from_gguf` reads the architecture from GGUF
**metadata** (`qwen2.block_count`, `qwen2.attention.head_count`, …) and expects
llama.cpp tensor names (`token_embd.weight`, `blk.{i}.attn_q.weight`, …). The
candle `tensor-tools` `quantize` example does **not** produce a loadable model
here — it keeps the safetensors tensor names (`model.layers.{i}.…`) and writes
**no** metadata, so `from_gguf` bails on the first missing key. (An earlier note
in this file suggested `tensor-tools`; that recipe does not load and has been
corrected.)

The simplest correct source is the **first-party GGUF Qwen already publishes**:

```sh
# 1. Fetch the official quantized GGUF (llama.cpp layout + full metadata).
hf download Qwen/Qwen2.5-0.5B-Instruct-GGUF qwen2.5-0.5b-instruct-q4_k_m.gguf --local-dir .
mv qwen2.5-0.5b-instruct-q4_k_m.gguf model.gguf
# 2. Fetch the matching tokenizer, kept next to model.gguf.
hf download Qwen/Qwen2.5-0.5B-Instruct tokenizer.json --local-dir .
# 3. Record the SHA-256 + revision under Provenance above, then commit via Git LFS.
shasum -a 256 model.gguf
```

To roll your own instead, convert with **llama.cpp** (`convert_hf_to_gguf.py`,
then `llama-quantize … Q4_K_M`) — its output is the same llama.cpp layout candle
loads. Pick the quantization against the bundle-size budget (`Q4_K_M` ≈ 470 MB;
`Q8_0` is near-lossless and larger) and record which one you used above.

Verify with the env-gated `#[ignore]` test (never runs in CI):

```sh
MYNE_TEST_TAG_MODEL=$(pwd)/model.gguf \
cargo test -p myne-desktop --lib \
    infer_tags_with_a_real_model_returns_tag_text -- --ignored --nocapture
```

It feeds a sample note through the real prompt framing and asserts the reply is
a short, multi-item list — i.e. that the checkpoint actually answers in the
shape `parseTagCandidates` expects, which is the thing a smaller checkpoint is
most likely to get wrong.

Commit via Git LFS (`git lfs ls-files` must list `model.gguf` as a pointer, not
a raw blob).
