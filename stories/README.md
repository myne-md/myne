# Design-system story catalogue

An in-repo, dev-only catalogue of every component, screen and state in Myne's
shared `src/` tree, mounted from the **real** components with a fake Tauri host
(myne-md/myne#832).

It exists to make "which screen, which state" answerable in one click instead of
by driving individual screens, and to give reviews a coverage roster so no
surface is missed.

## Run it

```bash
pnpm stories          # dev server on :1423 (desktop :1420, web :1421, mobile :1422)
pnpm stories:build    # static build in stories/dist/
pnpm stories:preview  # serve the built bundle
pnpm stories:test     # smoke (blocking) + drift (warning) render checks
pnpm stories:record   # re-record the DOM-hash baseline
```

Every story is addressable by URL: the fragment is the story id
(`#primitives/button/variants`), so a link can be pasted into an issue.

## How it mounts the real app

`stories/src/host/internals.ts` installs a fake `window.__TAURI_INTERNALS__`
before any app module body runs, so the desktop platform seam
(`src/platform/*`) runs **unmodified** and every `invoke(cmd, args)` routes to
canned fixture data. This is the mechanism `mobile/tests/flow-logic/mock-ipc.ts`
and the E2E page seat already use. No app source changes, and no second UI
codebase.

The real token sheets, ornament sheet and (for editor stories) the editor host
are reused, so the catalogue paints exactly as the app does.

## Adding a story

1. Add an entry to a `stories/src/stories/*.tsx` file (or a new one), with
   `id`, `group`, `surface`, `state`, an optional `fixture`, and `render`.
2. If it needs canned data, add a named fixture to `stories/fixtures/index.ts`.
3. `node scripts/check-story-coverage.mjs` fails until the new surface has a
   story, which is the point: the roster is a ratchet and its debt may only
   shrink.

## Deploying (the ops boundary)

`pnpm stories:build` produces a self-contained static SPA in `stories/dist/`
that any static server can serve. Standing it up (host, TLS, the deploy itself)
is the **ops task**; this repository owes a correct build and the guarantees
below.

**CSP note.** The catalogue renders Myne's real inline styles, so it needs
`style-src 'unsafe-inline'` (the same allowance the desktop WebView carries, for
the same reason: every design token is applied through inline `style`
attributes). It makes no network call, so `connect-src 'none'` is correct and
should be pinned. A reasonable policy:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'none';
```

## The guards

| Guard | What it prevents | Where |
|---|---|---|
| `scripts/check-story-coverage.mjs` | a component or screen landing with no story | pre-commit + `pnpm-build` |
| `scripts/check-stories-isolation.mjs` | the catalogue entering an app bundle (an app build config or a Tauri bundle manifest referencing `stories/`) | pre-commit + `pnpm-build` |
| `scripts/check-stories-bundle.mjs` | an unrecorded origin, a BIP-39 word list (so no phrase can be shown or typed) or an account-number-shaped string in the served bundle | `stories-build` (CI) |
| `tests/stories/smoke.test.tsx` | a story that will not mount | `pnpm stories:test` (CI `vitest`) |
| `tests/stories/drift.test.tsx` | an unintended rendering change (WARNING only) | `pnpm stories:test` (CI `vitest`) |

`stories/` is a guarded shared root in `scripts/lib/shared-roots.mjs`, so the
token, seam and i18n guards scan it like any other consumer of the shared tree.
The story host is the one file allowed to name the Tauri runtime global, the
same reasoned exemption `src/lib/app-window.ts` holds.

## Review pass (myne-md/myne#843)

Every registered story was mounted and reviewed against the canon, and each
finding below is either fixed here or recorded with the reason it is not.

**Fixed.**

- **The catalogue could go completely blank.** `stories/vite.config.ts` defined
  `__APP_VERSION__` and `__BUILD_COMMIT__` but not `__UPDATE_CHANNEL__`, which
  `AboutPanel` reads during render. Selecting `settings/aboutpanel/default`
  threw `ReferenceError`, and with no boundary in the shell it unmounted every
  story at once. The third global is now defined in both the catalogue's Vite
  config and `vitest.stories.config.ts` (whose smoke check hit the same throw),
  and `stories/src/ErrorBoundary.tsx` wraps each story so one failure renders a
  message in place of that story instead of taking the rail down with it.
- **Three modal backdrops bypassed the scrim token.** `CommandPalette`,
  `QuickPicker` and `promptForText` hardcoded `rgba(0, 0, 0, 0.32)`, which
  neither matched `--scrim` nor followed the theme. They now use `var(--scrim)`,
  the token `ModalShell` already reads. `check-token-adoption` recorded three
  fewer literals.
- **`settings/syncpanel/default` rendered `NaN KiB of NaN KiB`.** The fixture
  answered no `sync_account_status`, so the fake host's `{}` default reached
  `SyncUsageBlock`. Not enrolled means the block is absent, so the fixture now
  answers `null` and supplies an empty device list.
- **`MemberVaultUnlockCard` printed one sentence twice.** The intro paragraph and
  the phrase field's `hint` were both `unlock.memberHint`; the field hint is now
  the shared `sync.enroll.recoveryPhraseHint`.
- **`ai-panel/chat` showed the "compiled without local AI" state.** The fixture
  set `ai_enabled` but answered no `ai_capability_report`, so the capability gate
  read it as uncompiled. Its handler is now present, and the story shows the chat
  it describes (the same story a user-guide screenshot is taken from).

**Reviewed, not a defect.**

- Stories that render nothing under their default state (`RemoteMergeHint`,
  `SyncBanners`, `RepairResidueBanner`, `ThemeInstallDialog`, …) are deliberate:
  the header of `components.tsx` documents "breadth over depth", and mounting
  them is what catches a module-scope crash. The new boundary strengthens that
  purpose rather than changing it.
- Controls below 24px (`Switch` at 36×20, several 20px icon buttons) pass axe's
  `target-size` through its spacing exception; the `--target-min` work is
  myne-md/myne#728's, not this pass's.
- Hardcoded colours in `AppearancePanel` are theme-swatch and accent-preset
  data, which a single token cannot express.
- The disabled "Save" label's 2.32 contrast is a disabled control, which WCAG
  exempts.
