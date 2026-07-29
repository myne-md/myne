---
name: Myne
description: Open-source, end-to-end-encrypted markdown notes. Paper and ink surface, one cool accent, monospace for cryptographic identifiers.
canonicalSource: penpot
canonicalSourceNote: "Penpot is the canonical design source (page '4 — Desktop UI Kit'). Tokens here are extracted from docs/design/colors_and_type.css, which is the code-side projection. When Penpot and the values below disagree, Penpot wins and these values get updated."
colors:
  iron-blue: "#2c4a7a"
  iron-blue-hover: "#233b62"
  iron-blue-press: "#1b2e4d"
  iron-blue-soft: "#e8edf5"
  iron-blue-on: "#ffffff"
  iron-blue-dark: "#8aa4d0"
  warm-paper: "#fbfbfa"
  warm-paper-recessed: "#f4f4f2"
  warm-paper-pressed: "#ecebe7"
  ink-display: "#0b0b09"
  ink-primary: "#1a1a17"
  ink-secondary: "#3a3934"
  ink-tertiary: "#6b6a64"
  hairline: "#e3e2dd"
  divider: "#c8c7c1"
  control-disabled: "#a3a29c"
  brick-danger: "#8a2a23"
  brick-danger-soft: "#f5e7e5"
  ochre-warning: "#8a6a1f"
  ochre-warning-soft: "#f5efde"
  forest-success: "#2f6048"
  forest-success-soft: "#e3eee8"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "48px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  body-large:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "0em"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.08em"
    textTransform: "uppercase"
  caption:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "'ss02', 'zero', 'calt'"
  mono-large:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "18px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "'ss02', 'zero', 'calt'"
  account-number:
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.04em"
    fontFeature: "'ss02', 'zero', 'calt'"
rounded:
  sm: "3px"
  md: "6px"
  lg: "10px"
  pill: "999px"
spacing:
  "0": "0"
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
  "8": "64px"
  "9": "96px"
components:
  button-primary:
    backgroundColor: "{colors.iron-blue}"
    textColor: "{colors.iron-blue-on}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.iron-blue-hover}"
    textColor: "{colors.iron-blue-on}"
  button-primary-active:
    backgroundColor: "{colors.iron-blue-press}"
    textColor: "{colors.iron-blue-on}"
  button-secondary:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.warm-paper-recessed}"
    textColor: "{colors.ink-primary}"
  input-text:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.warm-paper-recessed}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "16px"
  account-number-chip:
    backgroundColor: "{colors.warm-paper-recessed}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.account-number}"
    rounded: "{rounded.sm}"
    padding: "4px 8px"
  sidebar-item:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    height: "32px"
  sidebar-item-active:
    backgroundColor: "{colors.iron-blue-soft}"
    textColor: "{colors.iron-blue}"
  status-pill:
    backgroundColor: "{colors.warm-paper-recessed}"
    textColor: "{colors.ink-tertiary}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
---

# Design System: Myne

## 1. Overview

**Creative North Star: "Paper and Terminal"**

The reference points are a printed page and a Unix terminal, not a SaaS dashboard. The surface is warm off-white paper (`#fbfbfa`) with warm-shifted near-black ink (`#1a1a17`). The cryptographic identifiers (account numbers, recovery-phrase words, key fingerprints) render in JetBrains Mono with the slashed zero turned on, because a person will read them aloud, type them by hand, and compare them against another device. The two registers (writerly paper, exact terminal) live in the same window without one swallowing the other.

The system is monochrome by default. More than 90% of any screen is neutral. There is exactly one accent color, an iron-blue `#2c4a7a` lifted toward sky tones in dark mode (`#8aa4d0`), and it is used only for focus rings, primary actions, links, and the active selection in the sidebar. State colors (a brick-red danger, a forest-green success, an ochre warning) are muted enough to read as information rather than alarm. The product is built to be lived in for hours: comfortable density, zero looping animations, no marching ants on the focus border, no pulsing status indicators. A user who has been writing for an hour should not have noticed the chrome.

The system explicitly rejects the privacy-product visual canon. There is no lock icon, no shield icon, no green checkmark badge. The Myne mark is a minimal `M` glyph, not a padlock. There is no glassmorphism, no backdrop-filter, no gradient on text or backgrounds. There are no cards with a colored left-border accent (the SaaS-callout cliché), no hero-metric template (big number + small label + supporting stats), no identical card grids of "icon + heading + paragraph", no stock photography of people. The visual surface for a privacy product should not telegraph that the product is about privacy; that conflation is what the system refuses.

