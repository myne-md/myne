// The opt-in diagnostic log and the bug-report surface (myne-md/myne#860).
//
// PRECONDITION: exactly ONE vault (the fixture seeds one and never opens the
// picker). `e2e/AGENTS.md` makes the count a per-scenario declaration because a
// >=2-vault fixture routes to the picker stage, and an undeclared one is how a
// scenario turns into three 45-second waits reported as a timeout on an element.
//
// WHY THIS SCENARIO EXISTS, AND WHAT IT PROVES. The feature's whole value is one
// flow: turn the log on, hit a bug, produce a report. Everything it depends on is
// host-side and none of it is visible to Vitest: the ACL entry that authorizes
// each command, the `generate_handler!` registration no tool verifies, the
// device-local flag file the sink reads at startup, and the fact that the About
// surface is assembled from a hook that talks to a plugin. A command with its
// permission block, its capability grant and its UI, but missing from
// `generate_handler!`, compiles, passes clippy, renders and is dead at runtime
// (`src-tauri/AGENTS.md`, MYND-441).
//
// Each command's SUCCESS is therefore asserted against its own host-side effect,
// so an emptied command body or a missing registration fails here instead of
// passing on a rendered button:
//
//   * `diagnostic_log_enabled_get` and `_set` (dl1): the switch is flipped, the
//     About panel is REMOUNTED (a settings-rail tab switch re-runs the hook and
//     re-reads the host), and the state must come back from THAT read. The hook's
//     own local state is never the evidence. `get` folds a rejection to `false`
//     and the flag file is absent by default, so a fresh profile that stays
//     `false` proves nothing; only a `true` that survives a remount does.
//   * `report_manifest` (dl2): a log file of a known size is seeded into the
//     app's own log directory, and the manifest line's TEXT (the file count and
//     the byte size) is asserted, not its presence. A rejected read folds to
//     `null`, whose rendering ("Myne has not read the log yet") is a different
//     string, so the count and the size cannot be rendered by a fold.
//   * `save_report` (dl2): the OS save dialog is the one surface WebDriver cannot
//     drive, so it is intercepted at the page seat; the bundle the real command
//     then writes at that destination is read back and asserted by content.
//   * `reveal_logs_folder` (dl2): the log directory is seeded 0755, and the
//     command's own host-side effect (it holds the directory owner-only before
//     handing it to the opener) must land. The opener's own success is an OS file
//     manager the container does not have, so the UI toast is deliberately NOT
//     the evidence.
//   * `crash_record_state` and `crash_record_clear` (dl3): a crash record is
//     seeded into the same directory; the row must appear WITH the seeded date (a
//     rejected read folds to `null`, which renders NO row) and Delete must take
//     both the record off disk and the row off the panel.
//
// WHAT REMAINS UNCOVERED, deliberately. The opener actually opening a file
// manager (no session for one in the Linux container; the manual test roster's
// `app.diagnostic-log` item owns it). The `save_report` branch that clears a
// crash record it included (it needs a record to survive to save time, and dl2
// runs a record-free profile). The dialog-cancel arm of `saveReport`, which
// needs a second stub response. And the 0600 file mode plus the 0700 directory
// mode are asserted on Linux only, the single platform this harness runs on.
//
// WHY IT LIVES IN `e2e/` AND NOT `e2e-web/`. The feature is a shared-tree
// desktop flow: the web verdict for it is `adapted` (copy-only), and there is no
// web-specific behaviour here to drive. Per the root AGENTS.md the web lane owes
// this change nothing.
//
// WHY IT DOES NOT ASSERT THE CLIPBOARD BY VALUE, AND WHY `textContent` NOT
// `text()`. `tauri-driver` drives W3C WebDriver against the app's WebView; it has
// no clipboard read, and a scenario that claimed to compare clipboard contents
// would be claiming something it did not do. `textContent` reads a tall preview
// that the modal's scroll container clips, where the driver's `getText` returns
// only what is VISIBLE (the trap `beta-terms-consent.e2e.ts` documents).

import { expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickByTestId,
  dismissImporterOffer,
  openSettings,
  unlockToEditor,
} from "./support/flows";
import { testIdSelector, type Session } from "./support/webdriver";

/**
 * Whether the log switch has settled to a known state, or `null` while it is
 * still loading.
 *
 * Keyed on the Switch primitive's `aria-checked`, which is what drives both its
 * state and its paint. The `enabled()` half is load-bearing rather than
 * defensive: `useDiagnostics` renders the switch DISABLED while its first read is
 * in flight, and `aria-checked` already reads `false` during that window (the
 * hook's initial value), so a predicate over `aria-checked` alone resolves before
 * the control can be clicked, and a click there can be swallowed by a disabled
 * button.
 *
 * The driver's element facade exposes `attribute`/`enabled`, not the DOM's
 * `getAttribute`/`disabled`; `tsconfig.tests.json` is the only thing that checks
 * these trees, since `tsconfig.json` is `include: ["src"]`.
 */
