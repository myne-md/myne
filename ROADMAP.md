# Roadmap

This is a direction, not a schedule. There are no dates, no promised versions
and no guarantee that an item ships. The order states priority, not sequence.

## Where the project is

Pre-alpha. The on-disk format is pre-1.0, v0.1 and the next major are
forward-incompatible by design, and no prebuilt binaries are distributed. The
threat model is normative: a feature that cannot be described there does not
ship, and marketing copy may not exceed its guarantees.

## Now

- **Protocol and format.** Close the remaining v0.1 hardening work, keep
  `myne-test-vectors` in lockstep with every protocol change, and prepare the
  on-disk format for a stable 1.0. An external cryptographic review is planned
  before 1.0; until it happens, the threat model's compensating-controls
  regime is the honest description of the assurance available.
- **Clients.** Close the gaps listed in [`mobile/README.md`](mobile/README.md),
  keep the desktop, web and mobile clients on the same `src/` tree and the same
  protocol crate, and hold WCAG 2.2 AA across all three.
- **Verification.** Keep the web bundle reproducible and the hash record in
  [`docs/web-bundle-hashes.md`](docs/web-bundle-hashes.md) append-only. Keep the
  update path refusing on signature or hash failure and never installing an
  older version.
- **Self-hosting.** Document a sync server a stranger can run from the
  `myne-server` companion repository. Myne operates no sync service and offers
  no hosted account.
- **Project hygiene.** Keep governance, support and contribution documents
  current, and keep CI running on pull requests from forks.

## Next

- Desktop shell maintenance, including the move to Tauri 3 and archive
  extraction on Windows. The updater stays until a replacement meets the same
  signature and anti-downgrade properties; it is not removed to simplify the
  migration.
- Multi-user sharing and live co-editing over the same synced vault are being
  designed. They change the threat model, and they ship only with it.
- Reproducible desktop builds, so a third party can rebuild a released artifact
  and compare hashes.

## Not planned

- A hosted sync service, a paid tier or telemetry.
- A proprietary on-disk format or a plugin API for v1.
- Databases, kanban boards, calendars or whiteboards. Myne is markdown notes,
  links, search and a graph.

## How to influence this

Open an issue with the use case, not only the feature. A roadmap change is a
maintainer decision recorded in the issue; see [`GOVERNANCE.md`](GOVERNANCE.md).