**Key Characteristics:**
- Warm-paper light theme (`#fbfbfa`) with a dim-paper dark theme (`#121210`); both first-class.
- One accent (iron-blue) used on roughly 5% of any screen; never decorative, never gradient.
- Inter Variable for UI sans, JetBrains Mono Variable for cryptographic identifiers (slashed zero on, `ss02 + zero + calt`).
- 1px hairlines (`#e3e2dd`) for every divider; 2px borders are forbidden.
- Flat at rest. Shadows live only on overlays (command palette, dropdowns, toasts, tooltips), never on the editor surface or on cards.
- Restrained motion: 120/180/260ms, exponential ease-out only, `prefers-reduced-motion` disables transitions globally.

## 2. Colors: The Paper-and-Ink Palette

A near-monochrome system. The warm-paper neutral ramp does almost all the work; iron-blue is the only chromatic accent; the state colors are present but muted. No pure red, no kelly green, no Discord-purple anywhere.

### Primary
- **Iron Blue** (`#2c4a7a`, dark-theme `#8aa4d0`): Cool, technical, calm. Used for focus rings, primary buttons, hyperlinks, the active sidebar item, and nothing else. Hover shifts to `#233b62`, press to `#1b2e4d`. The soft tint `#e8edf5` is the active-selection background in the sidebar; `#ffffff` is the on-color for primary buttons. **Never** decorative, **never** as gradient, **never** as a left-border stripe on a card.

### Neutral
- **Warm Paper** (`#fbfbfa`): The page background of the entire product. Not pure white; tinted to read as paper rather than as a screen surface.
- **Warm Paper Recessed** (`#f4f4f2`): Recessed surfaces (sidebars, cards, the chrome around the editor).
- **Warm Paper Pressed** (`#ecebe7`): Hover and pressed surfaces. The hover-to-press shift is the only chromatic feedback most controls give.
- **Hairline** (`#e3e2dd`): The 1px hairline that separates every region. The system's most-used color after `--paper`.
- **Divider** (`#c8c7c1`): Stronger dividers, default input borders.
- **Control Disabled** (`#a3a29c`): Disabled controls and inactive icon strokes.
- **Ink Tertiary** (`#6b6a64`): Captions, the recovery-phrase word index, status text.
- **Ink Secondary** (`#3a3934`): Secondary body copy, sidebar non-active items.
- **Ink Primary** (`#1a1a17`): Primary body copy, headings, the editor text. Warm-shifted near-black, never `#000`.
- **Ink Display** (`#0b0b09`): High-emphasis display type only.

### State (functional, never decorative)
- **Brick Danger** (`#8a2a23`, soft `#f5e7e5`): Recovery-phrase mismatch, sync error, irreversible-warning copy. A muted brick, not a fire-engine red.
- **Ochre Warning** (`#8a6a1f`, soft `#f5efde`): Soft warnings (clipboard timeout, autosave conflict). An ochre, not a school-bus yellow.
- **Forest Success** (`#2f6048`, soft `#e3eee8`): The very few places a green is needed (vault unlocked, file imported). A forest, not a kelly green. **Never** rendered as a checkmark badge on encrypted-status surfaces.

### Named Rules

**The One Accent Rule.** Iron-blue is the only chromatic color in any UI region except a state surface. Anywhere you reach for "another color for visual interest", you are wrong; reach for typography, density, or whitespace instead.

**The Anti-Privacy-Theme Rule.** No lock icon, no shield icon, no green checkmark badge anywhere on the product surface. Encryption status is communicated typographically (a small caption "Encrypted, synced 12s ago" in ink-tertiary), never with chrome.

**The Warm-Black Rule.** Use `#1a1a17`, never `#000`. Use `#fbfbfa`, never `#fff`. The 1% chroma toward warm shifts the surface from "screen" to "paper" and is the single most identity-defining choice in the system.

## 3. Typography

**Display Font:** Inter Variable (with `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif` fallback)
**Body Font:** Inter Variable (same)
**Mono Font:** JetBrains Mono Variable (with `ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace` fallback)