async function toggleSettled(s: Session, want: "true" | "false"): Promise<true | null> {
  const el = await s.byTestId("about.diagnostic-log-toggle");
  if (!(await el.enabled())) return null;
  return (await el.attribute("aria-checked")) === want ? true : null;
}

async function blockPreview(s: Session): Promise<string> {
  const el = await s.byTestId("about.diagnostic-block-preview");
  return (await el.textContent()) ?? "";
}

async function manifestText(s: Session): Promise<string> {
  const el = await s.byTestId("about.diagnostic-files-manifest");
  return (await el.textContent()) ?? "";
}

/**
 * The app's own log directory: `<appDataDir>/logs`.
 *
 * `app_log_dir()` resolves to `data_local_dir()/<bundle id>/logs` on Linux, and
 * `data_local_dir()` reads `XDG_DATA_HOME`, which the harness points at the
 * session's own `dataHome`. `appDataDir` is already `<dataHome>/md.myne.desktop`,
 * so its `logs` child is what the host reads and writes. Derived here rather than
 * asked of a command on purpose: the whole point of these assertions is the
 * host's OWN on-disk state, which a command would have to be trusted about.
 */
function logDir(appDataDir: string): string {
  return path.join(appDataDir, "logs");
}

/** The active log file's name (`logging::sink::LOG_FILE_NAME`). */
const LOG_FILE_NAME = "myne.log";
/** The crash record's name (`logging::crash::CRASH_FILE_NAME`). */
const CRASH_FILE_NAME = "crash.log";
/**
 * The seeded log file is exactly this many bytes.
 *
 * 512 is below 1024, so `formatBytes` renders it as `512 B`: a figure small
 * enough to state exactly and to assert as text, with no rounding to hide a
 * wrong size behind.
 */
const LOG_FILE_BYTES = 512;
/** The one distinctive line every bundle assertion looks for. */
const LOG_MARKER = 'INFO myne_core: event="seeded_diagnostic_log"\n';
/**
 * A realistic crash-record timestamp (2023-11-14T22:13:20Z). The panel renders
 * the year and the harness runs English, so the assertion below does not depend
 * on the runner's time zone.
 */
const CRASH_AT_EPOCH_SECONDS = 1_700_000_000;

/**
 * Seed the log directory with one log file of exactly {@link LOG_FILE_BYTES}
 * bytes.
 *
 * The directory is left 0755 on purpose: `reveal_logs_folder` is the only writer
 * that holds it owner-only, so a directory that were already 0700 would make that
 * assertion pass with the command never running at all.
 *
 * The file is not the app's own output (logging is off on a fresh profile), it is
 * a fixture laid down at the path the host will read. That is the same at-rest
 * fixture class the vault seeder uses, not a test hook.
 */
function seedLogFile(appDataDir: string): void {
  const dir = logDir(appDataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o755);
  const marker = Buffer.from(LOG_MARKER, "utf8");
  if (marker.length >= LOG_FILE_BYTES) {
    throw new Error("the log marker must fit inside the seeded file size");
  }
  const padding = Buffer.alloc(LOG_FILE_BYTES - marker.length, 0x61);
  fs.writeFileSync(path.join(dir, LOG_FILE_NAME), Buffer.concat([marker, padding]));
}

/**
 * Seed the log directory with one crash record, in the shape
 * `logging::crash::record_bytes` writes.
 *
 * `read_state` parses the `# at_epoch_seconds: ` line and the panel renders it,
 * so a fixture that wrote an unparseable file could only assert that SOME row
 * exists rather than that the record's own date reached the panel.
 */
function seedCrashRecord(appDataDir: string): void {
  const dir = logDir(appDataDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, CRASH_FILE_NAME),
    "# myne crash record\n" +
      "# version: 0.0.0\n" +
      "# platform: linux\n" +
      `# at_epoch_seconds: ${CRASH_AT_EPOCH_SECONDS}\n` +
      "# location: e2e/diagnostics-copy.e2e.ts:1\n",
  );
}

