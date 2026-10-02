# docs/ — Specifications, threat model, decisions log

> Subdirectory AGENTS.md. Loaded when OpenCode reads files here. See repo-root `AGENTS.md` for cryptographically load-bearing identifiers (the table that lives there is normative).

## What lives here

```
docs/
├── vision.md              ← phased plan, anti-features (commitments)
├── threat-model.md        ← the A/AS/TB rosters (adversaries, assets, trust boundaries) — NORMATIVE
├── glossary.md            ← canonical terminology, one A–Z entry per term
├── decisions.md           ← generated INDEX over design-notes/ (do not hand-edit)
├── decisions/             ← the log itself: one file per decision, grouped by topic,
│                          numbered NNNN in one global chronological sequence
├── questions.md           ← informal Q&A summaries of the specs (explicitly not normative)
├── dependency-policy.md   ← when a dependency may be added and how it is reviewed
├── self-host-policy.md    ← operator contract for a self-hosted sync server (normative)
├── self-host-web.md       ← operator contract for serving the web bundle (normative)
├── web-bundle-hashes.md   ← the published per-release web-bundle hash record (A15/TB11)
├── web-tor-browser.md     ← why the web client has no Tor toggle, and what Tor Browser costs instead
├── spec/
│   ├── protocol.md         ← v0.1 cryptographic protocol (at-rest format, key hierarchy)
│   ├── account-number.md   ← Crockford base32 + Damm-32 identifier
│   ├── recovery-flow.md    ← 24-word-phrase ceremony + post-recovery password reset (UX-normative)
│   ├── sync-protocol.md    ← vault head, conflict model, tombstone GC (client side of sync)
│   ├── server-protocol.md  ← what the untrusted sync server stores, counts, and must not do
│   ├── markdown-dialect.md ← the markdown dialect + canonical frontmatter fields
│   └── wikilink.md         ← `[[wikilink]]` syntax and resolution rules
├── design/                ← visual design tokens, icons, ui_kits
└── dev/                   ← internal dev notes (e2e, i18n, userguide-screenshots, etc.)
```

The A/AS/TB rosters grow as the product does — `threat-model.md` §1/§2/§3 are the lists of record. Don't restate their extent (or their count) anywhere else; point at them.

## Read order before editing

If you're touching crypto, on-disk format, key handling, sync, or trust boundaries:
1. `vision.md` — what is Myne, what is it not (anti-features)
2. `threat-model.md` — adversaries, assets, trust boundaries (NORMATIVE)
3. `spec/protocol.md` — v0.1 cryptographic protocol
4. `spec/account-number.md` — identifier format
5. `glossary.md` — canonical terms
6. `decisions.md` — historical context