Both webfonts are self-hosted under `public/fonts/` (`InterVariable.woff2`, `JetBrainsMono.woff2`); reproducible builds preclude CDN imports.

**Character.** Inter Variable carries the entire UI: clean, neutral, optical-margin balanced, comfortable from 11px labels up to 48px display. JetBrains Mono carries every cryptographic identifier: it has a true slashed zero with `ss02`, disambiguates `0/O 1/lI/!`, and renders ligatures with `calt` so adjacent symbols compose cleanly. There is no serif anywhere in the system; a serif voice would feel editorial, and Myne is a notes app, not a magazine.

### Hierarchy

- **Display** (semibold 600, 48px, line-height 1.15, letter-spacing -0.015em): Hero headlines on marketing-adjacent surfaces only. Almost never appears in product chrome.
- **Headline** (semibold 600, 36px, line-height 1.15, letter-spacing -0.015em): Section titles on the welcome screen, vault-creation step headings.
- **Title** (semibold 600, 28px, line-height 1.3, letter-spacing -0.015em): Page titles inside the app, modal headings.
- **Body** (regular 400, 14px, line-height 1.5): The desktop client default. Tauri WebView baseline; comfortable for sustained reading. Cap line length at 65–75ch in any prose surface.
- **Body Large** (regular 400, 16px, line-height 1.65): Onboarding copy, recovery-flow prose, anywhere the message needs to land carefully.
- **Caption** (regular 400, 13px, line-height 1.5, ink-tertiary): Captions, helper text, status text.
- **Label / Eyebrow** (semibold 600, 11px, line-height 1.5, letter-spacing 0.08em, uppercase, ink-tertiary): The only place the system uses uppercase. Eyebrow tags above primary blocks; nothing else gets all caps.
- **Mono** (regular 400, 14px, line-height 1.4, `ss02 + zero + calt`): Code spans, fingerprints, file paths.
- **Mono Large** (regular 400, 18px, line-height 1.4): Recovery-phrase word display.
- **Account Number** (medium 500, 16px, line-height 1.4, letter-spacing 0.04em, `ss02 + zero + calt`): The signature treatment for `MY-XXXX-XXXX-XXXX-XXXX-XXXX` (27 characters — `MY-` plus five 4-char Crockford groups; `docs/spec/account-number.md` §2). Always non-breaking hyphens (U+2011), `user-select: all`. Truncates to `MY-XXXX-...-XXXX` only in the sidebar account chip.

### Named Rules

**The Mono-for-Crypto Rule.** Every value a human types or compares by eye, account numbers, recovery-phrase words, key fingerprints, hash prefixes, file paths, renders in JetBrains Mono with `ss02` and `zero` on. Sans-serif is forbidden for these identifiers because the slashed zero is load-bearing for hand-typed Crockford-base32.

**The Sentence-Case Rule.** Buttons, headings, menu items, modal titles: sentence case. "Save note", not "Save Note". Title case is reserved for proper nouns (Myne, Argon2id, BIP-39, XChaCha20-Poly1305, Crockford-base32, Tauri). Acronyms stay in caps (E2EE, AEAD, KDF, AAD).

**The No-Hype-Words Rule.** "Military-grade", "bank-level", "unbreakable", "ultra-secure", "next-gen": forbidden in every type role. The threat model speaks for the product; marketing language inserted into the type system would expose the system as advertising rather than tooling.

## 4. Elevation

The system is **flat by default**. Surfaces at rest carry no shadow. Depth is communicated by tonal layering: the warm-paper ramp (`#fbfbfa` → `#f4f4f2` → `#ecebe7`) does the work that elevation does in a Material system. A "card" in Myne is just a `--paper-2` rectangle with a 1px hairline; it does not float.

Shadows exist only on transient overlays. They communicate "this layer is above the page", not "this card is important".

### Shadow Vocabulary

- **shadow-1** (`box-shadow: 0 1px 0 rgba(11,11,9,0.04), 0 1px 2px rgba(11,11,9,0.06)`): Tooltips only.
- **shadow-2** (`box-shadow: 0 2px 4px rgba(11,11,9,0.06), 0 4px 12px rgba(11,11,9,0.08)`): Dropdown menus, toasts.
- **shadow-3** (`box-shadow: 0 8px 16px rgba(11,11,9,0.08), 0 16px 40px rgba(11,11,9,0.12)`): Command palette and modal dialogs only.

