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
> (`docs/decisions.md` 2026-07-26 "Web E2E policy"; procedure for both:
> `docs/dev/e2e.md`.)

> Subdirectory CLAUDE.md. Loaded when Claude works in this directory. Operating
> manual (platform constraints, local container loop, env knobs, version pins):
> `docs/dev/e2e.md`. Policy provenance: `docs/decisions.md` 2026-06-10 "E2E
> harness" entry + `myne-agents/epics/e2e-testing/sync-ledger.md`.

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
- **A frontend-only change needs the crate to relink, or the binary keeps
  ANOTHER TREE's bundle.** The frontend is embedded at compile time, so a diff
  confined to `src/`, `editor/` or any other frontend tree touches no Rust source,
  cargo relinks nothing, and `target/release/myne-desktop` keeps whatever
  `dist/` it embedded when it was last compiled. It was found in its cross-tree
  form, back when the cargo target volume was shared, so the stale bundle could be
  a **different worktree's** frontend. It happened on myne-md/myne#520: `pnpm build` emitted a correct `dist/`, the
  build reported success, and the app under test loaded
  `main-CoKDUqv9.js` out of `.claude/worktrees/554-…/dist`, whose host still
  dispatched the pre-fix event, so a correct fix's own scenario failed and read
  as "the fix does not work". The three `e2e-*.sh` build scripts now
  `touch src-tauri/src/lib.rs` before `pnpm tauri build`; **`e2e-one.sh` does
  not build at all**, so after a frontend edit it is testing the previous
  binary, which is the same trap wearing a different hat. When a scenario
  contradicts a fix you have read in the source, check WHICH bundle the WebView
  loaded before you believe it: `[...document.querySelectorAll('script[src]')]`
  from the page seat gives the hashed filename, and `find . -name '<that>'`
  says which tree it came from.
- **The cargo target volume is PER TREE, and it has to be.** Every tree is
  bind-mounted at the same in-container path, `/work`, so two checkouts of this
  repo are indistinguishable to cargo: same package, same version, same absolute
  source path. One shared volume therefore lets a build here reuse an rlib
  compiled from ANOTHER tree, and worktrees live under `.claude/worktrees/` by
  convention, so they sit inside the mount and this is the normal case rather
  than an exotic one. `scripts/lib/e2e-docker.sh` keys the volume on `pwd` and is
  sourced by all seven scripts that run this repo in the container. The cost is one
  full rebuild per tree, once, which is exactly what the sharing was buying at the
  price of results that describe a different tree.

  **The registry cache had the mirror-image defect, and it was six copies.** Every
  runner sets `CARGO_HOME=/home/e2e/.cargo`, so that is the only registry path
  cargo reads or writes, and six of the seven mounted the named volume at the
  image's `/usr/local/cargo/registry` instead. That volume held 574 MB of crate
  sources no run had consulted since the override was added, and
  `/home/e2e/.cargo` does not exist in the image at all, so every containerised
  run re-downloaded the crates.io index and every crate and then threw the result
  away with `--rm`. Nothing reports it: the run is green, only slow, which is
  exactly why it survived. `e2e-ai-buildrun.sh` found it, fixed itself, and wrote
  down that its siblings were still wrong; the mount is now in the include with
  the rest.

  **The key lives in one file because four copies of it was already the bug twice.**
  It has to be byte identical everywhere, since two scripts that hash the same tree
  differently get two volumes and the second rebuilds from scratch while looking
  like a cache. The copies also missed three call sites entirely
  (`e2e-batch.sh`, `capture-theme-preview.sh`, `capture-userguide.sh` kept the
  shared volume), and in a fourth (`e2e-local.sh`) the assignment landed INSIDE the
  `RUN_FLAGS=( … )` array literal, where bash reads it as an element rather than an
  assignment: the subshell ran, nothing was assigned, and `set -u` aborted the
  script on the next line. Neither `bash -n` nor any guard sees either shape.
