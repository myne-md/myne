# Myne — Vision

## Tagline

Myne is the only open-source markdown notes app where your files stay plaintext-readable after decryption, where backlinks and graph are first-class, where signup requires no email, and where the same code runs on our hosted sync or your own server.


## The Problem

Privacy-aware users who want Obsidian-like flexibility face an impossible choice today. Either they self-censor inside Obsidian — keeping sensitive thoughts out of the app entirely because notes sit in plaintext on disk (a recurring forum sentiment: *"I will only use Obsidian for superficial information"*) — or they duct-tape together Obsidian + Cryptomator + Syncthing, a fragile three-tool stack where mobile barely works, IndexedDB caches leak plaintext outside the encrypted volume, and performance collapses on large vaults. The encrypted-first alternatives don't fix it either: Standard Notes paywalls markdown and has no backlinks or graph; Notesnook is rich-text-first and stores notes in its own format rather than plain markdown files; Joplin's E2EE is off by default, leaks timestamps, and its plugin ecosystem doesn't work on mobile; Logseq deprecated on-disk encryption entirely. There is no app that combines real built-in encryption with Obsidian-grade markdown flexibility — and the workarounds force users to choose between privacy and the way they actually want to think.

## Target User

**Primary** — the technical Obsidian power user who currently routes around Obsidian's lack of native E2EE. They run Obsidian + Cryptomator + Syncthing, pay for Obsidian Sync uneasily, or self-censor inside the app entirely. They read r/PrivacyGuides, have self-hosted at least one service, can manage a master password and a 24-word recovery phrase. They want Obsidian-grade flexibility without the privacy compromise — and they will read the protocol spec before they install.

**Secondary**: everyone else, including users who don't actively think about privacy. Myne has no plaintext mode for your vault and no opt-in encryption toggle. Built-in privacy is the default for every user, not a feature surfaced to a niche. (The plain-file editor opens a user's own separate on-disk `.md` files outside the vault; it never turns a vault note into plaintext. See `decisions/clients/0625`, `threat-model.md` §7.) A casual user who picks Myne because it looks like a clean, fast markdown notes app gets the same zero-knowledge guarantees as the threat-model expert without ever opening the settings. Privacy is not what the app sells; privacy is what the app *is*.

## The Wedge

Myne is the only encrypted notes app where the entire stack — protocol, client, sync server — is open source, and where your notes stay plain markdown after decryption. If you stop trusting us, you self-host. If you stop using us, you walk away with your files into any editor on your machine. There is no proprietary format, no migration tool required, no lock-in.

One qualification, stated here rather than buried: a **browser** client is delivered from a server on every page load, with no signature the browser checks — a materially weaker delivery channel than a desktop build the user downloads once and keeps, and one that gives up a guarantee the native clients keep. (The desktop build is not signed either, and this sentence said it was until 2026-08-25: `decisions.md` entry 0534. What the native channel has is persistence, not verification. The artifact stays on disk, so a substitution reaches only whoever downloaded during the window and the file is still there to compare by hand against the published hash list. A page is re-sent every visit and leaves nothing behind.) What that costs, exactly and against which adversary, is `threat-model.md` A15 / TB11; it is not restated here.

## Success Criteria

Tiered, with both numbers and qualitative outcomes.

**Minimum success — the personal-utility floor.**
- I dogfood Myne daily for at least 6 months without losing a note.
- v1.0 desktop ships within 9–12 months of project start.
- Protocol spec and threat model are public on day one of v1.0.

**Modest success — community validation, year 1.**
- 1,000+ GitHub stars within the first year of public release.
- A few dozen self-hosted instances run by people we don't know.
- 50–100 paying users on hosted sync.
- At least one r/PrivacyGuides forum thread recommending Myne unprompted.

**Stretch success — sustainable small business, year 2–3.**
- 5,000–10,000 GitHub stars.
- Listed on privacyguides.org's notebooks recommendation page.
- 1,000+ paying users on hosted sync — enough to fund continued development without external capital.
- Mobile and web clients shipped.
- Protocol spec reviewed informally by at least one external cryptographer or security researcher without a serious flaw being found.
- Community-contributed translations in 3+ languages.

