# src/ — React UI (Tauri WebView)

> Subdirectory CLAUDE.md. Loaded when Claude reads files here. See repo-root `CLAUDE.md` for project-wide context.

## Stack

- React 19 + TypeScript (strict mode + `noUnusedLocals` + `noUnusedParameters`)
- Vite (port 1420 hard-pinned via `strictPort`; `clearScreen: false` to keep Rust errors visible)
- pnpm — never npm/yarn (Tauri lifecycle hooks expect pnpm)
- **No Tailwind, no CSS Modules, no styled-components.** Inline `style={{}}` + design tokens. Per `decisions.md` 2026-04-26 reproducible-build minimal-deps commitment.

## Design tokens (canonical source)

`docs/design/colors_and_type.css` is loaded globally. **Use CSS variables, not hex codes:**

```tsx
// ✅ correct
<div style={{ background: "var(--bg-1)", color: "var(--fg-2)", fontFamily: "var(--font-mono)" }} />

// ❌ wrong
<div style={{ background: "#0a0a0a", color: "#888" }} />
```

Available tokens include `--bg-1`/`--bg-2`, `--paper-1`/`--paper-2`, `--fg-1`/`--fg-2`/`--fg-3`, `--line-1`, `--font-sans`, `--font-mono`. Dark mode coverage is inherited automatically.

Self-hosted fonts: Inter Variable + JetBrains Mono in `public/fonts/` (commit 40eab75). Don't add Google Fonts CDN — adds tracking + breaks reproducibility.

## Internationalization (i18n)

User-facing strings go through **react-i18next**, not hardcoded JSX. Source language is **English**; catalogs live at repo-root `locales/<lang>/common.json` and are bundled statically by `src/i18n/index.ts` (no HTTP backend). Translations are managed in self-hosted **Weblate** — see `docs/dev/i18n.md` for the full workflow and `decisions.md` 2026-06-25 for the rationale.

- In components: `const { t } = useTranslation();` → `t("welcome.createCta")`. Outside React: `import i18n from "src/i18n"` → `i18n.t(...)`.
- Add a key → `pnpm i18n:extract` → fill the **English** value in `locales/en/common.json`. Never hand-edit non-English catalogs (Weblate owns them).
- **Do NOT i18n load-bearing copy** (`src/lib/load-bearing-copy.ts`): its exact English wording is a privacy property and is E2E-pinned by literal equality. Render the constant verbatim in every locale.
- **Module-level data (command catalogs, label maps, error maps): store i18n KEYS, resolve with `t()`/`i18n.t()` at the render/usage consumer — never freeze a resolved string at module top level** (it would capture the boot language and not react to a language switch). `main.tsx` imports `./i18n` first so module-level `i18n.t()` (called at usage time) resolves against loaded resources.
- Status: **Comprehensive** — the whole desktop UI is migrated (~1300 strings, ~139 files, en catalog ≈1500 keys). When you add a user-facing string, add its `t()` key in the same change (`pnpm i18n:extract`, fill the English value in `locales/en/common.json`).

## Layout

