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

## Layout

```
src/
├── App.tsx              ← top-level stage union (welcome / create-vault / editor)
├── main.tsx             ← React 19 root mount
├── screens/             ← top-level screens (one per stage)
│   ├── CreateVault.tsx
│   ├── Editor.tsx       ← B4.5 placeholder; full CodeMirror = Lane B #10 (B5)
│   ├── Welcome.tsx
│   └── vault-creation/  ← multi-step flow (PasswordStep, PhraseStep, ConfirmStep, ...)
├── components/          ← reusable UI primitives
│   ├── primitives/      ← Button, Input, etc.
│   ├── ErrorBanner.tsx
│   ├── PasswordStrength.tsx
│   ├── Spinner.tsx
│   └── ComingSoonPill.tsx
├── lib/                 ← non-UI helpers
│   ├── icons.ts
│   ├── password-generator.ts
│   ├── secret-export.ts
│   ├── vault-creation-errors.ts
│   └── vault-creation-logging.ts
├── styles/              ← global CSS only
└── types/               ← shared TS types (mirrors Rust ProtocolError enum)
```

## Tauri command bindings

**No mock layer.** Plan 2 §B1 originally called for a `VITE_USE_MOCK_BACKEND` mock layer; it was skipped. Real Tauri commands are called directly from `src/lib/`. Risk: signature drift between Rust `#[command]` definitions and TS callers has no canary. `tauri-specta` (or equivalent codegen) is on the radar — see Furkan's todo `[B1]` (status `⏸`).

When you add a new Tauri command on the Rust side, manually mirror the signature in the matching `src/lib/<flow>.ts` file. Keep types in `src/types/` so a second consumer can reuse them.

## Vault creation flow (B3a/B3b shipped)

`src/screens/vault-creation/` is the canonical multi-step example:
- Reducer + Action union state machine (no zustand here yet)
- Per-step components (PasswordStep, PhraseStep, ConfirmStep, AccountStep, ReadyStep, SessionLostStep, EncryptingStep)
- Window-blur cover on PhraseStep (phrase visible → minimize covers it)
- BIP-39 wordlist autocomplete with exact-match required on ConfirmStep
- ReadyStep "Done" advances to editor stage (per `decisions.md` 2026-04-29)

When building the next multi-step flow (B4a unlock, B4b recovery), reuse this structure.

## Empty editor shell (B4.5 shipped, placeholder)

`src/screens/Editor.tsx` is a textarea-based placeholder — no save, no CodeMirror, no autosave. Full editor lands in B5 (`@uiw/react-codemirror` + markdown language pack). Layout:
- Outer flex column
- Row of three panes (left sidebar + center pane + right sidebar)
- 28 px bottom bar
- Section heading style + status text style extracted as `CSSProperties` constants (`SECTION_HEADING_STYLE`, `STATUS_TEXT_STYLE`)
- Center toolbar height 38 px; textarea minHeight 360; padding 32px 64px on scroll container, maxWidth 680 inner

Don't ship features against this placeholder — wait for B5.

## App shell (MYND-20 basic stage union)

`src/App.tsx` uses a basic `stage` union (`"welcome" | "create-vault" | "editor"`) — the v0.1 definition of "routing" (no URL/history-aware router). The full state-machine refactor is bundled with the vault-unlock UI work (MYND-33 / MYND-77); a `"locked"` stage will land then. Lock-on-idle (auto-lock on idle timer) is **explicitly out of scope** for Phase 1 per `src-tauri/src/plugins/vault_unlock/state.rs` Phase 2+ docstring — there is no Phase 1 writer for `last_activity`, so a stub here would be dead code.

Dev-only shortcut: `?test-stage=create-vault|editor` skips to a stage on `pnpm dev` (`import.meta.env.DEV`-guarded; tree-shaken from prod bundle).

## Common commands

```bash
pnpm install
pnpm dev                # Vite only — useful when testing UI in isolation
pnpm tauri dev          # full app (Vite + Rust core)
pnpm build              # tsc typecheck + vite build → dist/
```

## Gotchas

- **`tauri-apps/api` window methods don't exist on web.** If you reference `getCurrentWindow()` in a component that might render outside Tauri context, wrap in a try/catch or feature-detect. Vault creation's window-close prompt does this implicitly via `useEffect` cleanup (listener unmounts on stage change).
- **CSS variables don't work in inline `style={{}}` for some quirky props** (e.g., `background-image: linear-gradient(...)`). Test the rendered output before assuming the var resolved.
- **React 19 strict-mode double-render** in dev is real. Effects run twice; design with idempotency.
- **No `unsafeAllowedHosts`** in Vite config — keep it that way (TB6 attack surface).