describeE2E("diagnostic log switch (myne-md/myne#860)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("dl1: the switch is off, the block is real, and a remount reads the flag back from the host", async () => {
    let password = "";
    await scenario(
      "dl1-diagnostic-log-toggle",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "diagnostics");

        // The row renders, which is itself the ACL half: this panel is assembled
        // from a hook that invokes `plugin:diagnostics|diagnostic_log_enabled_get`
        // on mount, so a missing grant or registration leaves it at the loading
        // default with no error anywhere.
        await s.byTestId("about.diagnostic-log-toggle");

        // Off on a fresh profile. This is a PRECONDITION, not evidence: the flag
        // file is absent and `get` folds a rejection to `false`, so the two are
        // indistinguishable here. The `true` that survives the remount below is
        // what separates them.
        await s.waitUntil(
          async () => toggleSettled(s, "false"),
          { label: "the log switch settles to off", timeoutMs: 15_000 },
        );

        // The block is the real nine-field allowlist document, not a placeholder.
        const block = await blockPreview(s);
        expect(block).toContain("version:");
        expect(block).toContain("failureCode:");
        expect(block).toContain("engine:");

        // The setter is a real IPC write over the ACL.
        await clickByTestId(s, "about.diagnostic-log-toggle");
        await s.waitUntil(
          async () => toggleSettled(s, "true"),
          { label: "the log switch reports on", timeoutMs: 15_000 },
        );

        // THE PROOF THAT BOTH HALVES ARE WIRED, and why the assertion just above
        // is not enough. `setEnabled` sets the hook's local state itself, so a
        // `true` straight after the click can come from React and say nothing
        // about the flag file. The rail renders only the SELECTED panel, so
        // leaving About and returning unmounts `AboutPanel`; the fresh mount
        // re-runs `useDiagnostics`, which invokes `diagnostic_log_enabled_get`
        // and reads the file the setter just wrote. A setter that wrote nothing,
        // or a getter that is not registered, leaves it at `false` here.
        await openSettings(s, "appearance");
        await openSettings(s, "diagnostics");
        await s.waitUntil(
          async () => toggleSettled(s, "true"),
          { label: "a fresh mount reads the flag back as on", timeoutMs: 15_000 },
        );

        // Turning it off is the erase path, and the same round trip the other
        // way: a fresh mount must read `false` back off the host.
        await clickByTestId(s, "about.diagnostic-log-toggle");
        await s.waitUntil(
          async () => toggleSettled(s, "false"),
          { label: "the log switch reports off", timeoutMs: 15_000 },
        );
        await openSettings(s, "appearance");
        await openSettings(s, "diagnostics");
        await s.waitUntil(
          async () => toggleSettled(s, "false"),
          { label: "a fresh mount reads the flag back as off", timeoutMs: 15_000 },
        );
      },
    );
  });
});

