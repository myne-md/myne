// The topic roster for the in-panel tab strip (myne-md/myne#885, requirement 6).
//
// A settings panel that is several concerns deep gets a second level of
// navigation: topics as tabs, at the top of the content column, aligned with the
// settings search box. This file is the ROSTER those topics come from, kept as
// plain data (an id and an i18n label key) so three readers can share one copy
// without any of them importing a panel:
//
//   - `SettingsTabs.tsx` renders the strip from it;
//   - the panel renders one `SettingsTopicPanel` per topic and reads the active
//     id through the same module;
//   - `settingsSearchIndex.ts` names the topic an entry lives in, so a search hit
//     lands INSIDE the right topic rather than on the top of a tab (task 5);
//   - `tests/settings-search-index.test.ts` checks the index against it.
//
// **A panel with no entry here renders no strip at all**, which is the mechanism
// that keeps the short panels single-screen without a second, hand-maintained
// list of which panels are short (`SettingsTabs.tsx` renders nothing when the
// roster has fewer than two topics).
//
// Deliberately data rather than JSX: a topic's BODY is the panel's own content and
// stays in the panel, because an inactive topic's body must not be mounted (a
// hidden-but-present control is a second way for a search hit to land on nothing,
// and the AI panel runs IPC on mount). So this file carries what both readers
// agree on - which topics exist and what each is called - and nothing else.

import { has, type Capability } from "../../platform/capabilities";
import type { PanelId } from "../SettingsModal";

/**
 * The Editor panel's topic ids, named so `EditorPanel.tsx` can key its preview
 * bands on them exhaustively (a `Record<EditorTopicId, ...>` fails to compile
 * the day a topic is added, which is the property a bare `string` loses).
 */
export type EditorTopicId =
  | "text"
  | "editing"
  | "writing"
  | "tasks"
  | "periodic"
  | "calendar"
  | "features";

/**
 * Every topic id in the tree.
 *
 * A union rather than `string` so an index entry naming a topic that no panel
 * declares fails to compile, and so the panels' `SettingsTopicPanel` calls are
 * checked against the roster by name.
 */
export type SettingsTopicId =
  | EditorTopicId
  // The AI panel (myne-md/myne#867, #885). Tagging folded into Models.
  | "answering"
  | "models"
  | "limits"
  | "externalAccess"
  | "advanced"
  // The Appearance panel.
  | "display"
  | "notes"
  | "interface"
  // The Privacy panel.
  | "access"
  | "locking"
  // The Vault panel.
  | "vault"
  | "danger"
  // The Sync panel.
  | "connection"
  | "devices"
  | "conflicts";

export interface SettingsTopicMeta {
  id: SettingsTopicId;
  /** i18n leaf resolved with `t()` at render, never frozen here
   *  (`src/AGENTS.md` i18n discipline: a module-scope catalog read captures the
   *  boot language). The AI panel's topics reuse the group-heading keys the
   *  panel already carried, so the split adds no second vocabulary for the same
   *  concern: the heading becomes the tab. `groupTagging` now titles the
   *  Tagging SECTION inside Models rather than a tab (myne-md/myne#867). */
  labelKey: string;
  /**
   * The capabilities ANY ONE of which keeps this topic's body non-empty, for a
   * topic whose every row is capability-gated.
   *
   * Absent means "always produced". Present means the topic is DROPPED on a
   * client that has none of them, because the rule below requires every topic
   * the roster produces to be non-empty on every client and a topic whose whole
   * body is absent is a tab with nothing behind it. This is the per-client half
   * of the same rule the capability-gated-block clause states: a block joins the
   * topic that owns its question, and a topic whose ONLY blocks are all gated
   * away is not produced at all.
   *
   * The list is a disjunction rather than the render conditions themselves, so
   * it is the topic's shape rather than a second copy of the panel's gates: the
   * one gap it leaves is a client that has only the last capability AND has
   * Developer mode off, which no shipped client is.
   */
  liveOn?: readonly Capability[];
}