```
src/
├── App.tsx              ← top-level stage union (welcome / create-vault / unlock / editor / recover)
├── main.tsx             ← React 19 root mount
├── screens/             ← top-level screens (one per stage)
│   ├── CreateVault.tsx
│   ├── Editor.tsx       ← B4.5 placeholder; full CodeMirror = Lane B #10 (B5). Hosts SettingsModal mount.
│   ├── Unlock.tsx       ← password form + reducer (idle / decrypting / corrupted modes); renders SuspicionBanner when stage carries one
│   ├── VaultRecover.tsx
│   ├── Welcome.tsx
│   ├── vault-creation/  ← multi-step flow (PasswordStep, PhraseStep, ConfirmStep, ...)
│   └── vault-recover/   ← recover-from-phrase flow
├── components/          ← reusable UI primitives
│   ├── primitives/      ← Button, Input, Icon, CenteredCard, MyneMark, ModalShell (shared modal carve-out chrome)
│   ├── BlockingProgressStep.tsx
│   ├── DestructiveBanner.tsx
│   ├── ErrorBanner.tsx
│   ├── FailClosedError.tsx  ← shared fail-closed UI (reason: invalid-state | corrupted-vault | io-error)
│   ├── PasswordChangeForm.tsx  ← 3-input form (current + new + confirm) used by Settings → Account
│   ├── PasswordCreateForm.tsx  ← 2-input form (new + confirm) used by vault-creation + vault-recover (renamed from PasswordForm.tsx)
│   ├── PasswordInput.tsx       ← single-field primitive: Input + eye toggle + optional zxcvbn meter slot; exports MIN_PASSWORD_LEN/MIN_ZXCVBN_SCORE + usePasswordStrength hook
│   ├── PasswordStrength.tsx
│   ├── SettingsModal.tsx       ← Settings shell modal (6-panel rail; carve-out per decisions.md 2026-05-08, taxonomy superseded — Editor panel added)
│   ├── TemplatesManager.tsx    ← Note-template management modal (MYND-189; modal carve-out, opened by the "Manage templates…" palette action)
│   ├── settings/               ← per-panel content components rendered by SettingsModal
│   │   ├── AboutPanel.tsx
│   │   ├── AccountPanel.tsx
│   │   ├── AppearancePanel.tsx  ← purely-visual controls (theme / custom theme)
│   │   ├── EditorPanel.tsx      ← note-authoring behaviour (spell-check + daily-notes); composes SpellSettings + DailyNotesSettings
│   │   ├── PrivacyPanel.tsx
│   │   └── StoragePanel.tsx
│   ├── Spinner.tsx
│   ├── SuspicionBanner.tsx     ← red/informational banner driven by Stage.unlock.suspicionReason
│   └── Toast.tsx               ← post-event notification (auto-dismiss 2.5s); used by Editor for "Parola güncellendi"
├── lib/                 ← non-UI helpers
│   ├── app-window.ts             ← closeApp() helper for fail-closed CTAs
│   ├── bip39-normalize.ts
│   ├── icons.ts
│   ├── io-banner.ts
│   ├── notes.ts
│   ├── password-generator.ts
│   ├── secret-export.ts
│   ├── stage.ts                   ← Stage / Action discriminated unions + transition() + dev harness; carries optional suspicionReason on the unlock variant
│   ├── vault-change-password.ts   ← changePassword() IPC wrapper (MYND-22 backend)
│   ├── vault-creation-errors.ts
│   ├── vault-creation-logging.ts
│   ├── vault-recover.ts
│   ├── vault-slot-kind.ts
│   ├── vault-status.ts            ← probeVaultStatus() boot probe wrapper
│   └── vault-unlock.ts            ← isVaultUnlocked() + lockVault() wrappers
├── styles/              ← global CSS only
├── types/               ← shared TS types (mirrors Rust error enums)
└── vite-env.d.ts        ← Vite client types + __APP_VERSION__ compile-time global (sourced from package.json::version, displayed by Settings → About)
```

## Tauri command bindings

**No mock layer.** Plan 2 §B1 originally called for a `VITE_USE_MOCK_BACKEND` mock layer; it was skipped. Real Tauri commands are called directly from `src/lib/`. Risk: signature drift between Rust `#[command]` definitions and TS callers has no canary. `tauri-specta` (or equivalent codegen) is on the radar — see Furkan's todo `[B1]` (status `⏸`).

When you add a new Tauri command on the Rust side, manually mirror the signature in the matching `src/lib/<flow>.ts` file. Keep types in `src/types/` so a second consumer can reuse them.

## Vault creation flow (B3a/B3b shipped)

`src/screens/vault-creation/` is the canonical multi-step example:
- Reducer + Action union state machine (no zustand here yet)
- Per-step components (BriefingStep, PasswordStep, PhraseStep, ConfirmStep, AccountStep, ReadyStep, SessionLostStep, EncryptingStep)
- **BriefingStep is first-run-only (MYND-114):** the pre-vault-create safety briefing (3 acknowledged statements + opt-in "Why?" disclosures gating "Continue to vault creation"). It is the reducer's initial step ONLY when `CreateVault` is mounted with `withBriefing` — set by App.tsx from the `create-vault` stage's `briefing` flag, which the `welcome → create-vault.start` transition sets and the picker/switcher "create another" entries leave unset. `BRIEFING_ACKED` advances briefing → password; `RESET_TO_PASSWORD`/`RESET` always land on `password` (the one-time briefing is never re-shown mid-flow). Its acknowledgement/disclosure state is local to the component (the step is never re-entered via back-nav — "Back" exits through the reprobe path). Tone is load-bearing: honest, not alarming — no red banners, no alarm icons (PRODUCT.md).
- Window-blur cover on PhraseStep (phrase visible → minimize covers it)
- BIP-39 wordlist autocomplete with exact-match required on ConfirmStep
- ReadyStep "Done" triggers auto-unlock chain (`commit` → `vault_unlock` → editor) per `decisions.md` 2026-05-02 — supersedes 2026-04-29 entry's slot-population implication. `passwordRef` lifetime extended through phrase/confirm/account/ready until auto-unlock resolves; wiped on every exit path (BEGIN_ERR / COMMIT_ERR / SESSION_LOST / RESET_TO_PASSWORD / unmount / auto-unlock resolve).

