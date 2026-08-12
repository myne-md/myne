# Product

## Register

product

## Scope

This document binds **all Myne client surfaces**: the Phase 1 Tauri desktop client at this repo root, the in-repo desktop-**browser** client at `web/` (same `src/` tree, platform seam substituted at build time), and the `myne-mobile` client — all of which share the same protocol, voice, and visual language. (There is no `myne-web` repo; that companion is archived and the web client lives in this one — `design-notes.md` 2026-07-26.) The marketing site (`myne-website`) is a separate brand-register surface and carries its own PRODUCT.md.

### Source of truth (read this order)

The visual system has three layers, each with a different role. Honor the order; do not invert it.

1. **`docs/design/` is canonical.** `README.md` (voice + tactical rules), `colors_and_type.css` (the CSS-variable source — these are the binding values), `ui_kits/desktop/` (JSX primitives), `preview/`, `icons/`, `assets/`. The design system lives in the repository and is versioned with the code that consumes it; there is no external design file that outranks it.
2. **`DESIGN.md` + `DESIGN.json` are the machine-readable projection** of that system for agents — the token layer, tonal ramps, live-panel components, shadow/motion/focus extensions. Where they and `colors_and_type.css` disagree, the **CSS is the value** and `DESIGN.md`/`DESIGN.json` get corrected.
3. **`src/` is the implementation.** A component binds to the CSS variables, never to a literal — a hardcoded colour or numeric radius in an inline style outranks every stylesheet and is unreachable to any custom theme, permanently (`scripts/check-token-adoption.mjs` is the ratchet that enforces it).

When a shipped screen and the canon disagree, decide **which side is wrong on the merits** rather than by rank: a screen that drifted off the system gets fixed, and a screen that genuinely improved on the system is a reason to update `docs/design/` in the same change. What is never acceptable is leaving the two disagreeing silently.

The strategy in this document covers all three layers. `docs/design/` covers tactical execution detail (voice rules, fixed strings, token values, component anatomy). `DESIGN.md` (alongside this file at repo root) carries the machine-readable visual spec for AI agents.

## Users

**Primary.** The technical Obsidian power user who currently routes around Obsidian's lack of native end-to-end encryption. They run Obsidian plus Cryptomator plus Syncthing today, or pay uneasily for Obsidian Sync, or self-censor inside the app entirely. They read r/PrivacyGuides, have self-hosted at least one service, can manage a master password and a 24-word recovery phrase, and will read the protocol spec before they install. Their context is a desktop session of sustained reading and writing, often hours long, frequently with a sidebar of cryptographic identifiers visible.

**Secondary.** Everyone else, including users who don't actively think about privacy. Myne has no plaintext mode, no encryption opt-in toggle, no settings to flip. A casual user who picks Myne because it looks like a clean, fast markdown notes app gets the same zero-knowledge guarantees as the threat-model expert without ever seeing the word "encryption" in a heading. The job-to-be-done is the same for both personas: capture, link, and find markdown notes across devices, calmly, without lock-in.

## Product Purpose

Myne is the only open-source markdown notes app where files stay plaintext-readable after decryption, where backlinks and graph are first-class, where signup requires no email, and where the same code runs on hosted sync or a self-hosted server.

The wedge is portability plus open-source full stack. If a user stops trusting the project, they self-host. If they stop using Myne entirely, they walk away with their files into any markdown editor on the machine. There is no proprietary format, no migration tool required, no lock-in. Privacy is not what the product sells. Privacy is what the product is.

Phase 1 is a Tauri desktop client with encrypted markdown blobs on disk, an Argon2id-derived master key, BIP-39 24-word recovery, a CodeMirror editor with `[[wikilinks]]`, full-text search, backlinks, and a minimal graph view. v1.0 ships when a real user can install the desktop app, generate a recovery phrase, write notes for 30 days, deliberately lose their password, recover the vault from the phrase, and at no point have plaintext touched the disk outside the in-memory editor session. Sharing, real-time collaboration, and any plugin API stay explicitly out of v1. Two of the original exclusions were reconsidered on the record and are now in scope: the self-hostable open-source sync server ships in Phase 1, with only the managed hosted account and paid tier held back to Phase 2 (`docs/vision.md`; `decisions.md` 2026-07-18), and a deliberately narrower desktop-browser client is being built in-repo at `web/` (`decisions.md` 2026-07-26). Mobile remains Phase 3.

