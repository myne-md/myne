# e2e-web/ — the browser E2E lane

> Subdirectory CLAUDE.md. Loaded when Claude reads files here. See repo-root
> `CLAUDE.md` for project-wide context and `e2e/CLAUDE.md` for the **desktop**
> lane, whose non-negotiables this lane inherits.

## What this lane is for, and what it is emphatically not for

**Web-specific behaviour only.** Both clients compile the same `src/` tree; the
only thing that differs is the platform seam (`src/platform/`), which the web
build substitutes. So a flow in the shared tree owes **one** scenario to the
desktop `e2e/` suite and **nothing** here — and the premise that makes that
legitimate is verified by the platform-seam contract tests
(`tests/platform/seam-contract.ts`), one assertion suite run against every seam
implementation in both CI lanes. `docs/decisions.md` 2026-07-26 "Web E2E policy".

What belongs here:

- capability gating — an affordance **absent**, not disabled
- OPFS persistence across reload, and crash recovery of the double-buffered
  singleton blobs
- the single-tab lock
- sync-required entry (there is no local-only vault on this client)
- incremental first-sync materialisation
- the browser refusals: unsupported environment, quota precheck

**If you find yourself writing the same scenario twice, the thing that actually
needs a test is the seam contract.** Dual-driving the desktop suite — 93
scenario files today (`e2e/*.e2e.ts`) — against a browser would roughly double
the pipeline's slowest step to re-assert identical source, and a second suite
that duplicates the first decays into the one nobody fixes.

## The non-negotiables, inherited from `e2e/CLAUDE.md`

They apply here unchanged, and two of them bite differently in a browser:

1. **The production bundle is under test.** `web/dist`, built by
   `pnpm web:build`. Never a dev server, never `vite preview` — see below.
2. **Zero production test hooks.** No `window.__test`, no query-parameter
   backdoor. At-rest state is arranged by writing FIXTURE BYTES into OPFS before
   the app boots, exactly as the desktop lane does byte surgery on a seeded vault
   directory.
3. **`byTestId` is the only sanctioned selector.** Not a CSS path, not text.
4. **Credentials never reach failure output.** No password, account number or
   phrase in a screenshot, a log or a DOM dump. This is why Playwright was
   rejected in part: its default trace records DOM **plus network**.

## Why the harness serves the bundle itself

`vite preview` sends no CSP, no COOP and no COEP. A lane running against it would
prove the app works in an environment it is never deployed into, and would go
green on precisely the misconfiguration `docs/self-host-web.md` calls fatal:
without cross-origin isolation `SharedArrayBuffer` is undefined and the sync
backoff's blocking waiter (`core/src/task.rs`) cannot exist.

So `support/server.ts` serves `web/dist` with `securityHeaders()` from
`web/csp.ts` — **the same function the production deployment uses**, not a copy.
A copy would drift, and it would drift in the one direction that matters: a lane
looser than production.

**One server per worker slot, because one origin per worker slot.** OPFS is keyed
by origin; two concurrent vitest workers sharing a server would share a vault,
and one test's data would be visible to its neighbour. `support/worker-ports.ts`
gives each slot its own port band.

## The driver, and the browser matrix

**The existing zero-dependency W3C client, extended — not Playwright.**
`e2e/support/webdriver.ts` is pointed at `chromedriver` / `geckodriver` instead
of tauri-driver. Playwright was evaluated and rejected: its whole case was a
WebKit seat for Safari-specific storage behaviour, and **Playwright's WebKit is a
build of WebKit, not Safari** — the seat would imply coverage it does not
provide. Full reasoning in `docs/decisions.md` 2026-07-27 and the ledger entry in
`docs/dependency-policy.md`.

`support/harness.ts`'s `SUPPORTED_BROWSERS` is the source of truth for what this
lane can drive: `chrome`, `firefox`, `safari`. What CI *seats* is narrower.

| Browser | CI seat | How it is verified |
|---|---|---|
| Chromium | yes — the `e2e-web` step, `chromium` + `chromium-driver` from its own `apt-get install` | the whole lane, on every push that trips the `code-paths` filter |
| Firefox | driver supported (`geckodriver`); seated only where the step names it | host-local, `MYNE_WEB_E2E_BROWSER=firefox ./scripts/e2e-web-local.sh` |
| Safari | **no, and it cannot be** | manual macOS gate, per release |
| Edge | **no** | never measured, not even in the Phase 0 spike |

