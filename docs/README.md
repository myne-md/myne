# Myne public documentation

This directory is the public, normative documentation set for Myne. It is a
subset of the project's internal documentation tree:

- `spec/` — the protocol, on-disk format, account number, sync and recovery
  specifications. `spec/protocol.md` is the normative reference.
- `threat-model.md` — adversaries, assets, trust boundaries and limitations.
  Marketing copy and code may not exceed the guarantees stated here.
- `glossary.md` — the canonical vocabulary used across the code and the specs.
- `web-bundle-hashes.md` — the append-only record of web bundle hashes.

The decision log, the design canon and the internal development notes are not
published. A reference such as `decisions/protocol/0763` in the source is an
identifier for a private record, not a path in this repository.

Everything in this directory is licensed under CC-BY-4.0; see `LICENSE`.