- **The symptom is a compile error in code you did not touch.** A build refused
  with `run_probe` taking 2 arguments while
  `core/src/plugins/agent/probe.rs` plainly declared 3, and `ProbeProgress`
  unresolved while the struct was right there. Neither file was in the diff. The
  discriminator is two commands: `cargo check -p myne-desktop` on the host, and
  the same inside
  `docker run -v "$(pwd):/work" -v "$E2E_TARGET_VOLUME":/work/target` (source
  `scripts/lib/e2e-docker.sh` first, or pass the shared name to reproduce the
  original failure).
  Host green plus container red is the volume, and the container run itself
  clears it by recompiling the crate. Read the file through the container before
  suspecting the mount (`docker run --rm -v "$(pwd):/work" -w /work myne-e2e
  grep -n '<symbol>' <path>`); if the container sees the right source and cargo
  still disagrees, the artifact is what is wrong, not the tree.
- **A captured element handle cannot be re-found, so a click on one can only time
  out.** `Element.click` retries while WebKit reports the node is in the DOM but
  not hit-testable, which is the case it exists for. It cannot answer a node that
  has been REPLACED: the handle is stale on every poll, and the failure reads
  `waitUntil(element interactable + clicked) timed out … [stale element
  reference]`, which looks like a slow app and is not. The sidebar list
  re-renders on a save settling, on a sync tick and on the row's own selection,
  so the window between `await noteRow(...)` and `.click()` is real. Measured on
  `nco3`: one failure in eight runs after two retries, then three consecutive
  passes with no change. Drive a row with `clickNoteRow`, which re-finds inside
  the poll, the shape `clickByTestId` already uses for a bare testid.
- **`e2e-one.sh` can report a red that `e2e-buildrun.sh` does not, on the same
  tree and the same volume.** Measured on myne-md/myne#461's branch: `ws1` in
  `workspace-state.e2e.ts` passed in 3.6 s under `e2e-buildrun.sh` and then hung
  to the 180 s test timeout under `e2e-one.sh`, twice, with no source change
  between them and with `e2e/fixture-gen` already compiled (measured at 4.3 s, so
  the cold-cargo explanation in the toolchain guard is not this one). The
  mechanism is NOT established, so this says only what was observed. The rule
  that follows is: **a red from `e2e-one.sh` is a reason to re-run under
  `e2e-buildrun.sh`, never a result on its own.** `e2e-one.sh` is for iterating
  while you already believe the code is wrong; the build-and-run script is what
  produces an answer worth writing into a PR.
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
- **The `myne-e2e-target` Docker volume USED to be shared across git worktrees,
  and the volume is still on disk.** A run could fail to BUILD against a stale
  crate compiled from another branch, the giveaway being a compile error naming a
  field that exists in neither your source nor `develop` (observed:
  `PrefsView has no field named editor_vim_mode`, with the note listing
  `attachment_ocr_enabled`, a field belonging to a different feature branch). The
  per-tree keying above closed the class; this entry stays because a machine that
  ran the suite before it still has the shared volume, and because the same
  reasoning applies to any other volume shared across trees. Fix, then and now:
  `docker volume rm myne-e2e-target`, then a full rebuild (`--skip-build` is not
  enough). Same class as the shared-`CARGO_TARGET_DIR` collision, one layer down.
- **`e2e-one.sh` re-provisions the pinned Rust toolchain per run, which flakes the boot.**
  Each `e2e-one.sh` invocation spawns a fresh `--rm` container whose `RUSTUP_HOME`
  is not a persisted volume, so `rust-toolchain.toml`'s pinned toolchain re-downloads
  (~2 min) before the run; under that I/O pressure the WebKit/xvfb app boot can exceed
  the first vitest attempt's timeout, producing spurious retries and intermittent
  failures on a **deterministic** scenario. To prove a scenario green **N× consecutive**,
  pass the spec N times to `e2e-buildrun.sh` (`./scripts/e2e-buildrun.sh <spec> <spec> <spec>`):
  one build, then N runs in the **same warm container** — no per-run re-provision, no
  fresh-container boot flake. (A no-rebuild `e2e-one.sh` loop is the wrong tool for the
  3× gate.) Persisting `RUSTUP_HOME` as a volume — or baking the pinned toolchain into
  `e2e/Dockerfile` — would remove the re-provision cost; tracked as a separate infra item.
