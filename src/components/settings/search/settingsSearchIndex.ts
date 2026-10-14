// Settings search-index registry (MYND-536). The single declarative source of
// truth for what the Settings search can find. Matching runs against THIS static
// array, never the rendered DOM - panels run IPC on mount (prefsRead / usePrefs),
// so mounting all ten to scan their text is rejected as heavy + fragile.
//
// Each entry names an i18n key for its title (+ optional description + optional
// translatable keyword/synonym string) and the `panelId` that owns it. The `id`
// doubles as the `data-setting-anchor="<id>"` scroll target; where a setting
// already exposes a stable `data-testid` the entry records it as `testid` and the
// shell's scroll/flash resolver falls back to it - so most settings need no panel
// edit. Titles/descriptions reference the SAME keys the panels already render, so
// search text can't drift from the UI; a few settings whose live label is an
// inline string (or lives outside the `settings.*` namespace) get dedicated
// `settings.search.extra.*` / `sync.panel.*` keys.
//
// CONVENTION (see PRD + candidate decisions.md entry): a new user-facing setting
// ships with its entry here in the same change. The drift test guards key
// resolution + panel coverage, but cannot know about an entry that was never added.

import type { PanelId } from "../../SettingsModal";
import { has, type Capability } from "../../../platform/capabilities";

/**
 * Whether the in-app agent may change the setting this entry describes
 * (myne-md/myne#850).
 *
 * The agent's setting-write capability is a closed set of named intents, and this
 * is the field each entry declares itself in. It is REQUIRED rather than optional
 * on purpose: the failure it prevents is a setting entering this tree and quietly
 * becoming agent-writable, which is exactly how an AI or CLI switch would arrive.
 * The drift test in `tests/settings-search-index.test.ts` names any entry carrying
 * no verdict, so the question is put to whoever adds the setting, at the entry,
 * rather than being answered by default.
 *
 * `refused` carries a reason, and the reason is what keeps the boundary
 * reviewable: the egress and confidentiality controls are refused because they
 * bound what AI and the CLI may reach, not because nobody has got to them yet.
 * Without a reason those two are indistinguishable.
 *
 * This is a statement about the SETTING, not about the runtime. A build or a
 * window where the write cannot be performed omits the intent whatever this field
 * says; the two questions are separate.
 */
export type AgentWritability =
  | { verdict: "writable" }
  | { verdict: "refused"; reason: string };

/**
 * The refused arm of {@link AgentWritability}.
 *
 * Here so the two refusal constants below can carry their own `reason` as a
 * readable field: typed as the whole union, `WRITABILITY_CONTROL.reason` is a
 * type error at every consumer without a narrowing dance, which is exactly what
 * `tests/settings-search-index.test.ts` hit when it compared a control's reason
 * against the constant's.
 */
export type AgentRefused = Extract<AgentWritability, { verdict: "refused" }>;

export interface SettingsIndexEntry {
  /** Unique, stable id. Also the `data-setting-anchor` value (Task 4). */
  id: string;
  /** Owning rail panel - the navigation target + results grouping key. */
  panelId: PanelId;
  /** Existing `data-testid` on this setting's control, used as the scroll/flash
   *  fallback target when no `data-setting-anchor` is present (optional). */
  testid?: string;
  /** i18n key for the setting's display title (required). */
  titleKey: string;
  /** i18n key for the setting's description/helper (optional). */
  descriptionKey?: string;
  /** i18n key resolving to a space/comma-joined synonym string (optional,
   *  translatable). Broadens matching beyond the literal label. */
  keywordsKey?: string;
  /**
   * The capability this setting's control needs (phase3-web-client task 96).
   *
   * Matching runs against THIS static array rather than the rendered DOM -
   * panels are not mounted, which is the whole reason the registry exists. That
   * makes an ungated index actively harmful on a client with absent
   * capabilities: the search happily finds a setting, navigates to its panel and
   * scrolls to a `data-setting-anchor` that was never rendered, leaving the user
   * at a panel with no explanation and no setting.
   *
   * Absent ⇒ the setting is unconditional. Present ⇒ the entry is filtered out
   * where `platform/capabilities.has()` says no, which is the same rule the rail
   * and the panels already use - one descriptor, three consumers, no third
   * source of truth.
   */
  capability?: Capability;
  /**
   * Whether this entry additionally requires the `developer_mode` preference
   * to be on (developer-mode feature, MYND-593). **Deliberately separate from
   * `capability`** - the capability set is a static per-build descriptor the
   * platform seam-contract tests rest on, while Developer mode is a runtime
   * user toggle; folding the two together would make a static invariant
   * dynamic. Settings search resolves straight to a panel id, so without this
   * an entry behind the gate would happily navigate into a hidden panel.
   */
  developerGated?: boolean;
  /**
   * Whether the in-app agent may change this setting. See
   * {@link AgentWritability} for why this is required rather than optional.
   */
  agentWritability: AgentWritability;
}