**What success deliberately is not**: VC funding, hyper-growth, mass-market adoption, or feature parity with Notion. Myne aims to be a small, profitable, independent tool that outlasts the founders' attention span by being open enough that someone else can pick it up.

## What Myne Is Not

The list of explicit non-goals is longer than usual because privacy products die from scope creep more than from missing features. These are not "maybe later" — they are commitments the team makes to itself.

- **No VC funding, no acqui-hire exit.** Myne will not raise venture capital. The Skiff shutdown in 2024 is the canonical cautionary tale: VC pressure forced a Notion acquisition, the product was killed inside 12 months, and 2 million users lost their notes home. Bootstrapped, profitable, slow growth is the only path that aligns with a privacy promise.
- **No proprietary format.** Notes are plain markdown after decryption. No custom block model, no internal database that "owns" your content, no export tool needed. If Myne disappears, your files are already in the format every editor understands.
- **The recovery phrase is never a routine credential in served code.** The 24-word phrase is a **permanent** credential: it unwraps an independent copy of the same persistent `root_key`, changing the password does not invalidate it, and no rotation command exists. A leaked phrase therefore has no in-app remedy. From 2026-07-26 to 2026-08-15 the commitment was absolute, that the phrase never crossed into served code at all, and it was **partially reversed** because it cost two things a browser-first user could not get anywhere else: an account they could not create, and a password they could not recover. What survives is the part that carries the protection. **Display** (creation) and **entry** (a recovery the user started) ship on the web client; the phrase as a **device-enrolment credential** does not, and is kept out of the served artefact by build-time substitution rather than by a runtime branch. The rule a user can hold is therefore one sentence: Myne asks for your recovery phrase in a browser in exactly one situation, a recovery you started yourself, never to add a device and never to sign in. What was spent, and it was not nothing, is the structural inference that any web page asking for the phrase was self-evidently fake (`threat-model.md` A18). (`decisions.md` 2026-07-26, reversed in part by 2026-08-15, entry 0514.)
- **Mobile browsers are refused, not degraded.** The Argon2id parameters are AAD-bound and read from `vault.meta`, so they cannot be lowered for a constrained device without producing a vault no other client can open — and iOS Safari cannot reliably allocate the 256 MiB the baseline requires. A mobile browser therefore gets an honest refusal pointing at the native app, never a quietly-weakened derivation. Weakening the KDF to fit a device is the exact trade this project does not make.
- **No real-time collaborative editing in v1.** Single-user multi-device sync is the v1 commitment. Real-time co-editing requires a CRDT (Automerge, `decisions.md` 2026-08-09) and a substantially different sync architecture; it lands in Phase 4 at the earliest, not before the rest of the product is solid. B2B **async** multi-user sharing over the same synced vault is a separate, narrower commitment being built now (`design-notes/protocol/0592`): person-level keypairs, per-recipient `itemsKey` wraps, a shared roster, and a rekey on member removal. It is not real-time co-editing, and it does not change this line: the transport for live presence stays Phase 4.
- **No plugin ecosystem in v1.** Obsidian's plugin model is its biggest strength and the largest privacy hole — plugins can read, write, and exfiltrate the entire vault. Myne will not ship a plugin API in v1, possibly never. If it lands, it will be sandboxed and capability-scoped from the first design — not bolted on after the fact.
- **No mobile in Phase 1.** Tauri (Rust core) desktop is the v1 target. iOS and Android come in Phase 3 — on Tauri 2 Mobile, reusing the same Rust core and React UI (`decisions.md` 2026-05-01 supersedes the earlier React Native choice) — after the desktop client and sync server are stable. Trying to ship four platforms with two people is the silent killer in this category (Turtl, Laverna).
- **No feature paywall in the local app.** Everything that runs locally — editor, links, graph, search, encrypted storage — is free. The paid tier is exclusively the hosted sync convenience. Standard Notes paywalling markdown rendering is the explicit anti-pattern. Users who self-host pay nothing and lose nothing.
- **No email at signup. No email recovery.** Account identity is a self-generated number; recovery is a 24-word phrase the user holds. If both are lost, the data is gone — and we cannot help. This is a hard line. Adding email recovery later would silently invalidate the zero-knowledge claim.
- **No closed-source components.** Client, sync server, protocol spec, build pipeline — all open source. "Open core" is not the model. There will be no proprietary "enterprise" build with extra features.
- **No Notion-style feature creep.** No databases, no kanban boards, no calendar, no whiteboard, no embedded apps. Markdown notes, files on disk, bidirectional links, graph. That is the entire product surface. Users who want a database can keep their database and link to it from a note.