- **`rustc ... (signal: 9, SIGKILL)` on `myne_desktop_lib` is the OOM killer, not a compile
  error, and the message says neither.** What the runner prints is `error: could not compile
  myne-desktop (lib)` followed by the whole rustc invocation and `failed to build app`, which
  reads exactly like a broken build and sends you looking at the diff. Nothing in it mentions
  memory. The cause is the VM's ceiling against cargo's default parallelism: a colima or
  Docker Desktop VM is commonly 8 to 10 GiB, an unrelated container stack can hold a couple of
  those, and eight concurrent `opt-level=3` rustc jobs on the top crate do not fit in what is
  left. The tell is that the SAME commit built minutes earlier, and that the failure moves
  between runs rather than naming a line. Fix by capping jobs rather than by touching the
  code: `CARGO_BUILD_JOBS=3` costs wall clock and changes nothing about the artifact, so the
  run still proves what the 3× gate asks. `docker stats --no-stream` during the build is how
  you confirm it, and it is worth doing before believing a red build on an unchanged tree.
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
  record the debt on the tracking issue — a real failure marked `.flaky` is a
  real failure nobody will see. Currently quarantined: `nav1`, `tp1`, `ci1`, `gp1`,
  `gp2`, `svc1`, `tor1`.
- **"Runner contention" was the wrong diagnosis, and the quarantine list is
  built on it.** The flake reproduces on an IDLE machine — same spec, one warm
  container, nothing else running: 4 failures in 21 runs (~19 %), every one of
  them `waitUntil(waitForElement([data-testid="notes.new-menu-dropdown"]))
  timed out after 45000 ms`. Durations were bimodal (~11 s or ~52–61 s, nothing
  between), which is a stuck wait, not a loaded host. It was never visible
  because `retry: 2` rescued the second attempt and the suite reported green —
  the failing attempt never reached a report at all. The cause was
  `flows.ts::clickNewMenuItem` firing the `+` trigger ONCE and then waiting the
  full budget on the dropdown, with nothing to re-click when that click missed;
  it now re-clicks until the menu is actually up. 75 of the 123 spec files reach
  that helper, which is why the victim was a different scenario every run, and
  each occurrence added a full 45 s, which is most of where the "~20-min serial
  run" came from. Raising `DEFAULT_TIMEOUT_MS` 20 s → 45 s therefore fixed
  nothing; it doubled the price of each occurrence.
  **Consequence for this list:** five of the seven quarantined specs (`nav1`,
  `tp1`, `gp1`/`gp2`, `svc1`) go through that helper and are candidates for
  release — but candidacy is not evidence. Un-quarantine one only after running
  it `--retry=0` in a warm container ~15× with zero failures, which is the same
  bar that proved the fix. `tor1` and `ci1`'s spec do NOT use the helper, so
  they are separate debts: `tor1` is a fake-sidecar posture timeout (raise its
  20 s budget or fix a handshake bug), not a network limit.
