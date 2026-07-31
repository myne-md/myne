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
| `myne-server`, `myne-mobile`, `myne-clipper` | AGPL-3.0 |
| `myne-web` | AGPL-3.0 — **archived**; the web client is the in-repo `web/` subtree above (`design-notes.md` 2026-07-26) |
| `myne-test-vectors` | CC-BY-4.0 |
| `myne-website` | MIT |
| `myne-themes` | by subtree — CC-BY-4.0 (themes) / AGPL-3.0 (tooling) |
| `myne-branding` | by subtree — reserved marks (trademark) / CC-BY-4.0 (token exports) / SIL OFL (fonts) |
| `agent-tooling`, `operations` | Proprietary — All Rights Reserved (internal) |

## Bundled third-party assets

Some non-source assets are redistributed inside the desktop bundle. Each is
under a license compatible with the application's AGPL-3.0 and is redistributed
with attribution; none is Myne-authored.

| Asset | Where | Upstream | License | AGPL-3.0 compatibility |
|---|---|---|---|---|
| Default speech-to-text model (voice-to-text, MYND-270) | `src-tauri/resources/models/whisper/model.gguf` (Git LFS; desktop-only) | [OpenAI Whisper `whisper-base`](https://huggingface.co/openai/whisper-base) weights, quantized to a candle GGUF | **Apache-2.0** | Compatible (Apache-2.0 → AGPL-3.0 is a one-way-compatible direction per the FSF license list). Redistribution requires only preserving the Apache-2.0 license + attribution — both satisfied here. |
| Tag-suggestion model (auto-tag, MYND-651) | `src-tauri/resources/models/tag/model.gguf` (Git LFS; desktop-only) | [Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) weights, quantized to a candle GGUF | **Apache-2.0** | Compatible, on the same one-way Apache-2.0 → AGPL-3.0 direction as the Whisper model above. Redistribution requires preserving the Apache-2.0 license + attribution — both satisfied here. |
| Hunspell spell-check dictionaries | `src-tauri/resources/dictionaries/**` | per-language upstreams | mixed (LGPL / MPL / BSD / GPL-with-linking-exception, per dictionary) | Compatible; each dictionary keeps its upstream license. |

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

**Tag-model provenance + obligations.** The auto-tag weights are a quantized
derivative of `Qwen/Qwen2.5-0.5B-Instruct`, distributed under **Apache-2.0** by
Alibaba Cloud. The same §4 obligations apply and are discharged the same way: the
Apache-2.0 text ships beside the model as `MODEL-LICENSE`, attribution to the
Qwen2.5 upstream is retained, and the modification (quantization to a candle GGUF
— a format conversion of the same weights, which does not change their license)
is noted here and in `src-tauri/resources/models/tag/README.md`. Unlike
transcription, this model has **no user-override picker**, so no third-party file
can take its place and there is no user-supplied-license case to disclaim.
Reproducible-build note: like the Whisper weights it is a **Git LFS**-tracked data
asset, not a dependency — no crate enters the tree — so the TB9 dependency surface
is unchanged, while the bundle (and therefore the hash a rebuilder reproduces)
grows by the model for every desktop download, including users who never enable
AI. The `--no-default-features` AI-free build ships no model at all.
(`design-notes.md` 2026-07-31.)
