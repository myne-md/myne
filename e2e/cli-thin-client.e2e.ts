// CLI terminal-access suite (cli-thin-client task 14; MYND-490;
// `docs/decisions.md` "CLI terminal access is a default-off, unlock-gated local
// socket with a folder exclusion list (MYND-490)"; `docs/threat-model.md` §7).
//
// This is the ONLY lane that drives both halves of the door at once: the
// production desktop binary through tauri-driver, and the production `myne`
// binary as a real child process talking to it over the real Unix socket.
// Everything below the socket already has dense unit coverage on both sides
// (`cli_bridge::*` on the desktop, `cli/src/*` plus `cli/tests/` on the CLI);
// what NO unit test can reach is the part these six scenarios own — that the
// UI toggle a user actually clicks moves the socket a script actually connects
// to, and that the exit code a script branches on is the one the running app
// produces.
//
//   cli1 — ENABLE: the door is shut on a fresh unlocked vault; flipping
//          Settings → Privacy → Terminal access opens it, and the socket is
//          not merely present but ANSWERS a real `myne list`.
//   cli2 — ROUND TRIP: a note written through the real editor comes back out
//          of `myne search`, and its id reads back through `myne show` with
//          the body intact. The UI writes, the terminal reads.
//   cli3 — LOCKED: locking the vault takes the door with it. The CLI refuses
//          with the locked exit code, prompts for nothing, and the attempt
//          leaves the app locked.
//   cli4 — DISABLED: with the toggle off, the refusal names Settings and is
//          distinguishable from "app not running" — the whole reason the
//          `cli-status` marker exists (`cli_bridge/status.rs` module docs).
//   cli5 — EXCLUDED: a note in an excluded folder is absent from `list`, from
//          `search`, and from `show` (which answers `not_found`, the same
//          reply an unknown id gets), while an in-scope sibling stays visible.
//   cli6 — HIDDEN IS NOT DISABLED (#181): the Terminal-access block now lives
//          behind Developer mode, and turning that mode back off must take the
//          CONTROL away without touching the DOOR. Its own toggle is the only
//          thing that closes the socket — the alternative (a visibility switch
//          that silently revokes an external client's access) is the surprise
//          the issue rejected by name.
//
// # Why the CLI is spawned with `XDG_DATA_HOME` and that is NOT a test hook
//
// `cli/src/paths.rs::app_data_dir` resolves through `dirs::data_dir()`, which
// on Linux reads `$XDG_DATA_HOME` — the same variable `support/session.ts`
// already exports on the driver process to give each app instance its isolated
// data dir (SYNC-2). So pointing the CLI at `app.dataHome` steers PRODUCTION
// path resolution, unchanged, exactly as it would resolve for a user whose
// session sets that variable. There is no `--socket` flag, no env var the
// binary knows about, and nothing here that ships. `cli/tests/logging_
// discipline.rs` uses the same steering against a fake desktop; this suite
// points it at the real one.
//
// # KDF + credential discipline
//
// Weak-KDF generator fixtures (params are `vault.meta`-resident). The password
// never reaches the CLI — the door never prompts, which is half of cli3's
// point — and never reaches an assertion diff (SYNC-13). Note bodies DO reach
// stdout, deliberately: printing a note is the feature. The needles below are
// in-source scenario constants, the accepted exception.
//
// Vault-count precondition: 1 (weak KDF) for all six scenarios.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, it } from "vitest";