- **The contention diagnosis was wrong a second time, and the real cause was the
  driver PORT** (myne-md/myne#529). `gp1`, `gp2`, `nav1` and `sd1` were all
  sitting on the **Welcome screen** with a correctly seeded vault, which
  `initialStageFromProbe` reaches on exactly one input: `vault_list` answering
  zero. Every scenario in a worker launches its own `tauri-driver` on the same
  port, `teardown` sent SIGTERM, slept 200 ms, sent SIGKILL and returned WITHOUT
  waiting, and `waitForDriver` can only ask whether SOMETHING is answering
  there. So a scenario routinely attached to the previous scenario's dying
  driver, and that driver spawns the app with ITS environment — an
  `XDG_DATA_HOME` pointing at the `dataHome` the same teardown had just deleted.
  The app found no `vaults/`, took the legitimate fresh-install path, and the
  scenario waited its whole budget for an unlock screen that was never coming.
  It explains every property contention could not: more timeout never helped
  (the app is pointed at a deleted directory forever), it worsened at the tail
  of a run (process death is slower under load), and it reproduced on an idle
  machine now and then (the race is small, not absent). `launchApp` now RESOLVES
  a free port rather than insisting on one, because a full local run proved
  waiting is not enough: something held 4544 more than twenty seconds after
  being SIGKILLed as a group. Measured either side of the fix, same warm
  container: 2 failures then 0, and the suite got 62 s FASTER (758 s → 696 s),
  because a burned 45 s budget costs more than the fix does.
- **Every one of those failures was a permanent state a bigger budget cannot
  reach, and the family is larger than the port.** The same shape turned up
  seven times in one pass: an event emitted before its listener existed (Tauri
  `emit` has no replay), the deleted-directory launch above, a control below the
  fold of a nested `overflow` container (WebDriver's own pre-click scroll does
  not reliably reach one in WebKit), a query the driver truncated during a focus
  settle, an `<img>` the widget leaves hidden forever on a load `error`, a widget
  never built because the per-mount catalog had not resolved, and a fake sidecar
  that never reached either branch of its `listen`. **When a wait times out,
  ask what would have to CHANGE for it to succeed, and if the answer is
  "nothing", raising the number is the one fix guaranteed not to work.** The
  helpers now say which of their several silent arms kept firing, and that is
  what turned six of these from guesses into measurements.
- **A helper that VERIFIES nothing is the same family, and it hides behind the
  helper that comes after it.** `eo1` failed CI pipeline 653 three attempts
  running, reporting the raw `![[att:…]]` text sitting in the buffer with no
  widget over it. Nothing about that message points at typing, and every embed
  scenario had a private `typeRaw` that sent the payload with `sendKeys` and then
  returned: `sendKeys` resolving means the DRIVER accepted the keys, not that
  CodeMirror applied them, and a garbled payload is not a Wikilink node, so the
  embed decoration is never built and the raw text stays forever. The failure
  then surfaces inside the NEXT helper, wearing the name of an attachment
  problem. Same file, second defect, same shape: the keystroke probe types `q`
  on every poll of its `waitUntil` and all six copies sent exactly one
  Backspace, so a poll that looped left surplus characters ahead of the payload.
  Both are now `typeEmbedIntoEditor` in `support/flows.ts`, and both are pinned
  by `tests/scripts/e2eEmbedTyping.test.ts` against a fake `Session` running the
  real `waitUntil`, because the mechanism of the first one IS "the poll ran more
  than once" and no container run reproduces it on demand.
- **When four rounds of hardening a helper each fix the shape CI just showed, the
  defect is the INPUT METHOD, not the check.** Typing `![[att:…]]` races
  CodeMirror's bracket auto-close: `[` inserts a closing `]`, and under
  full-suite load the caret update and the incoming characters interleave. Two
  permanent outcomes, both measured on the SAME commit — pipeline 661 got an
  empty-target `cm-wikilink-chip-broken` with the payload behind it as plain
  text, pipeline 664 got an unterminated span that is not a Wikilink node at all,
  so nothing ever decorates it. Each round's check was correct about the shape it
  had been shown and blind to the next one. The embed scenarios now WRITE the
  embed through the real `note_update` IPC (`seedEmbedIntoNote`) and reopen the
  note, which three scenarios in this suite already did for the reason
  `sync-replication.e2e.ts` states in one line: "deterministic note_update IPC,
  no flaky editor typing". What that gives up is stated in the helper: these
  scenarios never meant to prove a user can type an embed, and typing is covered
  where it IS the subject.
- **A helper that owns a reload owns everything the reload undoes.** Two
  scenarios broke the moment seeding started calling `refresh()`, in ways that
  looked nothing like a reload problem: `waitForSaved` burned its full budget
  (the write no longer goes through the editor, so the autosave badge never
  leaves its pre-edit state), and `attachment-image.menu` "never rendered"
  because the fresh-vault importer OVERLAY came back and swallowed the click.
- **A raw `.click()` followed by a wait is the single most common shape behind a
  timeout that reads like a dead surface**, and it kept being written after
  `clickNewMenuItem` had already been fixed for it. `eo1` and `za1` both clicked
  a widget control once and then waited 45 s for a surface that a missed click
  can never produce. `clickByTestId` hit-tests and scrolls the control into its
  own container; wrapping it in a re-click loop keyed on the surface appearing is
  what makes the wait an assertion rather than a hope.
- **Diagnose the DOM the way the code renders it, or the diagnostic lies with
  confidence.** The same helper's first message read the source text and
  reported "the `att:` text never landed" whenever it was absent. Every embed
  widget is an ATOMIC `Decoration.replace`, so the moment any of them builds the
  source leaves the DOM: a note whose text landed perfectly and is being drawn
  as a tombstone reported as a typing failure. Worse, the tombstone is
  DELIBERATELY shared between "the catalog has not loaded yet" and "the catalog
  loaded without this id" (a broken-image flash is the alternative), so the two
  are indistinguishable from the page and only a `catalog_list` from the page
  seat separates them. A probe has to enumerate the states the RENDERER can be
  in, not the ones the test author was thinking about.
- **Hunt flake with `MYNE_E2E_RETRIES=0`**, which all three runners now take
  (`e2e-one.sh`, `e2e-batch.sh`, `e2e-local.sh`), along with
  `MYNE_E2E_QUARANTINE=1` and `MYNE_E2E_AI=1`. None of them did until
  myne-md/myne#529, which is why that round cost ten CI pipelines: this file had
  been telling people to hunt flake with retries off while no runner could turn
  them off, and a quarantined spec was unreachable from a developer machine at
  all. The quarantine one has a measured failure behind it — a release run of
  `tp1` reported PASS having executed ZERO tests, and only the batch script's
  three-bucket tally caught it. With retries on, a failing attempt is erased
  from the report and the flake rate reads as zero no matter how bad it is.
  Repeat the spec in ONE warm container and always discard a warm-up run: the
  first suite invocation in a fresh container costs ~40 s more than every one
  after it (the `RUSTUP_HOME` re-provision above), and an A/B that does not
  absorb it will measure that instead of whatever it meant to measure — badly
  enough to invert the sign when the arms are swapped.
- States unreachable through real UI are NOT forced into E2E: downgrade to a
  Vitest component test (mocked `invoke`) and record the downgrade on the
  tracking issue.
- **A helper that WAITS for a surface without OPENING it fails every scenario at
  the same line, and reads as a flake.** `agent-run.e2e.ts` shipped an
  `openAgentComposer` that only waited for `agentComposer.root`; that component
  renders solely while the right pane's active tab is `ai-chat`, which nothing
  had opened, so all five scenarios timed out identically at 15 s. The file
  compiled, the testids were correct, and none of it ran. When a surface lives
  behind a tab, a mode or a panel, the helper's first line is the one that
  *opens* it (`runPaletteAction(s, "ai.open-chat", "chat")` here), and the wait
  is the assertion that opening worked.
- **The AI lane needs BOTH halves, and until recently neither was reachable
  locally.** A scenario gated on `MYNE_E2E_AI=1` also needs the binary built
  `--features local-inference-stub`, or `StubEngine` is not the backend and the
  gate is meaningless; `.woodpecker.yml` pairs them and `e2e-buildrun.sh`
  supplies neither. That is the mechanism by which a whole family of specs was
  written and never run once on a developer machine. `scripts/e2e-ai-buildrun.sh`
  pairs them; repeating a spec argument runs it that many times in the same warm
  container, which is the shape the 3x gate wants.
- **A stub engine that ECHOES cannot drive a tool-calling loop.** The agent's
  system instructions list every action as a literal JSON line so a model can
  copy the shape, so echoing the prompt back parses as all of them at once and
  ends at `finish` with an empty proposal. Three scenarios asserted a non-empty
  proposal and could never have passed. `StubEngine::agent_script` is the fixed
  script that fixes it, and its own tests assert the echo could not have worked.
