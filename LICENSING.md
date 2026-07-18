# Licensing

This repository is **multi-licensed by subtree**. The repo-root [`LICENSE`](LICENSE)
file carries the default (AGPL-3.0); subtrees with a different license carry their
own `LICENSE` file, which governs that subtree.

| Subtree | License | License file |
|---|---|---|
| `src/`, `src-tauri/` (desktop client) | **AGPL-3.0** | [`LICENSE`](LICENSE) |
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

## Companion repositories

The companion repos under [`myne-md`](https://github.com/myne-md) are separately
licensed (each carries its own `LICENSE`):

| Repo | License |
|---|---|
| `myne-server`, `myne-web`, `myne-mobile`, `myne-clipper` | AGPL-3.0 |
| `myne-test-vectors` | CC-BY-4.0 |
| `myne-website` | MIT |
| `myne-themes` | by subtree — CC-BY-4.0 (themes) / AGPL-3.0 (tooling) |
| `myne-branding` | by subtree — reserved marks (trademark) / CC-BY-4.0 (token exports) / SIL OFL (fonts) |
| `agent-tooling`, `operations` | Proprietary — All Rights Reserved (internal) |
