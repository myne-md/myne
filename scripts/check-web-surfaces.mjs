#!/usr/bin/env node
// Every service-layer module has a web verdict, and the excluded ones are gone
// (phase3-web-client task 96).
//
// The sibling of `check-web-screens.mjs`, for the three directories that task 70
// does not reach: `src/components/settings/`, `src/lib/` and `src/hooks/`.
// Task 70's header explains the shape and the four verdicts; the difference
// here is what these files ARE — not screens with routes, but the service layer
// underneath them, which is where a platform assumption hides best. Nothing
// routes to `useBackupScheduler`; `Editor.tsx` just mounts it, and it ran a
// five-minute IPC loop against a plugin the web dispatcher refuses.
//
// `--emit` regenerates the checked-in assessment
// (`myne-agents/features/phase3-web-client/web-surface-assessment.md`) from this
// table, so the document cannot drift from the gate: there is one roster, and
// the prose is its projection.

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const DIRS = [
  join("src", "components", "settings"),
  join("src", "lib"),
  join("src", "hooks"),
];
const DIST = join("web", "dist");
const ASSESSMENT = join(
  "myne-agents",
  "features",
  "phase3-web-client",
  "web-surface-assessment.md",
);

// `ported` — runs as written. `adapted` — runs, with a stated difference.
// `excluded` — substituted out of the bundle; `marker` is a string only the real
// module contains, and its presence in `web/dist` fails this script.
// `typed-unsupported` — reachable, and its backend answers a typed refusal.
const V = {
  // ── src/components/settings ─────────────────────────────────────────────
  "src/components/settings/AboutPanel.tsx": ["ported", "Build identity and links; no host call."],
  "src/components/settings/AccountPanel.tsx": [
    "adapted",
    "Ships; the clipper block is capability-gated AND its module is substituted, and vault delete is task 72's open decision.",
  ],
  "src/components/settings/AiPanel.tsx": [
    "adapted",
    "Never mounted: the `ai` rail entry is filtered out where `localAi` is absent (task 27), so the panel is unreachable rather than empty.",
  ],
  "src/components/settings/AppearancePanel.tsx": ["ported", "Themes + typography; all prefs-backed."],
  "src/components/settings/ArchiveSettings.tsx": ["ported", "Pure prefs toggle."],
  "src/components/settings/AttachmentOcrSettings.tsx": [
    "adapted",
    "Ships; OCR extraction is a backend concern and its command answers per the dispatcher.",
  ],
  "src/components/settings/AutomaticBackupBlock.tsx": [
    "excluded",
    "Reached only through StoragePanel, which is substituted; carries the backup schedule chain.",
    "settings.auto-backup-retention",
  ],
  "src/components/settings/BetaBadge.tsx": ["ported", "Presentational."],
  "src/components/settings/browser-icons.tsx": [
    "excluded",
    "Renders extension identities for the clipper block; leaves with ConnectedExtensions.",
  ],
  "src/components/settings/ConnectedExtensions.tsx": [
    "excluded",
    "The clipper is a native-messaging host a page cannot reach; substituted so its five command names leave the bundle.",
    "clipper-pairing|pairing_revoke",
  ],
  "src/components/settings/ControlBlock.tsx": ["ported", "Layout primitive."],
  "src/components/settings/CustomThemesSection.tsx": [
    "adapted",
    "Ships; import goes through the file-picker seam and export through the download seam (task 45).",
  ],
  "src/components/settings/DailyNotesSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/DefaultViewModeSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/EditorPanel.tsx": [
    "adapted",
    "Ships; the spell-check rows are filtered from search and the controls are omitted where `spellCheck` is absent.",
  ],
  "src/components/settings/FilesPanel.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/FocusModeSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/HotkeysPanel.tsx": [
    "adapted",
    "Ships; host-reserved chords are refused at bind time and existing ones badged (task 66).",
  ],
  "src/components/settings/LanguageSelect.tsx": ["ported", "i18n only."],
  "src/components/settings/LineNumbersSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/NewNoteLocationSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/panel-styles.ts": ["ported", "Style constants."],
  "src/components/settings/PrivacyPanel.tsx": [
    "adapted",
    "Ships; the screen-capture toggle and quick-unlock block are capability-gated, and both are filtered from search.",
  ],
  "src/components/settings/QuickUnlockSettings.tsx": [
    "adapted",
    "Rendered only where quick-unlock exists; the PIN path itself is portable and task 40 owns it.",
  ],
  "src/components/settings/SpellSettings.tsx": [
    "adapted",
    "Rendered only where `spellCheck` is present (task 47 decided its absence on web).",
  ],
  "src/components/settings/StartupOpenSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/StoragePanel.tsx": [
    "excluded",
    "Four wrong controls: a filesystem path OPFS does not have, an OS file-manager call, the backup pair, and a directory import task 71 owns.",
    "settings.storage.openInFiles",
  ],
  "src/components/settings/SyncPanel.tsx": ["ported", "Sync is required on web, so this panel is more load-bearing here than on desktop."],
  "src/components/settings/ToolbarCustomizeSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/TypographySettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/VimModeSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/search/matchSettings.ts": ["ported", "Pure matching."],
  "src/components/settings/search/resultsGrouping.ts": ["ported", "Pure grouping."],
  "src/components/settings/search/searchSettings.ts": [
    "adapted",
    "Searches the capability-FILTERED index, so a hidden control cannot be navigated to (task 96).",
  ],
  "src/components/settings/search/SettingsSearchResults.tsx": ["ported", "Presentational."],
  "src/components/settings/search/settingsSearchIndex.ts": [
    "adapted",
    "Entries carry an optional `capability`; `visibleSettingsIndex()` is what every search path reads.",
  ],
  "src/components/settings/search/SettingsSearch.tsx": ["ported", "The search input + results shell; what it can FIND is filtered upstream."],
  "src/components/settings/search/foldAccents.ts": ["ported", "Pure Unicode folding."],

  // ── src/lib ─────────────────────────────────────────────────────────────
  "src/lib/account-number-format.ts": ["ported", "Pure Crockford/Damm formatting."],
  "src/lib/ai-chat.ts": ["adapted", "Unreachable where `localAi` is absent; the editor host omits the `ai` member entirely."],
  "src/lib/ai-model-store.ts": ["adapted", "Same as ai-chat: no AI surface mounts on web."],
  "src/lib/ai-qa.ts": ["adapted", "Same as ai-chat."],
  "src/lib/aiExcludedFolders.ts": ["ported", "Pure path predicate; also read by non-AI callers."],
  "src/lib/app-window.ts": [
    "adapted",
    "`closeApp` was deleted in task 95; the fail-closed exit is the `app-exit` seam, whose web arm reloads the page.",
  ],
  "src/lib/attachments.ts": ["ported", "IPC bindings; the import path moved to the seam in task 67."],
  "src/lib/backup-errors.ts": [
    "excluded",
    "Backup error copy; leaves with the modules that produce those errors.",
  ],
  "src/lib/backup-schedule.ts": [
    "excluded",
    "The schedule engine and its `plugin:backup|*` names; reachable only through substituted modules.",
    "plugin:backup|backup_schedule_read",
  ],
  // NOT `excluded`, and the distinction is the point. `excluded` in this roster
  // means "substituted out", and this module is not — it is still importable,
  // still compiled, and `EnrollDeviceForm`'s own tests exercise it. What changed
  // in task 92 is that its one PHRASE-ENTRY caller moved into
  // `src/components/sync/phrase-credential.ts`, which the web build substitutes,
  // so there is no import edge from served code to the wordlist. That is a
  // stronger fact than the grep it replaces (a grep describes today's
  // tree-shake) and a weaker one than exclusion, so it is recorded as neither.
  "src/lib/bip39-normalize.ts": [
    "adapted",
    "Pure NFKD/whitespace normalisation, with NO IMPORT EDGE from served code since task 92: its one phrase-entry caller moved into `src/components/sync/phrase-credential.ts`, which the web build substitutes with a stub that cannot construct a credential. What remains here is a string function nothing on this client feeds a phrase.",
  ],
  "src/lib/clipper-pairing.ts": [
    "excluded",
    "Pairing IPC; leaves with ConnectedExtensions.",
    "clipper-pairing|pairing_list_paired",
  ],
  "src/lib/device-name.ts": ["adapted", "The `web` platform token maps to 'Browser' so a browser device is distinguishable in the list (task 69)."],
  "src/lib/deviceJoinQr.ts": ["ported", "Pure payload encoding."],
  "src/lib/focusable.ts": ["ported", "Pure DOM query."],
  "src/lib/icons.ts": ["ported", "Icon vocabulary."],
  "src/lib/imperative-focus-trap.ts": ["ported", "Pure DOM."],
  "src/lib/imperative-modal.ts": ["ported", "Pure DOM."],
  "src/lib/io-banner.ts": ["ported", "Bounded IO-failure copy mapping."],
  "src/lib/load-bearing-copy.ts": ["ported", "Re-exports `@myne/copy`; the literals are identical across clients by construction."],
  "src/lib/note-export-errors.ts": ["ported", "Error copy; the export destinations differ, the taxonomy does not."],
  "src/lib/noteImageCard.ts": ["ported", "Pure markdown/DOM shaping."],
  "src/lib/noteImageExport.ts": ["adapted", "Rendering is portable; delivery goes through the download seam."],
  "src/lib/password-generator.ts": ["ported", "CSPRNG through `crypto.getRandomValues`, which a browser has."],
  "src/lib/picked-file.ts": [
    "adapted",
    "The desktop handle only. The unwrap moved INTO the seam in task 67 — it used to throw for every web pick.",
  ],
  "src/lib/prefs.ts": ["ported", "Prefs IPC; the plugin is dispatched."],
  "src/lib/promptForText.ts": ["ported", "In-app modal prompt, not a host dialog."],
  "src/lib/quick-unlock.ts": ["adapted", "The PIN path is portable (task 40); the biometric path is a decided absence."],
  "src/lib/routing.ts": ["adapted", "The stage/history binding; desktop's seam arm is all no-ops (task 64)."],
  "src/lib/flush-chain.ts": [
    "ported",
    "The write-down ordering, shared by the lock and exit paths on both clients. The `hiding` reason is web-only (a browser tab switch), and skipping the workspace write there is what keeps `MYW1`'s mtime a lock/quit signal rather than an activity log.",
  ],
  "src/lib/subscribe.ts": [
    "ported",
    "Wraps the event seam's `listen`. Written FOR web: the rejected-subscription branch is dead on desktop (the IPC bridge is up before React mounts) and live in a browser, where a dropped rejection reaches `global-failure` and takes the page down.",
  ],
  "src/lib/secret-export.ts": [
    "adapted",
    "Ships for `saveJsonAsFile` (theme export, through the download seam) — its SECRET callers are the two creation steps, both substituted. The clipboard auto-clear it also exports is web-hostile in a way worth naming: it READS the clipboard back to check it still holds the secret, which page content cannot be granted in Firefox and is gesture-gated elsewhere, so a clear would silently never fire. No web path reaches it.",
  ],
  "src/lib/spell.ts": ["adapted", "Unreachable where `spellCheck` is absent; the editor host omits the `spell` member."],
  "src/lib/stage.ts": ["adapted", "Boot routing branches on capabilities: an empty web client goes to account-entry, a corrupt one to re-sync (task 85)."],
  "src/lib/syntaxTheme.ts": ["ported", "CodeMirror theme."],
  "src/lib/theme-errors.ts": ["ported", "Error copy."],
  "src/lib/theme.ts": ["ported", "CSSOM only."],
  "src/lib/themeDeepLink.ts": ["adapted", "Deep links arrive through the seam; a browser has no OS URL registration."],
  "src/lib/themes.ts": ["ported", "`MYT1` IPC; the plugin is dispatched (task 45)."],
  "src/lib/transcribe.ts": ["adapted", "Unreachable where `localAi` is absent."],
  "src/lib/vault-backup.ts": [
    "excluded",
    "Export/restore IPC; a browser cannot write a backup where the user keeps it.",
    "plugin:backup|vault_export_backup",
  ],
  "src/lib/vault-change-password.ts": ["ported", "Present on web by decision — the password is already typed into the page at unlock."],
  "src/lib/vault-creation-errors.ts": [
    "excluded",
    "Creation error copy; task 32 requires the creation path absent and does not name this file.",
  ],
  "src/lib/vault-creation-logging.ts": [
    "excluded",
    "Creation-flow logging; same reason as vault-creation-errors.",
  ],
  "src/lib/vault-delete.ts": ["adapted", "Task 72 owns what deletion MEANS on a sync-required client; the binding itself is portable."],
  "src/lib/vault-export-errors.ts": ["ported", "Error copy shared with the note-level export that does ship."],
  "src/lib/vault-list.ts": ["adapted", "One constant vault id per origin (task 85)."],
  "src/lib/vault-recover.ts": [
    "excluded",
    "The phrase-recovery binding; module-gated out of the wasm build too (task 12).",
    "plugin:vault-recover|recover_with_phrase",
  ],
  "src/lib/vault-repair.ts": ["adapted", "Task 72 owns the verdict; the dispatcher answers `Pending` meanwhile."],
  "src/lib/vault-slot-kind.ts": ["ported", "Boot probe."],
  "src/lib/vault-status.ts": ["ported", "Boot probe."],
  "src/lib/vault-switch.ts": ["adapted", "Reachable only with ≥2 vaults, which one origin cannot have."],
  "src/lib/vault-unlock.ts": ["ported", "The unlock IPC — the one path web needs most."],
  "src/lib/voice-record.ts": ["adapted", "Voice capture is desktop-only; the editor host omits the recorder."],
  "src/lib/workspace-persist.ts": ["ported", "`MYW1` IPC; ported into core and dispatched in task 65."],
  "src/lib/writing-assistant.ts": ["adapted", "Unreachable where `localAi` is absent."],

  // ── src/hooks ───────────────────────────────────────────────────────────
  "src/hooks/useAccountStatus.ts": ["ported", "Sync account status; degrades to null on an older server."],
  "src/hooks/useActivityHeartbeat.ts": ["adapted", "Page activity, not OS idle — `osIdleAutoLock` is absent and the browser timer is a different signal (task 43)."],
  "src/hooks/useAiModelReady.ts": ["adapted", "Unreachable where `localAi` is absent."],
  "src/hooks/useAttachmentTransfers.ts": ["ported", "Progress state around the attachment IPC."],
  "src/hooks/useBackupScheduler.ts": [
    "excluded",
    "Mounted unconditionally by the Editor; it ran a five-minute IPC loop for the whole session against a plugin that refuses every call.",
  ],
  "src/hooks/useConflictMaterializer.ts": ["ported", "Keep-both conflict drain; the sync engine is shared."],
  "src/hooks/useDevices.ts": ["ported", "Device roster; the commands are dispatched (task 69)."],
  "src/hooks/useEnroll.ts": ["adapted", "The phrase credential is refused at the last door (task 92); password enrolment is the web path."],
  "src/hooks/useFocusTrap.ts": ["ported", "Pure DOM."],
  "src/hooks/useIdleAutoLock.ts": ["adapted", "Same signal difference as useActivityHeartbeat."],
  "src/hooks/useIsFullscreen.ts": [
    "adapted",
    "Answers the Fullscreen API on web — the seam's `isFullscreen` is `document.fullscreenElement !== null`, which is the question the caller is asking.",
  ],
  "src/hooks/useLastActiveNotePref.ts": ["ported", "Prefs-backed."],
  "src/hooks/usePrefs.ts": ["ported", "The shared prefs hook."],
  "src/hooks/useSyncStatus.ts": ["ported", "Sync status; more load-bearing on web, where sync is required."],
  "src/lib/diagnostics.ts": [
    "ported",
    "The allowlist-built diagnostic block (task 114). Pure — no DOM, no defines — so its allowlist is testable without an environment; the reading half is `collect-diagnostics.ts`.",
  ],
  "src/lib/collect-diagnostics.ts": [
    "ported",
    "Reads the environment into the allowlisted fields (task 114). More load-bearing on web, where the bundle is re-delivered every load and the running client is the only thing that can say WHICH bundle it is. Transmits nothing — the sole consumer is a copy-to-clipboard button.",
  ],
  "src/lib/global-failure.ts": [
    "ported",
    "Window-level `error` / `unhandledrejection` → a bounded code (task 114). Most load-bearing on web: a browser user cannot read a devtools panel back to a maintainer, so a failure outside React render is otherwise invisible.",
  ],
  "src/lib/storage-pressure.ts": [
    "ported",
    "Is this failure the storage running out (task 91)? Asks the closed `IoFailureKind`, not a browser-specific check, so a desktop full disk gets the same answer — the OPFS backend already maps `QuotaExceededError` onto `NoSpace` at the seam.",
  ],
  "src/hooks/useMaterialisationProgress.ts": [
    "ported",
    "First-sync materialisation progress (task 39). Most load-bearing on web: a browser's first run materialises the WHOLE vault, measured at 1.9-9.4 s for 3 000 notes and 4.8-29.9 s at 10 000 depending on engine — a spinner over that is the thing this replaces.",
  ],
  "src/hooks/useStorageHealth.ts": [
    "ported",
    "Mid-session storage-health poll (task 22). Shared because the condition is not browser-specific — a desktop vault directory can vanish too — but it is the web client that meets it routinely, since an OPFS container is evictable under storage pressure.",
  ],
  "src/hooks/useUnsyncedEdits.ts": [
    "ported",
    "Per-note 'not yet on the server' (task 23). Most load-bearing on web: the local copy is an OPFS cache the browser may evict without asking, so an unacknowledged edit is the one thing between the user and real loss.",
  ],
};

