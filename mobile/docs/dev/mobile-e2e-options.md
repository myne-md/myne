# Mobile E2E testing — options & recommendation

> Research deliverable. **No e2e harness is implemented yet** — this documents
> how the desktop stack maps (or doesn't) to mobile and presents options for a
> decision. Anchored on reusing as much of the main-repo e2e stack as possible.

## 1. What the desktop e2e stack is (the thing we want to reuse)

(Full detail: main repo `docs/dev/e2e.md` + `e2e/CLAUDE.md`.)

- **Runner**: Vitest (`vitest run --config vitest.e2e.config.ts`), serial
  (`fileParallelism:false`), 180 s/test, 2 retries.
- **Driver**: `tauri-driver` 2.0.6 + a **hand-rolled, zero-dependency W3C
  WebDriver client** (`e2e/support/webdriver.ts`) that talks to the WebView.
- **Target**: the **production binary** (`target/release/myne-desktop`), driven
  through real Tauri IPC (no mocks, no test hooks in production code).
- **Selector contract**: everything is found by **`data-testid`**
  (`[data-testid="x"]`, repeated rows narrowed by `data-*`). This is the SYNC-8
  observability discipline.
- **Isolation + fixtures**: a fresh `XDG_DATA_HOME` temp dir per launch; vaults
  are **pre-seeded** by writing `vault.meta` bytes (weak-KDF for speed,
  production-KDF for recovery drills) via `e2e/support/fixtures.ts` +
  `e2e/fixture-gen/` (a Rust crate).
- **Platform**: **Linux-only** — `tauri-driver` relies on
  `WebKitWebDriver`, which has no macOS/Windows equivalent. Mac devs run it in
  Docker (`scripts/e2e-local.sh`). It was the merge gate in Woodpecker until
  myne-md/myne#579; it now runs in `.woodpecker/e2e.yml` on a manual trigger,
  before a release, and gates no merge.

## 2. The core blocker for mobile

**`tauri-driver` does not support iOS or Android.** It is a thin shim over the
platform desktop WebDriver (`WebKitWebDriver` / Edge WebView2 driver); there is
no Tauri-Mobile WebDriver. So the desktop harness **cannot** drive a simulator
or emulator as-is. A mobile e2e needs a different *driver*, but can keep most of
the *discipline* (data-testid, fixture seeding, production-IPC, no test hooks).

## 3. What carries over regardless of the driver choice

- ✅ **The `protocol` crate tests (767) + `myne-test-vectors`** — primitives are
  byte-identical (shared crate); already validated upstream.
- ✅ **The mirrored backend's `myne-core` `cargo test` (1035 as of 2026-07-07,
  MYND-459 sync included)** — vault/notes/prefs/**sync** logic. (The 560 figure
  here was stale; the shared cores have grown, and the whole sync engine now
  lives in `myne-core`.) The mobile crate itself carries **13** thin-wiring Rust
  tests over these shared bodies.
- ✅ **The Vitest unit suite** (`tests/` — 116 tests as of 2026-07-07: state
  machine, IPC contract, bip39, conflict-copy, etc.) — pure TS, platform-agnostic.
- ✅ **The `data-testid` selector contract** — native mobile drivers all support
  element lookup by attribute inside a WebView. **Landed:** the wired sync flows
  now carry their `data-testid` pass (MYND-459/461 — enroll/endpoint/devices/SAS/
  status/conflict surfaces; see `sync-test-confidence.md` for the audit), same
  discipline as desktop SYNC-8.
- ✅ **Fixture-seeding pattern** — write a `vault.meta` into the app's data dir.
  On mobile the dir is the app sandbox (iOS `Library/Application Support`,
  Android `files/`), reachable via the simulator/emulator filesystem; the
  `fixture-gen` Rust crate is reusable to mint unlockable vaults.

## 4. Options for the device-level driver

| Option | What it is | Reuses from our stack | Cost / caveats |
|---|---|---|---|
| **A. Appium + WebView context (recommended)** | Appium server + UiAutomator2 (Android) / XCUITest (iOS) drivers; switch into the **WebView context** and drive the React app by `data-testid` over W3C WebDriver. | **High** — same `data-testid` contract + W3C semantics our hand-rolled client already speaks; the client could be re-pointed at Appium's endpoint with modest changes. Fixture seeding + production-IPC discipline intact. | Appium infra (server + drivers + simulator/emulator). iOS needs a **mac runner**; Android emulator runs on a **Linux runner**. WebView-context flakiness needs care (context switch timing). |
| **B. Maestro** | Mobile-first YAML flow runner; supports native + WebView, `testID`/accessibility-id selectors, great DX, low setup. | **Medium** — can target the same `data-testid`s; but flows are YAML, NOT our Vitest/JS harness — a parallel test language to maintain. | Diverges from the shared JS harness; less programmable than WebDriver for complex fixture orchestration. Excellent for smoke/happy-path. |
| **C. WebdriverIO + Appium** | Standard WDIO test runner over Appium. | **Medium-High** — `data-testid` + WebView context; replaces the hand-rolled client with a maintained one (less code to own, but a new dep + a second runner alongside Vitest). | Heavier dep surface than the zero-dep desktop client (a TB9 consideration). Two runners (Vitest unit + WDIO e2e). |
| **D. Native XCUITest (iOS) + Espresso (Android)** | Two native UI test suites in the generated Xcode/Gradle projects. | **Low** — abandons the shared contract; two separate native test codebases in Swift + Kotlin. | Most robust against WebView quirks; highest maintenance + most divergence. Reasonable only for native surfaces (widgets, biometric prompts) that a WebView driver can't reach. |
| **E. Playwright against the Vite dev server (logic-only, complement)** | What this session already used for the smoke pass — drive the React app in headless Chromium with `HAS_TAURI=false` placeholders. | **High (UI logic)** — fast, no device, runs anywhere; great for flow-state coverage + visual regression of screens. | **Not a real device/IPC test** — no Rust backend, no WKWebView/Android-WebView parity. A complement, not a replacement. |

## 5. Recommendation

**A two-tier strategy:**

1. **Fast tier (every push, no device):** keep the **Vitest unit suite** + add a
   **Playwright-against-dev-server** flow-logic suite (option E) reusing the
   `data-testid`s. Catches state-machine/wiring/visual regressions cheaply in
   normal CI on the existing Linux runner.
2. **Device tier (merge gate / nightly):** **Appium + WebView context (option
   A)** — it preserves the desktop harness's load-bearing properties
   (production IPC, `data-testid`, fixture-seeded vaults, no test hooks) and is
   the smallest semantic jump from the hand-rolled W3C client. Run **Android on
   a Linux runner** (emulator) first; add **iOS on a mac runner** when the iOS
   track matures.

Rationale: option A maximizes reuse of the *discipline* we already trust, keeps
one selector contract across desktop + mobile, and avoids a second native test
language. Maestro (B) is the strong fallback if Appium infra proves too heavy —
it's the fastest path to a happy-path smoke gate.

## 6. Work items before any device e2e can run

1. **`data-testid` pass on `src/app/flows/*`** — same SYNC-8 discipline as
   desktop (`<screen>.<element>`; pre-unlock leak budget respected).
2. **Mobile fixture seeding** — a helper that writes a `fixture-gen` `vault.meta`
   into the simulator/emulator app sandbox before launch (the mobile analog of
   `seedVault(appDataDir)`).
3. **Biometric stubs** — Face ID / fingerprint prompts need simulator biometric
   enrollment automation (`xcrun simctl` / `adb emu finger`) or a test-only
   bypass behind a build flag (threat-model review first).
4. **CI runners** — Android: emulator on the existing Linux Woodpecker runner
   (KVM). iOS: a mac runner (Woodpecker mac agent or a GitHub-Actions mac job)
   — gate it like the desktop's secret-gated `sync-sim` step.
5. **Decision to record** in the main repo `docs/decisions.md` (mobile e2e
   driver choice + the Linux-only-desktop precedent it parallels).

## 7. Out of scope / native-only

Widget UI (WidgetKit), Control Center / Action Button, and biometric system
prompts live **outside** the WebView — only options A/D can reach them, and only
partially. Treat those as native XCUITest spot-checks if/when needed, not part
of the WebView e2e tier.
