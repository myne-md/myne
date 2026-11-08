# Mobile-sync test confidence — work-division map + honest gaps

> Where each sync layer is actually tested, and where it is not. The companion to the
> `agent-tooling/design-notes.md` 2026-07-07 "device-level UI E2E exemption (SYNC-44)" entry: that entry grants
> the exemption, this doc shows the compensating coverage honestly, layer by layer. Mobile *test*
> protocols live here, not in `operations` (SYNC-27).
>
> **Numbers below are the counts verified 2026-07-07; the precise per-suite figures are refreshed in
> `mobile-e2e-options.md` (MYND-462 task 5) — treat that file as the live tally.**

## A. Work-division map

| Sync layer | Where it is tested | Honest gap |
|---|---|---|
| **Crypto / byte-layout** | `protocol` unit tests (185 prefs incl. device_names) + `myne-test-vectors` byte-vectors run by `protocol/tests/vectors.rs` (vault-prefs 46 cases). Main-repo `cargo nextest run --workspace` pre-push, companion cloned. | **Vector CI is DISABLED in both repos** while `myne-test-vectors` is private (M-R6) — a **local** byte-level gate, **not CI-enforced**. |
| **Sync-engine logic** | ~140–150 `#[test]`s in `myne_core::plugins::sync` (pure-logic + `FakeTransport`). Main-repo `cargo nextest run --workspace` (post-MYND-457 the engine is shared). | **Mobile CI does not duplicate them** — the shared-core gate is the main repo's, by design. |
| **Multi-device convergence** | `sim.rs` 22-test convergence harness (real `myne-server` loopback). Main-repo secret-gated `sync-sim` Woodpecker step (filter repointed to `-p myne-core --lib plugins::sync::sim::` by MYND-457; self-skips without the server binary). | Convergence is proven against the loopback server, not against a hosted production server or across real network partitions. |
| **IPC command contract** | Mobile `vitest run` (116 tests, 17 files) — types, error shapes, state machines, with `@tauri-apps/api/core` mocked. | **No real IPC** — the mock boundary means a Rust-side command regression is caught by `cargo test`, not by Vitest. |
| **Sync UI flow-logic** (enroll / status / conflict) | The Playwright-vs-dev-server flow-logic layer (MYND-462 task 3), mobile CI, **mock IPC** — **never labeled "E2E"** (it drives the dev server, not the built app). | It exercises component/flow logic, **not** the device WebView, native lifecycle, or real transport. Device-level UI E2E is the SYNC-44 exemption (→ MYND-467). |
| **Token / keychain store** | Host-unit-testable policy behind the MYND-458 `TokenStore` provider seam (`MockTokenStore` + `FileTokenStore` round-trip tests). v1 tier = app-sandbox file (SYNC-34). | The **OS-keychain leaf** (`thisDeviceOnly`, accessibility class) is manual-matrix + deferred (MYND-464); no automated coverage of the keychain provider yet. |
| **Lifecycle triggers** | `SyncScheduler` suspend/resume/flush unit tests in core (MYND-460 task 1, clock-injected, 4 red→green cases). | On-device **firing order** (Suspended/Resumed vs `visibilitychange`, grace-lock timing) is **manual matrix** — iOS platform behaviour is not code-citable. |
| **On-device TLS / cert chain** | `rustls` against bundled public CA roots, plus the tls-exporter path (shared core). | **R3-gated: automated coverage of the refusal arms, NOT production-trusted** (M-R1). The CA-chain + server-name verifier and the empty-channel-binding SCRAM handshake owe a primitive-level review + live interop test; nothing may present cert-trust as verified until R3 closes. The refusal arms (untrusted issuer, wrong hostname, the same checks inside the Tor tunnel) are covered in `core/src/plugins/sync/rustls_transport.rs`; what is NOT covered is a live renewal against a real server, which is a roster item. |
| **Capability ACL + WebView parity** | Build-time ACL validation (`tauri_build::try_build` fails closed on a 3-list mismatch — proven for the 14/15-command sync surface). | **WKWebView ≠ Chromium** render/gesture parity is **manual matrix** (device-matrix.md); the ACL is validated at build, not the on-device WebView behaviour. |