/**
 * The AI panel's topics, in reading order: what answers, which models, what AI
 * may read, and everything else.
 *
 * **No `Tagging` topic** (myne-md/myne#867, on the user's read: "put tagging
 * inside models"). It held the auto-tag switch and the tag role's model row,
 * which made it a tab of one switch and one row; the row is now the tag line of
 * the Models topic's hand-picked table and the switch is a section beside it.
 */
export const AI_PANEL_TOPICS: readonly SettingsTopicMeta[] = [
  // Labelled "General" (myne-md/myne#867, on the user's read): the topic holds
  // the master switch and the provider choice, which is the panel's general
  // setup rather than only "what answers". The id stays `answering`, so search
  // entries, testids and a stored topic selection keep resolving.
  { id: "answering", labelKey: "settings.ai.groupGeneral" },
  { id: "models", labelKey: "settings.ai.groupModels" },
  { id: "limits", labelKey: "settings.ai.groupLimits" },
  // Its own topic, out of Limits: what an external AI tool may do is a different
  // question from what Myne's own AI may read (myne-md/myne#1052); absent without the sidecar.
  {
    id: "externalAccess",
    labelKey: "settings.ai.sections.externalAccess",
    liveOn: ["externalMcp"],
  },
  { id: "advanced", labelKey: "settings.ai.groupAdvanced" },
];

/**
 * The Appearance panel's topics: how the app is drawn and read, what a row in
 * the sidebar shows, and how the chrome is arranged.
 *
 * `Display` holds the language selector with the theme, the accent and the
 * custom themes rather than standing alone. Language is the one control here
 * that changes text rather than colour, but it is device-local in exactly the
 * way the accent is (it never touches `vault.prefs`, see `LanguageSelect.tsx`),
 * and a topic holding one control is a tab that does not earn its place. So the
 * boundary drawn here is colour-and-language against layout, and the panel
 * reads as three concerns rather than four with one of them vestigial.
 *
 * `Interface` closes with the graph pointer row, which is the one row in this
 * panel that is not a control: it names where the graph's own appearance and
 * physics settings live and opens the graph (MYND-604). It sits in `Interface`
 * rather than in `Display` because what it arranges is a pane, not a palette.
 */
export const APPEARANCE_PANEL_TOPICS: readonly SettingsTopicMeta[] = [
  { id: "display", labelKey: "settings.appearance.topics.display" },
  { id: "notes", labelKey: "settings.appearance.topics.notes" },
  { id: "interface", labelKey: "settings.appearance.topics.interface" },
];

/**
 * The Privacy panel's topics: what can see the notes, and how the vault locks
 * and unlocks.
 *
 * The terminal access block used to sit in `Access` as a third answer to "who
 * or what can get at my notes". It is its own developer-group panel now
 * (`CliPanel`, `decisions/ui/0678`), so `Access` holds the screen rows alone.
 *
 * `Locking` is the family the panel's own comments already describe: how the
 * vault locks and reopens, as opposed to what can see the notes. It used to
 * carry the recovery drill for the same reason, and that row is withdrawn with
 * it (`decisions/security/0747`, myne-md/myne#935).
 *
 * **`Access` carries `liveOn`, and it is the one topic in the tree that needs
 * it.** Every row in its body is capability-gated: the per-vault screen-capture
 * switch and its device-local override row on `screenCaptureProtection`, and
 * the lock-screen-name row on `lockedVaultNames`. The web client has both
 * absent, so the topic would render an `Access` tab whose body is one section
 * title and nothing else, which is the empty tab the rule below refuses. Where
 * neither is present the topic is dropped and `Privacy` falls to the single
 * `locking` concern, so the strip renders nothing and the panel is one screen.
 */
export const PRIVACY_PANEL_TOPICS: readonly SettingsTopicMeta[] = [
  {
    id: "access",
    labelKey: "settings.privacy.topics.access",
    liveOn: ["screenCaptureProtection", "lockedVaultNames"],
  },
  { id: "locking", labelKey: "settings.privacy.topics.locking" },
];

