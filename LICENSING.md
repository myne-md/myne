# Licensing

This repository is **multi-licensed by subtree**. The repo-root [`LICENSE`](LICENSE)
file carries the default (AGPL-3.0); subtrees with a different license carry their
own `LICENSE` file, which governs that subtree.

| Subtree | License | License file |
|---|---|---|
| `src/`, `src-tauri/` (desktop client) | **AGPL-3.0** | [`LICENSE`](LICENSE) |
| `web/` (Phase 3 browser client — bundle, seam implementation, self-host container) | **AGPL-3.0** | [`LICENSE`](LICENSE) |
| `core/` (myne-core shared backend crate) | **AGPL-3.0** | [`LICENSE`](LICENSE) |
| `protocol/` (cryptographic crate) | **AGPL-3.0** | [`protocol/LICENSE`](protocol/LICENSE) |
| `docs/` (specifications, threat model) | **CC-BY-4.0** | [`docs/LICENSE`](docs/LICENSE) |

Application code is licensed under the **GNU Affero General Public License,
version 3** (AGPL-3.0, not "or-later"). Every source file under `protocol/`
carries the SPDX header `// SPDX-License-Identifier: AGPL-3.0`, and the crate
manifests declare `license = "AGPL-3.0"`.

The specification subtree (`docs/`) is licensed under the **Creative Commons
Attribution 4.0 International** license (CC-BY-4.0) so that independent
implementations may reuse the protocol and on-disk format, provided Myne is
credited.

`web/` is AGPL-3.0 for a reason worth stating: the web client is served rather
than installed, and the [threat model](docs/threat-model.md)'s only mitigation
for that (A15 / TB11) is that a user can build and serve their **own** bundle
and stop being downstream of anyone else's. That is a licence promise as much as
a technical one — self-hostable "in practice and not just in principle" requires
the source of the thing being served to be available under a licence that
survives being deployed as a network service, which is exactly what the AGPL's
network clause is for.

## Companion repositories