import { seedVault } from "./support/fixtures";
import { KEY, pressKey } from "./support/keyboard";
import {
  closeSettings,
  createNote,
  dismissImporterOffer,
  enableDeveloperMode,
  openSettings,
  typeIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import { describeE2E, scenario } from "./support/scenario";
import { defaultAppPath, type AppSession } from "./support/session";
import { type Session } from "./support/webdriver";

// ---- the duplicated-by-design contract, from this side --------------------
//
// These two basenames are the THIRD independent copy of a wire contract that
// `cli/src/paths.rs` and `src-tauri/src/cli_bridge/{socket,status}.rs` already
// hold separately on purpose (the CLI crate depends on neither the desktop nor
// `myne-core`). `scripts/check-cli-sidecar.mjs` is what keeps all three in
// step — it greps these exact declarations, so keep the
// `const NAME = "value";` shape if you touch them.
const SOCKET_BASENAME = "cli.sock";
const STATUS_BASENAME = "cli-status";

/** Exit codes, mirroring `cli/src/exit.rs`. A script branches on these, so a
 *  changed number is a compatibility break — asserting them here by literal
 *  is the point, not an incidental detail. */
const EXIT = {
  OK: 0,
  VAULT_LOCKED: 4,
  CLI_DISABLED: 5,
  NOT_FOUND: 6,
} as const;

/** `cli_bridge::status`'s one-byte marker: Disabled / Locked / Open. */
type DoorByte = "D" | "L" | "O";

/** The production `myne` binary. Derived from the app path's directory so a
 *  `MYNE_E2E_APP` override carries the sidecar with it (a `tauri build` lands
 *  the staged sidecar next to the app binary as `<profile>/myne` — see
 *  `scripts/build-cli-sidecar.mjs`), with its own override for the odd layout. */
function cliBinary(): string {
  return process.env.MYNE_E2E_CLI ?? join(dirname(defaultAppPath()), "myne");
}

/** Requests are budgeted: the door serves 120 per 60 s by default
 *  (`cli_bridge::rate_limit::DEFAULT_MAX_PER_WINDOW`). Every poll loop below
 *  that talks to the socket ticks at this interval so a scenario cannot spend
 *  its own budget and then assert on a `rate_limited` refusal it caused. */
const CLI_POLL_MS = 1_000;
/** Filesystem-only polling (the marker + the socket inode) costs the door
 *  nothing, so it can be tight. */
const FS_POLL_MS = 250;
/** The lifecycle supervisor re-evaluates the gate once a second
 *  (`cli_bridge::SUPERVISOR_TICK`); this budgets many ticks for a contended
 *  runner, and a real regression still fails rather than hangs. */
const DOOR_TIMEOUT_MS = 30_000;
/** A `myne` invocation is a socket round trip. Generous, and load-bearing in
 *  cli3: a CLI that BLOCKED (i.e. prompted) must fail this suite rather than
 *  stall it, which is why `runCli` treats a signal-kill as an error. */
const CLI_TIMEOUT_MS = 30_000;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the production `myne` binary against this app session.
 *
 * `input` is always passed (empty by default), so stdin is a closed pipe
 * rather than the test runner's terminal — a command that tried to read a
 * password would see EOF instead of hanging forever.
 */
function runCli(app: AppSession, args: string[], input = ""): CliRun {
  const result = spawnSync(cliBinary(), args, {
    env: { ...process.env, XDG_DATA_HOME: app.dataHome },
    input,
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
  });
  if (result.error) {
    throw new Error(`myne ${args.join(" ")} did not spawn: ${result.error.message}`);
  }
  if (result.status === null) {
    // Killed by a signal / the timeout: the process did not decide its own
    // exit. For this door that is a failure with a name — it never prompts and
    // never waits on a human, so a blocked `myne` is a defect, not slowness.
    throw new Error(
      `myne ${args.join(" ")} never exited on its own (signal ${result.signal ?? "none"}) — ` +
        `this door refuses, it does not wait for input`,
    );
  }
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The `--json` envelope (`cli/src/output.rs`), parsed. */
interface CliEnvelope {
  ok: boolean;
  notes?: string[];
  body?: string;
  results?: Array<{ id: string; title: string }>;
  id?: string;
  error?: { kind: string; message: string };
}

function envelope(run: CliRun): CliEnvelope {
  try {
    return JSON.parse(run.stdout.trim()) as CliEnvelope;
  } catch {
    // Never echo stdout: on a `show` it is note plaintext.
    throw new Error(`--json output was not a JSON envelope (${run.stdout.length} bytes, exit ${run.code})`);
  }
}

/** Current door byte, or `null` when the marker is absent/garbled — which is
 *  what the CLI itself reads as "the app is not running at all". */
function doorState(app: AppSession): DoorByte | null {
  try {
    const raw = readFileSync(join(app.appDataDir, STATUS_BASENAME), "utf8").trim();
    return raw === "D" || raw === "L" || raw === "O" ? raw : null;
  } catch {
    return null;
  }
}

/** Whether the command socket exists AS A SOCKET — `isSocket()` rather than a
 *  bare existence check, so a leftover regular file of the same name can never
 *  read as an open door. */
function socketPresent(app: AppSession): boolean {
  try {
    return statSync(join(app.appDataDir, SOCKET_BASENAME)).isSocket();
  } catch {
    return false;
  }
}

/** Poll `probe` until it returns non-null, then hand that value back. The
 *  harness's own retry loop (`Session.waitUntil`) rather than a second one:
 *  same deadline/interval shape, same timeout message, and the probes here
 *  are synchronous filesystem/subprocess reads it drives just as happily as
 *  a DOM one. */
function until<T>(
  app: AppSession,
  label: string,
  probe: () => T | null,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<T> {
  return app.session.waitUntil(async () => probe(), { label, ...opts });
}

/**
 * Wait until the door reaches `want` — marker byte AND socket presence
 * together, because either alone is half the fact: the marker is advisory
 * (`cli_bridge/status.rs` says so), and the socket's existence IS the access
 * gate. Both must agree before a scenario proceeds.
 */
async function waitForDoor(app: AppSession, want: DoorByte): Promise<void> {
  await until(
    app,
    `CLI door reached "${want}"`,
    () => {
      const marker = doorState(app);
      const socketAgrees = want === "O" ? socketPresent(app) : !socketPresent(app);
      return marker === want && socketAgrees ? true : null;
    },
    { timeoutMs: DOOR_TIMEOUT_MS, intervalMs: FS_POLL_MS },
  );
}

/** Wait until the UI reflects `expected` on the Terminal-access block. */
async function waitToggleReflects(session: Session, expected: "true" | "false"): Promise<void> {
  await session.waitUntil(
    async () =>
      (await (await session.byTestId("settings.cli-access")).attribute("data-enabled")) === expected
        ? true
        : null,
    { label: `cli access toggle = ${expected}`, timeoutMs: 15_000 },
  );
}

/** Settings → Developer mode → Privacy → flip Terminal access on, then close
 *  Settings. Leaves the caller to wait on the door itself: the toggle's
 *  reflected attribute is optimistic (see `CliAccessSettings.tsx`), so it
 *  proves the click landed, never that `vault.prefs` was written.
 *
 *  Developer mode first (#181): the Terminal-access block is hidden while the
 *  mode is off, so the block is not merely unclicked here — it is not in the
 *  DOM. `enableDeveloperMode` leaves Settings open on About, hence the rail
 *  click rather than a second `openSettings`. */
async function enableCliAccess(session: Session): Promise<void> {
  await enableDeveloperMode(session);
  await (await session.byTestId("settings.tab-privacy")).click();
  await session.byTestId("settings.cli-access");
  await (await session.byTestId("settings.cli-access-toggle")).click();
  await waitToggleReflects(session, "true");
  await closeSettings(session);
}

describeE2E("cli1 CLI access opens the command socket (MYND-490)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("enabling Terminal access in Settings makes the socket answer a real command", async () => {
    let password = "";
    await scenario(
      "cli1-enable-opens-socket",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Default-off: unlocked is not enough. The marker says Disabled and
        // there is no socket to connect to.
        await waitForDoor(app, "D");

        await enableCliAccess(s);

        // The supervisor re-reads `vault.prefs` each tick, so the marker
        // reaching "O" is itself proof the write reached disk.
        await waitForDoor(app, "O");

        // Present is not reachable. A real command over the real socket is.
        const run = runCli(app, ["--json", "list"]);
        expect(run.code).toBe(EXIT.OK);
        const parsed = envelope(run);
        expect(parsed.ok).toBe(true);
        // A fresh vault has no notes; `notes` is present regardless (the
        // envelope shape does not vary with the result set).
        expect(Array.isArray(parsed.notes)).toBe(true);
      },
    );
  });
});