/**
 * The verdicts, as named values, so the answer at an entry is one short line
 * rather than a repeated object literal.
 *
 * `WRITABILITY_CONTROL` is the one that carries a policy, and it is the reason the
 * verdict is not a boolean: these settings bound what AI and the CLI may reach,
 * and the shipped copy promises two of them absolutely ("Notes in these folders
 * are never read or indexed by AI"). An agent that could write one would turn that
 * promise into one conditional on the agent not having been steered.
 */
export const WRITABILITY_NONE: AgentRefused = {
  verdict: "refused",
  reason:
    "not an agent-settable setting: no setting intent resolves to it, so the agent is not given it",
};

export const WRITABILITY_CONTROL: AgentRefused = {
  verdict: "refused",
  reason:
    "an egress or confidentiality control, refused so the agent cannot write the value that bounds what AI and the CLI may reach",
};

/**
 * A per-DEVICE setting, refused because a change would not travel
 * (myne-md/myne#850).
 *
 * **Its own verdict rather than `WRITABILITY_CONTROL`, because the reason is
 * different and the user's remedy is different.** A control is refused because
 * the agent must not move a bound it runs under; one of these is refused because
 * it is stored per machine and syncs nothing, so a change made on the computer
 * would leave the phone showing the old value with nothing explaining why. The
 * classification calls these `DeviceLocal`, and the agent's intent table leaves
 * them out on exactly that basis.
 */
export const WRITABILITY_DEVICE_LOCAL: AgentRefused = {
  verdict: "refused",
  reason:
    "a per-device setting that does not sync, so an agent write would apply on the machine that ran it and nowhere else with nothing saying why",
};

/**
 * The setting has an intent and the agent may change it (myne-md/myne#850).
 *
 * **The verdict is about the SETTING; whether a run can act on it is a separate
 * question, and that separation is why this constant exists at all.** The field
 * says the setting is in the v1 families; the catalogue a run is offered is built
 * from this field, and `myne-core`'s intent table is the authority that re-derives
 * it at the write. A build or a window where the write cannot happen omits the
 * intent whatever this says.
 */
export const WRITABILITY_WRITABLE: AgentWritability = { verdict: "writable" };