## Phase 1 Scope

**What v1.0 is.** A single-user Tauri (Rust core) desktop app:

- Encrypted markdown blobs on disk — one ciphertext file per note
- Master password derived via Argon2id; BIP39 24-word recovery phrase wrapping the root key
- CodeMirror 6 editor with live markdown and `[[wikilinks]]`
- Full-text search across decrypted notes
- Backlinks pane ("which notes link here")
- Minimal graph view (d3-force layout + hand-rolled canvas render, separate panel, lazy-loaded)
- Obsidian vault importer (`.md` files, YAML frontmatter, `[[wikilinks]]`)

**Definition of done.** v1.0 ships when a real user can install the desktop app, generate a recovery phrase, write notes for 30 days, deliberately lose their password, recover the vault from the phrase, and at no point have plaintext touched the disk outside the in-memory editor session (user-initiated export excepted — see `threat-model.md` §3 TB3).

Everything else, the **managed hosted sync service** (the paid convenience tier), mobile, web, real-time collaboration and plugin API, is explicitly out of scope for v1.0 and lives in later phases. **B2B async sharing is the one exception being pulled forward now** (`design-notes/protocol/0592`): the person-level identity substrate (keypairs + per-recipient wraps + a shared roster) is landing now, with the invite relay and cross-device roster propagation following, and without the live-co-edit transport. (Self-hostable multi-device sync is itself the v1 commitment; see "No real-time collaborative editing in v1" above and the Decisions-Log "Sync" note. Only the *managed/paid* offering is deferred.)

---

## Decisions Log

A record of the choices made while drafting this document, captured for the next reader.

