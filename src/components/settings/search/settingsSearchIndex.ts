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
import type { SettingsTopicId } from "../settingsTopics";
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
   * Whether this entry additionally requires the ACTIVE VAULT to be a member
   * vault (myne-md/myne#885).
   *
   * **The third gate axis, and it is a runtime per-vault fact rather than a
   * per-build capability.** `capability` is a static descriptor the seam-contract
   * tests rest on, and `developerGated` is a runtime user toggle; neither can say
   * "this vault is shared with other people". The shared-vault-unlock row in
   * Privacy renders only while a B2B member vault is open
   * (`MemberPasswordSettings` returns `null` for a single-account vault), so on a
   * vault that is not shared the entry navigated to an anchor that was never
   * rendered: the exact failure `capability` exists to prevent, wearing a
   * different gate. The status is resolved at the shell (one
   * `memberVaultStatus(activeVaultId)` probe) and threaded through
   * {@link visibleSettingsIndex}, the same way `developerModeEnabled` is.
   *
   * Absent ⇒ the setting renders on any vault. Present ⇒ the entry is filtered
   * out unless the active vault is a member vault. The default when the status is
   * unknown is `false`, which hides the entry: the safe direction, since a hidden
   * setting is a smaller failure than one the user is sent to and cannot find.
   */
  memberVaultGated?: boolean;
  /**
   * Whether the in-app agent may change this setting. See
   * {@link AgentWritability} for why this is required rather than optional.
   */
  agentWritability: AgentWritability;
  /**
   * The topic the setting lives in, for a panel that renders an in-panel tab
   * strip (myne-md/myne#885 task 5).
   *
   * REQUIRED for every entry whose panel has a strip, and enforced by
   * `tests/settings-search-index.test.ts` rather than by the type, because the
   * relationship is between this array and `settingsTopics.ts` and no single
   * interface can express it.
   *
   * **The regression this field exists to prevent is the feature's likeliest
   * one.** An inactive topic's body is not mounted, so a search hit that
   * resolved to a panel and an anchor but NOT to the topic would scroll to an
   * element that is not in the document: `SettingsModal` would switch the rail
   * panel, find no anchor, and leave the user at the top of a tab with no
   * answer. Every entry in such a panel therefore names its topic, and
   * `handleSelectResult` selects it before arming the scroll - the same one
   * channel the `initialAnchor` deep link already uses.
   *
   * Absent for a panel with no strip, which is most of them.
   */
  topic?: SettingsTopicId;
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
  // The account-level panel. Its namespace is the account grouping: which
  // vaults this device treats as one account. An account has no name
  // (`docs/decisions/ui/0728`), so there is no entry for one: the group heading
  // is derived from the group's own vault names. Everything that acts on a
  // vault's own container lives under `vault.*` below.
  {
    id: "account.vaults",
    agentWritability: WRITABILITY_NONE,
    panelId: "account",
    testid: "settings.account-vaults",
    titleKey: "settings.account.vaultsLabel",
    descriptionKey: "settings.account.vaultsHelper",
    keywordsKey: "settings.search.keywords.accountVaults",
  },
  {
    // The person account number (2026-10-23), and the panel's first block since
    // `docs/decisions/ui/0728` replaced the account name with it. It is derived
    // from the identity phrase, so this entry is a READ: the copy button is the
    // only control, and the value itself is never in the index (it is generated,
    // not authored).
    id: "account.number",
    agentWritability: WRITABILITY_NONE,
    panelId: "account",
    testid: "settings.account-number-copy",
    titleKey: "settings.account.numberLabel",
    descriptionKey: "identityHome.accountNumberHint",
    keywordsKey: "settings.search.keywords.accountNumber",
  },
  {
    // The clipper's own panel since myne-md/myne#960: it left Account, where it
    // sat under the account number and read as one more identity control. The
    // entry follows the control, and the registry's contract is what makes a
    // stale `panelId` here a test failure rather than a search hit that lands on
    // a panel which does not render the row.
    id: "extensions.install",
    agentWritability: WRITABILITY_NONE,
    capability: "clipper",
    panelId: "extensions",
    testid: "settings.clipper-install",
    titleKey: "settings.clipperInstall.label",
    descriptionKey: "settings.clipperInstall.helper",
    keywordsKey: "settings.search.keywords.clipper",
  },

  // ── Vault ──────────────────────────────────────────────────────────────────
  // Split out of Account: everything that acts on the sealed container itself.
  // Same controls, same testids, same copy — a different home.
  {
    id: "vault.label",
    agentWritability: WRITABILITY_NONE,
    panelId: "vault",
    topic: "vault",
    testid: "settings.label-input",
    titleKey: "settings.vault.vaultLabelEyebrow",
    descriptionKey: "settings.vault.vaultLabelHelper",
    keywordsKey: "settings.search.keywords.vaultLabel",
  },
  {
    id: "vault.icon",
    agentWritability: WRITABILITY_NONE,
    panelId: "vault",
    topic: "vault",
    testid: "settings.icon-picker",
    titleKey: "settings.vault.vaultIconLabel",
    keywordsKey: "settings.search.keywords.vaultIcon",
  },
  {
    id: "vault.change-password",
    agentWritability: WRITABILITY_NONE,
    panelId: "vault",
    topic: "vault",
    testid: "settings.change-password-cta",
    titleKey: "settings.vault.changePasswordHeading",
    descriptionKey: "settings.vault.changePasswordHelper",
    keywordsKey: "settings.search.keywords.changePassword",
  },
  {
    // The one-phrase upgrade (myne-md/myne#911). Gated on `vaultMigration`, the
    // capability the row's control renders behind (`VaultPanel`): the upgrade
    // needs a desktop vault directory and the person plane beside it. It was
    // gated on `personVaultCredential`, which the browser HAS, so a web search
    // would have scrolled to a section that client never draws.
    id: "vault.format",
    agentWritability: WRITABILITY_NONE,
    capability: "vaultMigration",
    panelId: "vault",
    topic: "vault",
    testid: "settings.vault.format-cta",
    titleKey: "settings.vault.format.heading",
    descriptionKey: "settings.vault.format.intro",
    keywordsKey: "settings.search.keywords.vaultFormat",
  },
  {
    id: "vault.danger-zone",
    agentWritability: WRITABILITY_NONE,
    panelId: "vault",
    topic: "danger",
    /* The typed-`DELETE` field is the anchor now that the section shows the
       field itself (myne-md/myne#1020). It pointed at a CTA whose only job was
       to reveal that field. */
    testid: "delete-vault.confirm-input",
    titleKey: "settings.vault.dangerZoneHeading",
    /* The disclosure the section renders, rather than a helper paragraph beside
       it: those two keys (`dangerZoneHelper`, `localEraseHelper`) are gone
       because the sentence was already there once, in the form's own copy. The
       rendered claim varies by client variant (owner erase, browser cache
       sign-out, member departure) and only the owner one is a catalog key, so
       that is the one search can resolve. */
    descriptionKey: "settings.deleteVault.copyPrimary",
    keywordsKey: "settings.search.keywords.dangerZone",
  },

  // ── Privacy ────────────────────────────────────────────────────────────────
  {
    id: "privacy.screen-capture",
    agentWritability: WRITABILITY_CONTROL,
    // Gated the way the panel gates the row: `PrivacyPanel` renders it only
    // behind `has("screenCaptureProtection")`, so an untagged entry offered a
    // web hit that landed on a panel with no such row (and, since the `access`
    // topic is dropped on a client with none of its capabilities, on a topic
    // that does not exist there). `src/AGENTS.md` states the rule: an entry
    // carries the capability its row renders behind.
    capability: "screenCaptureProtection",
    panelId: "privacy",
    topic: "access",
    titleKey: "settings.privacy.screenCaptureLabel",
    descriptionKey: "settings.privacy.screenCaptureHelperOn",
    keywordsKey: "settings.search.keywords.screenCapture",
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
    topic: "access",
    testid: "settings.hide-vault-names",
    titleKey: "settings.privacy.hideVaultNamesLabel",
    descriptionKey: "settings.privacy.hideVaultNamesHelper",
    keywordsKey: "settings.search.keywords.hideVaultNames",
  },
  {
    id: "privacy.auto-lock",
    agentWritability: WRITABILITY_CONTROL,
    panelId: "privacy",
    topic: "locking",
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
    topic: "locking",
    testid: "settings.quick-unlock",
    titleKey: "settings.quickUnlock.title",
    descriptionKey: "settings.quickUnlock.setupHelper",
    keywordsKey: "settings.search.keywords.quickUnlock",
  },
  // Shared vault password (myne-md/myne#711). Two gates, and they answer
  // different questions: `capability: memberSharing` keeps it off a client where
  // the feature does not exist at all, and `memberVaultGated` keeps it off a
  // single-account vault on a client that has the feature. The row itself
  // renders only while a B2B member vault is the ACTIVE vault
  // (`MemberPasswordSettings` returns `null` otherwise), so an entry carrying
  // only the capability would still navigate to an anchor that was never
  // rendered on the ordinary desktop vault. That was the defect this field
  // fixes.
  {
    id: "privacy.member-password",
    agentWritability: WRITABILITY_NONE,
    capability: "memberSharing",
    memberVaultGated: true,
    panelId: "privacy",
    topic: "locking",
    testid: "settings.member-password",
    titleKey: "settings.memberPassword.title",
    descriptionKey: "settings.memberPassword.helperNotConfigured",
    keywordsKey: "settings.search.keywords.memberPassword",
  },
  // CLI terminal access (MYND-490), in the CLI panel since
  // `decisions/ui/0678`. All three carry `cliAccess`: the panel is absent
  // where the capability is, so an ungated entry would navigate to an anchor
  // that was never rendered. All three ALSO carry `developerGated` (#181) —
  // the rail drops the whole developer group while the mode is off, and the
  // search index has no view of the rail's groups, so dropping the flag here
  // would offer a result that scrolls into a panel the rail is not showing.
  // (The flag no longer means "hidden inside a core panel"; the vim toggle is
  // the last entry of that shape.)
  {
    id: "cli.access",
    agentWritability: WRITABILITY_CONTROL,
    capability: "cliAccess",
    developerGated: true,
    panelId: "cli",
    titleKey: "settings.cliAccess.label",
    descriptionKey: "settings.cliAccess.helperOff",
    keywordsKey: "settings.search.keywords.cliAccess",
  },
  {
    id: "cli.excluded-folders",
    agentWritability: WRITABILITY_CONTROL,
    capability: "cliAccess",
    developerGated: true,
    panelId: "cli",
    titleKey: "settings.cliAccess.excludedLabel",
    descriptionKey: "settings.cliAccess.excludedHelper",
    keywordsKey: "settings.search.keywords.cliExcludedFolders",
  },
  {
    id: "cli.rate-limit",
    agentWritability: WRITABILITY_CONTROL,
    capability: "cliAccess",
    developerGated: true,
    panelId: "cli",
    titleKey: "settings.cliAccess.rateLimitLabel",
    descriptionKey: "settings.cliAccess.rateLimitHelper",
    keywordsKey: "settings.search.keywords.cliRateLimit",
  },

  // ── Sync (keys live under `sync.panel.*`, not `settings.*`) ─────────────────
  {
    id: "sync.status",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    topic: "connection",
    titleKey: "sync.panel.status.label",
    descriptionKey: "sync.panel.status.helper",
    keywordsKey: "settings.search.keywords.syncStatus",
  },
  {
    id: "sync.devices",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    topic: "devices",
    // The section's own title, not the shorter `devices.label` the mobile panel
    // still uses: a search result that lands on a heading has to name the
    // heading the reader arrives at (2026-10-25, the same pass that renamed it).
    titleKey: "sync.panel.sections.devices",
    keywordsKey: "settings.search.keywords.syncDevices",
  },
  {
    id: "sync.members",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    topic: "devices",
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
    id: "sync.add-device",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    topic: "devices",
    titleKey: "sync.panel.addDevice.label",
    descriptionKey: "sync.panel.addDevice.helper",
    keywordsKey: "settings.search.keywords.syncAddDevice",
  },
  {
    id: "sync.conflicts",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    topic: "conflicts",
    titleKey: "sync.panel.conflicts.label",
    descriptionKey: "sync.panel.conflicts.helper",
    keywordsKey: "settings.search.keywords.syncConflicts",
  },
  {
    id: "sync.recovered",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    topic: "conflicts",
    titleKey: "sync.panel.recovered.label",
    descriptionKey: "sync.panel.recovered.helper",
    keywordsKey: "settings.search.keywords.syncRecovered",
  },
  {
    id: "sync.server",
    agentWritability: WRITABILITY_NONE,
    panelId: "sync",
    topic: "connection",
    titleKey: "sync.panel.server.label",
    keywordsKey: "settings.search.keywords.syncServer",
  },

  // ── Editor ─────────────────────────────────────────────────────────────────
  {
    id: "editor.text-size",
    agentWritability: WRITABILITY_DEVICE_LOCAL,
    panelId: "editor",
    topic: "text",
    titleKey: "settings.typography.textSizeLabel",
    keywordsKey: "settings.search.keywords.textSize",
  },
  {
    id: "editor.line-spacing",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "text",
    titleKey: "settings.typography.lineSpacingLabel",
    keywordsKey: "settings.search.keywords.lineSpacing",
  },
  {
    id: "editor.content-width",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "text",
    titleKey: "settings.typography.contentWidthLabel",
    descriptionKey: "settings.typography.contentWidthHelper",
    keywordsKey: "settings.search.keywords.contentWidth",
  },
  {
    id: "editor.font",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "text",
    titleKey: "settings.typography.fontLabel",
    keywordsKey: "settings.search.keywords.font",
  },
  {
    id: "editor.line-numbers",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "text",
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
    topic: "editing",
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
    topic: "editing",
    testid: "settings.plain-file",
    titleKey: "settings.plainFile.label",
    descriptionKey: "settings.plainFile.helper",
    keywordsKey: "settings.search.keywords.plainFile",
  },
  {
    id: "editor.toolbar",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "editing",
    testid: "settings.toolbar-customize",
    titleKey: "settings.toolbarCustomize.label",
    descriptionKey: "settings.toolbarCustomize.helper",
    keywordsKey: "settings.search.keywords.toolbar",
  },
  {
    id: "editor.view-mode",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "editing",
    titleKey: "settings.viewMode.label",
    descriptionKey: "settings.viewMode.helper",
    keywordsKey: "settings.search.keywords.viewMode",
  },
  {
    id: "editor.date-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "editing",
    titleKey: "settings.dateTime.dateLabel",
    descriptionKey: "settings.dateTime.dateHelper",
    keywordsKey: "settings.search.keywords.dateFormat",
  },
  {
    id: "editor.time-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "editing",
    titleKey: "settings.dateTime.timeLabel",
    descriptionKey: "settings.dateTime.timeHelper",
    keywordsKey: "settings.search.keywords.timeFormat",
  },
  {
    id: "editor.timezone",
    agentWritability: WRITABILITY_DEVICE_LOCAL,
    panelId: "editor",
    topic: "editing",
    titleKey: "settings.dateTime.zoneLabel",
    descriptionKey: "settings.dateTime.zoneHelper",
    keywordsKey: "settings.search.keywords.timezone",
  },
  {
    id: "editor.focus-dim",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "editing",
    testid: "settings.focus-dim",
    titleKey: "settings.focusMode.dimLabel",
    descriptionKey: "settings.focusMode.dimHelper",
    keywordsKey: "settings.search.keywords.focusMode",
  },
  {
    id: "editor.focus-typewriter",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "editing",
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
    topic: "writing",
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
    topic: "writing",
    titleKey: "settings.spell.languagesLabel",
    descriptionKey: "settings.spell.languagesHelper",
    keywordsKey: "settings.search.keywords.spellLanguages",
  },
  {
    id: "editor.daily-notes-folder",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "periodic",
    titleKey: "settings.dailyNotes.sectionDaily",
    descriptionKey: "settings.dailyNotes.periodFolderLabel",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  {
    id: "editor.daily-notes-date-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "periodic",
    titleKey: "settings.dailyNotes.sectionDaily",
    descriptionKey: "settings.dailyNotes.periodFormatLabel",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  {
    id: "editor.daily-notes-template",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "periodic",
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
    topic: "periodic",
    titleKey: "settings.dailyNotes.sectionWeekly",
    descriptionKey: "settings.dailyNotes.periodFolderLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.weekly-notes-date-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "periodic",
    titleKey: "settings.dailyNotes.sectionWeekly",
    descriptionKey: "settings.dailyNotes.periodFormatLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.weekly-notes-template",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "periodic",
    titleKey: "settings.dailyNotes.sectionWeekly",
    descriptionKey: "settings.dailyNotes.periodTemplateLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.monthly-notes-folder",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "periodic",
    titleKey: "settings.dailyNotes.sectionMonthly",
    descriptionKey: "settings.dailyNotes.periodFolderLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.monthly-notes-date-format",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "periodic",
    titleKey: "settings.dailyNotes.sectionMonthly",
    descriptionKey: "settings.dailyNotes.periodFormatLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.monthly-notes-template",
    agentWritability: WRITABILITY_WRITABLE,
    panelId: "editor",
    topic: "periodic",
    titleKey: "settings.dailyNotes.sectionMonthly",
    descriptionKey: "settings.dailyNotes.periodTemplateLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.reminders",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "writing",
    testid: "settings.reminders-toggle",
    titleKey: "settings.reminders.label",
    keywordsKey: "settings.search.keywords.reminders",
  },
  {
    id: "editor.archive",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "features",
    testid: "settings.archive-disabled",
    titleKey: "settings.archive.label",
    descriptionKey: "settings.archive.helper",
    keywordsKey: "settings.search.keywords.archive",
  },
  {
    id: "editor.views",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "features",
    testid: "settings.views-enabled",
    titleKey: "settings.views.label",
    descriptionKey: "settings.views.helper",
  },
  {
    id: "editor.task-chip-color",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "tasks",
    testid: "settings.editor.taskChipColor",
    titleKey: "settings.editor.taskChipColor.label",
    descriptionKey: "settings.editor.taskChipColor.help",
  },
  {
    id: "editor.task-chip-icon-only",
    agentWritability: WRITABILITY_NONE,
    panelId: "editor",
    topic: "tasks",
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
    topic: "display",
    titleKey: "settings.appearance.themeLabel",
    descriptionKey: "settings.appearance.themeHelper",
    keywordsKey: "settings.search.keywords.theme",
  },
  {
    id: "appearance.accent",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    topic: "display",
    testid: "settings.accent-color",
    titleKey: "settings.appearance.accentLabel",
    descriptionKey: "settings.appearance.accentHelper",
  },
  {
    id: "appearance.show-edit-times",
    agentWritability: WRITABILITY_DEVICE_LOCAL,
    panelId: "appearance",
    topic: "notes",
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
    topic: "interface",
    testid: "settings.open-graph",
    titleKey: "settings.appearance.graphSettingsLabel",
    descriptionKey: "settings.appearance.graphSettingsHelper",
    keywordsKey: "settings.search.keywords.graphSettings",
  },
  {
    id: "appearance.custom-themes",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    topic: "display",
    titleKey: "settings.customThemes.label",
    keywordsKey: "settings.search.keywords.customThemes",
  },
  {
    id: "appearance.language",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    topic: "display",
    titleKey: "settings.language.label",
    descriptionKey: "settings.language.helper",
    keywordsKey: "settings.search.keywords.language",
  },
  {
    id: "appearance.ribbon",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    topic: "interface",
    testid: "settings.ribbon-customize",
    titleKey: "settings.ribbonCustomize.label",
    descriptionKey: "settings.ribbonCustomize.helper",
    keywordsKey: "settings.search.keywords.ribbon",
  },
  {
    id: "appearance.bar",
    agentWritability: WRITABILITY_NONE,
    panelId: "appearance",
    topic: "interface",
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
    id: "storage.auto-backup",
    agentWritability: WRITABILITY_NONE,
    capability: "backup",
    panelId: "storage",
    testid: "settings.auto-backup",
    titleKey: "settings.autoBackup.title",
    descriptionKey: "settings.autoBackup.helper",
    keywordsKey: "settings.search.keywords.autoBackup",
  },
  // ── About ──────────────────────────────────────────────────────────────────
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
    id: "about.diagnostic-log",
    // Refused, and the reason is the whole point: this switch decides whether a
    // plaintext log is written to the user's disk at all, which is a consent
    // control rather than a preference. No setting intent resolves to it, so the
    // agent is not given it (myne-md/myne#860).
    agentWritability: {
      verdict: "refused",
      reason:
        "consent control: it decides whether a plaintext log is written to disk, not how the app behaves, so it is not an agent-settable setting",
    },
    // `panelId` follows the ROW, not the key prefix: the row moved to its own
    // Diagnostics panel on 2026-10-25 and its i18n keys kept the `settings.about.`
    // prefix, because a key name is a catalog id that no user reads and renaming it
    // would move thirty-three catalogs for a naming preference.
    panelId: "diagnostics",
    titleKey: "settings.about.diagnosticLogLabel",
    descriptionKey: "settings.about.diagnosticLogHelper",
    keywordsKey: "settings.search.keywords.diagnosticLog",
    testid: "about.diagnostic-log-toggle",
    capability: "diagnosticLog",
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
    topic: "answering",
    titleKey: "settings.ai.providerChooseLabel",
    descriptionKey: "settings.ai.providerChooseHelper",
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
    topic: "answering",
    testid: "ai.provider-section",
    titleKey: "settings.ai.providerModelLabel",
    descriptionKey: "settings.ai.providerModelHelper",
    keywordsKey: "settings.search.keywords.aiProviderModel",
  },
  {
    // The provider block as the fallback target, the same shape as
    // `ai.provider-model` above and for the mirror reason: the local runtime
    // block renders only while NO service is named (myne-md/myne#867), so with
    // a provider chosen its own anchor is absent, and the hit lands on the
    // chooser that brings it back.
    id: "ai.endpoint",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    topic: "answering",
    testid: "ai.provider-section",
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
    topic: "answering",
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
    topic: "models",
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
    topic: "limits",
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
    topic: "advanced",
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
    topic: "models",
    titleKey: "settings.ai.modelsLabel",
    descriptionKey: "settings.ai.modelsHelper",
    keywordsKey: "settings.search.keywords.aiModels",
  },
  {
    // On-demand downloads (myne-md/myne#805), listed inline in the Models topic
    // since myne-md/myne#885. Both gates apply as everywhere in this panel; the
    // block itself is desktop-only because the download command is, but a
    // `localAi` host always has it, so `capability` is the right predicate here
    // rather than a new one.
    //
    // It carries no `testid`: the target is the `ai.downloads` anchor on the
    // catalogue table itself, which is where the row's button used to sit. The
    // anchor moved with the surface rather than being left pointing at a control
    // that no longer exists.
    id: "ai.downloads",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    topic: "models",
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
    topic: "models",
    titleKey: "settings.ai.sideloadDisclosure",
    keywordsKey: "settings.search.keywords.aiModels",
  },
  {
    id: "ai.excluded-folders",
    agentWritability: WRITABILITY_CONTROL,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    topic: "limits",
    titleKey: "settings.ai.excludedLabel",
    descriptionKey: "settings.ai.excludedHelper",
    keywordsKey: "settings.search.keywords.aiExcluded",
  },
  // External access (external-mcp-connection, myne-md/myne#923): the master switch
  // for the `myne-mcp` door, in the same Limits topic because it answers the same
  // question about a different program.
  //
  // **Its own capability, not `localAi`.** The AI panel is dropped from the rail
  // where `localAi` is absent, so a client without on-device AI renders no panel
  // and this entry inherits that absence for free; the `externalMcp` gate is what
  // keeps it off a client that has AI but no sidecar (a page, a phone), where the
  // section really is omitted.
  //
  // `WRITABILITY_CONTROL` rather than `WRITABILITY_DEVICE_LOCAL`, which is the
  // other verdict this row could carry: `cli_enabled` IS stored device-local, but
  // the reason it must not be agent-writable is the stronger one, and it is what
  // the field's twin in the CLI panel already says. Two verdicts for one field
  // would be worse than either.
  {
    id: "ai.external-access",
    agentWritability: WRITABILITY_CONTROL,
    // `localAi`, not `externalMcp`: the row lives in the AI panel, so a client
    // without the AI capability has no panel to show it in. The section it points
    // at needs `externalMcp` as well, and that is the component's gate rather than
    // the search row's — a row keyed to a narrower capability would be offered on a
    // build where the panel itself is absent.
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    topic: "limits",
    testid: "settings.mcp-enable",
    titleKey: "settings.ai.externalAccess.label",
    descriptionKey: "settings.ai.externalAccess.helperOff",
    keywordsKey: "settings.search.keywords.externalAccess",
  },
  {
    id: "ai.memory",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    topic: "advanced",
    titleKey: "settings.memory.heading",
    descriptionKey: "settings.memory.helper",
    keywordsKey: "settings.search.keywords.aiMemory",
  },
  {
    id: "ai.memorySeed",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    topic: "advanced",
    titleKey: "settings.memory.seed.rowTitle",
    descriptionKey: "settings.memory.seed.rowHelper",
    keywordsKey: "settings.search.keywords.aiMemory",
  },
  {
    id: "ai.personality",
    agentWritability: WRITABILITY_NONE,
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    topic: "advanced",
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
 * static the way the capability set is. `memberVault` is the same kind of
 * runtime fact one step further out: whether the ACTIVE VAULT is a B2B member
 * vault (myne-md/myne#885), which decides whether the shared-vault-unlock row
 * is on screen at all. It defaults to `false` so a caller that has not resolved
 * the vault hides the entry rather than offering one that does not render.
 */
export function visibleSettingsIndex(
  developerModeEnabled: boolean,
  memberVault = false,
): readonly SettingsIndexEntry[] {
  return SETTINGS_SEARCH_INDEX.filter(
    (e) =>
      (e.capability === undefined || has(e.capability)) &&
      (!e.developerGated || developerModeEnabled) &&
      (!e.memberVaultGated || memberVault),
  );
}
