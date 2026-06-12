# e2e/ — real-IPC E2E suites (tauri-driver harness)

> Subdirectory CLAUDE.md. Loaded when Claude works in this directory. Operating
> manual (platform constraints, local container loop, env knobs, version pins):
> `docs/dev/e2e.md`. Policy provenance: `design-notes.md` 2026-06-10 "E2E
> harness" entry + `agent-tooling/epics/e2e-testing/sync-ledger.md`.

## Non-negotiable rules

- **Production bundle under test.** The suite drives `target/release/myne-desktop`
  through real Tauri IPC. Dev-only behaviors are Vitest territory, never E2E.
- **Zero test hooks, zero capability-ACL changes.** Production code may gain
  `data-testid`/`data-*` observability attributes ONLY. Forced states come from
  real UI driving, WebDriver `refresh()` (the Cmd+R primitive — host slots
  survive it), and **at-rest fault injection** (`tamperVaultMeta`,
  `corruptVaultMetaWholesale`, `deleteVaultMetaKeepArtifacts`, `denyRead`).
  Backend-only paths may be driven via `__TAURI_INTERNALS__.invoke` from the
  page seat (`pageSeatInvoke` pattern) — production IPC, still no hook.
- **Page-seat dialog interception** is the one sanctioned stub: an OS-native
  dialog WebDriver cannot drive (`plugin:dialog|save`) may be intercepted
  from the page seat. `__TAURI_INTERNALS__` is immutable on the production
  build (every IPC-path own property — `invoke`, `ipc`, `postMessage` — is
  non-writable + non-configurable, and the window binding itself is
  non-configurable), so the wrapper goes on the writable seam the transport
  calls: the global `fetch` carrying Tauri's custom-protocol IPC. Intercept
  ONLY the target command's exact IPC URL
  (`convertFileSrc('plugin:dialog|save', 'ipc')`) with a synthetic
  ok-Response (`content-type: application/json`, `Tauri-Response: ok`, body
  = the known path JSON-encoded), delegate every other URL to the native
  fetch, assert the patch took, and count the calls (`note-export.e2e.ts`
  ne3 is the template). Production code stays untouched; everything past
  the dialog is the real flow.
- **Credentials never reach failure output (SYNC-13).** No `expect` whose
  failure diff prints a phrase, password, or even phrase-word LENGTHS. Shapes:
  length-only counts, emptiness booleans, in-page reductions (see
  `captureFailureOutcome`). In-source scenario constants are the accepted
  exception. `e2e/artifacts/` may capture credentials on failure — gitignored,
  never attach to public issues. The at-rest plaintext residue proof is PS-1
  (`plaintext-residue.e2e.ts`, MYND-228): note-content markers are the
  in-source-constant class; the needle-design rule (single lowercase-alnum
  tokens ≥24 chars — tokenizer-survivable) lives in the
  `support/plaintext-scan.ts` header.
- **Load-bearing banner copy is asserted by FULL-LITERAL equality** via
  `src/lib/load-bearing-copy.ts` (or `ioBanner(...)` where production renders
  that mapping). A copy collapse must fail a test.
- **KDF policy:** weak-KDF generator fixtures by default (legal: unlock reads
  params from `vault.meta`; creation stays pinned — no code branch). The VR-1
  recovery drill + creation scenarios run PRODUCTION params every pipeline.

## Authoring conventions

- One scenario = one story; every scenario declares its **vault-count
  precondition** in a comment (0 / 1 / ≥2 / legacy). Don't merge stories to
  save a boot.
- Build on the layers, don't re-roll them: `support/scenario.ts`
  (`describeE2E` + `scenario()` — self-skip off-platform, artifacts-on-throw,
  teardown-in-finally), `support/fixtures.ts` (seeding + fault injection),
  `support/flows.ts` (`unlockToEditor`, `selectPickerRow`, `switchToVault`,
  `dismissImporterOffer`, `enterRecoveryPhrase`, `completePasswordReset`),
  `support/realistic-fixture.ts` (`seedProductionVault` — VC-1 capture with
  generator fallback).
- Selectors are `byTestId` / `testIdSelector(id, attrs?)` only — no CSS-class
  or text selectors. A fresh vault's first editor shows the importer
  onboarding offer overlay: call `dismissImporterOffer` before clicking
  anything in the editor.
- **`Element.replaceText`, not `clear()`+`sendKeys`** when replacing a value on
  the `Input` primitive — W3C clear bypasses React's value tracker there
  (keystrokes APPEND after a silent no-op clear).
- Elements go STALE on step remount (e.g. Back navigation) — re-fetch handles
  after any sub-step transition.
- Post-exit assertions (disk state AFTER the app quit): launch with
  `keepDataDir: true`, capture `dataHome` in the SEED callback (the
  launch-failure path leaks the dir otherwise), gate on
  `waitForFsQuiescence` after `scenario()` returns (WebKit's auxiliary
  processes flush late), and own the final `rmSync` in a `finally`.
  PS-1 (`plaintext-residue.e2e.ts`) is the template.
- Definition of done for a new/changed scenario: **green 3× consecutive in the
  container** (`./scripts/e2e-local.sh`, `--skip-build` when only test files
  changed; production-code changes need the full rebuild).
- States unreachable through real UI are NOT forced into E2E: downgrade to a
  Vitest component test (mocked `invoke`) and record the downgrade on the
  Plane item.