**Resolved**
- **Project name kept as Myne** for now (placeholder, not branding-final).
- **Tagline retained from the project-advisor evaluation** with the explicit "Mullvad-style" reference removed; the no-email property is preserved in plain language.
- **Problem framing combines self-censorship + workaround stack + critique of existing E2EE apps.** All three are load-bearing; dropping any one weakens the case.
- **Two personas, with privacy as default for both.** Primary is the technical Obsidian power user; secondary is everyone else, who gets E2EE without opting in. There is no plaintext mode for the vault. (The plain-file editor opens a user's own separate on-disk files outside the vault; `decisions/clients/0625`, `threat-model.md` §7.)
- **Wedge is portability + open source full stack** (alternatives `b` + `c`) rather than competitor takedown or trust-only framing.
- **Success criteria tiered (Minimum / Modest / Stretch)** with both numerical and qualitative outcomes. Numbers anchored on the audience-sizing analysis (5k–30k global power users) and the Notesnook benchmark (~14k stars in ~2 years OSS).
- **Anti-features include nine commitments**, deliberately longer than typical because the team treats scope creep as the primary failure mode for privacy products.
- **Phase 1 includes a minimal graph view** (lazy-loaded d3-force panel) — the wedge sentence promises graph as first-class, and v1 has to credibly back that.
- **Definition of done is the recovery flow drill**: lose the password, recover from the phrase, plaintext never on disk. Recovery is the highest-risk piece of the project; the DoD reflects that.

**Deliberately deferred**
- AI features: **admitted, and the condition they were admitted under has since been superseded** (2026-08-09). AI was first reconsidered on 2026-07-01 under one exact condition: *a fully local LLM with no provider call*: and the local-ai epic (MYND-406,412) shipped on-device summarize / semantic search / auto-tag / writing-assistant / voice-to-text transcription (MYND-270) behind Candle against it. **That condition no longer holds.** A user may now name an AI **provider**: either a model runtime running on their own machine (reached over loopback: nothing leaves the device) or a remote service such as Ollama Cloud or OpenRouter (where note text does leave the device). Both are **opt-in and default off**, both require an explicit consent step naming what is sent, and the surfaces that fire *without* the user asking: ghost-text, auto-tag, embedding: can never reach a remote provider at all. Two things hold, the first now amended: **Myne downloads a model only when the user asks it to, from Myne's own artefact origin, which keeps no IP logs and no analytics** (models not fetched on demand are side-loaded from the user's own disk; this supersedes the never-downloads clause of 2026-08-09, `decisions/ai/0627`), and **nothing is sent anywhere until the user names a provider**: that is the invariant that replaced "zero networked dependency", which the CI gate never actually proved (it is a crate-name denylist, destination-blind; `decisions.md` 2026-08-04). It ships in the default build as a **runtime opt-in, default-off** (Settings → Developer → AI); a `--no-default-features` build is the AI-free auditable binary (`decisions.md` 2026-07-02). What survives of the original line: **no telemetry, no model download by Myne that the user did not ask for, and no egress the user did not ask for.** (See `decisions.md` 2026-08-09 for the supersession and its costs, 2026-07-01 + 2026-07-02 for the history, and `threat-model.md` §3 TB12/TB13 + §1 A16/A17 + §7 "Local AI"; the model runtime's key-isolation sidecar is a hardening still owed, and its recorded plan conflicts with a loopback provider: see §7.) *Note for the reader tracking this clause: the "never downloaded" wording was already narrowed twice: for transcription (2026-07-19) and the auto-tag model (2026-07-31): and neither supersession amended this sentence. This edit reconciles all three at once, so the drift predates the provider work.*
- Real-time collaboration (CRDT, Automerge) — Phase 4 at the earliest.
- Plugin API — possibly never; if it lands, sandboxed and capability-scoped from the first design.
- Mobile — Phase 3.
- **Web — reconsidered (2026-07-26).** A desktop-**browser** client is being built, in-repo at `web/`, compiling the same UI tree and the same Rust crypto core (to wasm) as the desktop client. It is deliberately narrower than the native clients: no quick-unlock, no backup import/export, none of the affordances that need the operating system, and no use of the recovery phrase as a device-enrolment credential — and it requires sync, because the browser is a window onto a synced vault rather than a place a vault lives. Account and vault creation, and phrase-based password recovery, were out of scope until 2026-08-15 and now ship (`decisions.md` 2026-08-15, entry 0514). Mobile browsers stay out of scope. The trust cost is real and is recorded as an adversary and a boundary rather than a footnote (`threat-model.md` A15 / TB11); the decisions are dated 2026-07-26 in `decisions.md`.
- **Sync — reconsidered (2026-07-18).** Single-user multi-device sync is the v1 commitment (see "No real-time collaborative editing in v1" above), and the **self-hostable open-source sync server ships in Phase 1** — it is in production hardening now (`sync-protocol.md`; the 2026-07-16/17 sync entries in `decisions.md`). What stays **Phase 2** is the **managed hosted account + paid tier**; the hosted `sync.myne.md` service currently runs as a free invite-only beta. The paid tier remains exclusively the hosted-sync convenience. (See `decisions.md` 2026-07-18.)

**Open risks to revisit**
- Recovery-phrase-only model: Standard Notes and Bitwarden both bleed users at this exact step. Worth checking 12 months in whether the team holds the line or quietly adds an encrypted recovery file as a compensating control.
- Graph view in v1: tension with the "tight Phase 1" goal. If the implementation slips, demote graph to v1.1 rather than slipping the v1 ship date.
- Audience size: 5k–30k global power users is the inferred ceiling. If the year-1 numbers fall short of the modest-success tier, revisit positioning rather than expanding scope.

