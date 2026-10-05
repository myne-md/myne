# Auto-tag model (desktop): tag suggestion (MYND-651)

**This directory no longer ships a model.** Since myne-md/myne#805
(`decisions/ai/0627`) the auto-tag weights are **downloaded on demand** from
`downloads.myne.md` and verified against a SHA-256 compiled into the desktop
binary; they are no longer bundled in the installer. The `tag` role remains
selectable (a downloaded or side-loaded `tag.path`), and a build with neither a
downloaded nor a side-loaded tag model has no auto-tag at all.

What stays here:
- `README.md`: this file, the provenance record for the artefact.
- `MODEL-LICENSE`: the Apache-2.0 licence text for the weights.

`model.gguf` and `tokenizer.json` were removed from the bundle in myne-md/myne#805
task 5; their bytes live at `/models/tag/05df94f8140a/` on the origin and are
fetched only when the user asks. **The SHA-256 below remains the provenance
anchor** the client's compiled-in digest table is checked against.

## Provenance (this model)

- **Source:** [`Qwen/Qwen2.5-0.5B-Instruct-GGUF`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF),
  file `qwen2.5-0.5b-instruct-q4_k_m.gguf`, revision
  `9217f5db79a29953eb74d5343926648285ec7e67` — the **first-party GGUF Qwen
  publishes** for `Qwen2.5-0.5B-Instruct`. `tokenizer.json` is the matching
  tokenizer from [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct),
  revision `7ae557604adf67be50417f59c2c2f167def9a775`. **License: Apache-2.0**
  (see `MODEL-LICENSE`; attribution in the repo-root `LICENSING.md`).
- **Quantization:** as published by Qwen — **not re-quantized by Myne.** Every
  tensor that ships carries Qwen's own bytes. The shipped file is nonetheless a
  **Myne-produced derivative** of that GGUF, because one tensor was removed
  (below), so Apache-2.0 §4 attaches to Myne's modification (`LICENSING.md`).
- **Myne's modification:** the duplicated `output.weight` tensor was **dropped**
  (ai-bundle-slim myne#190, ledger SYNC-21 option A). Qwen2.5-0.5B-Instruct is a
  tied-embedding model and the GGUF materializes the tied LM head twice —
  `output.weight` (Q8_0, 137.94 MiB) is `token_embd.weight` (Q5_0, 89.26 MiB) at
  higher precision. `candle_transformers` 0.8.4 already handles the absence:
  `quantized_qwen2.rs:211-217` falls back to `token_embd.weight` with the comment
  `// use tie_word_embeddings`. **468.64 MiB → 330.69 MiB, −137.94 MiB.**
- **`model.gguf` SHA-256:**
  `05df94f8140a0cb43910c1f7b4c680c6dd1539ef6790b33dd9c6a10dc714cd93`
  (346,756,928 bytes, 290 tensors). The pre-modification first-party file was
  `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`
  (491,400,032 bytes, 291 tensors).
- **`general.file_type` still reads `15` (`MOSTLY_Q4_K_M`)**, and it was already a
  misnomer before this change — see the dtype census below. Nothing was
  re-quantized, so the field is left exactly as Qwen wrote it rather than made
  differently wrong.
- **Verified end-to-end** with the env-gated `#[ignore]` real-model test
  (`infer_tags_with_a_real_model_returns_tag_text`), against **both** files, three
  runs each, deterministic in both:

  | | tag output for the sample note |
  |---|---|
  | before | `baking, sourdough, starter, hydration, loaf, fermentation, overnight, retard` |
  | after | `baking, sourdough, starter, hydration, loaf, yeast, overnight, retard` |

  Eight tags either way; one substitution, both on-topic. That single difference
  is the LM head reading `token_embd` at Q5_0 instead of the dedicated Q8_0
  copy — the whole of what option A trades away.

## Why this file cannot get much smaller by re-quantizing

Measured, so it is never re-derived. The dtype census of the **shipped** file:

| dtype | tensors | bytes |
|---|---:|---:|
| Q5_0 | 133 | 254.39 MiB |
| Q8_0 | 12 | 1.40 MiB |
| Q6_K | 12 | 40.91 MiB |
| Q4_K | 12 | 28.05 MiB |
| F32 | 121 | 0.27 MiB |

- **Hidden size is 896, not a multiple of the K-quant block size 256.** llama.cpp's
  `convert_incompatible_tensor` path therefore promotes every 896-column tensor
  **Q4_K → Q5_0** and **Q6_K → Q8_0**. Only the 24 `ffn_down` tensors (4864
  columns) can carry a K-quant at all, which is exactly the 12 + 12 above.
  Re-running `llama-quantize … Q4_K_M` reproduces the same file.
- **candle 0.8.4 implements no IQ type.** Its `GgmlDType` is F32, F16, Q4_0, Q4_1,
  Q5_0, Q5_1, Q8_0, Q8_1, Q2K, Q3K, Q4K, Q5K, Q6K, Q8K. An IQ-quantized GGUF is
  unloadable here, and every IQ type small enough to help is 256-blocked and so
  illegal on the 896-column tensors anyway. **The floor is Q4_0 at 4.5
  bits/weight.**
- Which is why the lever taken was redundancy, not precision.

## Producing / updating the model

**The recipe below is what produced the artefact now hosted at
`/models/tag/05df94f8140a/`; it no longer produces a bundled file.**

**Use a GGUF in the llama.cpp layout.** `candle_transformers`'
`quantized_qwen2::ModelWeights::from_gguf` reads the architecture from GGUF
**metadata** (`qwen2.block_count`, `qwen2.attention.head_count`, …) and expects
llama.cpp tensor names (`token_embd.weight`, `blk.{i}.attn_q.weight`, …). The
candle `tensor-tools` `quantize` example does **not** produce a loadable model
here — it keeps the safetensors tensor names (`model.layers.{i}.…`) and writes
**no** metadata, so `from_gguf` bails on the first missing key. (An earlier note
in this file suggested `tensor-tools`; that recipe does not load and has been
corrected.)

The source is the **first-party GGUF Qwen publishes**, with one tensor removed:

```sh
# 1. Fetch the official quantized GGUF (llama.cpp layout + full metadata).
hf download Qwen/Qwen2.5-0.5B-Instruct-GGUF qwen2.5-0.5b-instruct-q4_k_m.gguf --local-dir .
# 2. Fetch the matching tokenizer, kept next to model.gguf.
hf download Qwen/Qwen2.5-0.5B-Instruct tokenizer.json --local-dir .
# 3. Drop the duplicated tied LM head. This is a byte-preserving edit: the KV
#    block is copied verbatim and the remaining tensor data is copied as one
#    contiguous range, so NOTHING is re-quantized. See Provenance above.
python3 ../../../../scripts/strip-gguf-tensor.py \
    qwen2.5-0.5b-instruct-q4_k_m.gguf model.gguf
# 4. Record the SHA-256 under Provenance, then commit via Git LFS.
shasum -a 256 model.gguf
```

**Do not "just re-run `llama-quantize`" to make it smaller** — it reproduces the
same file, for the block-size reason in the section above. And do not requantize
the existing GGUF: requantizing an already-quantized source compounds error, and
the whole point of the strip is that it introduces none.

If you ever do need a genuinely different quantization, convert from the
**f16/bf16 HF checkpoint** (`convert_hf_to_gguf.py`, then `llama-quantize` with
explicit `--output-tensor-type` / `--token-embedding-type`), not from this file,
and re-read the constraints above first — the reachable band is narrow.

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