describeE2E("cli2 search + show round trip over the command socket (MYND-490)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a note written in the editor comes back through myne search and myne show", async () => {
    // 27 lowercase-alnum chars, one token — survives the search tokenizer and
    // cannot collide with app chrome.
    const NEEDLE = "clithinclientroundtripneedle";
    let password = "";
    await scenario(
      "cli2-search-show-round-trip",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await enableCliAccess(s);
        await waitForDoor(app, "O");

        // Write through the REAL editor, not the CLI's own `new`: the story is
        // "what I wrote in the app is what the terminal sees".
        await createNote(s, "cli round trip");
        await typeIntoEditor(s, NEEDLE);
        await waitForSaved(s);

        // The search index is populated through the vault-lifecycle hooks on
        // save, so the hit can trail the autosave badge by a moment. Bounded
        // poll — a genuinely missing note still fails.
        const hit = await until(
          app,
          "myne search returned the note",
          () => {
            const run = runCli(app, ["--json", "search", NEEDLE]);
            if (run.code !== EXIT.OK) return null;
            const results = envelope(run).results ?? [];
            return results.length > 0 ? results[0] : null;
          },
          { timeoutMs: 20_000, intervalMs: CLI_POLL_MS },
        );

        // The advisory is fixed text on every invocation and goes to stderr, so
        // stdout stays pipe-clean for a script. Asserting it here is what makes
        // cli5's "no count of what was hidden" claim checkable: the same line
        // appears whether or not anything was filtered.
        const searchAgain = runCli(app, ["--json", "search", NEEDLE]);
        expect(searchAgain.stderr).toContain("see Settings");

        const shown = runCli(app, ["--json", "show", hit.id]);
        expect(shown.code).toBe(EXIT.OK);
        expect(envelope(shown).body ?? "").toContain(NEEDLE);

        // Human mode is the `cat` this feature restores: the body verbatim on
        // stdout, no envelope, no chrome.
        const shownPlain = runCli(app, ["show", hit.id]);
        expect(shownPlain.code).toBe(EXIT.OK);
        expect(shownPlain.stdout).toContain(NEEDLE);
      },
    );
  });
});

