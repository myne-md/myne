# Bundled auto-tag model (desktop) — tag suggestion (MYND-651)

This directory ships the **dedicated on-device tag-suggestion model** with the
desktop app, so the inline tag-suggestion band works out of the box once the
user turns on AI (Settings → Developer → AI) *and* the dedicated auto-tag
toggle. It is **desktop-only** (no Candle on web; mobile is deferred to
MYND-653).

Unlike the transcription model next door, this one has **no user-override
picker** — there is no "choose a tag model" setting, no `tag.path` marker, and
no IPC role string that names it (`model_store::ModelRole::TagSuggestion` is
bundled-only by construction). That is deliberate: `threat-model.md` §7 records
that auto-tag therefore never re-enters the untrusted-model case, and a picker
would walk that back. Adding one is a threat-model change first and a code
change second.

## What ships here

| File | What | Tracking |
|---|---|---|
| `model.gguf` | quantized Qwen2.5-0.5B-Instruct GGUF (candle format) — the tag model | **Git LFS** (`.gitattributes` `*.gguf`) |
| `tokenizer.json` | the Qwen2.5 tokenizer | normal git |
| `MODEL-LICENSE` | the Apache-2.0 license text for the weights | normal git |

The engine (`src-tauri/src/plugins/local_inference/engine_candle.rs`, `load_tag`)
loads `model.gguf` through the **same** `Qwen2::from_gguf` path as the
side-loaded generation model — same architecture family, so the second model
costs no new runtime and no new dependency. If `model.gguf` is absent (an
`--no-default-features` AI-free build, or a checkout whose LFS blob was not
fetched) `infer_tags` returns `NotReady` and the feature is simply unavailable;
there is no fallback to the generation model, and nothing panics.

## Provenance (this model)

- **Source:** [`Qwen/Qwen2.5-0.5B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct)
  weights + `tokenizer.json`. **License: Apache-2.0** (see `MODEL-LICENSE`;
  attribution in the repo-root `LICENSING.md`).
- **Quantization:** to be recorded here with the checkpoint revision and the
  `model.gguf` **SHA-256** when the blob lands — the bundle hash a rebuilder
  reproduces depends on these exact bytes (`threat-model.md` §6), so an
  unpinned model file is a reproducible-build hole, not a detail.

> **The weights blob is not in the tree yet.** Everything around it is wired —
> the resource mapping in `tauri.conf.json`, the LFS rule, the loader, the
> license — so dropping a `model.gguf` + `tokenizer.json` in this directory is
> all that is left. Follow the recipe below, then replace the bullet above with
> the real revision, quantization and SHA-256.

## Producing / updating the model

candle's `from_gguf` needs a GGUF that candle's own `tensor-tools` produced — a
llama.cpp-produced Qwen GGUF may use different tensor naming and fail to load.

```sh
# 1. Fetch Qwen/Qwen2.5-0.5B-Instruct weights + tokenizer.json (Apache-2.0).
# 2. Quantize to a candle GGUF. q4_k_m keeps the bundle small; q8_0 is
#    near-lossless but roughly doubles it — pick against the bundle-size budget
#    and record which one you used above.
cargo run --release --example tensor-tools -- \
    quantize model.safetensors --out-file model.gguf --quantization q4_k_m
# 3. Keep tokenizer.json next to model.gguf.
# 4. Verify (below), record the SHA-256, then commit via Git LFS.
sha256sum model.gguf
```

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