## B. Gap / honesty register

- **Vector CI (M-R6):** the byte-vector coverage is **"locally gated; CI-gating pending vectors-repo access"** — **not** "CI-enforced". This wording is load-bearing: do not upgrade the claim until the `myne-test-vectors` repo is reachable by CI.
- **Transport review-debt (R3):** the `rustls` cert-pin verifier + tls-exporter wiring is unreviewed; no "-PLUS" / channel-bound / verified-cert-trust claim may be made anywhere (spec, UI, marketing) until R3 lands.
- **`head_fingerprint` (SYNC-17):** the SAS substrate's primitive-level review is still open — the enroll-time eye-compare must not ship before it closes.
- **Shared-core gate location:** the sync engine's logic + convergence tests run in the **main repo's** `cargo nextest run --workspace`; **mobile CI does not re-run them** (MYND-457 made the engine identical compiled code). A mobile-only CI green does not mean the sync engine is untested — it means it is tested upstream.
- **Device-level UI E2E:** deferred; a real iOS/Android WebDriver / Appium-class harness is **MYND-467**, out of this epic. The manual `device-matrix.md` protocol is the interim.

## C. Testid-completeness audit (MYND-462 task 5 — run 2026-07-07)

The `data-testid` selector contract is the prerequisite for every driver tier
(flow-logic + the deferred device tier). Audit method:
`grep -rho 'data-testid="\(sync\|conflicts\)[^"]*"' src/components src/app/flows | sort -u`.

**Verdict: PASS.** The MYND-459 (enroll/device) + MYND-461 (status/conflict) sync
surfaces carry **54 distinct** `sync.*` / `conflicts.*` testids. Coverage by surface:

- **Enroll (SY-03/04):** `sync.enroll`, `.account-input`, `.account-hint`, `.mode`
  (Segmented), `.password-input`, `.phrase-grid`, `.phrase-cell`, `.error`,
  `.pending`, `.approved`, `.submit`.
- **Endpoint (SY-02):** `sync.endpoint-config`, `-input`, `-connect`, `-msg`,
  `sync.cert-fingerprint`, `sync.pin-source`.
- **Devices + remove (SY-06/07):** `sync.device-management`, `sync.device-row`,
  `sync.pending-devices`, `sync.pending-row`, `sync.approve-device`,
  `sync.remove-device`, `sync.remove-confirm`, `sync.remove-disclosure`,
  `sync.remove-device-confirm`/`-cancel`, `sync.this-device`, `sync.reset-local`,
  `sync.device-not-enrolled`/`-error`/`-retired-self`.
- **Approve-then-verify SAS (SY-05):** `sync.approve-verify`, `sync.sas-fingerprint`,
  `sync.sas-pending`, `sync.sas-match`, `sync.sas-mismatch`.
- **Settings hub (SY-01):** `sync.settings`.
- **Status + banners (MYND-461):** `sync.header-glyph`/`-count`, `sync.status-detail`
  /`-title`/`-sync-now`, `sync.reconcile-banner`/`-dismiss`, `sync.integrity-alert`
  /`-copy`/`-dismiss`/`-verify-devices`, `sync.conflict-count-banner`.
- **Conflicts view (MYND-461):** `conflicts.view`, `.empty`, `.group`, `.copy`,
  `.keep-both`, `.discard`, `.take-this`.

The testids were added by MYND-459/461 themselves (this audit is the gate that they
landed, per the task's audit-only scope — it adds none). The flow-logic tier (task 3)
consumes this contract against the mock-IPC dev server.

## Cross-check

Each "where-tested" cell should be re-verified against the actual `.woodpecker/main.yml` (the mobile lane lives there too since the client moved in-repo; the manual E2E lane is `.woodpecker/e2e.yml`) at each release. If a CI step is renamed, disabled, or moved, update the matching row here rather than letting the doc drift.