describeE2E("cli3 a locked vault closes the door (MYND-490)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("locking Myne makes the CLI refuse with the locked code and prompt for nothing", async () => {
    let password = "";
    await scenario(
      "cli3-locked-refusal",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await enableCliAccess(s);
        await waitForDoor(app, "O");

        // Lock through the real Lock button. No CLI-specific code path runs
        // here — the supervisor sees the slot go empty and tears the socket
        // down, which is the same mechanism auto-lock relies on.
        await (await s.byTestId("editor.lock-cta")).click();
        await s.byTestId("unlock.password-input");
        await waitForDoor(app, "L");

        const run = runCli(app, ["list"]);
        expect(run.code).toBe(EXIT.VAULT_LOCKED);
        // Distinguishable from "app not running" (exit 3) — the marker is what
        // makes that possible, since the socket's absence looks identical.
        expect(run.stderr).toContain("Myne is locked");

        // Nothing anywhere in the refusal asks for a credential, in either
        // channel: no password prompt, no phrase prompt, no offer to unlock.
        const both = `${run.stdout} ${run.stderr}`.toLowerCase();
        for (const word of ["password", "passphrase", "recovery", "pin"]) {
          expect(both).not.toContain(word);
        }

        // And the attempt did not move the app: still locked, still no socket.
        // A door that could be opened by knocking would fail here.
        await s.byTestId("unlock.password-input");
        expect(socketPresent(app)).toBe(false);
        expect(doorState(app)).toBe("L");
      },
    );
  });
});