When building the next multi-step flow (recovery — separate PR), reuse this structure.

## Empty editor shell (B4.5 shipped, placeholder)

`src/screens/Editor.tsx` is a textarea-based placeholder — no save, no CodeMirror, no autosave. Full editor lands in B5 (`@uiw/react-codemirror` + markdown language pack). Layout:
- Outer flex column
- Row of three panes (left sidebar + center pane + right sidebar)
- 28 px bottom bar
- Section heading style + status text style extracted as `CSSProperties` constants (`SECTION_HEADING_STYLE`, `STATUS_TEXT_STYLE`)
- Center toolbar height 38 px; textarea minHeight 360; padding 32px 64px on scroll container, maxWidth 680 inner

Don't ship features against this placeholder — wait for B5.

## App shell (MYND-80 full state machine + route guards)

`src/App.tsx` uses the full Stage discriminated union (`{ name: "welcome" } | { name: "create-vault" } | { name: "unlock"; initialStatus } | { name: "editor" } | { name: "recover"; subStep }`) — the v0.1 definition of "routing" (no URL/history-aware router). Pure `transition(prev, action): Stage` function in `src/lib/stage.ts` enforces legal source/target combinations; illegal pairs return `prev` unchanged + dev `console.warn`. Boot starts in `null` (loading shim) until `vault_status` IPC probe resolves; `initialStageFromProbe(result)` maps Ok(Missing)→welcome, Ok(Exists)→unlock(Exists), Ok(Corrupted)→unlock(Corrupted), Err(IoError)→unlock(IoError). User-initiated `editor.lock` lands directly on `unlock(Exists)` — no intermediate "vault locked" screen (MYND-131). Lock-on-idle (auto-lock on idle timer) is **explicitly out of scope** for Phase 1 per `src-tauri/src/plugins/vault_unlock/state.rs` Phase 2+ docstring — there is no Phase 1 writer for `last_activity`, so a stub here would be dead code.

Belt+suspenders invalid-state guard (Q5β-1 of `app-state-machine` grill): `transition()` is React-side defense; `Editor` mount probes `vault_is_unlocked()` at mount as the Rust-side reality check, rendering `<FailClosedError reason="invalid-state" />` if React Stage and Rust slot disagree. The "Kilitle" CTA on that error UI calls `vault_lock` + reprobe via `App.tsx::reprobe()` (out-of-band reset; bypasses transition fn intentionally).

No dev-only stage shortcut: any `?test-stage=` URL parameter has no effect. Per `app-state-machine` PRD + MYND-80 acceptance, dev cannot bypass production guards.

### `Stage.unlock.suspicionReason?` field (MYND-87 + MYND-107)

The `unlock` variant carries an optional `suspicionReason` payload — `"vault-meta-changed-externally" | "vault-locked-during-change"`. It is a one-shot signal carried from change-password force-relock paths to the resulting Unlock screen banner; never produced by `initialStageFromProbe()` (boot probe), only by explicit `setStageWithSuspicion()` calls from `App.tsx`. The `LEGAL` transition table tracks `name` only (not payload), so the field doesn't affect legality. **Dev-harness lockstep:** `ALL_STAGES_FOR_VERIFICATION` includes at least one `unlock` entry with `suspicionReason` populated so `verifyTransitionTable()` covers the variant. Adding a third reason value requires a matching `ALL_STAGES_FOR_VERIFICATION` entry. Rationale + provenance: `docs/decisions.md` 2026-05-08 "`Stage.unlock.suspicionReason?` field for change-password force-relock signals".

## Settings shell (MYND-87 + MYND-107)