Dark theme uses the same vocabulary with deeper alpha values (`rgba(0,0,0,0.4..0.6)`).

### Named Rules

**The Flat-Editor Rule.** The editor surface and any pane inside the editor (sidebar, backlinks pane, status bar) carry no shadow. Adding a shadow to a pane is a category error; the editor is paper, and paper does not float over itself.

**The No-Glass Rule.** No `backdrop-filter`, no `filter: blur()`, no vibrancy, no glassmorphism. Tauri 2 supports it on macOS; the system declines on purpose. The only translucent surface in the entire product is the modal scrim (`rgba(11,11,9,0.4)` light, `rgba(0,0,0,0.6)` dark), and it has no blur.

**The No-Card-Stripe Rule.** A card is never communicated by a colored left-border accent. Cards earn distinction from the `--paper-2` fill and the `--line-1` hairline only. If a card needs to communicate state, an eyebrow label inside does the work.

## 5. Components

Lucide stroke icons throughout (`https://lucide.dev`), copied locally to `docs/design/icons/` so the desktop client works offline and reproducible builds stay reproducible. 1.5px stroke at 24px canonical size, 16px in dense rows. `currentColor` always; icons inherit text color and are never colored independently.

### Buttons

- **Shape:** rounded medium (6px). Pill radius is reserved for status pills; small radius (3px) is reserved for inputs and chips.
- **Primary:** iron-blue background (`#2c4a7a`), white text (`#ffffff`), 14px Inter, 10px×16px padding. Hover shifts the background to `#233b62`, press to `#1b2e4d`. A 1px inset shadow is acceptable on press; **no scale or translate transforms**, the product is not playful. Focus ring is the standard 2px iron-blue stroke with a 1px paper offset.
- **Secondary:** warm-paper background (`#fbfbfa`), ink-primary text (`#1a1a17`), 1px hairline border (`#e3e2dd`), same padding. Hover background shifts to `#ecebe7`.
- **Ghost:** transparent background, ink-secondary text, no border. Used in dense toolbars only.
- **Disabled:** opacity 0.4, control-disabled stroke for icons, no hover.

### Inputs

- **Shape:** rounded small (3px).
- **Default:** warm-paper background (`#fbfbfa`), ink-primary text, 1px divider border (`#c8c7c1`), 8px×12px padding, 14px Inter.
- **Focus:** the standard 2px iron-blue ring with a 1px paper offset. The border itself does not change color; the ring is the focus signal.
- **Error:** brick-danger border (`#8a2a23`); the ring stays iron-blue. Error message renders below in caption-size brick-danger text, paired with the `circle-alert` icon.
- **Disabled:** opacity 0.4, control-disabled border.

### Cards

- **Corner Style:** rounded medium (6px).
- **Background:** warm-paper recessed (`#f4f4f2`).
- **Shadow Strategy:** none. Flat at rest. See `## 4. Elevation`.
- **Border:** 1px hairline (`#e3e2dd`). Always full border, never a partial stripe.
- **Internal Padding:** 16px.
- **State communication:** an eyebrow label (label type role, 11px uppercase) inside the card. Never a colored left-border accent.

### Sidebar Item

- **Shape:** rounded small (3px).
- **Default:** warm-paper background, ink-secondary text, 8px×12px padding, 32px height (the system is for sustained reading, not compact dashboarding).
- **Hover:** warm-paper-pressed background (`#ecebe7`), ink-primary text. No transform.
- **Active:** iron-blue-soft background (`#e8edf5`), iron-blue text (`#2c4a7a`). The only place iron-blue appears as a fill outside of primary buttons.

### Status Pill

- **Shape:** pill (999px).
- **Background:** warm-paper recessed; **never** a state color as fill. State pills express their state through an inline icon and label, not through the pill background. A "Sync error" pill is warm-paper recessed with a brick-danger `circle-alert` icon and ink-tertiary "Sync error" text.

### Account Number (signature component)

The most distinctive visual element in the product. Renders as `MY-XXXX-XXXX-XXXX-XXXX-XXXX` in JetBrains Mono medium 16px with letter-spacing 0.04em — 27 characters, the `MY-` prefix plus five 4-char Crockford groups, the last of which ends in the Damm-32 check character (`docs/spec/account-number.md` §2). Size input fields and chips for the full 27; the truncated `-X` schematic that appears in older prose is illustrative shorthand, not the display form. Hyphens are non-breaking (U+2011) so the value never wraps mid-group. `user-select: all` so a single click selects the whole value. The slashed zero (`ss02 + zero` features) is mandatory because the value is hand-typed from another device. In the sidebar account chip, truncates to `MY-XXXX-...-XXXX` (first group + last group); everywhere else, full form.