If the change touches **sync**, add `spec/sync-protocol.md` (vault head, conflict model, tombstone GC) and `spec/server-protocol.md` (the untrusted server's wire contract) after `spec/protocol.md` — the at-rest spec does not describe either. If it touches note **content** rather than its envelope, the pair is `spec/markdown-dialect.md` + `spec/wikilink.md`.

## Authoring discipline

### The decisions log is append-only, and it is now one file per decision

The log used to be a single 1.86 MB `decisions.md` carrying 489 entries, which is well past what
anything can read in one pass, so in practice nobody read it and agents grepped it. It is now
`design-notes/<topic>/<NNNN>-<slug>.md`, one file per decision, with `design-notes.md`
regenerated as the index over them. The `decisions.md` path still exists and carries the full
chronological table, so an existing reference of the form "see `decisions.md` 2026-06-09" still
lands somewhere useful, at the cost of one hop to reach the entry itself.

**The log was written with mixed heading levels**, 470 entries as `###` and 19 as `##`, and the
first split matched `###` only, so those 19 were absorbed into the preceding entry's body. They
still read fine to a human and were unreachable to the index, to a topic browse and to any tooling.
Six of them are the written record behind rows in `threat-model.md`. `scripts/decisions-index.mjs`
now refuses any entry file carrying a second dated heading, which detects that shape regardless of
the level it was written at.

- **`NNNN` is a single global sequence in date order**, not per directory. Sorting on it
  reconstructs the original timeline exactly, which is the property that makes the split safe.
- **`design-notes.md` is generated. Never hand-edit it.** Add the entry file, then run `node scripts/decisions-index.mjs`. A hand-edit survives until the next regeneration and then vanishes, which is why `--check` runs in `pre-commit`.
- **Newest entry gets the next number.** Never renumber, never reorder.
- **"The next number" is read off `origin/develop`, and on a long branch it goes stale.** Two branches each take the same next number, both are correct in isolation, and `decisions-index.mjs --check` is green in both trees because it only sees one of them. The collision appears at merge, and it is the one case where the "never renumber" rule above does not apply: the number is not in `develop`'s history yet, so whoever merges SECOND renumbers their own entry, which is a rename plus a `seq:` edit plus a regenerate. Verify the number immediately before the commit rather than when you write the entry, and if another branch is known to hold one, say so in the PR body. Measured on myne-md/myne#622: `0541` was taken by an unmerged `myne#456` branch while develop's highest was `0540`, and nothing in either tree could see it.
- **Reversals get new entries** with the form `### YYYY-MM-DD — <title> (supersedes YYYY-MM-DD — <old title>)`. The supersession belongs in the *title*, so a reader scanning headings sees it; a reversal that only mentions the old entry in its body is invisible. Never delete or rewrite a past entry; the audit trail is the value. A superseded entry keeps its file and its number.
- **Pick the topic a reader would look in first**, and cross-reference the other one in the body when two fit. The topic is navigation, not taxonomy, and getting it slightly wrong costs nothing because the index lists everything.
- One entry per decision, even if multiple land the same day.
- Use absolute dates, not "yesterday" / "last week".
- Link out to the spec/PR/ADR; the log is a pointer, not a replacement.
- "Deferrals count" — explicitly choosing not to decide X yet is itself worth logging.

### `glossary.md` is gated

Every new term added in any doc (`vision.md`, `threat-model.md`, `protocol.md`, etc.) **gets a glossary entry in the same change**. No new term ships without a definition. Follow the conventions the glossary states about itself (§ "Overview & Conventions"): a category tag, an aliases / *Myne-divergent* line where it applies, and a `Used in:` line pointing at where the term is authoritatively defined. Keep entries terse by default — *Myne-divergent* and "deep entry" terms are the ones that earn longer treatment.

### `threat-model.md` is normative

Marketing copy and code may not exceed the guarantees in the threat model. If you find yourself wanting to claim something stronger:
- Either downgrade the claim to match the threat model, or
- Update the threat model first (with a `decisions.md` entry justifying the change), then update the claim.

The order matters. Don't ship the marketing copy and "fix the threat model later".

**Every trust-boundary row (`TB*`) and adversary row (`A*`) the threat model declares owes a verdict in `myne`'s `scripts/check-adversary-coverage.mjs` in the same change** (the `internal-service` scenario that exercises it, or a written out-of-scope reason), and the projection `docs/dev/adversary-coverage.md` must be regenerated (`--emit`). The guard compares both ways: a new row with no verdict fails naming the row, and a verdict whose row is gone fails as stale. A threat-model row is normative, so its coverage binding is not optional bookkeeping.

### `protocol.md` versioning

v0.1 and a later major version are **forward-incompatible by design**. No extension points, no algorithm-agility headers, no negotiation. Cross-major reads happen only via explicit user-initiated migration. If you find yourself wanting to add a feature flag or version negotiation: stop, you're walking back the major-version commitment. Add a new major-version spec instead.

**Don't mint a codename for the next major.** In prose, features deferred to the next version read as **"later" / "a later version" / "the next major version"**; genuinely parked / speculative items read as **"icebox"** (matching the tracker's `roadmap: icebox` label). Do not invent a version string: the retired "v005" codename (`decisions.md` 2026-08-01) metastasized as a synonym for "deferred" and decorated nearly every forward-looking note. Name the next format only when it is actually being designed. The magic bytes that §10.3 still marks reserved stay as nameless placeholders, and that is now the smaller half of the table: `NTV5`, `MYP5`, `MYA5`, `MYC5`, `MYD5`, `MYT5`, `MYM5`, `MYJ5` and `NC05` are allocated and name bytes on disk today (§10.3.1 makes v0.2 the birth format), while `NT05` and the remaining `MY?5` values are the placeholders. The next major's AAD/HKDF prefixes are not pre-allocated.