// Ordered by rail order (account → … → about → ai), and within a panel by the
// order the settings appear in the panel. Keeping this aligned with the panels
// makes the additive `data-setting-anchor` pass in Task 4 a straight read-down.
export const SETTINGS_SEARCH_INDEX: readonly SettingsIndexEntry[] = [
  // ── Account ────────────────────────────────────────────────────────────────
  {
    id: "account.vault-label",
    agentWritability: WRITABILITY_NONE,
    panelId: "account",
    testid: "settings.label-input",
    titleKey: "settings.account.vaultLabelEyebrow",
    descriptionKey: "settings.account.vaultLabelHelper",
    keywordsKey: "settings.search.keywords.vaultLabel",
  },
  {
    id: "account.vault-icon",
    agentWritability: WRITABILITY_NONE,
    panelId: "account",
    testid: "settings.icon-picker",
    titleKey: "settings.account.vaultIconLabel",
    keywordsKey: "settings.search.keywords.vaultIcon",
  },
  {
    id: "account.change-password",
    agentWritability: WRITABILITY_NONE,
    panelId: "account",
    testid: "settings.change-password-cta",
    titleKey: "settings.account.changePasswordHeading",
    descriptionKey: "settings.account.changePasswordHelper",
    keywordsKey: "settings.search.keywords.changePassword",
  },
  {
    id: "account.danger-zone",
    agentWritability: WRITABILITY_NONE,
    panelId: "account",
    testid: "settings.delete-vault-cta",
    titleKey: "settings.account.dangerZoneHeading",
    descriptionKey: "settings.account.dangerZoneHelper",
    keywordsKey: "settings.search.keywords.dangerZone",
  },

  // ── Privacy ────────────────────────────────────────────────────────────────
  {
    id: "privacy.screen-capture",
    agentWritability: WRITABILITY_CONTROL,
    // NO `capability`, and that is the asymmetry with the override entry
    // below. `PrivacyPanel` renders THIS row unconditionally, so tagging it
    // was the inverse of the rule `src/AGENTS.md` states: search filtered it
    // out on web while the panel rendered it, which is a setting a user can
    // see and cannot find. The prose in this file and in
    // `check-web-surfaces.mjs` said the two rows matched; correcting the
    // prose without correcting the gate would have left the same defect with
    // better documentation.
    panelId: "privacy",
    titleKey: "settings.privacy.screenCaptureLabel",
    descriptionKey: "settings.privacy.screenCaptureHelperOn",
    keywordsKey: "settings.search.keywords.screenCapture",
  },
  {
    // myne-md/myne#482. The device-local escape hatch, mirrored here so a user
    // who took it pre-unlock has an obvious way back. `capability`-tagged
    // because `PrivacyPanel` wraps THIS row in `has("screenCaptureProtection")`
    // and an untagged entry would navigate to an anchor that was never
    // rendered. The per-vault row above is NOT gated, so the two differ: this
    // comment claimed they matched, and the web verdict in
    // `check-web-surfaces.mjs` said the same, both wrongly. The gate is new and
    // one-sided, and it stays that way deliberately: the per-vault field is
    // vault content that a user may want to read and set on a client where the
    // native call does nothing, while this row writes a device-local file whose
    // only purpose is suppressing a call that client never makes.
    //
    // No `developerGated`: the person this exists for is a low-vision or
    // remote-desktop user on a black window, and a setting behind Developer
    // mode cannot be found by them.
    id: "privacy.screen-capture-override",
    agentWritability: WRITABILITY_CONTROL,
    capability: "screenCaptureProtection",
    panelId: "privacy",
    titleKey: "settings.privacy.screenCaptureOverrideLabel",
    descriptionKey: "settings.privacy.screenCaptureOverrideHelper",
    keywordsKey: "settings.search.keywords.screenCaptureOverride",
  },
  {
    // myne-md/myne#411. One gate, and deliberately not the other.
    //
    // `capability`, because PrivacyPanel omits the row where
    // `lockedVaultNames` is absent, and an untagged entry would navigate to an
    // anchor that was never rendered. The capability is about the locked
    // picker and the keychain-sealed store behind it, not about the setting.
    //
    // No `developerGated`: `developer_mode` is a per-vault `vault.prefs` field
    // and the picker this governs is device-wide, and the person the option is
    // fully honest for is the one who sets it before a first unlock ever
    // writes a name, and a control behind Developer mode cannot be found by
    // them.
    id: "privacy.hide-vault-names",
    agentWritability: WRITABILITY_NONE,
    capability: "lockedVaultNames",
    panelId: "privacy",
    testid: "settings.hide-vault-names",
    titleKey: "settings.privacy.hideVaultNamesLabel",
    descriptionKey: "settings.privacy.hideVaultNamesHelper",
    keywordsKey: "settings.search.keywords.hideVaultNames",
  },
  {
    // The recovery drill (myne-md/myne#468). No `capability`: the command is
    // `myne-core`'s and the web dispatcher routes it, so every client renders
    // the row. No `developerGated` either — a first-time user is exactly who it
    // is for, and a control behind Developer mode cannot be found by them.
    //
    // Searchable on purpose, and it is the one surface this feature gets:
    // nothing offers the drill automatically (`RecoveryDrillRow`'s header says
    // why), so a user who remembers there is a way to check has to be able to
    // find it by typing "recovery" into Settings.
    id: "privacy.recovery-drill",
    agentWritability: WRITABILITY_NONE,
    panelId: "privacy",
    testid: "settings.recovery-drill",
    titleKey: "settings.privacy.recoveryDrillLabel",
    descriptionKey: "settings.privacy.recoveryDrillHelper",
    keywordsKey: "settings.search.keywords.recoveryDrill",
  },
  {
    id: "privacy.auto-lock",
    agentWritability: WRITABILITY_CONTROL,
    panelId: "privacy",
    testid: "settings.auto-lock-select",
    titleKey: "settings.privacy.autoLockLabel",
    descriptionKey: "settings.privacy.autoLockHelper",
    keywordsKey: "settings.search.keywords.autoLock",
  },
  {
    id: "privacy.quick-unlock",
    agentWritability: WRITABILITY_NONE,
    capability: "biometricQuickUnlock",
    panelId: "privacy",
    testid: "settings.quick-unlock",
    titleKey: "settings.quickUnlock.title",
    descriptionKey: "settings.quickUnlock.setupHelper",
    keywordsKey: "settings.search.keywords.quickUnlock",
  },
  // Shared vault password (myne-md/myne#711). Carries `memberSharing`: the row is
  // rendered only while a B2B member vault is active, so an ungated entry would
  // navigate to an anchor that was never rendered.
  {
    id: "privacy.member-password",
    agentWritability: WRITABILITY_NONE,
    capability: "memberSharing",
    panelId: "privacy",
    testid: "settings.member-password",
    titleKey: "settings.memberPassword.title",
    descriptionKey: "settings.memberPassword.helperNotConfigured",
    keywordsKey: "settings.search.keywords.memberPassword",
  },
  // CLI terminal access (MYND-490). All three carry `cliAccess`: the block is
  // omitted where the capability is absent, so an ungated entry would navigate
  // to an anchor that was never rendered. All three ALSO carry
  // `developerGated` (#181) - PrivacyPanel now renders the block only while
  // Developer mode is on, and the two gates are independent, so the entry
  // needs both to stay in step with its control. The first developer-gated
  // entries in a `core` panel: the flag has never meant "lives in the
  // Developer rail group", only "hidden while the mode is off".
  {
    id: "privacy.cli-access",
    agentWritability: WRITABILITY_CONTROL,
    capability: "cliAccess",
    developerGated: true,
    panelId: "privacy",
    titleKey: "settings.cliAccess.label",
    descriptionKey: "settings.cliAccess.helperOff",
    keywordsKey: "settings.search.keywords.cliAccess",
  },
  {
    id: "privacy.cli-excluded-folders",
    agentWritability: WRITABILITY_CONTROL,
    capability: "cliAccess",
    developerGated: true,
    panelId: "privacy",
    titleKey: "settings.cliAccess.excludedLabel",
    descriptionKey: "settings.cliAccess.excludedHelper",
    keywordsKey: "settings.search.keywords.cliExcludedFolders",
  },
  {
    id: "privacy.cli-rate-limit",
    agentWritability: WRITABILITY_CONTROL,
    capability: "cliAccess",
    developerGated: true,
    panelId: "privacy",
    titleKey: "settings.cliAccess.rateLimitLabel",
    descriptionKey: "settings.cliAccess.rateLimitHelper",
    keywordsKey: "settings.search.keywords.cliRateLimit",
  },

  // ── Sync (keys live under `sync.panel.*`, not `settings.*`) ─────────────────
  {
    id: "sync.status",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    titleKey: "sync.panel.status.label",
    descriptionKey: "sync.panel.status.helper",
    keywordsKey: "settings.search.keywords.syncStatus",
  },
  {
    id: "sync.devices",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    titleKey: "sync.panel.devices.label",
    keywordsKey: "settings.search.keywords.syncDevices",
  },
  {
    id: "sync.members",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    titleKey: "sync.memberRoster.title",
    descriptionKey: "sync.memberRoster.hint",
    keywordsKey: "settings.search.keywords.syncMembers",
    // The control is gated on `memberSharing` (SyncPanel renders the panel only
    // under `hasCapability("memberSharing")`), so the search
    // entry must carry the same gate or it navigates to an anchor that never
    // renders on a client where the capability is absent.
    capability: "memberSharing",
  },
  {
    id: "sync.device-bindings",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    titleKey: "sync.deviceBindings.title",
    descriptionKey: "sync.deviceBindings.hint",
    keywordsKey: "settings.search.keywords.syncDeviceBindings",
    // Same gate as `sync.members` above, and for the same reason: the block is
    // rendered only under `hasCapability("memberSharing")`, so an ungated entry
    // would scroll to an anchor that never renders on a client without it.
    capability: "memberSharing",
  },
  {
    id: "sync.add-device",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    titleKey: "sync.panel.addDevice.label",
    descriptionKey: "sync.panel.addDevice.helper",
    keywordsKey: "settings.search.keywords.syncAddDevice",
  },
  {
    id: "sync.conflicts",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    titleKey: "sync.panel.conflicts.label",
    descriptionKey: "sync.panel.conflicts.helper",
    keywordsKey: "settings.search.keywords.syncConflicts",
  },
  {
    id: "sync.recovered",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    titleKey: "sync.panel.recovered.label",
    descriptionKey: "sync.panel.recovered.helper",
    keywordsKey: "settings.search.keywords.syncRecovered",
  },
  {
    id: "sync.server",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    titleKey: "sync.panel.server.label",
    keywordsKey: "settings.search.keywords.syncServer",
  },

  // ── Editor ─────────────────────────────────────────────────────────────────
  {
    id: "editor.text-size",
    agentWritability: WRITABILITY_DEVICE_LOCAL,
    panelId: "editor",
    titleKey: "settings.typography.textSizeLabel",
    keywordsKey: "settings.search.keywords.textSize",
  },
  {
    id: "editor.line-spacing",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    titleKey: "settings.typography.lineSpacingLabel",
    keywordsKey: "settings.search.keywords.lineSpacing",
  },
  {
    id: "editor.content-width",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    titleKey: "settings.typography.contentWidthLabel",
    descriptionKey: "settings.typography.contentWidthHelper",
    keywordsKey: "settings.search.keywords.contentWidth",
  },
  {
    id: "editor.font",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    titleKey: "settings.typography.fontLabel",
    keywordsKey: "settings.search.keywords.font",
  },
  {
    id: "editor.line-numbers",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    testid: "settings.line-numbers",
    titleKey: "settings.lineNumbers.label",
    descriptionKey: "settings.lineNumbers.helper",
    keywordsKey: "settings.search.keywords.lineNumbers",
  },
  {
    // Developer-gated (#181), like the CLI trio above and for the same
    // reason: EditorPanel renders the toggle only while Developer mode is on.
    // No `capability` - vim ships on every client, so this entry's gate is
    // the runtime one alone.
    id: "editor.vim-mode",
    agentWritability: WRITABILITY_NONE,
    developerGated: true,
    panelId: "editor",
    testid: "settings.vim-mode",
    titleKey: "settings.vimMode.label",
    descriptionKey: "settings.vimMode.helper",
    keywordsKey: "settings.search.keywords.vimMode",
  },
  {
    // The plain-file editor (myne-md/myne#788). Both gates, and they are
    // independent: `capability` keeps search from navigating to a row the web
    // bundle does not render (the plugin is absent there). NOT
    // `developerGated`: the row is on by default and not behind Developer mode
    // (amended 2026-10-01), so search must find the off-switch for every user
    // rather than hiding it until Developer mode is on.
    id: "editor.plain-file",
    agentWritability: WRITABILITY_NONE,
    capability: "plainFile",
    panelId: "editor",
    testid: "settings.plain-file",
    titleKey: "settings.plainFile.label",
    descriptionKey: "settings.plainFile.helper",
    keywordsKey: "settings.search.keywords.plainFile",
  },
  {
    id: "editor.toolbar",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    testid: "settings.toolbar-customize",
    titleKey: "settings.toolbarCustomize.label",
    descriptionKey: "settings.toolbarCustomize.helper",
    keywordsKey: "settings.search.keywords.toolbar",
  },
  {
    id: "editor.view-mode",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    titleKey: "settings.viewMode.label",
    descriptionKey: "settings.viewMode.helper",
    keywordsKey: "settings.search.keywords.viewMode",
  },
  {
    id: "editor.date-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dateTime.dateLabel",
    descriptionKey: "settings.dateTime.dateHelper",
    keywordsKey: "settings.search.keywords.dateFormat",
  },
  {
    id: "editor.time-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dateTime.timeLabel",
    descriptionKey: "settings.dateTime.timeHelper",
    keywordsKey: "settings.search.keywords.timeFormat",
  },
  {
    id: "editor.timezone",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    titleKey: "settings.dateTime.zoneLabel",
    descriptionKey: "settings.dateTime.zoneHelper",
    keywordsKey: "settings.search.keywords.timezone",
  },
  {
    id: "editor.focus-dim",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    testid: "settings.focus-dim",
    titleKey: "settings.focusMode.dimLabel",
    descriptionKey: "settings.focusMode.dimHelper",
    keywordsKey: "settings.search.keywords.focusMode",
  },
  {
    id: "editor.focus-typewriter",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    testid: "settings.focus-typewriter",
    titleKey: "settings.focusMode.typewriterLabel",
    descriptionKey: "settings.focusMode.typewriterHelper",
    keywordsKey: "settings.search.keywords.focusMode",
  },
  {
    id: "editor.spell-check",
    agentWritability: WRITABILITY_NONE,
    capability: "spellCheck",
    panelId: "editor",
    testid: "settings.spell-check",
    titleKey: "settings.spell.label",
    descriptionKey: "settings.spell.helper",
    keywordsKey: "settings.search.keywords.spell",
  },
  {
    id: "editor.spell-languages",
    agentWritability: WRITABILITY_NONE,
    capability: "spellCheck",
    panelId: "editor",
    titleKey: "settings.spell.languagesLabel",
    descriptionKey: "settings.spell.languagesHelper",
    keywordsKey: "settings.search.keywords.spellLanguages",
  },
  {
    id: "editor.daily-notes-folder",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionDaily",
    descriptionKey: "settings.dailyNotes.periodFolderLabel",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  {
    id: "editor.daily-notes-date-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionDaily",
    descriptionKey: "settings.dailyNotes.periodFormatLabel",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  {
    id: "editor.daily-notes-template",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionDaily",
    descriptionKey: "settings.dailyNotes.periodTemplateLabel",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  // myne#177. The weekly and monthly rows get their own entries rather than
  // riding the daily ones: search scrolls to a setting's ANCHOR, and the three
  // periods are three anchors. Each is titled by its section and described by
  // its row, so three results are not all called "Folder".
  {
    id: "editor.weekly-notes-folder",
    // The tracer bullet's intent (myne-md/myne#850): the first setting the
    // agent may change, chosen because the periodic-notes setter already
    // registers a folder backend-side, so the write needs no new seam.
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionWeekly",
    descriptionKey: "settings.dailyNotes.periodFolderLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.weekly-notes-date-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionWeekly",
    descriptionKey: "settings.dailyNotes.periodFormatLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.weekly-notes-template",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionWeekly",
    descriptionKey: "settings.dailyNotes.periodTemplateLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.monthly-notes-folder",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionMonthly",
    descriptionKey: "settings.dailyNotes.periodFolderLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.monthly-notes-date-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionMonthly",
    descriptionKey: "settings.dailyNotes.periodFormatLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.monthly-notes-template",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionMonthly",
    descriptionKey: "settings.dailyNotes.periodTemplateLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.reminders",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    testid: "settings.reminders-toggle",
    titleKey: "settings.reminders.label",
    keywordsKey: "settings.search.keywords.reminders",
  },
  {
    id: "editor.archive",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    testid: "settings.archive-disabled",
    titleKey: "settings.archive.label",
    descriptionKey: "settings.archive.helper",
    keywordsKey: "settings.search.keywords.archive",
  },
  {
    id: "editor.views",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    testid: "settings.views-enabled",
    titleKey: "settings.views.label",
    descriptionKey: "settings.views.helper",
  },
  {
    id: "editor.task-chip-color",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    testid: "settings.editor.taskChipColor",
    titleKey: "settings.editor.taskChipColor.label",
    descriptionKey: "settings.editor.taskChipColor.help",
  },
  {
    id: "editor.task-chip-icon-only",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    testid: "settings.editor.taskChipIconOnly",
    titleKey: "settings.editor.taskChipIconOnly.label",
    descriptionKey: "settings.editor.taskChipIconOnly.help",
  },

  // ── Files ──────────────────────────────────────────────────────────────────
  {
    id: "files.startup-open",
    agentWritability: WRITABILITY_NONE,
    panelId: "files",
    testid: "settings.startup-open-select",
    titleKey: "settings.files.startup.label",
    descriptionKey: "settings.files.startup.helper",
    keywordsKey: "settings.search.keywords.startupOpen",
  },
  {
    id: "files.new-note-location",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "files",
    testid: "settings.new-note-location-select",
    titleKey: "settings.files.newNote.label",
    descriptionKey: "settings.files.newNote.helper",
    keywordsKey: "settings.search.keywords.newNoteLocation",
  },
  {
    id: "files.folder-notes",
    agentWritability: WRITABILITY_NONE,
    panelId: "files",
    testid: "settings.folder-notes-toggle",
    titleKey: "settings.folderNotes.label",
    descriptionKey: "settings.folderNotes.helper",
    keywordsKey: "settings.search.keywords.folderNotes",
  },
  {
    id: "files.attachment-compression",
    agentWritability: WRITABILITY_NONE,
    panelId: "files",
    testid: "settings.attachment-compression",
    titleKey: "settings.attachmentCompression.label",
    descriptionKey: "settings.attachmentCompression.helper",
    keywordsKey: "settings.search.keywords.attachmentCompression",
  },
  {
    id: "files.attachment-ocr",
    agentWritability: WRITABILITY_NONE,
    panelId: "files",
    testid: "settings.attachment-ocr",
    titleKey: "settings.attachmentOcr.label",
    descriptionKey: "settings.attachmentOcr.helper",
    keywordsKey: "settings.search.keywords.attachmentOcr",
  },

  // ── Transcription ──────────────────────────────────────────────────────────
  {
    id: "transcription.enabled",
    agentWritability: WRITABILITY_NONE,
    panelId: "transcription",
    testid: "settings.transcription",
    titleKey: "settings.transcription.label",
    descriptionKey: "settings.transcription.helper",
    keywordsKey: "settings.search.keywords.transcription",
  },

  // ── Hotkeys (the panel has its own in-panel search; one entry routes to it) ──
  {
    id: "hotkeys.shortcuts",
    agentWritability: WRITABILITY_NONE,
    panelId: "hotkeys",
    titleKey: "settings.shell.panels.hotkeys",
    descriptionKey: "settings.hotkeys.helper",
    keywordsKey: "settings.search.keywords.hotkeys",
  },

  // ── Appearance ─────────────────────────────────────────────────────────────
  {
    id: "appearance.theme",
    agentWritability: WRITABILITY_DEVICE_LOCAL,
    panelId: "appearance",
    titleKey: "settings.appearance.themeLabel",
    descriptionKey: "settings.appearance.themeHelper",
    keywordsKey: "settings.search.keywords.theme",
  },
  {
    id: "appearance.accent",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    testid: "settings.accent-color",
    titleKey: "settings.appearance.accentLabel",
    descriptionKey: "settings.appearance.accentHelper",
  },
  {
    id: "appearance.show-edit-times",
    agentWritability: WRITABILITY_DEVICE_LOCAL,
    panelId: "appearance",
    testid: "settings.note-timestamps-toggle",
    titleKey: "settings.appearance.showEditTimesLabel",
    descriptionKey: "settings.appearance.showEditTimesHelper",
    keywordsKey: "settings.search.keywords.showEditTimes",
  },
  {
    // A pointer row, not a control (MYND-604): the graph's own settings live in
    // the graph pane. Indexed anyway - "where do I change how the graph looks?"
    // is exactly the question Settings search is asked, and the row it lands on
    // answers it.
    id: "appearance.graph-settings",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    testid: "settings.open-graph",
    titleKey: "settings.appearance.graphSettingsLabel",
    descriptionKey: "settings.appearance.graphSettingsHelper",
    keywordsKey: "settings.search.keywords.graphSettings",
  },
  {
    id: "appearance.custom-themes",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    titleKey: "settings.customThemes.label",
    keywordsKey: "settings.search.keywords.customThemes",
  },
  {
    id: "appearance.language",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    titleKey: "settings.language.label",
    descriptionKey: "settings.language.helper",
    keywordsKey: "settings.search.keywords.language",
  },
  {
    id: "appearance.ribbon",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    testid: "settings.ribbon-customize",
    titleKey: "settings.ribbonCustomize.label",
    descriptionKey: "settings.ribbonCustomize.helper",
    keywordsKey: "settings.search.keywords.ribbon",
  },
  {
    id: "appearance.bar",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    testid: "settings.bar-customize",
    titleKey: "settings.appearance.barCustomize.label",
    descriptionKey: "settings.appearance.barCustomize.helper",
    keywordsKey: "settings.search.keywords.bar",
  },

  // ── Storage ────────────────────────────────────────────────────────────────
  {
    id: "storage.backup",
    agentWritability: WRITABILITY_NONE,
    capability: "backup",
    panelId: "storage",
    titleKey: "settings.storage.backupLabel",
    descriptionKey: "settings.storage.backupHelper",
    keywordsKey: "settings.search.keywords.backup",
  },
  {
    id: "storage.export",
    agentWritability: WRITABILITY_NONE,
    capability: "vaultExport",
    panelId: "storage",
    titleKey: "settings.storage.exportLabel",
    keywordsKey: "settings.search.keywords.export",
  },
  {
    id: "storage.import",
    agentWritability: WRITABILITY_NONE,
    panelId: "storage",
    titleKey: "settings.storage.importLabel",
    keywordsKey: "settings.search.keywords.import",
  },
  {
    id: "storage.location",
    agentWritability: WRITABILITY_NONE,
    capability: "nativeSaveAs",
    panelId: "storage",
    titleKey: "settings.storage.locationLabel",
    keywordsKey: "settings.search.keywords.vaultLocation",
  },
  {
    id: "storage.auto-backup",
    agentWritability: WRITABILITY_NONE,
    capability: "backup",
    panelId: "storage",
    testid: "settings.auto-backup",
    titleKey: "settings.autoBackup.title",
    descriptionKey: "settings.autoBackup.helper",
    keywordsKey: "settings.search.keywords.autoBackup",
  },
  {
    id: "storage.clipper",
    agentWritability: WRITABILITY_NONE,
    capability: "clipper",
    panelId: "storage",
    testid: "settings.clipper-install",
    titleKey: "settings.clipperInstall.label",
    descriptionKey: "settings.clipperInstall.helper",
    keywordsKey: "settings.search.keywords.clipper",
  },

  // ── About ──────────────────────────────────────────────────────────────────
  {
    id: "about.build-channel",
    agentWritability: WRITABILITY_NONE,
    panelId: "about",
    titleKey: "settings.about.buildChannelLabel",
    keywordsKey: "settings.search.keywords.buildChannel",
  },
  {
    id: "about.update-channel",
    agentWritability: WRITABILITY_NONE,
    panelId: "about",
    titleKey: "settings.about.updateChannelLabel",
    capability: "selfUpdate",
  },
  {
    id: "about.update",
    agentWritability: WRITABILITY_NONE,
    panelId: "about",
    titleKey: "settings.about.updateLabel",
    descriptionKey: "settings.about.updateHelper",
    keywordsKey: "settings.search.keywords.update",
    testid: "about.update-check",
    capability: "selfUpdate",
  },
  {
    id: "about.update-auto-check",
    agentWritability: WRITABILITY_NONE,
    panelId: "about",
    titleKey: "settings.about.updateAutoCheckLabel",
    descriptionKey: "settings.about.updateAutoCheckHelper",
    keywordsKey: "settings.search.keywords.update",
    testid: "about.update-auto-check",
    capability: "selfUpdate",
  },
  {
    id: "about.changelog",
    agentWritability: WRITABILITY_NONE,
    panelId: "about",
    titleKey: "settings.about.changelogLabel",
    descriptionKey: "settings.about.changelogHelper",
    keywordsKey: "settings.search.keywords.changelog",
  },
  {
    id: "about.legal",
    agentWritability: WRITABILITY_NONE,
    panelId: "about",
    titleKey: "settings.about.legalLabel",
    descriptionKey: "settings.about.legalHelper",
    keywordsKey: "settings.search.keywords.legal",
  },
  {
    id: "about.license",
    agentWritability: WRITABILITY_NONE,
    panelId: "about",
    titleKey: "settings.about.licenseLabel",
    keywordsKey: "settings.search.keywords.license",
  },
  {
    id: "about.threat-model",
    agentWritability: WRITABILITY_NONE,
    panelId: "about",
    titleKey: "settings.about.threatModelLabel",
    descriptionKey: "settings.about.threatModelHelper",
    keywordsKey: "settings.search.keywords.threatModel",
  },

  // ── AI (Developer group, MYND-593) ──────────────────────────────────────────
  {
    // The remote-provider block (myne#415). `developerGated` AND `capability`
    // both apply: they are independent gates and neither implies the other
    // (`src/AGENTS.md`) - the whole AI panel is behind Developer mode, and it
    // is absent entirely where the platform has no local-AI capability.
    id: "ai.provider",
    agentWritability: WRITABILITY_CONTROL,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.providerLabel",
    descriptionKey: "settings.ai.providerHelper",
    keywordsKey: "settings.search.keywords.aiProvider",
  },
  {
    // Scrolls to the provider BLOCK, via the testid fallback, rather than to
    // the chooser itself: the chooser only renders once a provider is named,
    // so its own anchor would be missing exactly when someone searches for it
    // - the "navigates to a panel and scrolls to nothing" failure the
    // capability gating above exists to prevent, in its runtime form.
    id: "ai.provider-model",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    testid: "ai.provider-section",
    titleKey: "settings.ai.providerModelLabel",
    descriptionKey: "settings.ai.providerModelHelper",
    keywordsKey: "settings.search.keywords.aiProviderModel",
  },
  {
    id: "ai.endpoint",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.endpointLabel",
    descriptionKey: "settings.ai.endpointHelper",
    keywordsKey: "settings.search.keywords.aiEndpoint",
  },
  {
    id: "ai.enable",
    agentWritability: WRITABILITY_CONTROL,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.enableLabel",
    descriptionKey: "settings.ai.enableHelper",
    keywordsKey: "settings.search.keywords.aiEnable",
  },
  {
    id: "ai.auto-tag",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.autoTagLabel",
    descriptionKey: "settings.ai.autoTagHelper",
    keywordsKey: "settings.search.keywords.aiAutoTag",
    testid: "ai.auto-tag-toggle",
  },
  {
    // myne-md/myne#617. Both gates, because they are independent and neither
    // implies the other: `capability` drops it where there is no local-AI
    // surface at all, `developerGated` drops it where the group is hidden.
    // Search that found a setting the panel never rendered would scroll to
    // nothing.
    id: "ai.history-budget",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.historyBudgetLabel",
    descriptionKey: "settings.ai.historyBudgetHelper",
    keywordsKey: "settings.search.keywords.aiHistoryBudget",
    testid: "ai.history-budget-input",
  },
  {
    id: "ai.meeting-prompt",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.meetingPromptLabel",
    descriptionKey: "settings.ai.meetingPromptHelper",
    keywordsKey: "settings.search.keywords.aiMeetingPrompt",
    testid: "ai.meeting-prompt-input",
  },
  {
    id: "ai.models",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.modelsLabel",
    descriptionKey: "settings.ai.modelsHelper",
    keywordsKey: "settings.search.keywords.aiModels",
  },
  {
    // On-demand downloads (myne-md/myne#805). Both gates apply as everywhere in
    // this panel; the block itself is desktop-only because the download command
    // is, but a `localAi` host always has it, so `capability` is the right
    // predicate here rather than a new one.
    id: "ai.downloads",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.downloadsLabel",
    descriptionKey: "settings.ai.downloadsHelper",
    keywordsKey: "settings.search.keywords.aiModels",
  },
  {
    id: "ai.sideload",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.sideloadDisclosure",
    keywordsKey: "settings.search.keywords.aiModels",
  },
  {
    id: "ai.excluded-folders",
    agentWritability: WRITABILITY_CONTROL,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.excludedLabel",
    descriptionKey: "settings.ai.excludedHelper",
    keywordsKey: "settings.search.keywords.aiExcluded",
  },
  {
    id: "ai.memory",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.memory.heading",
    descriptionKey: "settings.memory.helper",
    keywordsKey: "settings.search.keywords.aiMemory",
  },
  {
    id: "ai.personality",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.memory.personalityLabel",
    descriptionKey: "settings.memory.personalityPlaceholder",
    keywordsKey: "settings.search.keywords.aiMemory",
  },

  // ── Network (Developer group, MYND-650) ────────────────────────────────────
  {
    // The keyword string deliberately includes "anonymity": someone searching
    // for it should land exactly here, on copy whose first sentence says Tor
    // mode does NOT make them anonymous to Myne. Keywords are a haystack, never
    // rendered, so this broadens the match without making the claim.
    id: "network.tor-routing",
    agentWritability: WRITABILITY_NONE,
    capability: "torRouting",
    developerGated: true,
    panelId: "network",
    titleKey: "settings.network.torLabel",
    descriptionKey: "settings.network.torHelper",
    keywordsKey: "settings.search.keywords.torRouting",
  },
];

/**
 * The entries this client can actually navigate to right now.
 *
 * Every search path goes through here rather than through
 * {@link SETTINGS_SEARCH_INDEX} directly - the raw array stays exported because
 * the drift test needs to see ALL of it, including the entries this platform
 * hides. `developerModeEnabled` is the live `vault.prefs.developer_mode` value
 * (developer-mode feature, MYND-593) - a runtime toggle, unlike `capability`,
 * so it's threaded in as a parameter rather than read from a module-level
 * static the way the capability set is.
 */
export function visibleSettingsIndex(developerModeEnabled: boolean): readonly SettingsIndexEntry[] {
  return SETTINGS_SEARCH_INDEX.filter(
    (e) =>
      (e.capability === undefined || has(e.capability)) &&
      (!e.developerGated || developerModeEnabled),
  );
}