export function surfaceFiles(dirs = DIRS) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) out.push(relative(".", full));
    }
  };
  dirs.forEach(walk);
  return out;
}

export function rosterGaps(files, verdicts = V) {
  const named = new Set(Object.keys(verdicts));
  return {
    missing: files.filter((f) => !named.has(f)),
    stale: [...named].filter((n) => !files.includes(n)),
  };
}

function bundleText(dist = DIST) {
  let text = "";
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|css|html)$/.test(name)) text += readFileSync(full, "utf8");
    }
  };
  walk(dist);
  return text;
}

function emitAssessment(files) {
  const rows = files
    .map((f) => {
      const [verdict, note, marker] = V[f] ?? ["?", "", undefined];
      const m = marker !== undefined ? ` \`${marker.replace(/\|/g, "\\|")}\`` : "";
      return `| \`${f}\` | **${verdict}** | ${note}${m} |`;
    })
    .join("\n");
  const body = `<!-- GENERATED by scripts/check-web-surfaces.mjs --emit. Do not edit by hand:
     the roster in that script is the source of truth, and it is also the gate. -->

# Web surface assessment — the service layer (MYND-574 task 96)

One row per file in \`src/components/settings/\`, \`src/lib/\` and \`src/hooks/\`.
Task 70 covers \`src/screens/\`; task 10 covers \`core/src/plugins/\`.

**The verdicts.** \`ported\` — runs as written. \`adapted\` — runs, with the stated
difference. \`excluded\` — substituted out of the web bundle by
\`web/vite.config.ts\`; where a row names a marker, that string's presence in
\`web/dist\` fails CI. The marker column is what makes "excluded" a claim about
the artefact rather than about the routing.

| File | Verdict | Reason |
|---|---|---|
${rows}
`;
  writeFileSync(ASSESSMENT, body);
  console.log(`web surfaces: assessment written — ${files.length} row(s) → ${ASSESSMENT}`);
}