/**
 * The Vault panel's two topics: the vault itself, and the one control that
 * destroys it.
 *
 * Vault is the panel `decisions/ui/0679` split out of Account (the label, the
 * icon, the password and the danger zone); these two topics are the split this
 * branch had drawn inside Account, carried to the panel those rows now live in.
 * The boundary is the one place a reader genuinely needs a destination rather
 * than a scroll: the irreversible erase, separated from the rows a user opens
 * the panel to change.
 *
 * The password and erase forms REPLACE the panel's body (the two early returns
 * in `VaultPanel`), so a form never renders beside the rows it replaces,
 * whichever topic is selected.
 */
export const VAULT_PANEL_TOPICS: readonly SettingsTopicMeta[] = [
  { id: "vault", labelKey: "settings.vault.topics.vault" },
  { id: "danger", labelKey: "settings.vault.topics.danger" },
];

/**
 * The Sync panel's topics: the account and its server, the devices and members
 * it holds, and the two surfaces that exist because something went wrong.
 *
 * `Conflicts` takes the recovered-notes block with the conflict list, because
 * both are the same story from two ends: a keep-both copy that has not been
 * reconciled, and one that has. A topic of its own for recovery would be a tab
 * holding one block.
 *
 * Migration stays in `Connection` rather than earning a topic, for the reason
 * the terminal block stays in Privacy's `Access`: the block is absent on a vault
 * created today (v0.2 from birth has neither a v0.1 upgrade to offer nor a
 * `legacy/` snapshot to settle), so a topic holding it would render an empty tab
 * for most users.
 */
export const SYNC_PANEL_TOPICS: readonly SettingsTopicMeta[] = [
  { id: "connection", labelKey: "sync.panel.topics.connection" },
  { id: "devices", labelKey: "sync.panel.topics.devices" },
  { id: "conflicts", labelKey: "sync.panel.topics.conflicts" },
];

/**
 * The Editor panel's topics: the five groups its own `SettingsSection`s already
 * drew, plus periodic notes, in the order the panel reads.
 *
 * **This panel is the requester's own model**, so the boundary is theirs and the
 * task was to name it rather than to invent it: the panel already carried five
 * titled sections (Text and display, Editing, Writing, Tasks, Features) and one
 * block of periodic-note configuration, and each of those is a question a reader
 * arrives holding. So the topics are those six, and the five existing section
 * titles are reused as the topic LABELS (`settings.editor.sections.*`) rather
 * than restated, so the surface does not grow a second vocabulary for one
 * concern. The sixth label is new only because periodic notes had no single
 * heading of its own to reuse; the block's own three headings name Daily, Weekly
 * and Monthly, which is one level down.
 *
 * Why each boundary is where it is, one line each:
 *
 *   - **Text & display** is what the text LOOKS like (the four typography
 *     presets and the line-number gutter). Every one of those inputs is a
 *     `--editor-*` custom property, which is also exactly what the preview
 *     specimen reads, so this is the topic whose preview is the most literal.
 *   - **Editing** is how you MOVE and what gets printed while you do: the vim
 *     keymap, the plain-file surface, the default view mode, the date/time
 *     display, the focus-mode behaviours and the floating toolbar's own layout.
 *     They are one concern because a reader arrives with "how does editing
 *     work" rather than with any single one of them.
 *   - **Writing** is what the app does TO the prose as you write it: spell
 *     check, the reminder switches. Both are device-local behaviours rather
 *     than content, which is the panel's own recorded test for this group.
 *   - **Tasks** is the two task-chip display settings. It is small, and it earns
 *     its topic because the chip is a different surface from the note body: the
 *     settings live on the workspace container rather than in `vault.prefs`, and
 *     the preview has a task specimen rather than a note one.
 *   - **Periodic notes** is where a daily, weekly or monthly note is filed and
 *     how it is titled, three periods deep. It is the one topic whose settings a
 *     note specimen cannot depict at all, which is stated in the preview rather
 *     than faked.
 *   - **Features** is the two whole-feature switches (archive, views). They
 *     change what the app offers rather than how a note reads.
 *
 * `PeriodicNotesSettings` renders its three sections inside this one topic and
 * nowhere else, which is the acceptance criterion that no control was dropped in
 * the move: it is reachable from exactly one topic and its own repeat structure
 * is untouched.
 */
