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
import { join } from "node:path";

import { TS_FILES, walkFiles } from "./lib/surface-files.mjs";

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
  "src/components/settings/AboutPanel.tsx": [
    "ported",
    "Build identity and links; no host call. Carries the Developer mode toggle, which since #181 renders here too — it used to be withheld on a `localAi`-less capability set, which on web left the mode's other members (the Vim row) unreachable.",
  ],
  "src/components/settings/AccountPanel.tsx": [
    "adapted",
    "Ships; the clipper block is capability-gated AND its module is substituted, and vault delete is task 72's open decision.",
  ],
  "src/components/settings/AiPanel.tsx": [
    "adapted",
    "Never mounted: the `ai` rail entry is filtered out where `localAi` is absent (task 27), so the panel is unreachable rather than empty. Unchanged by the remote-provider controls (myne#415): they live inside this same panel, so they inherit the same rail filter and reach the browser no more than the rest of it does.",
  ],
  "src/components/settings/AiOnboardingSurface.tsx": [
    "adapted",
    "Rendered only by Editor.tsx, and only where `has(\"localAi\")` is true (the whole surface is gated on that capability, not just its `downloads` prop), so on web, where `localAi` is absent, it is not mounted at all and no AI affordance appears (decisions/ai/0628). Its download cards are further gated on `downloads`, whose only `true` caller is the desktop Editor; mobile mounts its own copy with `downloads: false` (opt-in + Chat only). Its host calls are the `local-inference` download bindings (whole plugin `Unsupported` on web) plus prefs, and none is reachable on web because the component never renders there.",
  ],
  "src/components/settings/MemorySection.tsx": [
    "adapted",
    "Rendered only by AiPanel.tsx, so it inherits that panel's rail filter exactly: where `localAi` is absent the panel is never mounted and this section is unreachable. Holds no host call of its own beyond the `memory:` bindings (Unsupported on web), so there is nothing here that would need a web substitution even if it were reachable.",
  ],
  "src/components/settings/AiProviderConsent.tsx": [
    "adapted",
    "Rendered only by AiPanel.tsx, so it inherits that panel's rail filter exactly: where `localAi` is absent the panel is never mounted and this screen is unreachable. It holds no host call of its own — accepting calls back to the panel, which writes the consent — so there is nothing here that would need a web substitution even if it were reachable.",
  ],
  "src/components/settings/DateTimeSettings.tsx": [
    "ported",
    "Three closed-vocabulary rows over date_format / time_format / timezone; prefs-backed, no host call of its own.",
  ],
  "src/components/settings/AppearancePanel.tsx": ["ported", "Themes + typography; all prefs-backed."],
  "src/components/settings/ArchiveSettings.tsx": ["ported", "Pure prefs toggle."],
  "src/components/settings/AttachmentCompressionSettings.tsx": [
    "adapted",
    "Ships; the setter is dispatched and the preference is shared, so the toggle governs the vault. The web client itself does not perform the transform: `catch_unwind` cannot contain a decoder panic on wasm32 (core/src/plugins/attachments/compress.rs), so `is_supported_on_this_target` gates it off there rather than risk killing the Worker on a hostile image. The helper's closing scope sentence is selected by the `imageCompression` capability, so this client says the transform does not run here instead of claiming it applies on every device.",
  ],
  "src/components/settings/AttachmentOcrSettings.tsx": [
    "adapted",
    "Ships; OCR extraction is a backend concern and its command answers per the dispatcher.",
  ],
  "src/components/settings/AutomaticBackupBlock.tsx": [
    "excluded",
    "Reached only through StoragePanel, which is substituted; carries the backup schedule chain.",
    "settings.auto-backup-retention",
  ],
  "src/components/settings/browser-icons.tsx": [
    "excluded",
    "Renders extension identities for the clipper block; leaves with ConnectedExtensions.",
  ],
  "src/components/settings/ConnectedExtensions.tsx": [
    "excluded",
    "The clipper is a native-messaging host a page cannot reach; substituted so its five command names leave the bundle.",
    "clipper-pairing|pairing_revoke",
  ],
  "src/components/settings/CliAccessSettings.tsx": [
    "adapted",
    "Never rendered: PrivacyPanel gates the block on `cliAccess`, which is absent on web, so the whole terminal-access surface is omitted rather than greyed. Ships in the bundle (it is one small component inside a panel that does ship) but nothing on this client mounts it, and its one command is `Unsupported` in the dispatcher. The panel adds a second, independent gate on the `developer_mode` preference (#181), which changes nothing here — the capability gate already omits the block on every web build.",
  ],
  "src/components/settings/ControlBlock.tsx": ["ported", "Layout primitive."],
  "src/components/settings/SettingRow.tsx": [
    "ported",
    "Layout primitive — the canonical label-left / control-right settings row. Presentational: it composes panel-styles and renders its caller's control, with no host call and no capability of its own.",
  ],
  "src/components/settings/CustomThemesSection.tsx": [
    "adapted",
    "Ships; import goes through the file-picker seam (`pickFiles` + `readPickedSmallText`) and export through the download seam (task 45). The import half only became true with #262 — this entry described the fix while the code still called `dialog.open`, a typed refusal in the browser, so a valid theme file was reported as invalid.",
  ],
  "src/components/settings/PeriodicNotesSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/DefaultViewModeSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/EditorPanel.tsx": [
    "adapted",
    "Ships; the spell-check rows are filtered from search and the controls are omitted where `spellCheck` is absent. The Vim row is additionally gated on the `developer_mode` preference (#181) — a runtime toggle rather than a capability, so it behaves identically on both clients.",
  ],
  "src/components/settings/FilesPanel.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/TranscriptionPanel.tsx": [
    "ported",
    "Prefs-backed. The panel renders on web; the transcribe ACTION is desktop-only\n     (the local-inference plugin has no web counterpart), so the switch there governs\n     a preference that syncs to a device which can act on it.",
  ],
  "src/components/settings/FocusModeSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/FolderNotesSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/HotkeysPanel.tsx": [
    "adapted",
    "Ships; host-reserved chords are refused at bind time and existing ones badged (task 66).",
  ],
  "src/components/settings/LanguageSelect.tsx": ["ported", "i18n only."],
  "src/components/settings/LineNumbersSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/MigrateVaultForm.tsx": [
    "excluded",
    "The whole-vault v0.1→v0.2 migration form (#420) is desktop-only and its recovery-phrase credential is substituted out of the web bundle; a browser client joins an already-current account and never migrates.",
    "migrate.phrase-input",
  ],
  "src/components/settings/SettleMigrationBlock.tsx": ["typed-unsupported", "The post-migration settle surface (§10.4.1 point 5, #430) — abort / confirm over the `legacy/` snapshot. Desktop-only for the same reason as the form above: a browser client never migrates, so it never has a `legacy/` snapshot to settle. Its status probe answers the typed refusal, and the block renders nothing when the probe fails, so on web it is simply absent."],
  "src/components/settings/NewNoteLocationSettings.tsx": ["ported", "Prefs-backed."],
  "src/components/settings/NetworkPanel.tsx": [
    "adapted",
    "Never mounted: the `network` rail entry is filtered out where `torRouting` is absent, so the Tor toggle is unreachable rather than greyed. A page has no subprocess to spawn and no raw socket to tunnel; web users route the whole browser through Tor Browser instead. Ships in the bundle (one small panel), and both of its commands are `Unsupported` in the dispatcher.",
  ],
  "src/components/settings/panel-styles.ts": ["ported", "Style constants."],
  "src/components/settings/settingsCompact.ts": [
    "ported",
    "Pure content-width → compact-layout decision plus its ResizeObserver glue and context; no host call. Restacks Settings rows (and drops the Editor preview column) on a narrow dialog so labels never overlap controls (#391). Web applies it at the equivalent viewport width for free.",
  ],
  "src/components/settings/PrivacyPanel.tsx": [
    "adapted",
    "Ships; the device-local screen-capture OVERRIDE row, the quick-unlock block and the hide-vault-names row are capability-gated, and all three are filtered from search. The per-vault screen-capture toggle beside the override is deliberately NOT gated, and this verdict claimed for a long time that it was: it is a `vault.prefs` field a user may read and set on a client where the native call does nothing, while the override writes a device-local file whose only purpose is suppressing a call that client never makes. The hide-vault-names row is gated on `lockedVaultNames` (myne-md/myne#411): a browser origin holds exactly one container, so the locked picker the setting governs never renders there, and there is no OS keychain to seal its store. The CLI block carries a `developer_mode` gate on top of its capability gate (#181); on web the capability half already decides it.",
  ],
  "src/components/settings/QuickUnlockSettings.tsx": [
    "adapted",
    "Rendered only where quick-unlock exists; the PIN path itself is portable and task 40 owns it.",
  ],
  "src/components/settings/RecoveryDrillRow.tsx": [
    "ported",
    "The recovery drill (myne-md/myne#468), and it renders unchanged on web because the web client HAS phrase recovery: `plugin:vault-recover|verify_recovery_phrase` is on the wasm dispatcher's DISPATCHED roster beside `recover_with_phrase`, so the row works rather than sitting there reporting an error. No capability gate for the same reason, and no `developer_mode` gate because a first-time user is exactly who it is for.",
  ],
  "src/components/settings/ReminderSettings.tsx": [
    "adapted",
    "Renders and persists through the prefs setters like its siblings. The copy it shows follows `reminderTier`, which reports in-app-only on every host — so a browser reads the same honest sentence a desktop does, and neither is shown the OS-registration disclosure while no registration happens.",
  ],
  "src/components/settings/BarCustomizeSettings.tsx": [
    "ported",
    "Prefs-backed (myne-md/myne#773), the visibility half of the bottom-bar vocabulary. The bar renders from the same shared src/ tree on web and each item carries its own data guard, so hiding one behaves identically here. It is also the reason the bar is allowed to disappear at all: the bar's own right-click menu is the only other place visibility can be changed, so on every client this block is the route back.",
  ],
  "src/components/settings/CustomizeList.tsx": [
    "ported",
    "The row shared by the two customize rosters (myne-md/myne#773) — a grip, an icon, a label and a caller-supplied trailing control, plus the drag and Alt+Arrow bookkeeping. Pure DOM and React state, no host call and no capability of its own, so it carries whatever the two blocks that use it already carry. HTML5 drag-and-drop is the one host-ish thing in it and it is a browser API, which is where the desktop already gets it from.",
  ],
  "src/components/settings/RibbonCustomizeSettings.tsx": [
    "ported",
    "Prefs-backed (myne-md/myne#699). The rail itself renders from the same shared src/ tree on web, and the commands it pins carry their own per-state guards, so the customization roster behaves identically here.",
  ],
  "src/components/settings/SettingsSection.tsx": [
    "ported",
    "The settings-panel section wrapper (MYND-624). Presentational — a heading plus its children, no host call and no capability of its own, so it carries whatever its contents already carry.",
  ],
  "src/components/settings/SpellSettings.tsx": [
    "adapted",
    "Rendered only where `spellCheck` is present (task 47 decided its absence on web).",
  ],
  "src/components/settings/PlainFileSettings.tsx": [
    "adapted",
    "Myne-md/myne#788. SHIPS in the bundle: nothing substitutes it out, and this entry said `excluded` with no marker, which the absence half of this guard could not verify. What actually omits the row is the runtime `has(\"plainFile\")` gate in EditorPanel, and `web/wasm/src/capability.rs` classifies the whole `plain-file` plugin `Class::Unsupported`, so even if it were mounted its two bindings would answer the dispatcher's typed refusal. Same correction as `src/lib/import-source-vault.ts`: a module that ships and is unreachable is not an excluded module.",
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
  "src/components/settings/ViewsSettings.tsx": ["ported", "Device-local Views feature toggle (localStorage, like the language picker); runs as written."],
  "src/components/settings/VimModeSettings.tsx": [
    "ported",
    "Prefs-backed. Mounted only while `developer_mode` is on since #181 — the same condition on both clients, so still `ported` rather than `adapted`: nothing about the component differs here, only whether EditorPanel renders it.",
  ],
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
  "src/lib/accentColor.ts": ["ported", "Device-local accent-colour pref (localStorage) applied as CSS custom properties on :root; runs as written."],
  "src/lib/aiOnboardingSeen.ts": ["ported", "Device-local first-run AI-onboarding seen flag (localStorage), same shape as accentColor/viewsEnabled; runs as written. On web the surface it gates is only reachable with `downloads: false`, but this module holds no host call."],
  "src/lib/ai-model-download.ts": [
    "typed-unsupported",
    "Thin bindings over the `local-inference` download/`cancel` commands, which the whole plugin classifies `Unsupported` on web, so an invoke answers the typed refusal rather than dispatching. Rendered only where `has(\"localAi\")` is true, which web is not, so nothing on web reaches these calls; the module is reachable and its backend answers a typed refusal, which is the `typed-unsupported` verdict.",
  ],
  "src/lib/ai-download-store.ts": [
    "typed-unsupported",
    "Module-scope state over the `local-inference` download/cancel commands and their progress event (myne-md/myne#814). Same verdict and reason as `ai-model-download.ts`, which it wraps: the plugin is `Class::Unsupported` on web, so an invoke answers the typed refusal rather than dispatching. No AI surface renders on web (`localAi` is absent), so nothing reaches it; `typed-unsupported` rather than `excluded` because its backend answers a typed refusal rather than the code being absent.",
  ],
  "src/lib/account-number-format.ts": ["ported", "Pure Crockford/Damm formatting."],
  "src/lib/commandRecency.ts": ["ported", "Session-only, in-memory command recency for the new-tab surface; no host call, runs as written."],
  "src/lib/detachedWindow.ts": [
    "typed-unsupported",
    "The pop-out spawn binding (myne#173). The `detached-window` plugin is `Class::Unsupported` in web/wasm/src/capability.rs (a browser page cannot open an OS window), so its one command answers the typed unsupported refusal; the affordance is also gated off, since `detachedWindows` is absent on web.",
  ],
  "src/lib/agent-protocol.ts": [
    "ported",
    "The wire TYPES and the pure predicates over them, split out of `agent-run.ts` so mobile could share them. It has no host reach at all \u2014 type declarations, a marker table and four functions over their own arguments \u2014 so it compiles and runs in the browser exactly as written. It is unreachable there for the same reason its siblings are (`agent` is `Class::Unsupported` in web/wasm/src/capability.rs), but unreachable is not the same as adapted: nothing about this module changes shape on web, and marking it `adapted` would claim a divergence that does not exist.",
  ],
  "src/lib/agent-run-core.ts": [
    "adapted",
    "The agent plugin's IPC bindings as a FACTORY: `invoke` and `Channel` arrive as arguments because a shared module may not import either (`scripts/check-platform-seam.mjs`). Same verdict and same reason as `agent-run.ts`, which is its desktop caller: every command it wraps is refused on web, since `agent` is `Class::Unsupported` in web/wasm/src/capability.rs (myne-md/myne#529 puts web out of scope). The factory itself would construct on web; what it returns has nothing to talk to.",
  ],
  "src/lib/agent-run.ts": ["adapted", "Unreachable where the `agent` plugin is absent: it is `Class::Unsupported` in web/wasm/src/capability.rs (myne-md/myne#529 puts web out of scope), so every command this module wraps is refused."],
  "src/lib/ai-model-store.ts": ["adapted", "Unreachable where `localAi` is absent: no AI surface mounts on web, so nothing reads the store."],
  "src/lib/ai-capability.ts": [
    "adapted",
    "Runs as written and gives the right answer for the wrong-looking reason: the `local-inference` plugin is `Unsupported` in the dispatcher, so the invoke is refused and the module returns UNCOMPILED_REPORT — which is exactly true on web, where no AI is compiled. Nothing renders it there (`localAi` is absent), so it is unreachable in practice; it is `adapted` rather than `excluded` because it is correct if it ever is reached.",
  ],
  "src/lib/ai-tags.ts": [
    "adapted",
    "The auto-tag seam is unreachable where `localAi` is absent, and its command is `Unsupported` in the dispatcher.",
  ],
  "src/lib/aiExcludedFolders.ts": ["ported", "Pure path predicate; also read by non-AI callers."],
  "src/lib/app-window.ts": [
    "adapted",
    "`closeApp` was deleted in task 95; the fail-closed exit is the `app-exit` seam, whose web arm reloads the page.",
  ],
  "src/lib/attachments.ts": ["ported", "IPC bindings; the import path moved to the seam in task 67."],
  "src/lib/import-source-vault.ts": [
    "typed-unsupported",
    "Vault import (myne-md/myne#464). Every binding here wraps an `importer:` " +
      "command, and `web/wasm/src/capability.rs` classifies that whole plugin " +
      "`Class::Unsupported`, so none of them can be dispatched in the browser. " +
      "The placement is the reason: putting these under `vault-unlock:` or " +
      "`attachments:` would have widened plugins the web client DOES dispatch. " +
      "NOT `excluded`, and the correction is the finding: this module SHIPS. " +
      "`ObsidianImportModal.tsx` imports it statically, `src/screens/Editor.tsx` " +
      "imports and mounts that modal, and neither is in " +
      "`web/vite.config.ts`'s `SUBSTITUTED_MODULES`, so the `plugin:importer|*` " +
      "literals are in `web/dist`. The first version of this entry claimed " +
      "absence AND omitted the marker string, so the absence half of this guard " +
      "skipped it entirely: a false record that was unverifiable by " +
      "construction. What IS absent is the setup step " +
      "(`src/notes/import/MyneVaultSetup.tsx`, substituted), because it takes a " +
      "recovery phrase; the bindings are merely unreachable, since the absent " +
      "`vaultImport` capability keeps the source out of the picker.",
  ],
  "src/lib/backup-errors.ts": [
    "excluded",
    "Backup error copy; leaves with the modules that produce those errors.",
  ],
  "src/lib/backup-drill-line.ts": [
    "excluded",
    "The post-backup drill line's one-time dismissal store (myne-md/myne#468). Its only importer is `BackupExportModal`, which web substitutes, so it leaves the bundle with it.",
    "myne.backup.drill-line-seen",
  ],
  "src/lib/backup-schedule.ts": [
    "excluded",
    "The schedule engine and its `plugin:backup|*` names; reachable only through substituted modules.",
    "plugin:backup|backup_schedule_read",
  ],
  // NOT `excluded`, and the distinction is the point. `excluded` in this roster
  // means "substituted out", and this module is not — it is still importable,
  // still compiled, and `EnrollDeviceForm`'s own tests exercise it.
  //
  // CORRECTED 2026-08-15: this note used to claim there was NO import edge from
  // served code to the wordlist, because `phrase-credential` was substituted.
  // That substitution is gone — phrase ENTRY ships on web now
  // (`decisions.md` 2026-08-15, entry 0514) — so the edge is real and intended.
  // What keeps the phrase out of the artefact is narrower and lives elsewhere:
  // the ENROLMENT screen is substituted, and `check-web-no-phrase.mjs` asserts
  // its grid's absence from the built bundle.
  "src/lib/bip39-normalize.ts": [
    "ported",
    "Pure NFKD/whitespace normalisation, and it now has a real import edge from served code: `EnrollDeviceForm` and the recovery entry screen both feed it, since phrase entry ships on web (`decisions.md` 2026-08-15, entry 0514). No host call anywhere in it.",
  ],

  "src/lib/cli-access.ts": [
    "typed-unsupported",
    "The CLI door's session-state read. Reachable — the module ships and the binding is one `invoke` — and `cli-bridge` is `Unsupported` in the dispatcher, so a call that arrives by a path gating did not cover gets a typed refusal rather than a hang. No web path calls it: the only caller is the capability-gated Settings block.",
  ],
  "src/lib/tor-routing.ts": [
    "typed-unsupported",
    "The device-local Tor-routing toggle (MYND-650). Reachable — the module ships and both bindings are one `invoke` — and both commands are `Unsupported` in the dispatcher, so a call arriving by a path gating did not cover gets a typed refusal rather than a hang. No web path calls it: the only caller is the `torRouting`-gated Developer Options block. The absence is a platform fact (no subprocess, no raw socket), and the browser's answer is Tor Browser.",
  ],
  "src/lib/clipper-pairing.ts": [
    "excluded",
    "Pairing IPC; leaves with ConnectedExtensions.",
    "clipper-pairing|pairing_list_paired",
  ],
  "src/lib/chats.ts": [
    "ported",
    "The conversations plugin's IPC bindings (create/append/read/list/rename/delete, myne-md/myne#675). All six commands are Dispatched in web/wasm/src/dispatch.rs against the OPFS-backed store, so the history list/open/rename/delete run in the browser exactly as written. That makes it the one AI surface that survives the `agent` plugin's Unsupported classification.",
  ],
  "src/lib/memory.ts": [
    "adapted",
    "The agent-memory + personality IPC bindings (list/read/write/delete + personality read/write, myne-md/myne#697). Classified `memory: Unsupported` in web/wasm/src/capability.rs: the whole AI surface is absent on web (`localAi`), so no web path ever calls these bindings (unlike `chats.ts`, which the browser runs in full). Unreachable rather than substituted, the same posture as the AI settings panel that imports it.",
  ],
  "src/lib/device-name.ts": ["adapted", "The `web` platform token maps to 'Browser' so a browser device is distinguishable in the list (task 69)."],
  "src/lib/deviceJoinQr.ts": ["ported", "Pure payload encoding."],
  "src/lib/enroll-gate.ts": [
    "ported",
    "Pure predicate over the `sync_status` state tag, shared with mobile by source alias; `sync_status` is dispatched on web, so the enrol gate answers there too.",
  ],
  "src/lib/engine-error.ts": [
    "ported",
    "Pure shape reader over a rejection value; its AI callers are the ones the web build never reaches.",
  ],
  "src/lib/focusable.ts": ["ported", "Pure DOM query."],
  "src/lib/icons.ts": ["ported", "Icon vocabulary."],
  "src/lib/imperative-focus-trap.ts": ["ported", "Pure DOM."],
  "src/lib/imperative-modal.ts": ["ported", "Pure DOM."],
  "src/lib/io-banner.ts": ["ported", "Bounded IO-failure copy mapping."],
  "src/lib/overlay-inert.ts": [
    "ported",
    "Pure DOM: the one owner that sets `inert` on the siblings of the topmost open overlay (myne#728). An attribute walk with no host call in it; the web client needs it for exactly the same reason the desktop does, since `aria-modal` alone is an assertion some assistive technology ignores.",
  ],
  "src/lib/regions.ts": [
    "ported",
    "Pure DOM: the three-region keyboard model is an attribute query plus a cycle rule, with no host call in it. The web client renders the same shell from the same `src/` tree, so it inherits the regions and F6 with no seam involved.",
  ],
  "src/hooks/useBetaTermsGate.ts": [
    "ported",
    "Reads the device-local beta-terms acceptance through the platform seam (myne-ops#15), so the hook itself is platform-free — desktop resolves it to a sync-plugin command, the browser to localStorage on the main thread.",
  ],
  "src/lib/legal-urls.ts": [
    "ported",
    "Pure URL construction for the published legal documents (myne-ops#15) — no host call, no IPC, no platform branch. The only input is the i18next language tag, which both clients have. Opening the URL is the seam's job (`openUrl`), and that is already substituted.",
  ],
  "src/lib/load-bearing-copy.ts": ["ported", "Re-exports `@myne/copy`; the literals are identical across clients by construction."],
  "src/lib/meeting-ai.ts": ["typed-unsupported", "Wraps the `local-inference` plugin's `infer_batch` and `chat_stop`; the whole `local-inference` plugin is `Class::Unsupported` on web (web/wasm/src/capability.rs), so on web the dispatcher answers a typed refusal. The meeting AI surface is desktop-only and is not mounted on web."],
  "src/lib/note-export-errors.ts": ["ported", "Error copy; the export destinations differ, the taxonomy does not."],
  "src/lib/noteImageCard.ts": ["ported", "Pure markdown/DOM shaping."],
  "src/lib/noteImageExport.ts": ["adapted", "Rendering is portable; delivery goes through the download seam."],
  "src/lib/password-generator.ts": ["ported", "CSPRNG through `crypto.getRandomValues`, which a browser has."],
  "src/lib/pending-approval.ts": [
    "ported",
    "Two device-local reads through the seam, both dispatched by the web router: `sync_head_fingerprint` (has this device ever adopted a head, the discriminator `sync-protocol.md` §6.2 names) and then, only when it has not, `sync_status` (is it enrolled at all). Order is load-bearing and asserted. It asks the network nothing, because `try_claim_token` collapses a refusal and an unreachable server into one answer. Web-ONLY by construction since myne-md/myne#535: the module answers `false` outright where `localOnlyVault` is present, so desktop pays nothing and cannot be routed to the wait. Web is the client that needs it: the password path is the only enrolment a browser has, so landing pending is the ORDINARY outcome here.",
  ],
  "src/lib/picked-file.ts": [
    "adapted",
    "The desktop handle only. The unwrap moved INTO the seam in task 67 — it used to throw for every web pick.",
  ],
  "src/lib/datetimeFormat.ts": ["ported", "Re-export shim into @myne/editor; pure formatting, no host call."],
  "src/lib/useDateTimeDisplay.ts": ["ported", "Re-export shim into @myne/editor; reads the ambient display store."],
  "src/lib/prefs.ts": ["ported", "Prefs IPC; the plugin is dispatched."],
  "src/lib/promptForText.ts": ["ported", "In-app modal prompt, not a host dialog."],
  "src/lib/reminderLifecycle.ts": [
    "ported",
    "A pure decision table (which lifecycle event reconciles, which cancels everything). No host call, no timer, no DOM.",
  ],
  "src/lib/reminderNotifier.ts": [
    "ported",
    "The in-app tier's delivery: an in-memory pending set, `setTimeout`, and an injected callback. No notification API and no `@tauri-apps/*` — a browser runs it as written. The OS-registration tier, when it lands, is what will need a seam member here.",
  ],
  "src/lib/reminderPermission.ts": [
    "ported",
    "Pure policy over an injected platform API. No production API implementation exists on either client — the in-app tier needs no permission, since nothing is handed to the operating system.",
  ],
  "src/lib/reminderPlatform.ts": [
    "ported",
    "Reads `navigator.platform` to name the host, but `reminderTier` reports `in-app-only` everywhere until an OS-registration adapter exists — which is also the right answer for a browser tab, since it holds no registration either.",
  ],
  "src/lib/reminderSchedule.ts": [
    "ported",
    "Pure scheduling arithmetic: the target set, the diff, and the reconcile pass over an injected notifier.",
  ],
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
  "src/lib/clipboard.ts": [
    "ported",
    "The copy-policy chokepoint (myne-md/myne#390). Runs on web as written because it holds no transport: the platform write, the clear and the error sink are all injected, and the module imports nothing at all. On web the injected write IS `web/src/platform/clipboardManager.ts`, so the same code makes the same decision about what the user is told and only the byte-mover underneath it differs. The `os-managed` clear arm is mobile-only and simply has no web caller; the `host` arm's clear is the web dispatcher's refusal, exactly as `secret-export.ts` below describes.",
  ],
  "src/lib/recovery-kit.ts": [
    "ported",
    "A pure function from strings to one string: the recovery kit's file contents. No host call, no filesystem, no clipboard — the writing is `secret-export.ts` below, which is where the web adaptation lives. So the browser produces byte-identical kit text to the desktop, which is the point: a kit saved on one client has to be readable by the recovery flow on another.",
  ],
  "src/lib/secret-export.ts": [
    "adapted",
    "Both halves adapt rather than one shipping and one being substituted, and the note that said otherwise was falsified on three clauses at once by `decisions.md` 2026-08-15 (entry 0514). Save-as-file takes the browser-download arm where `nativeSaveAs` is absent; the clipboard copy takes the `none` clear strategy where `clipboardAutoClear` is absent, so it writes and reports and schedules nothing. Its secret callers are the two creation steps, which are no longer substituted: creation ships on web.",
  ],

  "src/lib/spell.ts": ["adapted", "Unreachable where `spellCheck` is absent; the editor host omits the `spell` member."],
  "src/lib/stage.ts": ["adapted", "Boot routing branches on capabilities: an empty web client goes to account-entry, a corrupt one to re-sync (task 85)."],
  "src/lib/sync-staleness.ts": [
    "ported",
    "Pure arithmetic over the last-successful-sync timestamp, plus the copy that says so after three days. It belongs on web MORE than on desktop, not less: a desktop vault works offline indefinitely, while the web client is sync-required (`decisions.md` 2026-07-26), so a sync that stopped working is the difference between a vault that is merely idle and one the user cannot reach from anywhere else.",
  ],
  "src/lib/syntaxTheme.ts": ["ported", "CodeMirror theme."],
  "src/lib/theme-errors.ts": ["ported", "Error copy."],
  "src/lib/theme.ts": ["ported", "CSSOM only."],
  "src/lib/themeMeasure.ts": ["ported", "Pure arithmetic + getComputedStyle."],
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
  "src/hooks/useScreenCaptureOverride.ts": [
    "adapted",
    "Ships, and short-circuits before its first IPC here. It owns the client state of the device-local screen-capture override for both surfaces that touch it (myne-md/myne#482), and its mount read is gated on the `screenCaptureProtection` capability, which is absent on web, so the hook holds `null` and both consumers render the override as off, which is what they would render anyway. The gate lives here rather than at each caller because it used to sit AFTER the escape's effect, which cost a Worker round trip per mount for an answer the capability set already had.",
  ],
  "src/lib/screen-capture-override.ts": [
    "typed-unsupported",
    "Ships, and on this client no call reaches IPC. All three wrappers name commands the wasm dispatcher classifies `Unsupported` for the whole `screen-capture` plugin, and every caller is gated on the `screenCaptureProtection` capability, which the web descriptor omits: `ScreenCaptureEscape` and the Privacy row omit their controls, and `useRevealAfterIdleLock` returns before calling `showWindowProtected` (a page has no hidden window to reveal and no capture affinity to lose). The gating is what makes this `typed-unsupported` rather than a live refusal path: the backend answer exists and is typed, and nothing on this client asks for it. `threat-model.md` A15/TB11 already records that the web client has no screen-capture protection, so an escape from it would be a control with no referent (myne-md/myne#482, #483).",
  ],
  "src/lib/vault-delete.ts": ["adapted", "Task 72 owns what deletion MEANS on a sync-required client; the binding itself is portable."],
  "src/lib/vault-migrate.ts": ["typed-unsupported", "The whole-vault v0.1→v0.2 migration (#420) is a desktop flow (Class::Unsupported in web/wasm/src/capability.rs, like vault-creation): a browser client joins an already-current account over sync and never migrates. The binding is present but its command answers the typed refusal on web."],
  "src/lib/vault-export-errors.ts": ["ported", "Error copy shared with the note-level export that does ship."],
  "src/lib/vault-label.ts": [
    "adapted",
    "Ships, and nothing on this client calls it. It is the shared half of the hide-vault-names row (myne-md/myne#411): the error narrowing, the notice mapping and the three `plugin:vault-label|...` wrappers. `PrivacyPanel` omits that row where `lockedVaultNames` is absent, which it is on web. The dispatcher answers `Unsupported` for the whole plugin to match: a page has no OS keychain to seal a name with, and no locked picker to show one on. It lives at this path rather than inside the panel so `scripts/check-twin-drift.mjs` can see its `mobile/src/lib/vault-label.ts` twin.",
  ],
  "src/lib/account.ts": [
    "adapted",
    "Ships, and nothing on this client calls it. The account-record command mirrors (myne-md/myne#684): the four `plugin:account|...` wrappers. The picker grouping UI that would call them is omitted where `accountGrouping` is absent, which it is on web (one vault per origin, no OS keychain). The dispatcher answers `Unsupported` for the whole plugin to match.",
  ],
  "src/lib/vault-list.ts": ["adapted", "One constant vault id per origin (task 85)."],
  "src/lib/vaultDisplayName.ts": [
    "ported",
    "Pure naming: a vault's label, or the neutral `Vault N` fallback derived from `stableVaultNumber`. No IPC, no host. It runs as written on web, where the one constant vault per origin means the fallback is always `Vault 1` — correct rather than degraded, since there is no list to rank it against.",
  ],
  "src/lib/viewsEnabled.ts": ["ported", "Device-local Views feature toggle helper (localStorage); runs as written."],
  "src/lib/vault-recover.ts": [
    "ported",
    "The phrase-recovery binding. Was `excluded` and module-gated out of the wasm build (task 12); `decisions.md` 2026-08-15 reverses that and ships recovery here. The core's read and write moved onto the IO seam as ONE implementation rather than a wasm twin, so this binding calls the same commands it always did.",
  ],
  "src/lib/vault-repair.ts": ["adapted", "Task 72 owns the verdict; the dispatcher answers `Pending` meanwhile."],
  "src/lib/vault-slot-kind.ts": ["ported", "Boot probe."],
  "src/lib/vault-status.ts": ["ported", "Boot probe."],
  "src/lib/vault-switch.ts": ["adapted", "Reachable only with ≥2 vaults, which one origin cannot have."],
  "src/lib/vault-unlock.ts": ["ported", "The unlock IPC — the one path web needs most."],
  "src/lib/meeting-notes.ts": ["adapted", "Meeting sessions are desktop-only in EFFECT rather than by omission: the capture path is a Rust CoreAudio tap plus cpal, and the web dispatcher refuses the three `plugin:attachments|meeting_session_*` commands, so `/meeting` starts and immediately fails on web. The seam member IS installed (an earlier version of this verdict claimed the host omits it, which `src/editor-host.ts` contradicts), which is the same interim shape `voice-record.ts` one line up documents."],
  "src/lib/voice-record.ts": ["adapted", "Voice capture is desktop-only; the editor host omits the recorder."],
  "src/lib/workspace-persist.ts": ["ported", "`MYW1` IPC; ported into core and dispatched in task 65."],
  "src/lib/writing-assistant.ts": ["adapted", "Unreachable where `localAi` is absent."],

  // ── src/hooks ───────────────────────────────────────────────────────────
  "src/hooks/useAccountStatus.ts": ["ported", "Sync account status; degrades to null on an older server."],
  "src/hooks/useScrollEdges.ts": [
    "ported",
    "Pure DOM geometry (scrollTop/clientHeight/scrollHeight) behind a ResizeObserver and a "
      + "MutationObserver, both feature-detected because a host may lack them. No host call, no "
      + "seam import, no capability. Its four consumers all ship on web: CenteredCard, "
      + "VaultPicker, step-shell and PhraseEntryStep, which is a pre-unlock screen, so the "
      + "absence half of this guard covers it there.",
  ],
  "src/hooks/useHeadFingerprintCompare.ts": [
    "ported",
    "The SYNC-40 eye-compare poll + its push hold (myne#462). More load-bearing here than on desktop: per `decisions.md` 2026-07-26 a web client re-runs this compare on EVERY re-bootstrap, because OPFS is evictable.",
  ],
  "src/hooks/useActivityHeartbeat.ts": ["adapted", "Page activity, not OS idle — `osIdleAutoLock` is absent and the browser timer is a different signal (task 43)."],
  "src/hooks/useAiModelReady.ts": ["adapted", "Unreachable where `localAi` is absent."],
  "src/hooks/useAttachmentTransfers.ts": ["ported", "Progress state around the attachment IPC."],
  "src/hooks/useBackupScheduler.ts": [
    "excluded",
    "Mounted unconditionally by the Editor; it ran a five-minute IPC loop for the whole session against a plugin that refuses every call.",
  ],
  "src/hooks/useConflictMaterializer.ts": ["ported", "Keep-both conflict drain; the sync engine is shared."],
  "src/hooks/useDevices.ts": ["ported", "Device roster; the commands are dispatched (task 69)."],
  "src/hooks/useRoster.ts": [
    "typed-unsupported",
    "The B2B member commands are `Class::Unsupported` on web (`memberSharing` absent), and the only module that imports this hook is `MemberRosterPanel`, itself substituted out of the bundle, so the hook does not reach served code. Recorded as typed-unsupported rather than excluded because the absence is a capability refusal, not a build-time substitution of this file.",
  ],
  "src/lib/invite.ts": [
    "typed-unsupported",
    "Same capability refusal as useRoster; every command here is `Class::Unsupported` on web.",
  ],
  "src/lib/personAccount.ts": [
    "excluded",
    "The person-account bindings are substituted out of the web bundle. The identity-only screens are absent and the backend is capability-refused there, so retaining these bindings would only preserve an unreachable path.",
    "person-account-binding",
  ],
  "src/hooks/useEnroll.ts": ["adapted", "The phrase credential is refused at the last door (task 92); password enrolment is the web path."],
  "src/hooks/useFocusTrap.ts": ["ported", "Pure DOM."],
  "src/hooks/useOverlayInert.ts": [
    "ported",
    "Pure DOM: the React binding for the shared overlay `inert` owner (myne#728). No host call, and the browser client renders the same overlays from the same `src/` tree.",
  ],
  "src/hooks/useIdleAutoLock.ts": ["adapted", "Same signal difference as useActivityHeartbeat."],
  "src/hooks/useIsFullscreen.ts": [
    "adapted",
    "Answers the Fullscreen API on web — the seam's `isFullscreen` is `document.fullscreenElement !== null`, which is the question the caller is asking.",
  ],
  "src/hooks/useDateTimeDisplaySync.ts": [
    "ported",
    "Publishes resolved prefs + the active language into the shared display store; prefs only.",
  ],
  "src/hooks/usePrefs.ts": ["ported", "The shared prefs hook."],
  "src/hooks/useReminderScheduler.ts": [
    "adapted",
    "The hook itself is timers over an injected notifier and runs as written. What differs is its input: the task list comes from the vault-indices plugin, which the web dispatcher still answers `Pending` (task 31), so the pass finds nothing to register until that lands. It fails quiet rather than loud — an empty target set is a valid pass.",
  ],
  "src/hooks/useRevealAfterIdleLock.ts": [
    "adapted",
    "Mounts on web and reaches a seam that REFUSES it (MYND-628). Desktop idle auto-lock hides the OS window with `orderOut:` and nothing on the Rust side shows it again, so a locked boot surface has to ask; a page has no hidden window, because web auto-lock re-renders the locked surface in the same tab. `window.show` is a typed refusal rather than a no-op, and the hook's `catch` is the correct handler — so this is adapted, not excluded: it still runs, it just correctly does nothing.",
  ],
  "src/hooks/useSyncStatus.ts": ["ported", "Sync status; more load-bearing on web, where sync is required."],
  "src/hooks/useUpdateAvailable.ts": [
    "adapted",
    "Desktop self-update. Gated on the `selfUpdate` capability, which is absent on web, so the check never runs there and no banner mounts. The `plugin:update|*` commands are `Unsupported` on web (`web/wasm/src/capability.rs`), reached only through the platform seam.",
  ],
  "src/hooks/useTorState.ts": [
    "adapted",
    "The live Tor posture poll (MYND-650 task 8). It ships and it mounts, but it gates on the `torRouting` capability and on web that is absent, so it never invokes and reports `null` — which every consumer renders as nothing at all. Deliberately not a typed refusal in practice: a browser tab cannot tell whether the browser around it is Tor Browser, and polling a command that would answer `stopped` would let the UI claim 'not protected' about a user who is in fact fully routed.",
  ],
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
  "src/lib/import-errors.ts": [
    "ported",
    "Why an import stopped, or why one file did not come across (myne-md/myne#223). Shared because the cause is the seam's own closed error set, not the host's: both clients reject with the serialized backend value rather than an `Error`, so both need the same classification to say anything more useful than 'Import failed.'",
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
  return walkFiles(dirs, { extensions: TS_FILES });
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
