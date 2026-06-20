# docs/ — Specifications, threat model, decisions log

> Subdirectory CLAUDE.md. Loaded when Claude reads files here. See repo-root `CLAUDE.md` for cryptographically load-bearing identifiers (the table that lives there is normative).

## What lives here

```
docs/
├── vision.md              ← phased plan, anti-features (commitments)
├── threat-model.md        ← A1–A13, AS1–AS17, TB1–TB9 — NORMATIVE
├── glossary.md            ← canonical terminology (~115 entries)
├── decisions.md           ← append-only timeline
├── questions.md           ← open questions parking lot
├── spec/
│   ├── protocol.md        ← v0.1 cryptographic protocol
│   └── account-number.md  ← Crockford base32 + Damm-32 identifier
├── design/                ← visual design tokens, icons, ui_kits
├── dev/                   ← internal dev notes (penpot-design-diff, etc.)
└── research/              ← evaluation notes (not normative)
```

## Read order before editing

If you're touching crypto, on-disk format, key handling, sync, or trust boundaries:
1. `vision.md` — what is Myne, what is it not (anti-features)
2. `threat-model.md` — adversaries, assets, trust boundaries (NORMATIVE)
3. `spec/protocol.md` — v0.1 cryptographic protocol
4. `spec/account-number.md` — identifier format
5. `glossary.md` — canonical terms
6. `decisions.md` — historical context

## Authoring discipline

### `decisions.md` is append-only

- **Newest entry last.** Never reorder.
- **Reversals get new entries** with the form `### YYYY-MM-DD — <title> (supersedes YYYY-MM-DD — <old title>)`. Never delete or rewrite past entries; the audit trail is the value.
- One entry per decision, even if multiple land the same day.
- Use absolute dates, not "yesterday" / "last week".
- Link out to the spec/PR/ADR; the log is a pointer, not a replacement.
- "Deferrals count" — explicitly choosing not to decide X yet is itself worth logging.

### `glossary.md` is gated

Every new term added in any doc (`vision.md`, `threat-model.md`, `protocol.md`, etc.) **gets a glossary entry in the same change**. No new term ships without a definition. Keep entries terse; one paragraph max.

### `threat-model.md` is normative

Marketing copy and code may not exceed the guarantees in the threat model. If you find yourself wanting to claim something stronger:
- Either downgrade the claim to match the threat model, or
- Update the threat model first (with a `decisions.md` entry justifying the change), then update the claim.

The order matters. Don't ship the marketing copy and "fix the threat model later".

### `protocol.md` versioning

v0.1 and v005 are **forward-incompatible by design**. No extension points, no algorithm-agility headers, no negotiation. Cross-major reads happen only via explicit user-initiated migration. If you find yourself wanting to add a feature flag or version negotiation: stop, you're walking back the major-version commitment. Add a new v005 spec instead.

### Cryptographically load-bearing identifiers

The table in repo-root `CLAUDE.md` lists strings/bytes bound into AEAD tags or magic-byte checks (AAD prefix `"myne.v0.1|"`, magic `MY01`/`MYV1`, etc.). **Changing any of these is a major-version event.** When editing `protocol.md`, do not casually revise these values — they're load-bearing in code and across other-language implementations.

## Companion: `myne-test-vectors`

Specs in `protocol.md` are the human-readable contract; vectors in the `myne-test-vectors/` companion are the machine-readable contract. When you add a new primitive or change a byte layout, you owe a vector update — see `myne-test-vectors/CLAUDE.md`.

## License

`docs/` is **CC0** (Creative Commons Zero, public domain). The spec must remain reusable for independent implementations even after the rest of the repo moves to AGPL-3.0. **Don't add code-level license headers to docs.**

## Operator-doc placement (normative vs runbook)

Split operator-facing docs by **nature**, which maps to the license boundary (MYND-439, ledger SYNC-27):

- **Normative / spec-projection** (the operator *contract* — what a self-hoster must preserve: no-IP, ZK, the protocol-guarantee-vs-policy-obligation split, retention obligations) → lives in `docs/` (CC0, reusable for independent implementations). Example: `docs/self-host-policy.md`.
- **Operational / how-to** (bundle-specific mechanics: compose commands, env-var syntax, snapshot/restore scripts, Caddy config, migration steps) → lives in the **`operations`** companion (AGPL).

Cross-reference is **one-way**: a runbook (AGPL) points to the policy doc (CC0) for the *why/guarantee*; the CC0 doc embeds **no** bundle-specific command (so it stays bundle-agnostic and reusable). Never reference an AGPL runbook from a CC0 doc.

## Gotchas

- `glossary.md` references are case-sensitive matches in some downstream tools — keep entry titles stable.
- `decisions.md` has ~50 entries; adding more never breaks anything but **never reorder existing ones**, even to fix a date typo (write a new entry that says "2026-04-26 entry has wrong date, actual was 2026-04-27").