Safari's absence is over-determined. The **runner** is Linux-only, so no driver
choice changes it — and `safaridriver` takes neither a profile nor a headless
flag (`support/session.ts` says so where it builds the capabilities), meaning it
drives the human's own Safari and the per-session profile isolation this lane
depends on cannot be had there at all. A Safari run is a human watching, not a
suite asserting. **A scenario asserting Safari-specific storage behaviour must
say in its own text that it does not run in CI**, or the suite claims coverage it
does not have.

**The Chromium seat is not version-pinned**, and the table says so rather than
implying otherwise. The `e2e-web` step installs `chromium` and `chromium-driver`
as a matched pair from its base image's Debian archive, which is what keeps the
driver's major version in step with the browser's — chromedriver refuses a
session against a browser one major off. Signed archive, not a pinned version.

The rule that does bind is **no unpinned release-archive download in a blocking
step** — the one that makes CI install `cargo-deny` from a sha256-verified
prebuilt. It is why Firefox has no CI seat: geckodriver is not a Debian package,
so seating it means a downloaded release archive, which owes a pinned version
*and* its sha256.

## Running it

```bash
./scripts/e2e-web-local.sh                  # build the bundle, start one driver per shard, run the lane
./scripts/e2e-web-local.sh --skip-build     # reuse the existing web/dist
MYNE_WEB_E2E_BROWSER=firefox ./scripts/e2e-web-local.sh
MYNE_WEB_E2E_HEADED=1 ./scripts/e2e-web-local.sh        # watch it; there is no trace viewer
./scripts/e2e-web-one.sh smoke              # ONE spec (bare name), one driver, one shard
./scripts/e2e-web-one.sh smoke -t "headers" # …with a vitest -t name filter
```

Both runners live on the **host**, not in a container: containerising would
remove the Safari seat, which has no other home. `--skip-build` is the only flag
`e2e-web-local.sh` takes; anything else is refused rather than ignored.

Underneath them is `pnpm web:build` (the lane refuses to run without a built
bundle) and `pnpm test:e2e:web`. Calling those two by hand works, with one
caveat that costs an afternoon to rediscover: `MYNE_WEB_E2E_DRIVER_PORT` is an
**explicit opt-in** meaning "a driver is listening", not a derived default. It
was derived once, and the lane then opened its gate on every machine including
ones with no chromedriver at all — the scenario failed where it should have
skipped. `worker-ports.ts` now only offsets it into the slot's band when it is
already set, so a single hand-started driver serves slot 1 and leaves slot 2
knocking on a port nobody opened. One driver per band, or
`MYNE_WEB_E2E_SHARDS=1`.

| Variable | Meaning |
|---|---|
| `MYNE_WEB_E2E_DRIVER_PORT` | a driver is listening here (opt-in; offset per slot, `4544 + (slot - 1) * 100`) |
| `MYNE_WEB_E2E_BUNDLE_PORT` | bundle-server port; defaults to `4545` offset per slot. This is the test **ORIGIN** — overriding it by hand collapses slot isolation, and OPFS is origin-keyed |
| `MYNE_WEB_E2E_BUNDLE_DIR` | bundle to serve; defaults to `web/dist` |
| `MYNE_WEB_E2E_BROWSER` | `chrome` \| `firefox` \| `safari` (`safari`: macOS host only); defaults to `chrome` |
| `MYNE_WEB_E2E_HEADED` | `1` runs the browser headed, for local debugging; headless otherwise (CI has no display) |
| `MYNE_WEB_E2E_SHARDS` | parallel worker slots (default 2); read by both `vitest.web-e2e.config.ts` and the runner's driver count, from the same variable so they cannot disagree |
| `MYNE_WEB_E2E_QUARANTINE` | `1` runs ONLY `describeE2E.flaky` scenarios |

## Skipping is honest here, deliberately

`support/harness.ts` returns a **reason**, one sentence naming the missing thing
and its fix, and `support/scenario.ts` prints it once at import time — so even a
filtered run that matches nothing explains itself. The checks are separate rather
than one boolean because their fixes are different: a missing bundle is
`pnpm web:build`, a missing driver is a pinned install, an unsupported host is
not fixable at all. A merged "harness unavailable" sends someone to the wrong one.

The reason ORDER matters and is tested: a run configured for an unsupported
browser reports that, even when the bundle is also missing.

## Status — read this before assuming a file exists

Landed, and the tree is the authority (`git ls-files e2e-web scripts/e2e-web-*`
settles any argument with this section):