### Recovery Phrase Word

The 24 BIP-39 words render in a 4×6 grid. The index number (1–24) sits to the left in ink-tertiary mono-small; the word itself is ink-primary mono-large. The word window covers itself when the OS reports window blur, so a quick minimize hides the phrase from anyone who walks past. Both behaviors are normative.

### Modal

Used only when an inline progressive disclosure is genuinely impossible. Background warm-paper recessed, `rounded-lg` (10px), `shadow-3` only. The scrim is a flat dim rectangle (`rgba(11,11,9,0.4)` light, `rgba(0,0,0,0.6)` dark) with no blur. Modal entry crossfades over 260ms with the standard ease-out cubic.

## 6. Do's and Don'ts

### Do
- **Do** treat Penpot as the canonical design source. Every screen ships from Penpot to code, never the reverse. When code and Penpot disagree, run `scripts/penpot-diff.sh` (see `docs/dev/penpot-design-diff.md`) and fix the side that is wrong.
- **Do** use OKLCH-style descriptive names in token discussions ("warm paper", "iron blue", "brick danger") rather than hex-code references in copy. The hex values are normative; the names are what humans use.
- **Do** render every cryptographic identifier (account numbers, recovery-phrase words, key fingerprints, hash prefixes) in JetBrains Mono with `ss02` and `zero` features on.
- **Do** use the standard 2px iron-blue ring with a 1px paper offset for `:focus-visible` on every interactive element. The ring is always visible; never removed.
- **Do** use sentence case everywhere. "Save note", not "Save Note". Title case is reserved for proper nouns (Myne, Argon2id, BIP-39, XChaCha20-Poly1305, Crockford-base32, Tauri).
- **Do** communicate state with an icon plus a text label, never with color alone.
- **Do** keep motion under 260ms with exponential ease-out cubic curves. Disable transitions globally under `prefers-reduced-motion`.
- **Do** ship `border-radius: 6px` on buttons and cards as the workhorse; 3px on inputs and chips; 10px on the command palette and modals; pill on status pills.
- **Do** keep neutrals warm-shifted: `#fbfbfa` not `#fff`, `#1a1a17` not `#000`. The 1% chroma is identity-defining.

### Don't
- **Don't** use a lock icon, shield icon, or green checkmark badge anywhere on the product surface. The Myne mark is not a padlock; encryption status is typography, not chrome.
- **Don't** ship a card with a colored left-border accent. Banned outright; full border or nothing.
- **Don't** use `backdrop-filter`, `filter: blur()`, vibrancy, or glassmorphism on any surface. The only translucent element in the product is the modal scrim, and it has no blur.
- **Don't** apply gradients to text or backgrounds. Single solid colors only; emphasis via weight and size.
- **Don't** ship a hero-metric SaaS template (big number + small label + supporting stats + gradient accent). Cliché, banned.
- **Don't** ship identical card grids of "icon + heading + paragraph" repeated endlessly.
- **Don't** ship stock photography of people: hands on keyboards, "diverse team in glass conference room", smiling laptop owners. None of it.
- **Don't** use emoji as iconography in the product. Lucide stroke icons only, `currentColor`.
- **Don't** write "military-grade", "bank-level", "unbreakable", "ultra-secure", "next-gen" anywhere in the type system. Hype words are forbidden across every surface.
- **Don't** write "Welcome back, friend!" or "Connecting securely..." copy. The voice is "careful engineer to careful engineer", not privacy salesperson.
- **Don't** use looping animations: no pulsing encrypted-status indicator, no marching-ants focus border, no spring physics, no bouncing easings. The product is calm, never twitchy.
- **Don't** add a shadow to the editor surface or to a pane inside the editor. Shadows are reserved for transient overlays (command palette, dropdowns, toasts, tooltips).
- **Don't** use `#000` or `#fff` literally. Always tint toward the warm neutral ramp.
- **Don't** reach for a modal as the first interaction pattern. Inline and progressive alternatives first; modals only when there is genuinely no other shape.