describeE2E("cli4 disabled CLI access refuses and names Settings (MYND-490)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("the default-off door refuses with the disabled code, not the not-running one", async () => {
    let password = "";
    await scenario(
      "cli4-disabled-refusal",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Unlocked, running, never enabled: the marker exists and says "D".
        // That the marker EXISTS is the load-bearing half — it is the only
        // thing separating this refusal from "Myne is not running".
        await waitForDoor(app, "D");

        const run = runCli(app, ["list"]);
        expect(run.code).toBe(EXIT.CLI_DISABLED);
        expect(run.stderr).toContain("Enable it in Myne's Settings");
        // The refusal must point at Settings rather than at the app's absence:
        // asserting the wrong-answer copy is absent is what catches a marker
        // that stopped being written.
        expect(run.stderr).not.toContain("not running");

        // `--json` carries the same fact as a machine-readable kind, which is
        // what a script branches on when it does not parse text.
        const jsonRun = runCli(app, ["--json", "list"]);
        expect(jsonRun.code).toBe(EXIT.CLI_DISABLED);
        const parsed = envelope(jsonRun);
        expect(parsed.ok).toBe(false);
        expect(parsed.error?.kind).toBe("cli_disabled");
      },
    );
  });
});

describeE2E("cli5 an excluded folder is absent from every CLI answer (MYND-490)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("excluding a folder removes its note from list, search and show", async () => {
    const EXCLUDED_FOLDER = "Private";
    const EXCLUDED_NEEDLE = "clithinclientexcludedneedle";
    const IN_SCOPE_NEEDLE = "clithinclientinscopeneedle";
    let password = "";
    await scenario(
      "cli5-excluded-folder",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await enableCliAccess(s);
        await waitForDoor(app, "O");

        // Two notes, written while the folder is still IN scope — writing into
        // an excluded folder is refused outright (task 8), so the exclusion has
        // to come second.
        const excluded = runCli(
          app,
          ["--json", "new", "--folder", EXCLUDED_FOLDER],
          `${EXCLUDED_NEEDLE}\n`,
        );
        expect(excluded.code).toBe(EXIT.OK);
        const excludedId = envelope(excluded).id ?? "";
        expect(excludedId).not.toBe("");

        const inScope = runCli(app, ["--json", "new"], `${IN_SCOPE_NEEDLE}\n`);
        expect(inScope.code).toBe(EXIT.OK);
        const inScopeId = envelope(inScope).id ?? "";
        expect(inScopeId).not.toBe("");

        // POSITIVE CONTROL. Without this, every absence below could pass
        // against a door that answers nothing at all.
        const before = envelope(runCli(app, ["--json", "list"])).notes ?? [];
        expect(before).toContain(excludedId);
        expect(before).toContain(inScopeId);
        expect(envelope(runCli(app, ["--json", "show", excludedId])).body ?? "").toContain(
          EXCLUDED_NEEDLE,
        );

        // Exclude the folder through the real textarea. It commits on blur, so
        // Tab out of the field rather than reaching for the DOM.
        await openSettings(s, "privacy");
        const textarea = await s.byTestId("settings.cli-excluded-folders");
        await textarea.replaceText(EXCLUDED_FOLDER);
        await pressKey(s, KEY.TAB);
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("settings.cli-exclusions")).attribute("data-folder-count")) ===
            "1"
              ? true
              : null,
          { label: "one excluded folder registered", timeoutMs: 15_000 },
        );
        await closeSettings(s);

        // The reflected count is optimistic; the door reads `vault.prefs` from
        // disk, so poll the door until it has the new scope. Bounded — a filter
        // that never took effect fails here.
        const listAfter = await until(
          app,
          "the excluded note left myne list",
          () => {
            const notes = envelope(runCli(app, ["--json", "list"])).notes ?? [];
            return notes.includes(excludedId) ? null : notes;
          },
          { timeoutMs: 20_000, intervalMs: CLI_POLL_MS },
        );
        // NEGATIVE CONTROL, same call: the in-scope sibling is still there, so
        // the disappearance is the filter and not an empty answer.
        expect(listAfter).toContain(inScopeId);

        // Search: absent, with no count and no marker of what was hidden — the
        // stderr advisory is the same fixed line cli2 already saw with nothing
        // filtered at all.
        const search = runCli(app, ["--json", "search", EXCLUDED_NEEDLE]);
        expect(search.code).toBe(EXIT.OK);
        expect(envelope(search).results ?? []).toHaveLength(0);
        expect(search.stderr).toContain("see Settings");
        const searchInScope = runCli(app, ["--json", "search", IN_SCOPE_NEEDLE]);
        expect((envelope(searchInScope).results ?? []).map((r) => r.id)).toContain(inScopeId);

        // Show: an excluded id is indistinguishable from an unknown one —
        // same `not_found`, same exit code, no separate "excluded" reply.
        const show = runCli(app, ["--json", "show", excludedId]);
        expect(show.code).toBe(EXIT.NOT_FOUND);
        expect(envelope(show).error?.kind).toBe("not_found");
        const unknown = runCli(app, ["--json", "show", "not-a-real-note-id"]);
        expect(unknown.code).toBe(show.code);
        expect(envelope(unknown).error?.kind).toBe(envelope(show).error?.kind);
      },
    );
  });
});