The companion repos under [`myne-md`](https://github.com/myne-md) are separately
licensed (each carries its own `LICENSE`):

| Repo | License |
|---|---|
| `myne-server`, `myne-clipper` | AGPL-3.0 |
| `myne-web` | AGPL-3.0 — **archived**; the web client is the in-repo `web/` subtree above (`design-notes.md` 2026-07-26) |
| `myne-test-vectors` | CC-BY-4.0 |
| `myne-website` | MIT |
| `myne-themes` | by subtree — CC-BY-4.0 (themes) / AGPL-3.0 (tooling) |
| `myne-branding` | by subtree — reserved marks (trademark) / CC-BY-4.0 (token exports) / SIL OFL (fonts) |
| `agent-tooling`, `operations` | Proprietary — All Rights Reserved (internal) |

## Bundled third-party assets

Some non-source assets are redistributed inside the desktop bundle, and a
different subset inside the mobile `.ipa` / `.apk`. Each is under a license
compatible with the application's AGPL-3.0 and is redistributed with attribution;
none is Myne-authored. The mobile rows were merged in here on 2026-08-13 when the
mobile client moved in-repo — they had been in a `myne-mobile/LICENSING.md` of
their own, and they are **not** duplicates of the desktop rows: the two bundles
ship different Whisper weights.

| Asset | Where | Upstream | License | AGPL-3.0 compatibility |
|---|---|---|---|---|
| Default speech-to-text model (voice-to-text, MYND-270) | `src-tauri/resources/models/whisper/model.gguf` (Git LFS; desktop-only) | [OpenAI Whisper `whisper-base`](https://huggingface.co/openai/whisper-base) weights, quantized to a candle GGUF | **Apache-2.0** | Compatible (Apache-2.0 → AGPL-3.0 is a one-way-compatible direction per the FSF license list). Redistribution requires only preserving the Apache-2.0 license + attribution — both satisfied here. |
| Tag-suggestion model (auto-tag, MYND-651) | `src-tauri/resources/models/tag/model.gguf` (Git LFS; desktop-only) | [Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) weights — **a Myne-produced derivative** of the first-party `Q4_K_M` GGUF Qwen publishes (one duplicated tensor removed; no re-quantization) | **Apache-2.0** | Compatible, on the same one-way Apache-2.0 → AGPL-3.0 direction as the Whisper model above. Redistribution requires preserving the Apache-2.0 license + attribution, **and stating the modification** — all three satisfied here. |
| Hunspell spell-check dictionaries | `src-tauri/resources/dictionaries/**` | per-language upstreams | mixed (LGPL / MPL / BSD / GPL-with-linking-exception, per dictionary) | Compatible; each dictionary keeps its upstream license. |
| Default speech-to-text model — **mobile bundle** (voice-to-text, MYND-563) | `models/whisper/model.gguf` in the `.ipa`/`.apk`, from `src-tauri/resources/models/whisper-tiny/` (Git LFS), pulled in by `mobile/src-tauri/tauri.conf.json` `bundle.resources` | [OpenAI Whisper `whisper-tiny`](https://huggingface.co/openai/whisper-tiny) weights, quantized to a candle GGUF | **Apache-2.0** | Compatible, same one-way direction as the desktop row above. |
| Text-recognition (OCR) models — **mobile bundle** | `models/ocr/` in the `.ipa`/`.apk`, from `src-tauri/resources/models/ocr/` (Git LFS) | RapidOCR / PP-OCR models via the `rten` runtime | permissive (per upstream) | Compatible; each model keeps its upstream license. |
| `myne-tor` sidecar binary (desktop Tor routing, MYND-650) | `src-tauri/binaries/myne-tor-<triple>` in the bundle; built from the in-repo `tor-sidecar/` crate | [arti](https://gitlab.torproject.org/tpo/core/arti) (The Tor Project's Rust Tor implementation) + its dependency tree | **MIT OR Apache-2.0** | Compatible (both are one-way-compatible into AGPL-3.0). Unlike every other dependency, this one is redistributed as a **separate executable** rather than linked in, so it is listed here as a bundled artefact too. |

**Whisper model provenance + obligations.** The bundled model is a quantized
derivative of the Apache-2.0 `openai/whisper-base` weights (the OpenAI Whisper
*code* is MIT; the *weights* are distributed under Apache-2.0 on Hugging Face —
either way permissive and AGPL-3.0-compatible). Quantization is a format
conversion of the same weights and does not change their license. Obligations
under Apache-2.0 §4: (a) ship the Apache-2.0 license text (kept next to the model
as `MODEL-LICENSE`), (b) retain attribution to OpenAI Whisper, and (c) note that
the file is a quantized modification of the upstream weights — all recorded here
and in `src-tauri/resources/models/whisper/README.md`. A user who overrides the
model with their own file is responsible for that file's license.

**The mobile bundle ships a different Whisper model, and that is deliberate.**
Mobile bundles **whisper-tiny** (~40 MB) where desktop bundles **whisper-base**
(~80 MB), because App Store / Play Store bundle-size limits make base too heavy.
The Apache-2.0 §4 obligations are identical and identically satisfied: the license
text ships next to the model as `MODEL-LICENSE`, attribution to OpenAI Whisper is
retained, and the quantization (q8_0 via candle `tensor-tools`) is stated as a
format conversion of the upstream weights — recorded here and in
`src-tauri/resources/models/whisper-tiny/README.md`. The OCR `.rten` weights were
bundled on mobile with no licensing file at all until MYND-563 documented them;
the row above is that record.

**Tag-model provenance + obligations.** The auto-tag weights are a quantized
derivative of `Qwen/Qwen2.5-0.5B-Instruct`, distributed under **Apache-2.0** by
Alibaba Cloud. Myne ships a **derivative of Qwen's own derivative**: the source is
the first-party `Q4_K_M` GGUF (`Qwen/Qwen2.5-0.5B-Instruct-GGUF`), and Myne
removed one tensor from it — the duplicated tied LM head `output.weight`, which
`candle` already handles the absence of (ai-bundle-slim myne#190). **Nothing was
re-quantized**: every tensor that ships carries Qwen's own bytes, verified by
byte-comparing the tensor-data region before and after. Both files' revisions and
SHA-256s are recorded in `src-tauri/resources/models/tag/README.md`, along with a
committed script (`scripts/strip-gguf-tensor.py`) that reproduces the shipped
blob byte-for-byte from the upstream one.

Because the modification is Myne's, **Apache-2.0 §4 attaches to it**, and is
discharged the same way as before: the Apache-2.0 text ships beside the model as
`MODEL-LICENSE`, attribution to the Qwen2.5 upstream is retained, and the
modification is stated — here, in the model's `README.md`, and in
`design-notes.md`. (The previous wording described redistributing Qwen's
unmodified first-party file, which stopped being true when the tensor was
dropped.) Unlike transcription, this model has
**no user-override picker**, so no third-party file can take its place and there
is no user-supplied-license case to disclaim. Reproducible-build note: like the
Whisper weights it is a **Git LFS**-tracked data asset, not a dependency — no
crate enters the tree — so the TB9 dependency surface is unchanged either way,
while the bundle (and therefore the hash a rebuilder reproduces) grows by the
model for every desktop download, including users who never enable AI. The
`--no-default-features` AI-free build **excludes the generative model, the embedding
model, ASR and every candle/tokenizers symbol** — but it does **not** ship "no model
at all", and the earlier wording here was simply false. Two reasons: OCR ships in
every build by design (`decisions.md` 2026-07-31, MYND-441 — it is search
correctness, not an AI feature), and `bundle.resources` in `tauri.conf.json` is
static JSON with no feature gating at all, so that build's **bundle** still carries
the tag and whisper weights even though nothing in its binary can load them. This is
pre-existing drift, not something the 2026-08-09 provider work introduced; the
resource-gating mechanism that would make the original sentence true is owed by
myne-md/myne#190.
(`design-notes.md` 2026-07-31.)
