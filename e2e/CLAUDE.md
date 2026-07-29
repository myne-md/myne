# e2e/ — real-IPC E2E suites (tauri-driver harness)

> **Scope: the NATIVE desktop client only.** Everything below — the production
> Tauri bundle, real IPC, tauri-driver, the Linux-only constraint, the
> page-seat dialog interception — is specific to this harness. The Phase 3 web
> client has a **second, separate lane** at `e2e-web/`, browser-driven, with its
> own driver and its own constraints, and it is deliberately thin: it covers
> only what is web-*specific* (capability gating, OPFS persistence across
> reload, the single-tab lock, sync-required entry, incremental first-sync
> materialisation, crash recovery of the double-buffered blobs). Shared UI
> behaviour is covered **once**, here, because it is the same `src/` tree —
> a premise the platform-seam contract tests (`tests/platform/seam-contract.ts`)
> verify rather than assume. Do not mirror a scenario across both lanes.
> (`design-notes.md` 2026-07-26 "Web E2E policy"; procedure for both:
> `docs/dev/e2e.md`.)

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
  teardown-in-finally; `describeE2E.flaky` is the quarantine marker, below),
  `support/fixtures.ts` (seeding + fault injection),
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
- **Never bound a NEGATIVE assertion with `waitForSaved`.** When the point is
  that nothing changed, no save ever fires and the helper burns its full
  timeout before failing (observed: 66 s + two retries on a "paste must add
  nothing" step). CodeMirror applies edits synchronously while handling the
  keystroke, so asserting straight after `sendKeys` is both correct and
  instant. Follow it with a positive probe (send a key, assert it took effect)
  so the absence cannot pass merely because input stopped arriving.
- **The `myne-e2e-target` Docker volume is shared across git worktrees.** A run
  can fail to BUILD against a stale crate compiled from another branch — the
  giveaway is a compile error naming a field that exists in neither your source
  nor `develop` (observed: `PrefsView has no field named editor_vim_mode`, with
  the note listing `attachment_ocr_enabled`, a field belonging to a different
  feature branch). Fix: `docker volume rm myne-e2e-target`, then a full rebuild
  (`--skip-build` is not enough). Same class as the shared-`CARGO_TARGET_DIR`
  collision, one layer down.
- Post-exit assertions (disk state AFTER the app quit): launch with
  `keepDataDir: true`, capture `dataHome` in the SEED callback (the
  launch-failure path leaks the dir otherwise), gate on
  `waitForFsQuiescence` after `scenario()` returns (WebKit's auxiliary
  processes flush late), and own the final `rmSync` in a `finally`.
  PS-1 (`plaintext-residue.e2e.ts`) is the template.
- Definition of done for a new/changed scenario: **green 3× consecutive in the
  container**, and run it ISOLATED — the full suite contaminates, so
  `./scripts/e2e-one.sh <spec>` (test-file changes only) or
  `./scripts/e2e-buildrun.sh <spec>` (production-code changes, rebuilds first)
  is the gate, with `./scripts/e2e-batch.sh <spec>…` when several specs need
  it. `./scripts/e2e-local.sh` runs the whole suite and is the wrong tool for
  proving one scenario. Invocations: `docs/dev/e2e.md`.
- **`describeE2E.flaky` takes a scenario OUT of the merge gate.** It is the
  quarantine marker (`support/scenario.ts`): the blocking `e2e` CI step skips
  the flaky set so an unrelated PR cannot go red on someone else's contention
  flake, and the non-blocking `e2e-quarantine` step (`MYNE_E2E_QUARANTINE=1`,
  `failure: ignore`) runs only them and reports without gating. Reserve it for a
  scenario verified as a runner-contention victim, keep the set short, and
  record the debt on the Plane item — a real failure marked `.flaky` is a real
  failure nobody will see. Currently quarantined: `nav1`, `tp1`.
- States unreachable through real UI are NOT forced into E2E: downgrade to a
  Vitest component test (mocked `invoke`) and record the downgrade on the
  Plane item.