describeE2E("cli6 hiding the Terminal-access control does not close the door (#181)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("turning Developer mode back off removes the block but leaves the socket serving", async () => {
    let password = "";
    await scenario(
      "cli6-hidden-not-disabled",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await waitForDoor(app, "D");

        // Developer mode on, Terminal access on, door open — the cli1 baseline.
        await enableCliAccess(s);
        await waitForDoor(app, "O");

        // Now hide the group again. `developer_mode` is a VISIBILITY switch:
        // the control it governs disappears, the preference it does not govern
        // (`cli_enabled`) is untouched.
        await openSettings(s, "about");
        await (await s.byTestId("about.developer-mode-toggle")).click();
        await s.waitUntil(
          async () =>
            (await (await s.byTestId("about.developer-mode-toggle")).attribute("aria-checked")) ===
            "false"
              ? true
              : null,
          { label: "developer_mode toggled off", timeoutMs: 10_000 },
        );

        // The control is gone from Privacy…
        await (await s.byTestId("settings.tab-privacy")).click();
        await s.byTestId("settings.auto-lock-select");
        expect((await s.byTestIdAll("settings.cli-access")).length).toBe(0);
        await closeSettings(s);

        // …and the door is still open. Asserted through the marker AND a real
        // command: the marker alone would only prove the supervisor's view of
        // `vault.prefs`, not that a terminal can still walk through.
        await waitForDoor(app, "O");
        const run = runCli(app, ["--json", "list"]);
        expect(run.code).toBe(EXIT.OK);
        expect(envelope(run).ok).toBe(true);
      },
    );
  });
});