### Cryptographically load-bearing identifiers

The table in repo-root `AGENTS.md` lists strings/bytes bound into AEAD tags or magic-byte checks (AAD prefix `"myne.v0.1|"`, magic `MY01`/`MYV1`, etc.). **Changing any of these is a major-version event.** When editing `protocol.md`, do not casually revise these values — they're load-bearing in code and across other-language implementations.

## Companion: `myne-test-vectors`

Specs in `protocol.md` are the human-readable contract; vectors in the `myne-test-vectors/` companion are the machine-readable contract. When you add a new primitive or change a byte layout, you owe a vector update — see `myne-test-vectors/AGENTS.md`.

## License

`docs/` is **CC-BY-4.0** (Creative Commons Attribution 4.0). The spec must remain reusable for independent implementations as long as Myne is credited; application code is AGPL-3.0. **Don't add code-level license headers to docs.**

## Operator-doc placement (normative vs runbook)

Split operator-facing docs by **nature**, which maps to the license boundary (MYND-439, ledger SYNC-27):

- **Normative / spec-projection** (the operator *contract* — what a self-hoster must preserve: no-IP, ZK, the protocol-guarantee-vs-policy-obligation split, retention obligations) → lives in `docs/` (CC-BY-4.0, reusable for independent implementations). Example: `docs/self-host-policy.md`.
- **Operational / how-to** (bundle-specific mechanics: compose commands, env-var syntax, snapshot/restore scripts, Caddy config, migration steps) → lives in the **`operations`** companion (AGPL).

Cross-reference is **one-way**: a runbook (AGPL) points to the policy doc (CC-BY-4.0) for the *why/guarantee*; the CC-BY-4.0 doc embeds **no** bundle-specific command (so it stays bundle-agnostic and reusable). Never reference an AGPL runbook from a CC-BY-4.0 doc.

**Ruling for the web client's self-host documentation** (MYND-574 tasks 49–51). The split applies unchanged, and the cut runs through the *middle* of the web self-host story rather than around it:

- The **obligations** a self-hoster takes on by serving the bundle — that they become the code-delivery operator for their users (`threat-model.md` A15/TB11), that the strict CSP and cross-origin isolation are part of the security posture and not decoration, that the sync-origin knob must be a runtime value so the published bundle hash stays comparable, and that no client IP is logged at the bundle origin either — are **normative** and live in `docs/` (CC-BY-4.0), alongside `self-host-policy.md`. They landed as `docs/self-host-web.md`; the hash record those obligations lean on is `docs/web-bundle-hashes.md`.
- The **mechanics** — the container image, its compose file, env-var syntax, reverse-proxy config, TLS setup — live in **`operations`** (AGPL), like every other runbook.
- **`web/README.md` is a third thing and stays small**: a contributor-facing map of the target (what `web/` is, which commands build it, where the seam substitution happens). It is neither the normative contract nor the operator runbook, and it must not grow into either.

## Gotchas

- `glossary.md` references are case-sensitive matches in some downstream tools — keep entry titles stable.
- **`glossary.md` is A-to-Z, and a hyphen sorts BEFORE a letter**, so `per-vault namespace` precedes `period anchor`. The trap is inserting by scanning for the first heading in FILE order that sorts after the new term: entries whose titles differ only by a hyphen or a space break that scan, and myne-md/myne#177's first attempt landed a new entry six hundred lines early, next to `full-reconcile`. Read the neighbours back after inserting rather than trusting the insert.
- The decisions log keeps growing; adding an entry never breaks anything, but **never renumber or reorder existing ones**, even to fix a date typo. Write a new entry that says "2026-04-26 entry has wrong date, actual was 2026-04-27" and leave the original alone.