The Settings UI is **not** a Stage variant. It mounts as a modal overlay inside `Editor.tsx` driven by Editor-local React state (`settingsOpen` boolean), per the desktop modal carve-out in `docs/decisions.md` 2026-05-08. Entry points: gear button in BottomBar's right cluster + `Cmd+,` / `Ctrl+,` keyboard shortcut. Both toggle `settingsOpen`; `<SettingsModal open onClose>` only renders when true.

`SettingsModal.tsx` owns the 6-panel rail (Account → Privacy → Editor → Appearance → Storage → About). The taxonomy was first locked at 5 panels by `decisions.md` 2026-05-08; the **Editor** panel was added by a superseding `decisions.md` entry, which also scoped Appearance down to purely-visual controls (spell-check + daily-notes moved from Appearance to Editor — they are note-authoring behaviour, not appearance). Panel content components live in `src/components/settings/`; the Editor panel (`EditorPanel.tsx`) is a thin composition of `SpellSettings` + `DailyNotesSettings`. Rail navigation: ↑/↓ arrows cycle (with focus management via per-panel refs); click sets selection. Default panel: Account.

**In-flight gating (Q9 of the grill):** Settings's only Argon2id-bound IPC today is `vault_change_password`. During the ~1-3s window, AccountPanel calls `onInFlightChange(true)` which gates the parent's Esc / backdrop / × dismissal handlers (the user must wait for the backend response). The Editor's BottomBar Lock button stays enabled — firing `vault_lock` during in-flight is the canonical graceful-cancel path; backend returns `VaultLockedDuringChange` which routes through `setStageWithSuspicion()` → Unlock screen with informational `SuspicionBanner`.

**Force-relock plumbing:** AccountPanel's change-password error handler pattern-matches on `VaultChangePasswordError` variants: `InvalidVaultMeta` → `setStageWithSuspicion({kind:"Corrupted"})`; `VaultMetaChangedExternally` → `setStageWithSuspicion({kind:"Exists"}, "vault-meta-changed-externally")`; `VaultLockedDuringChange` → `setStageWithSuspicion({kind:"Exists"}, "vault-locked-during-change")`. Modal closes via Editor unmount cascade after Stage transitions away from `editor`.

**Disabled-control discipline:** disabled toggles / buttons in Privacy / Appearance / Storage / About panels carry **real labels**, not "Coming soon" copy. Each disabled control corresponds to a tracked Plane work item and enables on the same PR that lands the backing feature. This is **distinct** from MYND-130's `ComingSoonPill` removal — that was a marketing-style hope label on a Phase-2+ scope; these are tracked-feature stubs. Don't reflexively delete them. Rationale: `docs/decisions.md` 2026-05-08 "Desktop modal carve-out + Settings 5-panel taxonomy + disabled-control discipline".

## Note templates (MYND-182 epic)

Templates are ordinary `.myn` notes carrying a value-strict `template: true`
frontmatter flag (the inverse-visibility twin of `trashed:`; `markdown-dialect.md`
§3.6.1). Surfaces and patterns added by the epic:

- **Management surface** (`components/TemplatesManager.tsx`): a modal-class
  surface mounted from `Editor.tsx` via an Editor-local boolean (`templatesOpen`)
  — the **same desktop modal carve-out as SettingsModal**, NOT a Stage variant,
  NOT a 6th Settings panel, NOT a sidebar surface. Opened by the
  `templates.manage` command-palette action ("Manage templates…", `editor`-stage
  guarded) → `CommandContext.onManageTemplates` → `setTemplatesOpen(true)`.
  Lists `listTemplates()` (the `template: true` filter, trashed excluded); row
  actions map 1:1 to the SYNC-9 surface in `src/notes/templates.ts` — New
  (`createTemplate` → open in editor), Edit (row click → open), Remove from
  templates (`convertTemplateToNote`, non-destructive), Delete (`deleteTemplate`
  → soft-trash, recoverable). Esc / backdrop / close dismiss; first-run empty
  state (start-empty, no seeding). Design canon: Penpot page "4 — Desktop UI
  Kit", `screen------templates--manage` frames.