// cli7 — myne-md/myne#555's `cli.read_commands` bullet:
//
//   > a note body containing raw ANSI escapes: passing them through verbatim
//   > and neutralising them are DIFFERENT byte streams, so asserting which one
//   > stdout carries settles whether a terminal can be cleared.
//
// # This scenario SETTLES a question rather than asserting a preference
//
// `print_show`'s own doc calls human mode "the `cat` this feature exists to
// restore — the body verbatim on stdout, no decoration, no trailing chrome,
// pipe-clean". Verbatim is therefore the deliberate design and this scenario
// pins it; what it adds is that the consequence is now written down and
// machine-checked rather than implied.
//
// The consequence, stated plainly because a reader of this file is the person
// who would need it: **a note body can drive the terminal that shows it.** An
// ESC sequence in a note reaches the tty unmodified, so `myne show` can clear
// the screen, move the cursor, or repaint earlier output, exactly as `cat` on
// any file can. That is `cat`'s contract and Myne chose it knowingly.
//
// What makes it worth a scenario rather than a shrug is where a note body can
// come from. `myne-clipper`'s capture walker runs "in the adversary-controlled
// page DOM (A14 / TB10)" and its text normaliser is
// `text.replace(/\s+/g, " ")` — and JavaScript's `\s` does NOT include U+001B.
// So a page's ESC bytes survive capture into a note, and the note is later
// `myne show`n into a terminal. Whether that chain should be closed, and on
// which side, is a decision; this scenario makes the CLI half of it a
// measured fact instead of an assumption.
//
// The note is written through the CLI's own `new` rather than typed into the
// editor, deliberately: driving raw control characters through CodeMirror would
// test the driver's key handling, and what is under test is the byte path.
describeE2E("cli7 a note body reaches stdout byte-for-byte (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("passes ANSI escapes through verbatim in human mode and escapes them in --json", async () => {
    // ESC[2J is "clear screen"; ESC[1;1H is "cursor home". Built from the code
    // point rather than pasted, so the file itself stays free of control bytes.
    const ESC = String.fromCharCode(0x1b);
    const CLEAR = `${ESC}[2J${ESC}[1;1H`;
    const MARKER = "clianseescapemarkerzzz";
    const BODY = `# ansi\n\n${CLEAR}${MARKER}\n`;

    let password = "";
    await scenario(
      "cli7-ansi-passthrough",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await enableCliAccess(s);
        await waitForDoor(app, "O");

        // Write the hostile-shaped body in through the door.
        const created = runCli(app, ["--json", "new"], BODY);
        expect(created.code).toBe(EXIT.OK);
        const id = envelope(created).id;
        expect(id, "myne new returned no id").toBeTruthy();

        // 1. HUMAN MODE: verbatim. The ESC bytes are on stdout, unmodified and
        //    uncounted — this is the `cat` contract, and it is what makes a
        //    note able to drive the terminal showing it.
        const human = runCli(app, ["show", id!]);
        expect(human.code).toBe(EXIT.OK);
        expect(
          human.stdout.includes(CLEAR),
          "the ESC sequence did not survive `myne show` verbatim. If it is now " +
            "neutralised that is a deliberate change to the `cat` contract " +
            "print_show documents — update this scenario and say so.",
        ).toBe(true);
        expect(human.stdout).toContain(MARKER);
        // The count matters as much as the presence: a partial strip that left
        // one of the two sequences would still contain `CLEAR`… but not twice.
        expect(human.stdout.split(ESC).length - 1).toBe(2);

        // 2. --json: the SAME bytes, but JSON-escaped, so a script parsing the
        //    envelope never has them applied to its own terminal. The two
        //    streams differ, which is the bullet's whole point — one is safe to
        //    pipe into a parser and the other is safe to look at.
        const json = runCli(app, ["--json", "show", id!]);
        expect(json.code).toBe(EXIT.OK);
        expect(
          json.stdout.includes(ESC),
          "the --json envelope carried a raw ESC byte. A script that prints " +
            "the envelope before parsing it would then apply the note's " +
            "escapes to its own terminal.",
        ).toBe(false);
        // …and the escape survives the round trip as DATA: parsing gives the
        // original bytes back, so nothing was lost, only encoded.
        expect(envelope(json).body ?? "").toContain(CLEAR);
      },
    );
  });
});