Optional intelligence is off by default. A user who turns it on (Settings → Developer → AI) gets a small model that runs on their own machine — summarize, semantic search, and voice-to-text transcription of an audio note among them. **Nothing is sent anywhere until the user names a provider**, and the default is none. A user may then name one: a model runner on their own computer (nothing leaves the device) or a remote service such as Ollama Cloud or OpenRouter (where the text of what they asked about does leave it, after a consent step that says so plainly). The surfaces that fire *without* being asked — ghost-text as you type, automatic tagging, search indexing — can never reach a remote service at all, for cost as much as for privacy. Two things hold regardless: **Myne never downloads a model** (bundled, or side-loaded from the user's own disk — desktop ships a built-in voice-to-text model so transcription works out of the box), and **there is no telemetry**. Voice-to-text is the one surface that is on-device unconditionally: no remote service takes audio. They are honestly fallible — a transcript is a machine's best guess, not a verbatim record, and the copy says so. The in-process runtime is local but not yet sandboxed from the vault keys (`docs/threat-model.md` §7 "Local AI"), so the product never claims "sandboxed". And it no longer claims "sends nothing" flatly — that sentence was true until 2026-08-09 and is now scoped: **nothing is sent until you name a provider, and Myne never picks one for you.** With a remote provider named, the honest claim is what that provider receives and that Myne cannot see what it keeps — never a promise made on the provider's behalf.

Success is bootstrapped, slow, and modest. Year one targets a few thousand GitHub stars, dozens of self-hosted instances run by strangers, around a hundred paying users on hosted sync, and one unsolicited r/PrivacyGuides recommendation. Hyper-growth, VC funding, and feature parity with Notion are explicit non-goals. The project aims to be a small, profitable, independent tool that outlasts the founders' attention by being open enough that someone else can pick it up.

## Brand Personality

**Three words: trustworthy, calm, technically honest.** These are lifted verbatim from `docs/design/README.md` and bind every surface.

**Voice.** The product talks like a careful engineer talks to another careful engineer. Direct, no filler. Honest about cost, including irreversibility. Technically literal: "24-word recovery phrase", not "secret words"; "Argon2id (m=256 MiB, t=3, p=2)" appears in advanced settings exactly as in the spec. Never marketing-overreach on security claims; every guarantee in the UI must be backed by `docs/threat-model.md`.

**Tone.** Sentence case for everything except proper nouns (Myne, Argon2id, BIP-39, XChaCha20-Poly1305, Crockford-base32, Tauri). No hype words: never "military-grade", "bank-level", "unbreakable", "ultra-secure", "next-gen". No emoji in the product surface. No exclamation points. Pronouns are "you" (the reader) and "we" (the project, used sparingly, mostly when stating limits).

**Emotional goals.** A user who has been writing for an hour should feel like the tool got out of the way. A user who just lost their password should feel that the recovery flow respects them and tells them the truth. A privacy-skeptical reader should close the protocol spec thinking "these people are not bullshitting." A first-time visitor who knows nothing about encryption should never feel lectured.

## Anti-references

Both at the strategic and visual levels. The list is long because privacy products fail more often from drift than from missing features.

**Strategic anti-products** (the categories Myne refuses to become):

- **Skiff.** VC-driven privacy product, Notion-acquired in 2024, killed inside 12 months, two million users lost their notes home. The canonical cautionary tale. Myne does not raise venture capital and does not pursue an acqui-hire exit.
- **Notion.** Feature creep into databases, kanban, calendar, whiteboards. Myne is markdown notes, files on disk, bidirectional links, and graph. That is the entire product surface forever.
- **Standard Notes.** Paywalls markdown rendering. Myne paywalls only the hosted-sync convenience. Everything that runs locally (editor, links, graph, search, encrypted storage) is free.
- **Notesnook.** Rich-text-first, stores notes in its own format. Myne is plain markdown after decryption with no custom block model.
- **Joplin.** End-to-end encryption is off by default, leaks timestamps, plugin ecosystem doesn't work on mobile. Myne has no plaintext mode and no opt-in encryption.
- **Logseq.** Deprecated on-disk encryption entirely. Myne treats encryption as the foundation, not a feature to retire.

**Visual and copy anti-patterns** (the surfaces Myne refuses to render):

- The "lock + shield + green checkmark" cliché. Encryption status is communicated typographically, not with badges.
- The Myne mark is not a lock, not a shield, not a key. The product is privacy-first; it is not a privacy product as theme.
- Cards with a colored left-border accent. Banned outright; cards earn distinction from a `--paper-2` fill and a `--line-1` hairline only.
- Glass, blur, vibrancy, backdrop-filter as decoration. Solid surfaces only.
- Gradients on text or backgrounds. Single solid colors only; emphasis comes from weight or size.
- Hero-metric SaaS templates: big number, small label, supporting stats, gradient accent. Never.
- Identical card grids of "icon plus heading plus paragraph", repeated endlessly.
- Stock photography of people. Hands on keyboards, "diverse team in glass conference room", smiling laptop owners. None of it.
- "Welcome back, friend!" copy. "Connecting securely..." copy. Hype-word marketing across every surface.
- Emoji as iconography in the product. Lucide stroke icons only, `currentColor`, never colored independently.
- Modals as the first reach for any interaction.

**Scope of the visual list: it binds the interface Myne ships, not the one a user builds for themselves.** Every anti-pattern above governs Myne's own surfaces — the default appearance, the built-in themes, the marketing site, every screen the project authors. It does **not** govern a [custom theme](docs/glossary.md) a user writes, or one they install from `myne-themes`. A user may give their own vault a look this project would never ship, and that is the point of the feature rather than a leak in the canon: the product's voice is what Myne says, and a person's own notebook is not Myne talking. What still binds a user theme is the machinery, not the taste — the value-shape allowlist (a theme value reaches the DOM and therefore executes), the contrast floor that refuses an unreadable palette at import and at apply, and the rule that [ornament](docs/glossary.md) is paint. The floor covers the colour pairs it names; it cannot see a pattern drawn behind text, which is why the ornament layer's *fields* — texture, ruled ground, tint wash — are capped in Myne's own stylesheet rather than trusted to the palette. Its edge decorations (tape, perforation, torn edges, folds) are opaque by design and bounded by where they sit rather than by how strong they are. Recorded in `design-notes.md` 2026-08-06; the strategic anti-products above are unaffected and remain absolute.

## Design Principles

Five strategic principles. They override convenience and they override convention. They do not bend.

1. **Privacy is the default, not the topic.** The product talks like a notes app, not a privacy product. We do not sell encryption. We are encrypted. A user who never opens a settings page and never reads a heading still gets the full zero-knowledge guarantee. Surfaces that explain encryption do so once, plainly, then return to the work.

2. **The threat model speaks for the product.** `docs/threat-model.md` is normative. Marketing copy, UI strings, and product claims may not exceed its guarantees. If the threat model says "best-effort", the UI does not say "secure". If a tempting marketing line requires loosening the threat model, the threat model is updated first (with a `decisions.md` entry) or the line is cut. Never the other way around.

3. **Honest about cost.** Whenever the user is about to do something irreversible, the product says so plainly, in advance, in the user's language. The recovery flow is the canonical example: "If you lose both your password and recovery phrase, your notes are unrecoverable. We cannot help." We do not soften, we do not hedge, we do not invent a compensating control to remove the discomfort. The discomfort is the point.

4. **Built to live in for hours.** Density is comfortable, not compact. Motion is restrained. There are no looping animations, no marching ants, no pulsing indicators. State is communicated by typography, not by chrome. The visual surface is paper and ink, with one cool accent. The product is for sustained reading and writing, not for monitoring metrics.

5. **Plain markdown, plain language.** Notes are plain markdown after decryption; copy is plain language at the surface. No proprietary format on disk, no proprietary tone in errors. If a user can write Obsidian-style markdown, they can write Myne notes. If they can read a clear paragraph, they can read our error messages. Both commitments are load-bearing.

## Accessibility & Inclusion

**WCAG 2.2 AA** across every client (desktop, the in-repo `web/` browser client, mobile). The existing token ramp in `docs/design/colors_and_type.css` is built to clear AA contrast on the warm-paper light theme and the dim dark theme; deviations require revisiting the tokens, not the audit.

**Motion.** `prefers-reduced-motion` disables all transitions globally. No looping animations anywhere; the encrypted-status indicator does not pulse, the focus border does not march, the spinner does not bounce.

**Focus.** `:focus-visible` is always visible and never removed. The standard ring is a 2px iron-blue stroke with a 1px paper offset. The product is keyboard-first because the primary user is keyboard-first.

**Crypto-identifier legibility.** JetBrains Mono Variable with `ss02`, `zero`, and `calt` features enabled disambiguates `0/O`, `1/lI/!`, and similar collisions for hand-typed Crockford-base32 account numbers. Account numbers always render as `MY-XXXX-XXXX-XXXX-XXXX-XXXX` — 27 characters, five 4-char Crockford groups after the `MY-` prefix (`docs/spec/account-number.md` §2) — in monospace with non-breaking hyphens (U+2011) and `user-select: all`, so a single click selects the whole value.

**Color is never the sole channel.** State (danger, warning, success, info) is always paired with a stroke icon and a text label. A red dot alone is not a state; a red dot with `circle-alert` and "Sync error" is.

**Localization.** English is the source language and the per-key fallback; the shipped clients carry the locale set enumerated in `src/i18n/config.ts` (`SUPPORTED_LANGUAGES`, one directory each under `locales/`, 32 at the time of writing, all of them complete). Translations are owned by the self-hosted Weblate at `translate.myne.md`, not by this document; the process is `docs/dev/i18n.md` and a pre-commit gate (`scripts/check-i18n.mjs`) fails a commit that leaves a used key uncatalogued. Layouts are designed to survive a translation running long — English is the shortest case, not the only one. The one deliberate exception is **load-bearing copy** (`src/lib/load-bearing-copy.ts`, `@myne/copy`): the handful of literals whose exact wording is a privacy or security property render verbatim in every locale and never pass through `t()`, because a faithful translation would destroy the byte identity the non-distinguishing error strings depend on.