export const EDITOR_PANEL_TOPICS: readonly SettingsTopicMeta[] = [
  { id: "text", labelKey: "settings.editor.sections.text" },
  { id: "editing", labelKey: "settings.editor.sections.editing" },
  { id: "writing", labelKey: "settings.editor.sections.writing" },
  { id: "tasks", labelKey: "settings.editor.sections.tasks" },
  { id: "periodic", labelKey: "settings.editor.topics.periodic" },
  { id: "calendar", labelKey: "settings.editor.topics.calendar" },
  { id: "features", labelKey: "settings.editor.sections.features" },
];

/**
 * The panels that have a strip, and the topics each one has.
 *
 * `Partial` on purpose: most panels are one concern and render no strip, and a
 * panel absent from this map is exactly that statement rather than an omission.
 *
 * **What earns a strip, which is the rule this map is the record of.** Not line
 * count, and not the number of search-index entries: a panel earns a strip when
 * it holds more than one concern, where a concern is a question a reader
 * arrives holding, AND every topic that rule produces is non-empty on every
 * client and in every state that renders the panel. The second clause is what
 * decides the two calls a line count cannot, and both came out "join the topic
 * that owns the question" rather than "earn a tab": `storage` stays a single
 * screen because its six blocks answer ONE question (where the vault is and how
 * data moves in and out) and any cut through them would be arbitrary; and a
 * capability-gated block (the terminal, the migration, the browser clipper)
 * never gets a topic of its own, because the strip renders a roster and not a
 * filtered set, so the tab would be there and its body would not.
 *
 * `storage` is therefore absent, and its absence is the statement that it is
 * one concern. `files`, `transcription`, `hotkeys`, `about` and `network` are
 * absent for the same reason, which is also the requester's own qualifier: a
 * panel that is not deep enough to lose a reader stays one screen.
 *
 * The second clause is a per-client one, and a topic whose whole body is gated
 * is how it bites: `liveOn` on a `SettingsTopicMeta` drops that topic where none
 * of its rows can render, and `livePanelTopics` is the list the strip and the
 * panel both read. Privacy's `access` is the one topic in the tree that carries
 * it; the reason is on `PRIVACY_PANEL_TOPICS`.
 */
export const SETTINGS_PANEL_TOPICS: Partial<
  Record<PanelId, readonly SettingsTopicMeta[]>
> = {
  ai: AI_PANEL_TOPICS,
  appearance: APPEARANCE_PANEL_TOPICS,
  privacy: PRIVACY_PANEL_TOPICS,
  vault: VAULT_PANEL_TOPICS,
  sync: SYNC_PANEL_TOPICS,
  editor: EDITOR_PANEL_TOPICS,
};

/**
 * The topics `panelId` actually produces on THIS client, which is the list the
 * strip renders and the list `SettingsTopicPanel` resolves its active id
 * against. Both readers call this rather than the raw roster, so a dropped topic
 * is dropped in both places and the two cannot disagree about which ids exist.
 *
 * `SETTINGS_PANEL_TOPICS` stays the FULL roster because two other readers want
 * it that way: the settings search validates an entry's `topic` against every
 * id any client can produce, and a test asserts that link. Only the render path
 * filters.
 */
export function livePanelTopics(panelId: PanelId): readonly SettingsTopicMeta[] {
  const topics = SETTINGS_PANEL_TOPICS[panelId] ?? [];
  return topics.filter(
    (topic) => topic.liveOn === undefined || topic.liveOn.some((cap) => has(cap)),
  );
}
