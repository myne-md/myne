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
needs a test is the seam contract.** Dual-driving the 92 desktop scenario files
against a browser would roughly double the pipeline's slowest step to re-assert
identical source, and a second suite that duplicates the first decays into the
one nobody fixes.

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

| Browser | CI | How it is verified |
|---|---|---|
| Chromium | yes | every scenario, every push |
| Firefox | yes | every scenario, every push |
| Safari | **no** | manual macOS gate, per release |
| Edge | **no** | never measured, not even in the Phase 0 spike |

Safari's absence is a property of the **runner** (Woodpecker's is Linux-only), so
no driver choice changes it. **A scenario asserting Safari-specific storage
behaviour must say in its own text that it does not run in CI**, or the suite
claims coverage it does not have.

Browser binaries are pinned or self-hosted — **no unpinned download in a blocking
step**, the same rule that makes CI install `cargo-deny` from a sha256-verified
prebuilt.

## Running it

```bash
pnpm web:build                 # the lane refuses to run without a built bundle
pnpm test:e2e:web              # the whole lane
MYNE_WEB_E2E_DRIVER_PORT=4544 pnpm test:e2e:web   # opt in: a driver IS running
```

`MYNE_WEB_E2E_DRIVER_PORT` is an **explicit opt-in** meaning "a driver is
listening", not a derived default. It was derived once, and the lane then opened
its gate on every machine including ones with no chromedriver at all — the
scenario failed where it should have skipped. `worker-ports.ts` now only offsets
it into the slot's band when it is already set.

| Variable | Meaning |
|---|---|
| `MYNE_WEB_E2E_DRIVER_PORT` | a driver is listening here (opt-in; offset per slot) |
| `MYNE_WEB_E2E_BUNDLE_DIR` | bundle to serve; defaults to `web/dist` |
| `MYNE_WEB_E2E_BROWSER` | `chrome` \| `firefox` \| `safari` (macOS host only) |
| `MYNE_WEB_E2E_SHARDS` | parallel worker slots (default 2) |
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

Landed: `support/harness.ts` (the gate), `support/scenario.ts` (`describeE2E` +
the quarantine gate), `support/server.ts`, `support/worker-ports.ts`,
`support/session.ts`, `support/flows.ts`, `vitest.web-e2e.config.ts`,
`pnpm test:e2e:web`, and `smoke.e2e.ts` — now a real scenario (production
headers over HTTP, then a browser boot to the first-run identity step) rather
than the deliberate failure it held while the session layer was missing.

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
is a long-lived service CI starts once for the lane, and
`MYNE_WEB_E2E_DRIVER_PORT` is an opt-in meaning "one is running". Spawning here
would make that flag a lie and re-open the bug it was introduced to fix.

Not written: the local runners (`scripts/e2e-web-local.sh` / `-one.sh`), the six
double-buffer fault fixtures from the shared Rust generator, and the OPFS
worker-context seeder. MYND-574 task 105, criteria 5–6.