function main() {
  const files = surfaceFiles();
  const { missing, stale } = rosterGaps(files);
  let failed = false;

  if (missing.length > 0) {
    console.error(
      `web surfaces: ${missing.length} file(s) have no web verdict:\n` +
        missing.map((f) => `    ${f}`).join("\n") +
        "\n  Add one to the roster in scripts/check-web-surfaces.mjs. A service-layer module " +
        "with no verdict ships to the browser by default, and nothing routes to it — so no " +
        "screen audit will find it.",
    );
    failed = true;
  }
  if (stale.length > 0) {
    console.error(
      `web surfaces: ${stale.length} verdict(s) name a file that no longer exists:\n` +
        stale.map((f) => `    ${f}`).join("\n"),
    );
    failed = true;
  }

  const markers = Object.entries(V).filter(([, v]) => v[2] !== undefined);
  if (!existsSync(join(DIST, "index.html"))) {
    console.warn(
      "web surfaces: web/dist not built — roster checked, ABSENCE NOT CHECKED. " +
        "Run `pnpm web:build` first for the full gate.",
    );
  } else {
    const text = bundleText();
    const leaked = markers.filter(([, v]) => text.includes(v[2]));
    if (leaked.length > 0) {
      console.error(
        "web surfaces: excluded module(s) are IN the served bundle:\n" +
          leaked.map(([f, v]) => `    ${f} — found "${v[2]}"`).join("\n"),
      );
      failed = true;
    }
  }

  if (failed) process.exit(1);
  if (process.argv.includes("--emit")) emitAssessment(files);

  const by = (k) => Object.values(V).filter((v) => v[0] === k).length;
  console.log(
    `web surfaces: ok (${files.length} file(s): ${by("ported")} ported, ${by("adapted")} adapted, ` +
      `${by("excluded")} excluded; ${markers.length} absence marker(s) checked)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { V as VERDICTS };