describeE2E("diagnostic report files (myne-md/myne#860)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("dl2: the manifest line, Save and Reveal act on the real log directory", async () => {
    let password = "";
    await scenario(
      "dl2-diagnostic-report-files",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
          seedLogFile(dir);
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "diagnostics");

        // THE MANIFEST LINE, BY TEXT. `report_manifest` counts the log files it
        // would include and sums their bytes, and the panel renders both. A
        // rejected read folds to `null`, which renders a DIFFERENT string
        // ("Myne has not read the log yet"), so "1 log file" and "512 B" can only
        // come from a real answer. Both halves are asserted: a manifest that
        // counted the file but reported its size as zero would pass a
        // presence-only check.
        await s.waitUntil(
          async () => {
            const text = await manifestText(s);
            return text.includes("1 log file") && text.includes("512 B") ? text : null;
          },
          { label: "the manifest line reports the seeded log file", timeoutMs: 20_000 },
        );

        // SAVE writes one plaintext bundle to a destination the user chose in the
        // OS dialog. That dialog is the one native surface WebDriver cannot
        // drive, so it is intercepted at the page seat. `__TAURI_INTERNALS__` is
        // immutable on the production build, so the wrapper goes on the writable
        // seam the transport calls, the global `fetch` carrying Tauri's
        // custom-protocol IPC, and only the exact `plugin:dialog|save` URL is
        // answered. Everything past the dialog (the write, the manifest refresh,
        // the toast) is production code. (`note-export.e2e.ts` ne3 is the
        // template.)
        const destination = path.join(app.dataHome, "myne-report.txt");
        const patched = await s.execute<boolean>(
          "if (window.__e2eDialogPatched !== true) {" +
            "  const saveUrl = window.__TAURI_INTERNALS__.convertFileSrc('plugin:dialog|save', 'ipc');" +
            "  const origFetch = window.fetch.bind(window);" +
            "  const wrapper = function (input, init) {" +
            "    const url = typeof input === 'string' ? input : input && input.url;" +
            "    if (url === saveUrl) {" +
            "      window.__e2eDialogSaveCalls += 1;" +
            "      return Promise.resolve(new Response(JSON.stringify(window.__e2eDialogSavePath), {" +
            "        status: 200," +
            "        headers: { 'content-type': 'application/json', 'Tauri-Response': 'ok' }," +
            "      }));" +
            "    }" +
            "    return origFetch(input, init);" +
            "  };" +
            "  window.fetch = wrapper;" +
            "  window.__e2eDialogSaveCalls = 0;" +
            "  window.__e2eDialogPatched = window.fetch === wrapper;" +
            "}" +
            "window.__e2eDialogSavePath = arguments[0];" +
            "return window.__e2eDialogPatched === true;",
          [destination],
        );
        // Verify the patch took: a non-writable `fetch` would silently keep the
        // real transport and the click below would open an undriveable dialog.
        expect(patched).toBe(true);

        // Save is disabled until the block is assembled, so wait for enabled
        // rather than clicking into a no-op.
        await s.waitUntil(
          async () => {
            const [el] = await s.findElements(testIdSelector("about.diagnostic-save"));
            if (el === undefined) return null;
            return (await el.enabled()) ? true : null;
          },
          { label: "the Save control enables once the block is assembled", timeoutMs: 15_000 },
        );
        await clickByTestId(s, "about.diagnostic-save");

        // THE FILE THE DESTINATION NAMES, BY CONTENT. A `save_report` that is
        // registered but empty, or missing from `generate_handler!`, leaves no
        // file and this poll never resolves.
        await s.waitUntil(
          async () => {
            try {
              return fs.readFileSync(destination, "utf8").includes(LOG_MARKER.trim())
                ? true
                : null;
            } catch {
              return null;
            }
          },
          {
            label: "the report bundle lands with the seeded log's content",
            timeoutMs: 20_000,
          },
        );
        const bundle = fs.readFileSync(destination, "utf8");
        expect(bundle.startsWith("# myne diagnostic report\n")).toBe(true);
        expect(bundle).toContain("## diagnostics block");
        expect(bundle).toContain(`## log: ${LOG_FILE_NAME}`);
        expect(bundle).toContain(LOG_MARKER.trim());
        expect(await s.execute<number>("return window.__e2eDialogSaveCalls")).toBe(1);

        // REVEAL resolves the log directory host-side and holds it owner-only
        // before asking the opener to show it. The opener's own success is an OS
        // file manager the container does not have, so the toast is not the
        // evidence; the directory's mode is, and that is the effect the command
        // performs on EVERY run, before the opener is consulted. The seed left
        // the directory 0755, so this cannot pass with the command absent, and
        // asserting that precondition first keeps it from passing vacuously.
        const dir = logDir(app.appDataDir);
        expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
        await clickByTestId(s, "about.diagnostic-reveal");
        await s.waitUntil(
          async () => ((fs.statSync(dir).mode & 0o777) === 0o700 ? true : null),
          { label: "Reveal holds the log directory owner-only", timeoutMs: 15_000 },
        );
      },
    );
  });
});

describeE2E("diagnostic crash record (myne-md/myne#860)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("dl3: a seeded crash record is shown with its date, and Delete clears it", async () => {
    let password = "";
    await scenario(
      "dl3-crash-record-clear",
      {
        seed: (dir) => {
          password = seedVault(dir).password;
          seedCrashRecord(dir);
        },
      },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await openSettings(s, "diagnostics");

        // `crash_record_state` answers `Some` only when a record exists, and a
        // rejected invoke folds to `null` in the hook, which renders NO row. So
        // the row's presence IS the read's success, where the previous scenario
        // asserted a count of 0 over a profile that never crashed and proved
        // nothing either way.
        await s.byTestId("about.crash-record-row");
        await s.byTestId("about.crash-record-clear");

        // The date reached the panel, which pins that the read returned the
        // seeded record's OWN timestamp and not the malformed-read zero:
        // `read_state` parses to `0` when it cannot find the `# at_epoch_seconds`
        // line, `formatCrashDate` answers `null` for a zero, and the panel renders
        // its "unknown date" fallback (no year at all). So a fixture the parser
        // could not read still draws a row, and this year is what separates a
        // real timestamp from that zero. Compared by YEAR so the runner's time
        // zone cannot move the assertion off the seeded date.
        const helper =
          (await (await s.byTestId("about.crash-record-helper")).textContent()) ?? "";
        expect(helper).toContain("2023");

        // Delete is the manual half of the record's bounded lifetime. Row gone
        // AND file gone: `crashRecordClear` resolves before the row unmounts, so
        // the record must already be off disk when the row disappears, and a
        // command that returned success without deleting fails the second half.
        const recordPath = path.join(logDir(app.appDataDir), CRASH_FILE_NAME);
        await clickByTestId(s, "about.crash-record-clear");
        await s.waitForGone(testIdSelector("about.crash-record-clear"));
        await s.waitUntil(
          async () => (fs.existsSync(recordPath) ? null : true),
          { label: "the crash record is off disk", timeoutMs: 15_000 },
        );
      },
    );
  });
});