- **`{{` token autocomplete** (`editor/template-tokens/plugin.ts`): a CM6
  ViewPlugin modeled on `editor/slash/plugin.ts`, composed in `editor/extensions.ts`
  alongside the slash menu. **Active only inside a `template: true` note** (reads
  the doc's own frontmatter via `cachedLocateFrontmatter` + the dialect's
  value-strict `readTemplateFromFmBody`) — in an ordinary note `{{date}}` stays
  literal. It is **closeBrackets-aware** (detects `{{` before the cursor robustly,
  and consumes a trailing auto-closed `}}` on insert so the result is one clean
  `{{token}}`). Menu items come from the engine's `SUPPORTED_TOKENS`
  (`dialect/templateEngine.ts`) — **never hard-coded here**, so adding a token to
  the engine surfaces it with no second edit site. Inserting only inserts the
  token text; it never evaluates (anti-scripting, SYNC-6-R).
- **Variable engine TS mirror** (`dialect/templateEngine.ts`): the Phase-1
  desktop runtime engine (`renderTemplate` + `SUPPORTED_TOKENS`), a hand-mirror
  of the canonical Rust engine `protocol/src/template.rs` (the spec/wasm-future
  source). The hand-mirror reaches the engine WITHOUT a Tauri command crossing
  the WebView boundary — same Rust↔TS discipline as `MIN_PASSWORD_LEN`
  (drift-check is the follow-up safety net; both sides pinned by equivalent tests).

## Test observability (E2E contract — SYNC-8)

The real-IPC E2E suites (`e2e/`, see `e2e/CLAUDE.md` + `docs/dev/e2e.md`)
locate everything by `data-testid`. **A screen without testids is invisible to
E2E — adding a user-facing flow means adding its testid pass in the same
change.**

- Naming: `<screen>.<element>` (`unlock.password-input`, `picker.vault-row`,
  `create.phrase-grid`). Repeated rows carry a discriminator attribute
  (`data-vault-id`, `data-index`); booleans as `data-*` strings
  (`data-revealed`, `data-active`). Never put anything beyond the SYNC-7
  pre-unlock leak budget into a `data-*` attribute.
- Curated-prop components take an explicit `testId` / `testIdPrefix` prop
  (`PasswordInput`, `PasswordCreateForm`'s `tid()` helper, `DestructiveBanner`,
  `BlockingProgressStep`) — no rest-spread escape hatches for styling.
- **Load-bearing user-facing copy lives in `src/lib/load-bearing-copy.ts`**
  (non-distinguishing banners etc.). Production renders the constant; E2E
  asserts it by full-literal equality. Don't inline-duplicate such strings.

## Common commands

```bash
pnpm install
pnpm dev                # Vite only — useful when testing UI in isolation
pnpm tauri dev          # full app (Vite + Rust core)
pnpm build              # tsc typecheck + vite build → dist/
pnpm test:e2e           # E2E suites — Linux-only; on macOS use ./scripts/e2e-local.sh
```

## Gotchas

- **`tauri-apps/api` window methods don't exist on web.** If you reference `getCurrentWindow()` in a component that might render outside Tauri context, wrap in a try/catch or feature-detect. Vault creation's window-close prompt does this implicitly via `useEffect` cleanup (listener unmounts on stage change).
- **CSS variables don't work in inline `style={{}}` for some quirky props** (e.g., `background-image: linear-gradient(...)`). Test the rendered output before assuming the var resolved.
- **React 19 strict-mode double-render** in dev is real. Effects run twice; design with idempotency.
- **No `unsafeAllowedHosts`** in Vite config — keep it that way (TB6 attack surface).
- **`locales/en/common.json` is NOT alphabetically ordered — never sort it.** A `json.load` → sort → `json.dump` round-trip reformats ~580 lines and buries a 10-line addition in an unreviewable diff. Insert new keys **positionally**, next to their nearest sibling, and verify with `git diff --stat`: a correct edit here is additions-only. (Round-tripping with `json.dumps(indent=2, ensure_ascii=False) + "\n"` reproduces the file byte-for-byte, so the formatter itself is safe — only re-ordering is not.)
- **A new preference field has far more registration sites than the three you'd expect.** Beyond the Tauri command + `build.rs` permission list + capability `[[permission]]` block, it also needs: the `PrefsView` struct, canonical encoder and parser (`protocol/src/prefs.rs`); a row in the sync classification table **plus** its exhaustive destructure **plus** `ALL_FIELDS` (three edits in one file — the destructure is a deliberate compile-time drift lock); the merge passthrough; every `PrefsView` literal across the test modules; the TS type, setter and `usePrefs` default; and the field roster in `docs/spec/protocol.md` §9.5.2. The Rust compiler finds every Rust one; nothing but `tsc` finds the TS ones, and **nothing at all** finds the spec one.
