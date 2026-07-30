# src/ — React UI (Tauri WebView)

> Subdirectory CLAUDE.md. Loaded when Claude reads files here. See repo-root `CLAUDE.md` for project-wide context.

## Stack

- React 19 + TypeScript (strict mode + `noUnusedLocals` + `noUnusedParameters`)
- Vite (port 1420 hard-pinned via `strictPort`; `clearScreen: false` to keep Rust errors visible)
- pnpm — never npm/yarn (Tauri lifecycle hooks expect pnpm)
- **No Tailwind, no CSS Modules, no styled-components.** Inline `style={{}}` + design tokens. Per `decisions.md` 2026-04-26 reproducible-build minimal-deps commitment.

## Design tokens (canonical source)

`src/styles/tokens.css` is the sheet the app actually loads — `main.tsx` imports it and it is the only global CSS in the tree. The design-subtree copy, `docs/design/colors_and_type.css`, is a **subset of it, not a mirror**: the two agree name-for-name and value-for-value on `:root` and `:root[data-theme="dark"]`, and the design copy stops there. It has no `:root[data-theme="amoled"]` block (the third theme the app ships, ~50 tokens), no `--selection-bg`, and none of the app-only globals `tokens.css` also carries (box-sizing reset, the `:focus-visible` ring, the spinner, the editor-chrome and reduced-motion rules). Nothing in either client loads the design copy: it is read by the `docs/design/` preview pages (`ui_kits/desktop/index.html`, `website/index.html`, and `preview/_card.css`'s `@import`) and by the specs that parse it for token values — `tests/a11y/contrast.test.ts` and `tests/a11y/focus-ring.test.ts` today; more specs under `tests/` *name* the file in a comment while reading `src/styles/tokens.css`, so a bare grep over-reports. Edit `src/styles/tokens.css` to change what ships, and keep the blocks the design copy does carry in step in the same change. **Use CSS variables, not hex codes:**

```tsx
// ✅ correct
<div style={{ background: "var(--bg-1)", color: "var(--fg-2)", fontFamily: "var(--font-mono)" }} />

// ❌ wrong
<div style={{ background: "#0a0a0a", color: "#888" }} />
```

Available tokens include the surface ramp `--paper`/`--paper-2`/`--paper-3` (semantic aliases `--bg-1`/`--bg-2`/`--bg-3`), the ink ramp `--ink-1`…`--ink-3` (aliases `--fg-1`/`--fg-2`/`--fg-3`), `--line-1`/`--line-2`/`--line-3`, `--font-sans`, `--font-mono`. **There is no `--paper-1`** — the light end of the surface ramp is plain `--paper`, and `var(--paper-1)` resolves to nothing. Dark mode coverage is inherited automatically: the theme blocks re-point the ramps, so the aliases follow.

Self-hosted fonts: Inter Variable + JetBrains Mono in `public/fonts/` (commit 40eab75). Don't add Google Fonts CDN — adds tracking + breaks reproducibility.

## Internationalization (i18n)

User-facing strings go through **react-i18next**, not hardcoded JSX. Source language is **English**; catalogs live at repo-root `locales/<lang>/common.json` and are bundled statically by `src/i18n/index.ts` (no HTTP backend). Translations are managed in self-hosted **Weblate** — see `docs/dev/i18n.md` for the full workflow and `decisions.md` 2026-06-25 for the rationale.

- In components: `const { t } = useTranslation();` → `t("welcome.createCta")`. Outside React: `import i18n from "src/i18n"` → `i18n.t(...)`.
- Add a key → `pnpm i18n:extract` → fill the **English** value in `locales/en/common.json`. Never hand-edit non-English catalogs (Weblate owns them).
- **Do NOT i18n load-bearing copy** (`src/lib/load-bearing-copy.ts`): its exact English wording is a privacy property and is E2E-pinned by literal equality. Render the constant verbatim in every locale.
- **Module-level data (command catalogs, label maps, error maps): store i18n KEYS, resolve with `t()`/`i18n.t()` at the render/usage consumer — never freeze a resolved string at module top level** (it would capture the boot language and not react to a language switch). `main.tsx` imports `./i18n` first so module-level `i18n.t()` (called at usage time) resolves against loaded resources.
- Status: **Comprehensive** — the whole desktop UI is migrated (~1700 `t()` call sites across ~150 files; the en catalog holds ~2500 leaf keys, and `locales/en/common.json` is its source of truth — don't trust a number here over a `pnpm i18n:status` run). When you add a user-facing string, add its `t()` key in the same change (`pnpm i18n:extract`, fill the English value in `locales/en/common.json`).

## Layout

One line per top-level entry. The per-file enumeration this section used to carry cannot be kept true at ~60 files in `lib/` alone — read the directory, and treat the annotations below as "what this is for", not as a roster.

```
src/
├── App.tsx              ← boot probe + the Stage switch (one arm per variant in lib/stage.ts)
├── main.tsx             ← React 19 root mount; imports ./i18n first, then ./editor-host, then <App>
├── editor-host.ts       ← installs the EditorHost seam (IPC + i18n) into @myne/editor before any editor mounts
├── platform/            ← THE PLATFORM SEAM — the only directory allowed to import `@tauri-apps/*`
│                          (one module per Tauri module, substituted at build time for the web client;
│                          `capabilities.ts` + `unsupported.ts` model what a host cannot do). See Gotchas.
├── screens/             ← top-level screens: one per Stage variant, plus the non-Stage takeovers
│                          and the multi-step flow dirs
│   ├── vault-creation/  ← multi-step create flow (BriefingStep, PasswordStep, PhraseStep, ConfirmStep, …)
│   ├── vault-recover/   ← recover-from-phrase flow
│   ├── Editor.tsx       ← the post-unlock workspace chrome + every modal mount (see "Editor screen" below)
│   ├── Unlock.tsx       ← quick-unlock OR password form (one at a time, MYND-558) + reducer (idle / decrypting / corrupted modes); renders SuspicionBanner when stage carries one
│   └── …                ← the remaining Stage variants (Welcome, CreateVault, VaultRecover,
│                          VaultPicker, RestoreBackup, AccountBootstrap — which serves BOTH
│                          account-entry and pending-approval, and composes the web-only
│                          AccountNumberEntry); the two takeovers Editor.tsx mounts rather than
│                          stages the router can reach, StorageLost and DeviceRevoked (see
│                          "Editor screen" below); the web-only dead-end WebNoAccount; and the
│                          layout helpers (editorLayout, centerView, layoutClamp,
│                          responsiveCollapse, titlebar)
├── components/          ← reusable UI + the modal surfaces
│   ├── primitives/      ← Button, Input, Icon, CenteredCard, MyneMark, ModalShell (shared modal carve-out chrome)
│   ├── settings/        ← per-panel content rendered by SettingsModal, plus `search/` (settings-search index + scorer)
│   ├── attachments/ backup/ export/ sync/   ← per-feature component clusters
│   ├── SettingsModal.tsx       ← Settings shell modal (rail roster = its `PANELS` const; carve-out per decisions.md 2026-05-08)
│   ├── TemplatesManager.tsx    ← Note-template management modal (MYND-189; modal carve-out, opened by the "Manage templates…" palette action)
│   ├── CommandPalette.tsx / QuickPicker.tsx / VaultSwitcher.tsx / PairingDialog.tsx / ThemeInstallDialog.tsx
│   ├── FailClosedError.tsx     ← shared fail-closed UI (reason: invalid-state | corrupted-vault | io-error)
│   ├── PasswordChangeForm.tsx  ← 3-input form (current + new + confirm) used by Settings → Account
│   ├── PasswordCreateForm.tsx  ← 2-input form (new + confirm) used by vault-creation + vault-recover (renamed from PasswordForm.tsx)
│   ├── PasswordInput.tsx       ← single-field primitive: Input + eye toggle + optional zxcvbn meter slot; exports MIN_PASSWORD_LEN/MIN_ZXCVBN_SCORE + usePasswordStrength hook
│   ├── RootErrorBoundary.tsx   ← mounted by main.tsx around <App>
│   ├── SuspicionBanner.tsx     ← red/informational banner driven by Stage.unlock.suspicionReason
│   └── Toast.tsx               ← post-event notification (2.5 s auto-dismiss; 6 s when it carries an action)
├── lib/                 ← non-UI helpers + the IPC wrappers: stage.ts (Stage / Action unions + transition()
│                          + dev harness), the vault-*.ts command wrappers, load-bearing-copy.ts, icons.ts, …
├── hooks/               ← cross-screen React hooks (usePrefs, useSyncStatus, useBackupScheduler,
│                          useActivityHeartbeat + useIdleAutoLock — the two auto-lock clocks, …)
├── notes/               ← the notes domain: sidebar, tabs, panes (components/PaneView.tsx is what mounts the
│                          editor), templates, views, import/export
├── commands/            ← command registry + bindable catalog + keybind engine/dispatcher (drives CommandPalette)
├── editor/              ← re-export shim into @myne/editor (repo-root `editor/`) — no logic of its own
├── dialect/             ← re-export shim into @myne/dialect (repo-root `dialect/`) — parser + template engine
├── clip/                ← browser-clipper ingest: envelope validation, clip assembly, host→WebView dispatch listener
├── pdf-export/          ← the script for the hidden PDF-export render window (MYND-255)
├── i18n/                ← react-i18next config + static catalog bundling
├── styles/              ← global CSS only (`tokens.css` — see "Design tokens" above)
├── types/               ← shared TS types (mirrors Rust error enums)
└── vite-env.d.ts        ← Vite client types + __APP_VERSION__ compile-time global (sourced from package.json::version, displayed by Settings → About)
```

### Adding a file here has a roster obligation

Four of those directories are under a web-lane gate that fails on a file with **no verdict** — and fails equally on a verdict with no file, so the roster cannot outlive the tree it describes:

| New file under | Gate | Where it runs |
|---|---|---|
| `src/screens/` | `scripts/check-web-screens.mjs` | CI `web-build` |
| `src/lib/`, `src/hooks/`, `src/components/settings/` | `scripts/check-web-surfaces.mjs` | CI `web-build` |

The fix is one line in the script's verdict table: `ported` (runs on web as written), `adapted` (runs, with the stated difference), or `excluded` (substituted out of the web bundle — which needs a `marker` string the gate then greps `web/dist` for, because "the route is hidden" is not "the code is absent"). Each script's header documents one more for its own domain — `web-only` for screens, `typed-unsupported` for the service layer (reachable, and its backend answers a typed refusal). `check-web-surfaces.mjs --emit` regenerates the checked-in assessment from the same table, so don't hand-edit that document.

Two neighbours in the same family, for the same reason:

- **A new `plugin:<plugin>|<command>` literal anywhere in the shared tree** must be classified in `web/wasm/src/capability.rs` (`DISPATCHED` / `PLUGIN_DEFAULT` / `PER_COMMAND`) in the same change, or `scripts/check-web-command-coverage.mjs` fails — this one in **`pre-commit`** as well as CI, and whole-tree rather than glob-scoped.
- **`scripts/check-web-testids.mjs`** (CI) holds `web/src` plus the two web-only shared screens (`src/screens/AccountNumberEntry.tsx`, `src/screens/WebNoAccount.tsx`) to the testid contract below, including the SYNC-7 rule that no `data-*` on a pre-unlock screen may carry a runtime value.

## Tauri command bindings

**No mock layer.** An early plan called for a `VITE_USE_MOCK_BACKEND` mock layer; it was skipped, and the real commands are invoked straight from `src/lib/` — through `src/platform/core.ts`'s `invoke`, never `@tauri-apps/api/core` directly (see Gotchas). Risk: signature drift between Rust `#[command]` definitions and TS callers has no canary. Codegen (`ts-rs`, per the `TODO(Phase-1-end)` in `src/types/vault-status.ts`) would close that; nothing schedules it yet, so treat the mirror as hand-maintained.

Adding a Tauri command on the Rust side is three edits on this side, and only the third one fails loudly:

1. Mirror the signature in the matching `src/lib/<flow>.ts` wrapper.
2. Keep the request/error types in `src/types/` so a second consumer can reuse them.
3. Classify the new `plugin:<plugin>|<command>` literal in `web/wasm/src/capability.rs` — see "Adding a file here has a roster obligation" above. Skip it and `scripts/check-web-command-coverage.mjs` rejects the commit.

## Vault creation flow (B3a/B3b shipped)

`src/screens/vault-creation/` is the canonical multi-step example:
- Reducer + Action union state machine (no zustand here yet)
- Per-step components (BriefingStep, PasswordStep, PhraseStep, ConfirmStep, AccountStep, ReadyStep, SessionLostStep, EncryptingStep)
- **BriefingStep is first-run-only (MYND-114):** the pre-vault-create safety briefing (3 acknowledged statements + opt-in "Why?" disclosures gating "Continue to vault creation"). It is the reducer's initial step ONLY when `CreateVault` is mounted with `withBriefing` — set by App.tsx from the `create-vault` stage's `briefing` flag, which the `welcome → create-vault.start` transition sets and the picker/switcher "create another" entries leave unset. `BRIEFING_ACKED` advances briefing → password; `RESET_TO_PASSWORD`/`RESET` always land on `password` (the one-time briefing is never re-shown mid-flow). Its acknowledgement/disclosure state is local to the component (the step is never re-entered via back-nav — "Back" exits through the reprobe path). Tone is load-bearing: honest, not alarming — no red banners, no alarm icons (PRODUCT.md).
- Window-blur cover on PhraseStep (phrase visible → minimize covers it)
- BIP-39 wordlist autocomplete with exact-match required on ConfirmStep
- ReadyStep "Done" triggers auto-unlock chain (`commit` → `vault_unlock` → editor) per `decisions.md` 2026-05-02 — supersedes 2026-04-29 entry's slot-population implication. `passwordRef` lifetime extended through phrase/confirm/account/ready until auto-unlock resolves; wiped on every exit path (BEGIN_ERR / COMMIT_ERR / SESSION_LOST / RESET_TO_PASSWORD / unmount / auto-unlock resolve).

When building the next multi-step flow (recovery — separate PR), reuse this structure.

## Editor screen (the post-unlock workspace)

`src/screens/Editor.tsx` is the largest module in the tree and it is **production code, not a shell** — an earlier revision of this file described it as a textarea placeholder waiting for a "real" editor; that placeholder is long gone. What it owns is the *chrome*, not the text editing:

- outer flex column: sync banners, the three-pane row (left `SidebarPane` + `PaneTree` + right `SidebarPane`), and the bottom bar;
- the split/tab workspace via `PaneTree` → `src/notes/components/PaneView.tsx` — each leaf pane owns its own content state and autosave loop, so two panes can show two notes side by side;
- the modal mounts, all Editor-local booleans per the desktop modal carve-out: `SettingsModal`, `TemplatesManager`, `CommandPalette` + `QuickPicker`, `VaultSwitcher`, and the fail-closed / storage-lost / device-revoked takeovers.

The text editor itself is **not here and not in `src/`**. It is the shared CodeMirror 6 engine in the repo-root `editor/` package (`@myne/editor`), reached three hops:

```
src/screens/Editor.tsx  →  src/notes/components/PaneView.tsx  →  src/editor/*  (re-export shim)  →  @myne/editor
```

Platform-coupled operations the engine needs (i18n, the vault tag index, spell, on-device AI, attachment IO, prefs, open-URL) are **injected**, not imported: `src/editor-host.ts` calls `setEditorHost(...)` once at startup — `main.tsx` imports it for that side effect, after `./i18n` and before `<App>`. That file is the `EditorHost` seam described in `editor/src/host.ts`, and it is where a platform's *absent* members are omitted so the engine hides the affordance instead of showing one that throws.

So: engine behaviour (keymaps, decorations, slash menu, vim, drawing, math) is an `editor/` change; pane/tab/sidebar/chrome behaviour is an `Editor.tsx` or `src/notes/` change.

## App shell (MYND-80 full state machine + route guards)

**(Web note: `phase3-web-client` task 64 gives the web target browser history, URL routing and a working back button on top of this same `Stage` union — the desktop client stays URL-free.)** `src/App.tsx` uses the full Stage discriminated union — the v0.1 definition of "routing" (no URL/history-aware router). `src/lib/stage.ts` is the roster; it currently declares nine variants and `App.tsx` has one switch arm for each: `welcome`, `create-vault`, `unlock` (carries `initialStatus`), `editor`, `recover` (carries `subStep`), `picker` (≥2 vaults, SYNC-7a), `account-entry` and `pending-approval` (the web client's first-run identity step and its approval wait, MYND-635 — both rendered by `AccountBootstrap`), and `restore-backup`. Pure `transition(prev, action): Stage` function in `src/lib/stage.ts` enforces legal source/target combinations; illegal pairs return `prev` unchanged + dev `console.warn`.

Boot starts in `null` (loading shim) until the probes resolve. `initialStageFromProbe(vaultList, slotMap, pendingApproval)` takes **three** inputs, gathered by one `Promise.all` in `App.tsx` — the on-disk vault list (`listVaults()`), the runtime slot kind, and whether this device is enrolled but still awaiting approval — and routes:

- **slot-priority first**: a non-Empty runtime slot pins the stage regardless of disk state (`Recovering` → recover, `Unlocked` → editor);
- list-level IO failure → `unlock(IoError)` (fail-closed, whatever the count);
- 0 vaults → `welcome`, or `account-entry` where the `vaultCreation` capability is absent (on web an empty container means "this browser hasn't been told which account to pull", not "make one");
- 1 vault, `Exists` → `unlock(Exists)` carrying its `vaultId` — unless `pendingApproval` and no `vaultCreation` capability, which lands on `pending-approval`;
- 1 vault, `Corrupted` → `unlock(Corrupted)` where `backup` exists, else `account-entry` (a corrupt container on a server-backed client is a re-bootstrap, not data loss — `decisions.md` 2026-07-26);
- ≥2 vaults → `picker`.

Read the function before relying on that summary; the capability gates are what make the same code route two clients differently. User-initiated `editor.lock` lands directly on `unlock(Exists)` — no intermediate "vault locked" screen (MYND-131).

**Lock-on-idle ships (MYND-121)** — an earlier revision of this file called it out of scope, and that is no longer true. Two mechanisms, split by which client can see idleness:

- **Desktop.** The timer is `src-tauri/src/auto_lock.rs`, and its "idle" is machine-level OS idle where the platform exposes one (`effective_idle_from`), falling back — fail-secure, strictly more eager — to a window-level clock this side keeps fresh. That clock is `src/hooks/useActivityHeartbeat.ts`: mounted by `Editor.tsx`, i.e. exactly while a vault is unlocked, throttled to one IPC per 5 s, calling `reportUserActivity()` (`src/lib/vault-unlock.ts` → `plugin:vault-unlock|report_user_activity`) → `VaultRuntimeState::report_activity`, a relaxed store into the `last_activity_millis` atom in `core/src/plugins/vault_unlock/state.rs`. Best-effort by design: a dropped heartbeat only lets idle grow.
- **Web.** No OS idle source exists, so `src/hooks/useIdleAutoLock.ts` drives the lock from the page — active only where the `osIdleAutoLock` capability is absent, so the two never race. It compares timestamps rather than counting ticks (a hidden tab's timers are throttled to nothing) and calls the Lock button's own flush-then-lock handler, so the keys are dropped and the plaintext unmounted rather than hidden.

The timeout is the `auto_lock_seconds` pref — Settings → Privacy → `usePrefs`'s `setAutoLock` → `plugin:prefs|set_auto_lock_timeout`. On desktop it is clamped by the code-constant protective envelope in `auto_lock.rs` (`MIN_AUTO_LOCK_SECS` / `AUTO_LOCK_CEILING_SECS` / `DEFAULT_AUTO_LOCK_SECS`), which has **no disabled state** — a tampered `vault.prefs` can only make auto-lock stricter. The `UnlockedVault` docstring in `core/src/plugins/vault_unlock/state.rs` still says a `last_activity` field awaits Phase 2+ "because there is no Phase 1 writer for it"; that rationale is stale — the writer exists, the atoms just live on `VaultRuntimeState` rather than on `UnlockedVault`.

Belt+suspenders invalid-state guard (Q5β-1 of `app-state-machine` grill): `transition()` is React-side defense; `Editor` mount probes `vault_is_unlocked()` at mount as the Rust-side reality check, rendering `<FailClosedError reason="invalid-state" />` if React Stage and Rust slot disagree. That surface's CTA (`t("failClosed.invalidState.cta")` — a **lock**, not an exit) calls `vault_lock` + reprobe via `App.tsx::reprobe()` (out-of-band reset; bypasses transition fn intentionally). Its label comes from the reason's own copy; only the call sites whose CTA is the platform *exit* pass `ctaLabelKey`, because that label has to track behaviour that differs per platform (desktop destroys the window, web reloads the page).

No dev-only stage shortcut: any `?test-stage=` URL parameter has no effect. Per `app-state-machine` PRD + MYND-80 acceptance, dev cannot bypass production guards.

### `Stage.unlock.suspicionReason?` field (MYND-87 + MYND-107)

The `unlock` variant carries an optional `suspicionReason` payload — `"vault-meta-changed-externally" | "vault-locked-during-change"`. It is a one-shot signal carried from change-password force-relock paths to the resulting Unlock screen banner; never produced by `initialStageFromProbe()` (boot probe), only by explicit `setStageWithSuspicion()` calls from `App.tsx`. The `LEGAL` transition table tracks `name` only (not payload), so the field doesn't affect legality. **Dev-harness lockstep:** `ALL_STAGES_FOR_VERIFICATION` includes at least one `unlock` entry with `suspicionReason` populated so `verifyTransitionTable()` covers the variant. Adding a third reason value requires a matching `ALL_STAGES_FOR_VERIFICATION` entry. Rationale + provenance: `docs/decisions.md` 2026-05-08 "`Stage.unlock.suspicionReason?` field for change-password force-relock signals".

## Settings shell (MYND-87 + MYND-107)

The Settings UI is **not** a Stage variant. It mounts as a modal overlay inside `Editor.tsx` driven by Editor-local React state (`settingsOpen` boolean), per the desktop modal carve-out in `docs/decisions.md` 2026-05-08. Entry points: gear button in BottomBar's right cluster + `Cmd+,` / `Ctrl+,` keyboard shortcut. Both toggle `settingsOpen`; `<SettingsModal open onClose>` only renders when true.

`SettingsModal.tsx` owns the rail, and the `panels` value inside it (derived from the `PANELS_BASE` const) is the roster — read it rather than a prose list, because the taxonomy has been extended more than once. As it stands the rail runs Account → Privacy → Sync → Editor → Files → Hotkeys → Appearance → Storage → About, followed by a `developer` group holding the **AI** panel (developer-mode feature, MYND-593 — supersedes the earlier `labs`/`BetaBadge` framing). Two mechanisms are worth knowing before you touch it: `group: "developer"` renders a one-off divider at the core→developer boundary (a non-focusable presentation row, so the ↑/↓ cycle and `itemRefs` are untouched), and the array is **filtered**, not render-hidden — `ai` is dropped entirely where the `localAi` capability is absent (i.e. on web, because a greyed panel is an offer the platform cannot honour, `decisions.md` 2026-07-26 makes omission normative) **and** wherever the `developer_mode` preference is off (a runtime toggle in the About panel — Developer mode is where the user leaves the path Myne vouches for). Because the group has exactly one member today, filtering `ai` out also removes the divider — "no Developer group" is derived from an empty filtered group, not a second condition. The taxonomy was first locked at 5 panels by `decisions.md` 2026-05-08; the **Editor** panel came with a superseding entry that also scoped Appearance down to purely-visual controls (spell-check + daily-notes are note-authoring behaviour, not appearance), and **Files** (note-storage + startup behaviour, MYND-462) with a further one — the `PanelId` docstring in `SettingsModal.tsx` carries that provenance. Panel content components live in `src/components/settings/`, one file per panel plus the shared control blocks they compose. Rail navigation: ↑/↓ arrows cycle (with focus management via per-panel refs); click sets selection. Default panel: Account.

The modal also carries a **settings search** (`src/components/settings/search/`, MYND-536): `searchSettings(query, t)` scores a static registry, `groupResultsByPanel` groups the hits, and selecting one navigates to the owning panel and scrolls to the setting's `data-setting-anchor` (falling back to its `data-testid`). Matching runs against the registry, never the rendered DOM — panels run IPC on mount, so scanning their text is not an option. Consequence: **a new user-facing setting ships with its entry in `settingsSearchIndex.ts` in the same change**, capability-gated where its control is, or search finds it and scrolls to something that was never rendered.

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
  NOT one more Settings panel, NOT a sidebar surface. Opened by the
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

The real-IPC E2E suites (`e2e/`, tauri-driver — see `e2e/CLAUDE.md` +
`docs/dev/e2e.md`; and the deliberately thin browser lane `e2e-web/`)
locate everything by `data-testid`. **A screen without testids is invisible to
E2E — adding a user-facing flow means adding its testid pass in the same
change.** Which lane owes a scenario is the root `CLAUDE.md`'s call, not this
file's: shared-tree flows go to `e2e/`, web-specific behaviour to `e2e-web/`.

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
- Across the shared tree the convention is held by **review alone**. The one
  mechanical enforcer is `scripts/check-web-testids.mjs` (CI), and its scope is
  `web/src` plus the two web-only shared screens
  (`src/screens/AccountNumberEntry.tsx`, `src/screens/WebNoAccount.tsx`): at
  least one testid per rendering module, `<screen>.<element>` naming, and no
  `data-*` fed a runtime expression on a pre-unlock screen — the account number
  is typed on one of them, and a `data-value={account}` would put it in the DOM,
  in screenshots and in every failure artefact CI keeps.

## Common commands

```bash
pnpm install
pnpm dev                # Vite only — useful when testing UI in isolation
pnpm tauri dev          # full app (Vite + Rust core)
pnpm build              # tsc typecheck + vite build → dist/
pnpm test               # Vitest — the only runner that exercises tests/ (outside tsc's include)
pnpm test:e2e           # desktop E2E suite — Linux-only; on macOS use ./scripts/e2e-local.sh

# the web lane compiles this same tree with the seam substituted
pnpm web:dev            # web client dev server on :1421 (runs alongside the desktop one)
pnpm web:build          # typecheck web/ against src/ + production web bundle
pnpm test:e2e:web       # browser E2E lane (e2e-web/)
pnpm test:seam:desktop  # seam contract vs. the Tauri implementation
pnpm test:seam:web      # …and vs. the web one — both must pass for a seam change
```

## Gotchas

- **Never import `@tauri-apps/*` outside `src/platform/`.** The platform seam (`phase3-web-client` task 1) is the UI's ONE contact point with its host: one module per Tauri module, re-exported unchanged, substituted at build time for a web implementation that routes the same calls into a wasm Worker. `scripts/check-platform-seam.mjs` enforces the ban in `pre-commit` and in CI (and, after task 76, across `editor/`, `dialect/` and `copy/` too). This **supersedes the old "wrap `getCurrentWindow()` in a try/catch or feature-detect" advice**: a try/catch around a host call is exactly the shape that produces a silent wrong answer on a platform that cannot do the thing, instead of a modelled one. The seam's answer is `PlatformUnsupportedError` (`src/platform/unsupported.ts`) — a typed refusal — and the UI's answer is to **omit** the affordance rather than show it broken. `tests/platform/seam-contract.ts` holds every implementation to the same assertions.
- **CSS variables don't work in inline `style={{}}` for some quirky props** (e.g., `background-image: linear-gradient(...)`). Test the rendered output before assuming the var resolved.
- **React 19 strict-mode double-render** in dev is real. Effects run twice; design with idempotency.
- **No `unsafeAllowedHosts`** in Vite config — keep it that way (TB6 attack surface).
- **`locales/en/common.json` is NOT alphabetically ordered — never sort it.** A `json.load` → sort → `json.dump` round-trip reformats ~580 lines and buries a 10-line addition in an unreviewable diff. Insert new keys **positionally**, next to their nearest sibling, and verify with `git diff --stat`: a correct edit here is additions-only. (Round-tripping with `json.dumps(indent=2, ensure_ascii=False) + "\n"` reproduces the file byte-for-byte, so the formatter itself is safe — only re-ordering is not.)
- **A new preference field has far more registration sites than the three you'd expect.** Beyond the Tauri command + `build.rs` permission list + capability `[[permission]]` block, it also needs: the `PrefsView` struct, canonical encoder and parser (`protocol/src/prefs.rs`); a row in the sync classification table **plus** its exhaustive destructure **plus** `ALL_FIELDS` (three edits in one file — the destructure is a deliberate compile-time drift lock); the merge passthrough; every `PrefsView` literal across the test modules; the TS type, setter and `usePrefs` default; and the field roster in `docs/spec/protocol.md` §9.5.2. The Rust compiler finds every Rust one; nothing but `tsc` finds the TS ones, and **nothing at all** finds the spec one.