- **Support layer**, eight modules — `support/harness.ts` (the gate),
  `support/scenario.ts` (`describeE2E` + the quarantine gate),
  `support/server.ts` (the bundle server with production headers),
  `support/worker-ports.ts` (per-slot driver + bundle bands),
  `support/session.ts` (the browser session), `support/flows.ts`
  (`openApp`, `bootstrapAccount`, `unlockToEditor`, `waitForFirstSync`, …),
  `support/artifacts.ts` (redaction, so a failure dump cannot carry a
  credential) and `support/opfs-seed.ts` (the OPFS fixture seeder).
- **Fixtures** under `fixtures/`, both emitted by the shared Rust generators
  (`cargo run -p myne-core --features test-support --example …`):
  `double-buffer.json` — the six double-buffer crash cases — and
  `unlockable-vault.json`.
- **Scenarios**: `smoke` (production headers over HTTP, then a browser boot to
  the first-run identity step), `capability-gating`, `device-class-refusal`,
  `isolation-and-viewport`, `no-third-party`, `opfs-seed`, `unlock-from-fixture`,
  `pending-approval`, `plaintext-residue-web`, `a11y`, `quarantine-roundtrip`.
- **Runners and config**: `scripts/e2e-web-local.sh`, `scripts/e2e-web-one.sh`,
  `vitest.web-e2e.config.ts`, `pnpm test:e2e:web`.

Still outstanding, and worth knowing before you plan work:

- Several "What belongs here" bullets have **no scenario yet**: the single-tab
  lock, sync-required entry as its own assertion, incremental first-sync
  materialisation, and the quota precheck (unit-level only, in
  `tests/web/quota-precheck.test.ts` — `device-class-refusal` covers the other
  half of that bullet, the unsupported-environment refusal).
  `unlock-from-fixture` deliberately reaches an unlocked vault with **no** sync
  server, which is what unblocked every post-unlock surface; it does not assert
  the sync-required path itself.
- `quarantine-roundtrip` is `it.skip`, and **not** because it is flaky: the
  driver cannot click `settings.tab-sync`, so the scenario has never passed. It
  is deliberately not marked `describeE2E.flaky` — quarantine is for tests that
  *sometimes* fail, and filing a never-passing one there would bury a real gap
  in a bucket nobody reads. The header comment on the file carries the diagnosis.

**`support/session.ts` is thirty lines of capability payload and nothing else,
on purpose.** Exactly one function in `e2e/support/webdriver.ts` is
tauri-specific — `newSession` — and everything else is protocol. Re-implementing
the client here would have quietly falsified the `decisions.md` 2026-07-27
argument that the alternative to Playwright "was already built and already
justified". `Session.navigate()` was added to the shared client for this lane:
the desktop lane never navigates because there the app IS the page.

**Two isolations, two mechanisms, and conflating them shares vaults between
tests.** ORIGIN isolation (OPFS is origin-keyed) comes from `worker-ports.ts`
giving each vitest slot its own bundle-server port — that separates PARALLEL
slots. PROFILE isolation separates SUCCESSIVE scenarios within one slot, which
hit the same origin: every session gets a throwaway `--user-data-dir` /
`-profile`. Without the second one, test 2 opens test 1's vault. The capability
payload is unit-tested (`tests/web/e2e-web-session.test.ts`) precisely because
losing a profile flag is silent — it passes on a fresh machine and shares state
everywhere else.

`newBrowserSession` deliberately does **not spawn the driver**. A browser driver
is a long-lived service the RUNNER owns for the whole lane — one per shard band,
because chromedriver is multi-session but geckodriver is not — and
`MYNE_WEB_E2E_DRIVER_PORT` is an opt-in meaning "one is running". Spawning here
would make that flag a lie and re-open the bug it was introduced to fix.

**The seeder's ordering constraint is the load-bearing part.** OPFS is
origin-scoped, so fixture bytes must be written on the app's own origin — but by
the time the app has booted it has already read what it was going to read. So
`support/server.ts` serves a blank page at `/__seed`, a route that exists only in
the test server and never in the production container, and the sequence is
navigate to `/__seed` → write → navigate to `/`, onto a store that already looks
crashed. `opfs-seed.e2e.ts` exists to prove the seeder actually lands the
generator's bytes: a seeder nobody verifies is one that can silently write
nothing, and every fixture-based scenario downstream would then assert against an
empty store.
