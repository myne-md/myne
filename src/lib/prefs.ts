// Tauri IPC wrappers for the `prefs` plugin (MYND-160).
//
// - `prefsRead()` — Slot::Unlocked-gated read of vault.prefs; resolves
//   to `PrefsView` with fall-back-to-defaults semantics applied on
//   the Rust side per spec § 9.5.5. Frontend never observes
//   absent / AEAD-fail / parse-fail as distinct outcomes.
// - `setScreenCaptureProtection(enabled)` — per-field setter; commits
//   to disk first, then re-applies native screen-capture protection.
//   Disk-then-native ordering is load-bearing for UI / disk
//   consistency per MYND-160 grill Q5.2.

import { invoke } from "../platform/core";
import { bumpPrefsNonce } from "../notes/prefsNonce";
import { blockSeedingOfExistingTurns } from "../notes/ai/chatStore";

/**
 * Editor three-pane layout — sidebar widths (px) + collapsed flags (MYND-137).
 * Mirrors `protocol::EditorLayout`. The widths carry the *last non-collapsed*
 * width so a re-expand restores it. `null` on {@link PrefsView.editor_layout}
 * means the user never customized the layout (the field is omitted from the
 * encrypted blob), and the caller applies its default widths.
 */
export interface EditorLayout {
  left_width: number;
  right_width: number;
  left_collapsed: boolean;
  right_collapsed: boolean;
}

/**
 * User theme preference (MYND-110). Mirrors `protocol::ThemeChoice` (Rust
 * side, serialized lowercase). `null` on {@link PrefsView.theme} means the
 * user made no explicit choice — i.e. **system** (follow the OS
 * `prefers-color-scheme`); the field is omitted from the encrypted blob in
 * that case, byte-identical to a pre-MYND-110 vault.
 */
export type ThemeChoice = "light" | "dark" | "amoled";

/**
 * New-note default-location mode (MYND-462, "Files" settings panel). Mirrors the
 * free `Option<String>` stored in `new_note_location`; the client owns the
 * closed enum + unknown→default mapping ({@link normalizeNewNoteLocation}).
 * `"root"` = vault root, `"current"` = the active note's folder, `"specific"` =
 * the folder in {@link PrefsView.new_note_location_folder}.
 */
export type NewNoteLocation = "root" | "current" | "specific";

/** Canonical default for {@link PrefsView.new_note_location} when unset. */
export const DEFAULT_NEW_NOTE_LOCATION: NewNoteLocation = "root";

/** Map a stored / unknown `new_note_location` value to a valid mode. */
export function normalizeNewNoteLocation(value: string | null): NewNoteLocation {
  return value === "current" || value === "specific" || value === "root"
    ? value
    : DEFAULT_NEW_NOTE_LOCATION;
}

/**
 * Startup-open mode (MYND-462, "Files" settings panel). Mirrors the free
 * `Option<String>` stored in `startup_open`; the client owns the closed enum +
 * unknown→default mapping ({@link normalizeStartupOpen}). `"last"` = restore the
 * last workspace layout, `"empty"` = fresh empty editor, `"specific"` = open the
 * note in {@link PrefsView.startup_open_note}.
 */
export type StartupOpen = "last" | "empty" | "specific";

/** Canonical default for {@link PrefsView.startup_open} when unset. */
export const DEFAULT_STARTUP_OPEN: StartupOpen = "last";

/** Map a stored / unknown `startup_open` value to a valid mode. */
export function normalizeStartupOpen(value: string | null): StartupOpen {
  return value === "empty" || value === "specific" || value === "last"
    ? value
    : DEFAULT_STARTUP_OPEN;
}

/** Mirrors `protocol::PrefsView` (Rust side). */
/** View render type (MYND-273, Saved Views). `map` is deliberately absent —
 *  it needs a Maps plugin and is not representable in v1. Mirrors Rust
 *  `ViewType` (serde lowercase). */
export type ViewType = "table" | "cards" | "list";

/** Sort direction. Mirrors Rust `SortDirection` (serde lowercase). */
export type SortDirection = "asc" | "desc";

/** A typed property-comparison operator — the closed allow-list (no arithmetic,
 *  no function calls). Mirrors Rust `PropertyOp` (operator-literal serde
 *  renames) and the query engine's `PropertyOp`. */
export type PropertyOp = "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains";

/** A within-group sort: a property key + a direction. Mirrors Rust `ViewSort`. */
export interface ViewSort {
  key: string;
  direction: SortDirection;
}

/** The recursive filter AST — boolean combinators over a closed leaf set
 *  (MYND-273). Byte-for-byte the shape the query engine's `FilterNode` reads, so
 *  a persisted `filters` is handed straight to the engine with no translation.
 *  There is deliberately no arithmetic / `map` / formula node (SYNC-7 anti-eval).
 *  Mirrors Rust `FilterNode` (`#[serde(tag = "kind")]`, camelCase kinds). */
export type FilterNode =
  | { kind: "and"; children: FilterNode[] }
  | { kind: "or"; children: FilterNode[] }
  | { kind: "not"; child: FilterNode }
  | { kind: "hasTag"; tag: string }
  | { kind: "inFolder"; path: string }
  | { kind: "search"; query: string }
  | { kind: "property"; key: string; op: PropertyOp; value: string }
  | { kind: "all" };

/** The canonical, persisted definition of one saved view (MYND-273) — the single
 *  shape the query engine (#2), the renderer (#5), and the `.base` importer (#6)
 *  bind to. Mirrors Rust `SavedView`. The optional fields are omitted on the wire
 *  when unset (Rust `skip_serializing_if`), so they read back as `undefined`. */
export interface SavedView {
  /** Stable unique id (a UUIDv7 in practice). */
  id: string;
  /** User-visible view name. */
  name: string;
  /** Render type (`table` / `cards` / `list`). */
  view_type: ViewType;
  /** The filter AST (an `{ kind: "all" }` leaf for an unfiltered view). */
  filters: FilterNode;
  /** Optional within-group sort. */
  sort?: ViewSort;
  /** Optional groupBy property key. */
  group_by?: string;
  /** Ordered display columns (the `.base` `order` list); a sequence. */
  columns?: string[];
  /** Optional card width in integer pixels (cards view). */
  card_size?: number;
  /** Optional cover-image frontmatter property name (resolved via `attachment://`
   *  by #5, SYNC-11) — NOT pixels. */
  image?: string;
  /** Optional image aspect ratio, a STRING (e.g. `"1.65"`) so the `.base` float
   *  round-trips without a canonical-JSON float. #5 parses it for CSS. */
  image_aspect_ratio?: string;
}

/** One color-group rule (graph-connection-ux-polish) — a stable id, a
 *  user-visible name, a color-palette key (resolved against the design-token
 *  palette; this type carries it verbatim, no palette validation here), an
 *  enable flag (a disabled rule stays in {@link PrefsView.color_groups} but
 *  contributes no match), and the filter it matches against. Mirrors Rust
 *  `protocol::color_group::ColorGroup`. `filter` reuses {@link FilterNode} —
 *  the single canonical filter AST also used by {@link SavedView}. */
export interface ColorGroup {
  /** Stable unique id (a UUIDv7 in practice). */
  id: string;
  /** User-visible rule name. */
  name: string;
  /** The color-palette key (a design-token name; the UI offers only the
   *  fixed palette, never free-form entry). */
  color: string;
  /** Whether the rule is evaluated — a disabled rule is retained but skipped. */
  enabled: boolean;
  /** The filter AST (an `{ kind: "all" }` leaf matches every note). */
  filter: FilterNode;
}

export interface PrefsView {
  screen_capture_protection: boolean;
  /**
   * Show the per-note "last edited" timestamp under each sidebar note row
   * (sidebar-note-timestamps). `true` (the default) ≡ timestamps visible — the
   * pre-feature behaviour. Serialized from Rust `bool` with `default = true`;
   * the codec OMITS the field on disk when `true`, so a vault that never touched
   * the toggle is byte-identical to a pre-feature `vault.prefs`. Only the
   * non-default `false` is persisted; an absent key decodes back to `true`.
   */
  show_note_timestamps: boolean;
  /**
   * Whether the note-task marker (MYND-613) is shown in the sidebar row and the
   * tab. Defaults `true`; only the non-default `false` is persisted, so an
   * untouched vault stays byte-identical to a pre-feature `vault.prefs`.
   * Classified **Shared / scalar last-write-wins**, deliberately unlike its
   * neighbour `show_note_timestamps` (device-local): a marker's visibility is
   * taste, not device capability, so it should not be re-chosen per device.
   */
  /** Whether THIS DEVICE shows task reminders (MYND-618). Device-local:
   *  whether a machine should be interrupted is a property of that
   *  machine, so it never syncs. Default true. */
  reminders_enabled: boolean;
  /** How many days ahead this device registers reminders with the OS
   *  (MYND-618); null falls back to the client's built-in horizon. A
   *  PRIVACY bound before a resource one — pending times sit in OS-owned
   *  plaintext, so a shorter horizon exposes less. */
  reminder_horizon_days: number | null;
  show_task_marker: boolean;
  /**
   * Whether speech-to-text may run on this vault's audio attachments
   * (MYND-592). Defaults to `true`; persisted only when `false`.
   *
   * Deliberately NOT `ai_enabled`: transcription ships a bundled model, runs
   * on-device and is invoked one file at a time by the user, so it is a
   * product feature rather than part of the AI beta opt-in. The host re-reads
   * this before it decrypts anything — the UI gate below is discovery, not
   * enforcement.
   */
  transcription_enabled: boolean;
  /**
   * Spell-check enabled toggle (MYND-267). `null` ≡ unset → the host applies
   * the default-ON policy (SYNC-15). Serialized from Rust `Option<bool>`.
   */
  spell_enabled: boolean | null;
  /**
   * Active spell-check language tags (MYND-267 / SYNC-11 union). `[]` ≡ unset →
   * the host applies the default active set ({OS-locale-if-bundled} ∪ {en-US}).
   * Serialized from Rust `Vec<String>` (NFC + sorted + deduped on disk).
   */
  spell_languages: string[];
  /**
   * User keybinding overrides (hotkeys epic, MYND-304). A map from a command id
   * (an existing frozen `COMMAND_ACTIONS` id, e.g. `graph.show`) to its set of
   * canonical chord strings (`Mod-Shift-g` form). **Overrides only** — a command
   * absent from the map uses its in-code default; the effective binding is
   * `override ?? default`. Three states: key absent ≡ default; a non-empty array
   * ≡ override; an empty array (`[]`) ≡ explicitly unbound (no shortcut). Defaults
   * to `{}` (no overrides). Serialized from Rust `BTreeMap<String, Vec<String>>`
   * (each chord set NFC-sorted + deduped on disk; the whole field omitted when
   * empty). Read-only here; write via {@link setKeymapBinding}.
   */
  keymap: Record<string, string[]>;
  /**
   * Unix epoch seconds of the vault's last backup export (MYND-58,
   * spec §9.5.2). `null` ≡ never backed up. Drives the 30-day backup
   * reminder banner. Written by an UNLOCKED export only (the documented
   * locked-export wrinkle). Serialized from Rust `Option<u64>`.
   */
  last_backup_at: number | null;
  /**
   * New-note default-location MODE (MYND-462, "Files" settings panel) —
   * {@link NewNoteLocation}: `"root"` (vault root), `"current"` (the active
   * note's folder), or `"specific"` (the folder named by
   * {@link PrefsView.new_note_location_folder}). `null` ≡ the default `"root"`,
   * applied client-side. A free enum string on the wire (Rust `Option<String>`);
   * the client validates + maps an unknown value to the default. Omitted from the
   * encrypted blob when `null`. Non-load-bearing. Write via
   * {@link setNewNoteLocation}.
   */
  new_note_location: string | null;
  /**
   * Target folder (canonical trailing-slash form) for new notes when
   * {@link PrefsView.new_note_location} is `"specific"` (MYND-462). `null`
   * otherwise. Designating it also registers the folder in `deliberate_folders`
   * so it survives empty. Serialized from Rust `Option<String>`; omitted when
   * `null`.
   */
  new_note_location_folder: string | null;
  /**
   * Startup-open MODE (MYND-462, "Files" settings panel) — {@link StartupOpen}:
   * `"last"` (restore the last workspace layout — the pre-feature behaviour),
   * `"empty"` (open a fresh empty editor), or `"specific"` (open the note named
   * by {@link PrefsView.startup_open_note}). `null` ≡ the default `"last"`,
   * applied client-side. A free enum string on the wire (Rust `Option<String>`);
   * the client validates + maps an unknown value to the default. Omitted from the
   * encrypted blob when `null`. Non-load-bearing. Write via
   * {@link setStartupOpen}.
   */
  startup_open: string | null;
  /**
   * Target note UUID for startup when {@link PrefsView.startup_open} is
   * `"specific"` (MYND-462). `null` otherwise. A stale / deleted UUID falls back
   * to the empty editor client-side (the pref is never auto-cleared on a
   * transient read miss). Serialized from Rust `Option<String>`; omitted when
   * `null`.
   */
  startup_open_note: string | null;
  /**
   * Deliberately-created folder paths (canonical trailing-slash form) that
   * persist independently of whether any note carries them — the carrier for
   * empty folders in the virtual-folder model (MYND-144). Absent in pre-MYND-144
   * vaults → the Rust decoder defaults it to `[]`.
   */
  deliberate_folders: string[];
  /**
   * AI opt-in toggle (local-ai epic, ai-ux-surface MYND-408, SYNC-12). `false`
   * ≡ AI off (the default). Serialized from Rust `bool`; omitted from the
   * encrypted blob when `false` (byte-identical to a pre-feature vault). The
   * whole AI surface is gated on this. Non-load-bearing.
   */
  ai_enabled: boolean;
  /**
   * Whether an imported image attachment is downscaled + re-encoded at ingest
   * time (ingest-image-compression). **Defaults to `true`** — omitted from the
   * encrypted blob when true, so a vault predating the field reads as enabled.
   * The transform is irreversible (the original bytes are not kept), which is
   * why this toggle — unlike its neighbor {@link PrefsView.attachment_ocr_enabled}
   * — is classified **shared** rather than device-local in the sync merge
   * (`sync-protocol.md` §10.2): a content-fidelity switch with a vault-wide,
   * irreversible effect needs the same reach as that effect. Write via
   * {@link setAttachmentCompressionEnabled}.
   */
  attachment_compression_enabled: boolean;
  /**
   * Whether attachment text extraction may read images and scanned PDFs
   * (image OCR, MYND-441). **Defaults to `true`** — omitted from the encrypted
   * blob when true, so a vault predating the field reads as enabled. Turning it
   * off stops the background extraction worker but never deletes cached
   * results. Device-local (`sync-protocol.md` §10.2): per-device compute
   * budget. Non-load-bearing.
   */
  attachment_ocr_enabled: boolean;
  /**
   * Folders excluded from every AI read/index (local-ai epic, ai-ux-surface
   * MYND-408, SYNC-14) — canonical trailing-slash form. Same encoding as
   * `deliberate_folders` (NFC-normalized, sorted, deduped set). Absent →
   * defaulted to `[]`. Non-load-bearing.
   */
  ai_excluded_folders: string[];
  /** Characters of chat history an agent run may be seeded with. `null` means
   *  unset, and the host applies its own default. Clamped at the write, so the
   *  stored value can be lower than the one sent. */
  chat_history_budget: number | null;
  /**
   * Developer mode toggle (`developer-mode` feature, MYND-593). `false` ≡ off
   * (the default). Serialized from Rust `bool`; omitted from the encrypted
   * blob when `false` (byte-identical to a pre-feature vault). Gates the AI
   * opt-in and the local-model override pickers. Device-local
   * (`sync-protocol.md` §10.2). Non-load-bearing.
   */
  developer_mode: boolean;
  /**
   * Folders archived as a unit (folder-archive) — canonical trailing-slash
   * form. Same encoding as `deliberate_folders` / `ai_excluded_folders`
   * (NFC-normalized, sorted, deduped set). Absent → defaulted to `[]`. A folder
   * in this set (and its subtree) drops out of the working-set sidebar/tree
   * while its notes stay resolvable (backlink / graph / search) — the
   * folder-level twin of the per-note `archived:` marker. Write via
   * {@link setArchivedFolders}. Non-load-bearing.
   */
  archived_folders: string[];
  /**
   * Active workspace slot id (MYND-308) — the workspace slot the editor restores
   * on unlock. `null` ≡ unset → the host applies its default (first / last-used)
   * workspace policy. A free string stored verbatim (NFC on the wire); the
   * client owns the slot-id interpretation. Serialized from Rust
   * `Option<String>`; omitted from the encrypted blob when `null` (byte-identical
   * to a pre-feature vault). Non-load-bearing. Canonical key sorts FIRST.
   */
  active_workspace: string | null;
  /**
   * Auto-lock-on-idle timeout in integer seconds (MYND-121). `null` when the
   * user has set no value — the backend then applies its protective-envelope
   * default for the timer. Serialized from Rust `Option<u32>` (null | number).
   */
  auto_lock_seconds: number | null;
  /**
   * Whether automatic on-device tag suggestion runs on this vault's notes
   * (MYND-651). Defaults to `false`; persisted only when `true`.
   *
   * The second half of a two-key gate — the tag pass runs only when this AND
   * {@link PrefsView.ai_enabled} are on, and the host re-reads both before it
   * touches the model, so the UI gate is discovery, not enforcement. Shared
   * across devices (scalar LWW) like {@link PrefsView.transcription_enabled}:
   * it gates a bundled task-model, so it is taste rather than device
   * capability. Its co-gate stays device-local, which is what keeps a synced
   * `true` from starting inference on a device that never opted into AI.
   */
  auto_tag_enabled: boolean;
  /**
   * The **remote** AI provider this account has named, or `null` for the
   * default — which is not "off" but **unreachable**: with no provider named
   * there is no remote path to reach (`decisions.md` 2026-08-09).
   *
   * Deliberately unlike {@link PrefsView.ai_enabled}, which is device-local:
   * that one answers "should this machine spend its CPU on inference", while
   * naming a remote provider is a statement about where this vault's notes may
   * be sent. Shared across devices (scalar LWW).
   */
  ai_provider: string | null;
  /**
   * **Which provider** the one-time consent was given for, or `null`. **A
   * gate, not a display flag** — the host's request path checks it, so a UI
   * that skipped the screen still cannot send.
   *
   * A name rather than a boolean because consent is per provider: the screen
   * names the recipient, so the request path compares this to the active
   * selection instead of trusting that some setter cleared a flag.
   *
   * Account-scoped: it syncs, so a newly enrolled device inherits it and sends
   * without re-asking (`threat-model.md` §5, ledger SYNC-22).
   */
  ai_provider_consent: string | null;
  /**
   * **Which model** at {@link PrefsView.ai_provider} answers, or `null`.
   *
   * There is no default and the client ships no fallback (SYNC-24): the value
   * comes from the list the provider itself reports. `null` means *not chosen*,
   * and the host refuses rather than substituting one — a pinned model tag rots
   * faster than the release that pinned it, and on a metered API a default
   * nobody chose is a bill nobody chose.
   *
   * Unlike the key it sits beside, this one **does** cross IPC: a published
   * model name is not a credential, and the panel renders the selection back.
   */
  ai_provider_model: string | null;
  /*
   * There is deliberately NO `ai_provider_key` here, and its absence is the
   * point rather than an omission. `prefs_read` serializes the whole host-side
   * `PrefsView`, so a key present in that struct would reach page context on
   * every read — and from there a DOM snapshot, a devtools session, or any
   * script running in the page. The host marks the field serde-skip and answers
   * {@link aiProviderHasKey} instead: the UI learns *whether*, never *what*.
   * Adding a field here would not surface the key (the host does not send it);
   * it would surface `undefined` and invite someone to "fix" the host.
   */
  /**
   * Active custom-theme name (custom-themes epic, MYND-297) — a key of the
   * encrypted `vault.themes` store (`MYT1`, `protocol.md` §9.21). It named a
   * plaintext file stem under `app_config_dir/themes/` until `decisions.md`
   * 2026-07-16 promoted palettes to vault content; the blob holds the palettes,
   * this field holds the pointer. A non-`null` value takes **precedence** over
   * {@link PrefsView.theme}: when set, the client applies the custom palette and
   * ignores the built-in Light/Dark/System choice. `null` ≡ no custom theme
   * selected (use `theme`), and so is a name with no live entry in the store —
   * the pointer is deliberately NOT rewritten in that case, since a re-add on
   * another device revives the theme. Serialized from Rust `Option<String>`.
   */
  custom_theme: string | null;
  /**
   * Daily-notes date-format string (MYND-191) — e.g. `YYYY-MM-DD`. `null` ≡ the
   * canonical default `YYYY-MM-DD`, applied host-side (blank-when-default).
   * Serialized from Rust `Option<String>`.
   */
  daily_date_format: string | null;
  /**
   * Daily-notes folder path (MYND-191), canonical trailing-slash form — e.g.
   * `Daily/`. `null` ≡ the canonical default `Daily/`, applied host-side.
   * Designating a folder also registers it in `deliberate_folders`.
   */
  daily_folder: string | null;
  /**
   * Daily-notes template pointer (MYND-191) — the UUIDv7 of a template note to
   * instantiate today's note from. `null` ≡ the "blank daily note" state.
   */
  daily_template: string | null;
  /**
   * Favorited notes — an ordered list of note UUIDs surfaced in the sidebar's
   * Favorites section, in display order (MYND-183). A sequence: the backend
   * preserves element order verbatim. UUIDs only (folders are not favoritable).
   * Absent in vaults with no favorites → the Rust decoder defaults it to `[]`.
   */
  favorites: string[];
  /**
   * Manual sidebar order across the single interleaved file-tree (MYND-183,
   * superseding `note_order` + `folder_order`; MYND-596 container-keyed reshape)
   * — a map keyed by CONTAINER (`""` for the tree root, else a folded folder key
   * `FolderNode.key`) whose value is that container's children in manual order:
   * a heterogeneous, order-preserving sequence of note UUIDs and canonical
   * trailing-slash folder paths (discriminated by the trailing `/`), freely
   * interleaved. Each container is reordered + synced independently (per-container
   * LWW), so a reorder in one container rewrites only its own sequence. Unlisted
   * children fall back to recency / folded name. Order within each sequence is the
   * payload — the backend preserves it verbatim. Absent / pre-reorder vaults →
   * defaults to `{}`.
   */
  item_order: Record<string, string[]>;
  /**
   * Editor three-pane layout (sidebar widths + collapsed flags, MYND-137).
   * `null` when the user never customized the layout — the field is omitted
   * from the encrypted blob, byte-identical to a pre-MYND-137 vault. Serialized
   * from Rust `Option<EditorLayout>` (null | object).
   */
  editor_layout: EditorLayout | null;
  /**
   * Display date format (myne#279) — `"system"` | `"iso"` | `"dmy"` | `"mdy"` |
   * `"dmmmy"`. `null` ≡ `"system"` (follow the OS locale). A free enum string on
   * the wire (Rust `Option<String>`); the client validates + maps an unknown
   * value to the default. Omitted from the encrypted blob when `null`.
   * Non-load-bearing cosmetic. Canonical key slot: after `daily_template`,
   * before `deliberate_folders`.
   */
  date_format: string | null;
  /**
   * Display time format (myne#279) — `"system"` | `"24h"` | `"12h"`. `null` ≡
   * `"system"`. Same free-enum-string discipline as {@link PrefsView.date_format}.
   * Canonical key slot: after `theme`, before `timezone`.
   */
  time_format: string | null;
  /**
   * Display timezone override (myne#279) — an IANA zone identifier, or `null` ≡
   * the host's own zone.
   *
   * **Display only.** It decides what the app treats as "today" and how a stored
   * wall-clock value is printed; it never enters a `.myn` file, a blob, or the
   * sync wire — `dialect/src/taskFields.ts` keeps note times zone-free, and this
   * does not walk that back. Filed device-local by `prefs_classification`, since
   * the right zone is a property of where the device is. Canonical key slot:
   * after `time_format`, before `transcription_enabled`.
   */
  timezone: string | null;
  /**
   * Editor content max-width preset (editor-typography) — `"narrow"` |
   * `"normal"` | `"wide"` | `"full"`. `null` ≡ the canonical default
   * `"normal"`. A free enum string on the wire (Rust `Option<String>`); the
   * client validates + maps an unknown value to the default. Omitted from the
   * encrypted blob when `null`. Non-load-bearing cosmetic.
   */
  editor_content_width: string | null;
  /**
   * Editor default view-mode preset (MYND-299) — `"live"` | `"reading"` |
   * `"source"`. `null` ≡ the host-applied default. A free enum string on the
   * wire (Rust `Option<String>`); the client validates + maps an unknown value
   * to the default. Omitted from the encrypted blob when `null`. Non-load-bearing.
   * Canonical key slot: after `editor_content_width`, before
   * `editor_focus_dim_inactive`.
   */
  editor_default_view_mode: string | null;
  /**
   * Editor focus-mode dim-inactive toggle (MYND-348). `null` ≡ unset → the host
   * applies its default focus-mode policy. `true` dims inactive paragraphs,
   * `false` leaves them lit. Serialized from Rust `Option<bool>`; omitted from
   * the encrypted blob when `null`. Non-load-bearing cosmetic. Canonical key
   * slot: after `editor_default_view_mode`, before `editor_focus_typewriter`.
   */
  editor_focus_dim_inactive: boolean | null;
  /**
   * Editor focus-mode typewriter-scrolling toggle (MYND-348). `null` ≡ unset →
   * the host applies its default focus-mode policy. `true` keeps the caret
   * vertically centered, `false` scrolls normally. Serialized from Rust
   * `Option<bool>`; omitted from the encrypted blob when `null`. Non-load-bearing
   * cosmetic. Canonical key slot: after `editor_focus_dim_inactive`, before
   * `editor_font_family`.
   */
  editor_focus_typewriter: boolean | null;
  /**
   * Editor font-family preset (editor-typography) — `"mono"` | `"sans"`.
   * `null` ≡ the canonical default `"mono"`. Same free-enum-string discipline
   * as {@link PrefsView.editor_content_width}.
   */
  editor_font_family: string | null;
  /**
   * Editor line-spacing preset (editor-typography) — `"tight"` | `"normal"` |
   * `"relaxed"`. `null` ≡ the canonical default `"normal"`. Stored as an enum
   * string (not a float) so the codec stays float-free; the client maps the
   * preset to a concrete line-height.
   */
  editor_line_spacing: string | null;
  /**
   * Editor base text-size preset (editor-typography) — `"sm"` | `"md"` |
   * `"lg"` | `"xl"`. `null` ≡ the canonical default `"md"`. The client maps it
   * to a base font-size; the headings scale relative to it.
   */
  editor_text_size: string | null;
  /**
   * Editor line-number gutter toggle (editor-line-numbers, MYND-314). `null` ≡
   * unset → the host applies the default-OFF policy (prose-first; the gutter is
   * opt-in). `true` shows the gutter, `false` hides it. Serialized from Rust
   * `Option<bool>`; omitted from the encrypted blob when `null` (byte-identical
   * to a pre-feature vault). Non-load-bearing cosmetic.
   */
  editor_line_numbers: boolean | null;
  /**
   * Vim keyboard-mode toggle (vim-keyboard-mode, MYND-313). `null` ≡ unset →
   * the host applies the default-OFF policy (modal editing is opt-in). `true`
   * makes the editor modal (normal/insert/visual); `false` keeps the plain
   * editor. Serialized from Rust `Option<bool>`; omitted from the encrypted blob
   * when `null` (byte-identical to a pre-feature vault). **Device-local**: the
   * vim choice never crosses devices in the Phase 2 prefs merge — a physical
   * keyboard and a touch keyboard want different answers. Non-load-bearing.
   */
  editor_vim_mode: boolean | null;
  /**
   * Archive-feature disable toggle (archive-disable, MYND-…). `null` ≡ unset →
   * the host applies the default-OFF policy (archiving enabled — the pre-feature
   * behaviour). `true` hides the archive entry points (sidebar button, context
   * menu actions); `false` keeps them. Serialized from Rust `Option<bool>`;
   * omitted from the encrypted blob when `null` (byte-identical to a pre-feature
   * vault). Non-load-bearing — the underlying `archived:` frontmatter surgery is
   * untouched; this flag only gates the UI surfaces.
   */
  archive_disabled: boolean | null;
  /**
   * CLI terminal-access door toggle (myne-cli epic, MYND-490). `false` ≡ the
   * door is closed (the default) — the local socket the `myne` CLI dials is
   * never created regardless of unlock state. Serialized from Rust `bool`;
   * omitted from the encrypted blob when `false` (byte-identical to a
   * pre-feature vault), same discipline as {@link PrefsView.ai_enabled}.
   * **Device-local** (`sync-protocol.md` §10.2): the CLI door is a per-machine
   * decision, so this value never travels in a merge. Rationale:
   * `docs/decisions.md` "CLI terminal access is a default-off, unlock-gated
   * local socket with a folder exclusion list (MYND-490)" and
   * `docs/threat-model.md` §7. Non-load-bearing.
   */
  cli_enabled: boolean;
  /**
   * Folders excluded from the CLI's reach (myne-cli epic, MYND-490) —
   * canonical trailing-slash form. Same encoding as `deliberate_folders` /
   * `ai_excluded_folders` (NFC-normalized, sorted, deduped set). Absent →
   * defaulted to `[]`. **Shared(SetUnion)**: an exclusion added on one device
   * must never be lost in a merge with a device that lacks it. Enforcement of
   * the exclusion (filtering CLI reads/writes) is a separate concern from this
   * codec field. Non-load-bearing.
   */
  cli_excluded_folders: string[];
  /**
   * CLI socket rate-limit opt-out (myne-cli epic, MYND-490). `null` ≡ unset →
   * the default-ON rate limit applies (a runaway or hostile script cannot
   * drain the vault at full speed). `true` ≡ the user explicitly disabled the
   * limit in Settings. `false` is a legal value (re-enabling after disabling)
   * but the UI is not expected to produce it — omitting the field again has
   * the identical effect. Serialized from Rust `Option<bool>`; omitted from
   * the encrypted blob when `null`, same shape as
   * {@link PrefsView.archive_disabled}. **Device-local**
   * (`sync-protocol.md` §10.2): a machine-local performance knob. Non-load-bearing.
   */
  cli_rate_limit_disabled: boolean | null;
  /**
   * User theme preference (MYND-110). `null` ≡ **system** (follow the OS
   * `prefers-color-scheme`) — the canonical encoding of "no explicit choice",
   * omitted from the encrypted blob. `"light"` / `"dark"` are explicit
   * choices the client applies as `<html data-theme="…">`. Serialized from
   * Rust `Option<ThemeChoice>` (null | "light" | "dark").
   */
  theme: ThemeChoice | null;
  /**
   * Per-folder custom sidebar icon (MYND-185) — a map from a canonical
   * trailing-slash folder path to an icon name (the client's curated stroke-glyph
   * set), replacing that folder's default glyph. Absent in vaults with no custom
   * folder icon → the Rust decoder defaults it to `{}`. Folders only. Serialized
   * from Rust `BTreeMap<String, String>`.
   */
  folder_icons: Record<string, string>;
  /**
   * Friendly device names (MYND-548 / SYNC-41) — a map from a `device_id` (hex)
   * to the user-chosen label the device list shows for it. The single home for
   * device names across clients, so no client ships a second default-name
   * heuristic. Absent in vaults where no device was ever named → the Rust
   * decoder defaults it to `{}`, and the list falls back to its id-derived
   * short label. Shared + synced, merged per key by UNION with a
   * `device_names/<key>` LWW clock (`sync-protocol.md` §10.2) — which is why
   * there is no "clear a name" path: a removed key resurrects from any peer
   * that still holds it. Serialized from Rust `BTreeMap<String, String>`.
   */
  device_names: Record<string, string>;
  /**
   * Hidden bottom-bar item ids (bottom-bar customization) — the set of
   * {@link BottomBar} element ids the user chose to hide via the bar's
   * right-click menu (e.g. `"graph"`, `"tags"`, `"word-count"`). The backend
   * encodes the array as a canonical set (NFC-normalized, sorted, deduped).
   * Empty (the default — bar fully visible) is byte-identical to a pre-feature
   * vault. An unknown id is ignored at render. Serialized from Rust
   * `Vec<String>`; absent in pre-feature vaults → the Rust decoder defaults
   * it to `[]`.
   */
  hidden_bar_items: string[];
  /**
   * Bottom-bar item display order (bottom-bar customization) — the right-cluster
   * {@link BottomBar} element ids in the order the user arranged them by dragging
   * or via the bar's right-click "move left / move right" actions. A sequence:
   * the backend preserves element order verbatim (not sorted/deduped, unlike
   * {@link PrefsView.hidden_bar_items}; unknown ids are the caller's to prune and
   * a known id absent from the array falls back to its canonical default
   * position). Empty (the default — canonical bar order) is byte-identical to a
   * pre-feature vault. Serialized from Rust `Vec<String>`; absent → `[]`.
   */
  bar_items_order: string[];
  /**
   * Color-group rules (graph-connection-ux-polish) — the ordered list of
   * user-authored rules the knowledge-graph pane paints matching notes with at
   * render time. Order is MEANINGFUL and IS the rule precedence (first match
   * wins) — unlike {@link PrefsView.saved_views} (id-sorted; its display order
   * lives in the separate `view_order`), this array is preserved verbatim,
   * never re-sorted. A disabled rule stays in the list, evaluated as a
   * no-match by {@link resolveGraphColorGroups}. Serialized from Rust
   * `Vec<ColorGroup>`; empty (the default) is byte-identical to a pre-feature
   * vault.
   */
  color_groups: ColorGroup[];
  /**
   * Active right-panel tab id (right-panel tabs) — the right-sidebar tab the
   * editor restores (e.g. `backlinks`, `unlinked`, `outline`). `null` ≡ unset →
   * the host applies its default (the first visible tab in canonical order). A
   * free pointer the client interprets (unknown id → host default), the
   * {@link PrefsView.active_workspace} precedent class. Absent in pre-feature
   * vaults → the Rust decoder defaults it to `null`. Serialized from Rust
   * `Option<String>` (null | string).
   */
  right_panel_active_tab: string | null;
  /**
   * Hidden right-panel tab ids (right-panel tabs) — the **set** of right-sidebar
   * tab ids the user hid via the panel's right-click menu. The backend encodes
   * the array as a canonical set (NFC-normalized, sorted, deduped); empty (the
   * default — every tab visible) is byte-identical to a pre-feature vault. An
   * unknown id is ignored at render. The {@link PrefsView.hidden_bar_items}
   * twin. Absent → the Rust decoder defaults it to `[]`.
   */
  right_panel_hidden_tabs: string[];
  /**
   * Right-panel tab display order (right-panel tabs) — the right-sidebar tab ids
   * in the order the user arranged them by dragging or via the panel's "move
   * left / move right" actions. A sequence: the backend preserves element order
   * verbatim (not sorted/deduped, unlike {@link PrefsView.right_panel_hidden_tabs};
   * unknown ids are the caller's to prune and a known id absent from the array
   * falls back to its canonical default position). The
   * {@link PrefsView.bar_items_order} twin. Empty (the default — canonical tab
   * order) is byte-identical to a pre-feature vault. Absent → `[]`.
   */
  right_panel_tab_order: string[];
  /** MYND-336 editor toolbar customization. `*_order` is a verbatim sequence,
   *  `*_hidden` a sorted+deduped set; both default `[]` (today's layout). */
  editor_toolbar_order: string[];
  editor_toolbar_hidden: string[];
  editor_slash_order: string[];
  editor_slash_hidden: string[];
  /**
   * Per-item color label (MYND-184) — a map from a sidebar item key (a note UUID
   * **or** a canonical trailing-slash folder path, discriminated by the trailing
   * `/`) to a color-slot name. Notes and folders both take a color (folders also
   * get an icon; notes do not). Absent in vaults with no color → the Rust decoder
   * defaults it to `{}`. Serialized from Rust `BTreeMap<String, String>`.
   */
  item_colors: Record<string, string>;
  /**
   * Per-vault human-readable label (MYND-205) — the name the in-app vault
   * switcher shows for this vault. `null` ≡ no label set → the switcher shows a
   * neutral fallback (`Vault N`). Lives encrypted-only inside `vault.prefs`
   * (SYNC-3); decrypted into a per-session RAM cache on unlock. Absent in vaults
   * with no label → the Rust decoder defaults it to `null`. Serialized from Rust
   * `Option<String>` (null | string).
   */
  label: string | null;
  /**
   * Per-vault decorative icon (vault-icons) — the curated stroke-glyph name the
   * in-app vault switcher shows beside this vault's name, replacing the default
   * `M` wordmark. `null` ≡ no icon → the switcher shows the neutral `M`
   * fallback. Drawn from the curated folder-icon glyph set (`FOLDER_ICON_NAMES`);
   * an unknown name is ignored at render. Twin of {@link PrefsView.label}: lives
   * encrypted-only inside `vault.prefs` (SYNC-3), decrypted into a per-session
   * RAM cache on unlock. Absent in vaults with no icon → the Rust decoder
   * defaults it to `null`. Serialized from Rust `Option<String>` (null | string).
   */
  icon: string | null;
  /**
   * Saved-view definitions (MYND-273) — authored filter/sort/group projections.
   * Authored content (survives an index rebuild + vault restore), persisted in
   * `vault.prefs` (SYNC-6). The backend encodes the array sorted by view id;
   * display order is the separate {@link PrefsView.view_order} sequence. Absent
   * in vaults with no views → the Rust decoder defaults it to `[]`.
   */
  saved_views: SavedView[];
  /**
   * Saved-view display order (MYND-273) — view ids in views-list / sidebar order
   * (SYNC-10). A sequence: the backend preserves element order verbatim (not
   * sorted/deduped; stale ids are the caller's to prune). Absent → `[]`.
   */
  view_order: string[];
}

/** Read vault.prefs from the unlocked vault; defaults to safer state. */
export async function prefsRead(): Promise<PrefsView> {
  return await invoke<PrefsView>("plugin:prefs|prefs_read");
}

/**
 * Toggle screen-capture protection.
 *
 * Critical ordering on the backend: vault.prefs disk write succeeds
 * first, then `screen_capture::apply` runs. A rejected promise means
 * the disk write failed — neither the persisted preference nor the
 * native state were modified, so the caller's optimistic UI MUST
 * revert.
 */
/**
 * THE write path for every `vault.prefs` setter in this module (#251).
 *
 * Invokes the prefs command and, on success, bumps the prefs nonce — the ONE
 * mechanism by which sibling `usePrefs` instances re-read disk truth
 * (`src/hooks/usePrefs.ts`). That bump used to be an optional second line in
 * each of ~56 setters, so it got forgotten: favourites starred from the sidebar
 * were silently dropped **and the deletion synced**; "Show outline" / "Open AI
 * Chat" appeared to do nothing; toggling the AI opt-in never reached the open
 * editor; reminders kept firing for the rest of the session after being turned
 * off. The rule was documented two functions away, and documentation was not
 * enough — a developer writing a new setter copies a neighbour, and some
 * neighbours were wrong.
 *
 * Skipping the bump is still possible, but it now costs an explicit
 * `{ bump: false }` carrying its reason — a visible choice in review rather
 * than an invisible omission. `scripts/check-prefs-nonce.mjs` holds the rule:
 * a setter invoking a prefs command outside this helper fails the commit.
 */
async function writePref(
  command: string,
  args: Record<string, unknown>,
  opts: { bump?: boolean } = {},
): Promise<void> {
  await invoke<void>(command, args);
  if (opts.bump !== false) bumpPrefsNonce();
}

export async function setScreenCaptureProtection(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_screen_capture_protection", { enabled });
}

/**
 * Persist the full deliberate_folders set (the carrier for empty /
 * deliberately-created folders, MYND-144). The caller passes the entire
 * desired set; v0.1 single-device writes it verbatim. Folded-identity dedup
 * (case-insensitivity) is the caller's responsibility — the Rust codec only
 * sorts + exact-dedups for canonical byte-stability. A rejected promise means
 * the disk write failed and the caller's optimistic UI must revert.
 *
 * Bumps the prefs nonce on success (like every sibling folder-set setter, e.g.
 * {@link setArchivedFolders}) so OTHER `usePrefs` consumers — the palette's
 * "Move note to folder…" picker reads `deliberate_folders` from the prefs blob,
 * not the sidebar's local set — see a freshly-created empty folder without an
 * app reload.
 */
export async function setDeliberateFolders(folders: string[]): Promise<void> {
  await writePref("plugin:prefs|set_deliberate_folders", { folders });
}

/**
 * Persist the `ai_enabled` AI opt-in toggle (local-ai epic, ai-ux-surface
 * MYND-408, SYNC-12). Per-vault + encrypted; a rejected promise means the disk
 * write failed and the caller's optimistic UI must revert (re-read disk truth,
 * as the screen-capture toggle does).
 */
export async function setAiEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_ai_enabled", { enabled });
}

/**
 * Name the remote AI provider, or pass `null` to clear it (myne#415).
 *
 * Clearing also clears the consent and the key host-side — a key for a
 * provider nobody selected is a credential with no owner, and a surviving
 * consent would silently pre-approve the next provider the user picks.
 *
 * A value outside the host's known set is **refused**, not stored, so the
 * promise rejects rather than leaving a selection the request path ignores.
 *
 * **Changing the provider cuts the chat-history seed, the same way changing
 * `ai_excluded_folders` does (myne-md/myne#617 review).** Since #617 an agent
 * run is seeded with the visible transcript, so without this a conversation
 * held entirely on-device is re-sent in full to a provider the user configured
 * afterwards. The consent screen enumerates what leaves the device and does not
 * name the conversation so far, so the seed would cross a boundary under a
 * consent that never mentioned it.
 *
 * **Cut on every change, including clearing to `null`.** Clearing sends future
 * runs to a local model runtime, which `threat-model.md` TB12 is a trust
 * boundary in its own right (a separately distributed daemon on the same
 * machine), so "clearing is free" is not true, only cheaper. One rule is
 * learnable and two are not, which is the argument `docs/decisions/ai/0541`
 * already makes about the seed itself.
 *
 * **The cut lives here rather than in `usePrefs`**, unlike the exclusion one,
 * because this binding is the single point every provider change passes
 * through: `AiPanel` calls it from three places (clear, re-select an already
 * consented provider, and accept consent), and a cut in the caller would be
 * three chances to miss one. `vault-switch.ts` reaches into stores from this
 * layer for the same reason.
 *
 * It fires BEFORE the write, and before any await: a failed persist does not
 * withdraw the intent, and the other order leaves a window in which a run could
 * seed the turns this is protecting.
 */
export async function setAiProvider(provider: string | null): Promise<void> {
  blockSeedingOfExistingTurns();
  await writePref("plugin:prefs|set_ai_provider", { provider });
}

/**
 * Record (or withdraw) the one-time consent for the named provider (myne#415).
 *
 * This is the persistence, not the enforcement: the host re-reads it before
 * every remote request, so calling it without having shown the screen buys a
 * stored `true` and nothing else.
 */
export async function setAiProviderConsent(
  grantedFor: string | null,
): Promise<void> {
  await writePref("plugin:prefs|set_ai_provider_consent", { grantedFor });
}

/**
 * Store the provider API key, or pass `null` to **revoke** it (myne#415).
 *
 * One-way by design: the value goes in and never comes back out — there is no
 * command that returns it, and {@link PrefsView} carries no field for it. Read
 * {@link aiProviderHasKey} to decide between "Add key" and "Replace key".
 *
 * Revocation propagates to the account's other devices as an LWW write of
 * `null`, which is what makes "revoke" mean more than "revoke here".
 */
export async function setAiProviderKey(key: string | null): Promise<void> {
  await writePref("plugin:prefs|set_ai_provider_key", { key });
}

/**
 * Choose which of the provider's models answers, or pass `null` to clear it
 * (myne#415, SYNC-24).
 *
 * The candidate list comes from {@link listProviderModels}, never from a
 * constant in this tree — that is the whole resolution, not an implementation
 * detail. Changing or clearing the provider clears this host-side, because a
 * model name is only meaningful at the provider that published it.
 */
export async function setAiProviderModel(model: string | null): Promise<void> {
  await writePref("plugin:prefs|set_ai_provider_model", { model });
}

/**
 * Whether a provider API key is stored — the boolean the UI reads **instead
 * of** the key (myne#415).
 *
 * Not a `writePref`, so it bumps no nonce: it is a read. It answers `false`
 * rather than throwing when the vault is locked or the blob is unreadable,
 * because "no key" is the safe answer for a control that only chooses a label.
 */
export async function aiProviderHasKey(): Promise<boolean> {
  try {
    return await invoke<boolean>("plugin:prefs|ai_provider_has_key");
  } catch {
    return false;
  }
}

/**
 * Progress event emitted by the background OCR worker (MYND-441). Paired with
 * `OCR_BACKLOG_PROGRESS_EVENT` in
 * `src-tauri/src/plugins/attachments/ocr_queue.rs` — the codebase convention is
 * a named constant on both sides rather than a string literal at the listener.
 */
export const OCR_BACKLOG_PROGRESS_EVENT = "ocr-backlog-progress";

/** Payload of {@link OCR_BACKLOG_PROGRESS_EVENT}: counts only, never filenames. */
export interface OcrBacklogProgress {
  /** Attachments still waiting, the in-flight one included. */
  remaining: number;
  /** Attachments extracted so far in this drain. */
  done: number;
}

/**
 * Persist the `attachment_compression_enabled` toggle (ingest-image-compression)
 * — whether a newly imported image attachment is downscaled + re-encoded before
 * it is encrypted and stored. This preference is **shared** (vault-wide): the
 * backend classifies it in the sync merge, not this wrapper. A rejected promise
 * means the disk write failed and the caller's optimistic UI must revert.
 */
export async function setAttachmentCompressionEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_attachment_compression_enabled", { enabled });
}

/**
 * Persist the `attachment_ocr_enabled` toggle (MYND-441) — whether attachment
 * text extraction may read images and scanned PDFs. A rejected promise means the
 * disk write failed and the caller's optimistic UI must revert.
 */
export async function setAttachmentOcrEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_attachment_ocr_enabled", { enabled });
}

/**
 * Persist the `developer_mode` toggle (`developer-mode` feature, MYND-593) —
 * the gate the AI opt-in and the local-model override pickers sit behind. A
 * rejected promise means the disk write failed and the caller's optimistic UI
 * must revert.
 */
export async function setDeveloperMode(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_developer_mode", { enabled });
}

/**
 * Persist `chat_history_budget`: how many characters of visible chat history
 * an agent run may be seeded with (myne-md/myne#617). `null` clears the
 * override and returns the run to the host's own default.
 *
 * **The value is CLAMPED host-side, and this wrapper deliberately does not
 * clamp it.** The bound is what limits how much of the user's plaintext one run
 * can send to a provider, multiplied by the loop's iteration ceiling, so it has
 * to hold for every path that reaches the command rather than for the one that
 * happened to render a control. A second clamp here would read as the control
 * and hide the day the real one stopped working.
 */
export async function setChatHistoryBudget(budget: number | null): Promise<void> {
  await writePref("plugin:prefs|set_chat_history_budget", { budget });
}

/**
 * Persist the full `ai_excluded_folders` set (local-ai epic, ai-ux-surface
 * MYND-408, SYNC-14) — folders the AI never reads/indexes. Same canonical set
 * encoding as `deliberate_folders` (the Rust codec NFC-sorts + exact-dedups).
 * The caller passes the entire desired set; a rejected promise means the disk
 * write failed and the caller's optimistic UI must revert.
 *
 * **The seed cut lives here, beside the one in [`setAiProvider`], rather than in
 * `usePrefs`.** This binding is the single point every exclusion write passes
 * through, and the two controls bound the same thing, so splitting them across
 * two layers meant a reader had to find both to know the rule. It fires BEFORE
 * the write and before any await: the user has stated an intent about what may
 * reach a provider, and a failed disk write does not withdraw it.
 *
 * It is not the only trigger, and the other one is the reason this control needs
 * two. `ai_excluded_folders` is classified `Shared(SetUnion)`, so it also
 * arrives by SYNC MERGE, where no setter on this machine runs at all;
 * `chatStore.observeEgressControls` catches that by watching the value on every
 * prefs read. This one catches the stated intent, including when the write
 * fails; that one catches the arrival, whatever route it took.
 */
export async function setAiExcludedFolders(folders: string[]): Promise<void> {
  blockSeedingOfExistingTurns();
  await writePref("plugin:prefs|set_ai_excluded_folders", { folders });
}

/**
 * Persist the `cli_enabled` CLI terminal-access door toggle (myne-cli epic,
 * MYND-490). Per-vault + encrypted; a rejected promise means the disk write
 * failed and the caller's optimistic UI must revert. Same pattern as
 * {@link setAiEnabled}.
 */
export async function setCliEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_cli_enabled", { enabled });
}

/**
 * Persist the full `cli_excluded_folders` set — folders the CLI door never
 * reaches (myne-cli epic, MYND-490). Same canonical set encoding as
 * `deliberate_folders` / `ai_excluded_folders` (the Rust codec NFC-sorts +
 * exact-dedups). The caller passes the entire desired set; a rejected promise
 * means the disk write failed and the caller's optimistic UI must revert.
 * Same pattern as {@link setAiExcludedFolders}.
 */
export async function setCliExcludedFolders(folders: string[]): Promise<void> {
  await writePref("plugin:prefs|set_cli_excluded_folders", { folders });
}

/**
 * Persist the full `archived_folders` set (folder-archive) — folders archived
 * as a unit. Same canonical set encoding as `deliberate_folders` (the Rust
 * codec NFC-sorts + exact-dedups). The caller passes the entire desired set; a
 * rejected promise means the disk write failed and the caller's optimistic UI
 * must revert.
 *
 * Bumps the prefs nonce after a successful write so the sidebar surfaces that
 * read `archived_folders` through their OWN `usePrefs` instance (saved-view
 * results, new-tab quick-open) re-read disk truth and drop / restore the
 * archived subtree live (same chokepoint discipline as {@link
 * setShowNoteTimestamps}).
 */
export async function setArchivedFolders(folders: string[]): Promise<void> {
  await writePref("plugin:prefs|set_archived_folders", { folders });
}

/**
 * Set the auto-lock-on-idle timeout (integer seconds, MYND-121). The backend
 * writes vault.prefs disk-first, then refreshes the idle timer's cached
 * effective timeout (clamped through the protective envelope). A rejected
 * promise means the disk write failed — the caller's optimistic UI must revert
 * (re-read disk truth, as the screen-capture toggle does).
 */
export async function setAutoLockTimeout(seconds: number): Promise<void> {
  await writePref("plugin:prefs|set_auto_lock_timeout", { seconds });
}

/**
 * Persist the full item_order map — the manual sidebar order across the
 * interleaved file-tree, keyed by container (`""` = root, else a folded folder
 * key) → that container's heterogeneous sequence of note UUIDs + canonical
 * folder paths (MYND-183, superseding `setNoteOrder`/`setFolderOrder`; MYND-596
 * container-keyed reshape — the Rust command takes a `BTreeMap`). The caller
 * passes the entire desired map; the backend preserves each sequence's element
 * order verbatim (the sequence IS the payload, unlike the sorted+deduped
 * `deliberate_folders`). No native side-effect; a rejected promise means the
 * disk write failed and the caller's optimistic UI must revert.
 */
export async function setItemOrder(
  order: Record<string, string[]>,
): Promise<void> {
  await writePref("plugin:prefs|set_item_order", { order });
}

/**
 * Persist the full bottom-bar item display order — the right-cluster
 * {@link BottomBar} element ids in the order the user arranged them by drag-to-
 * reorder or the bar's right-click move actions. The caller passes the entire
 * desired order; the backend preserves element order verbatim (the sequence IS
 * the payload, unlike the sorted+deduped `hidden_bar_items`). No native
 * side-effect; a rejected promise means the disk write failed and the caller's
 * optimistic UI must revert. The IPC payload key (`order`) matches the Rust
 * command's `order: Vec<String>` parameter.
 */
export async function setBarItemsOrder(order: string[]): Promise<void> {
  await writePref("plugin:prefs|set_bar_items_order", { order });
}

/**
 * Persist the full hidden-bottom-bar-items set — the {@link BottomBar} element
 * ids the user chose to hide via the bar's right-click menu. The backend
 * canonicalizes it (sorted + deduped); an empty array is the default (bar fully
 * visible). No native side-effect; a rejected promise means the disk write
 * failed and the caller's optimistic UI must revert. The IPC payload key
 * (`items`) matches the Rust command's `items: Vec<String>` parameter.
 */
export async function setHiddenBarItems(items: string[]): Promise<void> {
  await writePref("plugin:prefs|set_hidden_bar_items", { items });
}

/**
 * Persist the active right-panel tab id (right-panel tabs) — the right-sidebar
 * tab the editor restores, or `null` to clear to the host default. The backend
 * stores it verbatim; the client owns the unknown-id → default fallback. No
 * native side-effect; a rejected promise means the disk write failed and the
 * caller's optimistic UI must revert. The IPC payload key (`value`) matches the
 * Rust command's `value: Option<String>` parameter.
 */
export async function setRightPanelActiveTab(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_right_panel_active_tab", { value });
}

/**
 * Persist the full hidden-right-panel-tabs set — the right-sidebar tab ids the
 * user chose to hide via the panel's right-click menu. The backend canonicalizes
 * it (sorted + deduped); an empty array is the default (every tab visible). No
 * native side-effect; a rejected promise means the disk write failed and the
 * caller's optimistic UI must revert. The IPC payload key (`items`) matches the
 * Rust command's `items: Vec<String>` parameter.
 */
export async function setRightPanelHiddenTabs(items: string[]): Promise<void> {
  await writePref("plugin:prefs|set_right_panel_hidden_tabs", { items });
}

/**
 * Persist the full right-panel tab display order — the right-sidebar tab ids in
 * the order the user arranged them by drag-to-reorder or the panel's right-click
 * move actions. The caller passes the entire desired order; the backend preserves
 * element order verbatim (the sequence IS the payload). No native side-effect; a
 * rejected promise means the disk write failed and the caller's optimistic UI
 * must revert. The IPC payload key (`order`) matches the Rust command's
 * `order: Vec<String>` parameter.
 */
export async function setRightPanelTabOrder(order: string[]): Promise<void> {
  await writePref("plugin:prefs|set_right_panel_tab_order", { order });
}

/** MYND-336: persist the editor toolbar order (verbatim sequence). */
export async function setEditorToolbarOrder(order: string[]): Promise<void> {
  await writePref("plugin:prefs|set_editor_toolbar_order", { order });
}

/** MYND-336: persist the hidden editor-toolbar items (set — sorted/deduped on encode). */
export async function setEditorToolbarHidden(items: string[]): Promise<void> {
  await writePref("plugin:prefs|set_editor_toolbar_hidden", { items });
}

/** MYND-336: persist the slash-menu order (verbatim sequence). */
export async function setEditorSlashOrder(order: string[]): Promise<void> {
  await writePref("plugin:prefs|set_editor_slash_order", { order });
}

/** MYND-336: persist the hidden slash-menu items (set — sorted/deduped on encode). */
export async function setEditorSlashHidden(items: string[]): Promise<void> {
  await writePref("plugin:prefs|set_editor_slash_hidden", { items });
}

/**
 * Persist the full favorites sequence — the user's favorited notes (note UUIDs)
 * in display order, shown in the sidebar's Favorites section. Same order-
 * preserving, no-native-side-effect contract as {@link setItemOrder}. A rejected
 * promise means the disk write failed and the caller's optimistic UI must revert.
 */
export async function setFavorites(favorites: string[]): Promise<void> {
  await writePref("plugin:prefs|set_favorites", { order: favorites });
}

/**
 * Toggle one note in the favorites sequence, against DISK truth (#252).
 *
 * `favorites` is persisted as a whole sequence, so a caller that derives the
 * next value from its own `usePrefs` snapshot writes back whatever that
 * snapshot was missing. The command palette did exactly that: starring note A
 * from the sidebar and then palette-toggling note B persisted `[B]`, dropping
 * A — and since `favorites` is `SharedDiscipline::SequenceLww`, the truncation
 * was pushed to the account and won on every other device.
 *
 * Reading first makes the write depend on what is STORED rather than on which
 * surface rendered most recently. Surfaces that already hold the live sequence
 * (the sidebar, which owns the optimistic row state and its revert) keep using
 * {@link setFavorites} directly.
 */
export async function toggleFavoriteOnDisk(noteId: string): Promise<void> {
  const fresh = await prefsRead();
  const next = fresh.favorites.includes(noteId)
    ? fresh.favorites.filter((f) => f !== noteId)
    : [...fresh.favorites, noteId];
  await setFavorites(next);
}

/**
 * Persist the editor three-pane layout (sidebar widths + collapsed flags,
 * MYND-137). The caller passes the full desired layout; the backend
 * atomic-writes vault.prefs with no native side-effect. The codec stores the
 * raw value — the min/max clamp lives on the client, re-applied on read, so a
 * replayed/tampered blob is re-clamped into range rather than trusted. A
 * rejected promise means the disk write failed; the caller's in-memory layout
 * state remains the source of truth until the next successful write.
 */
export async function setEditorLayout(layout: EditorLayout): Promise<void> {
  await writePref("plugin:prefs|set_editor_layout", { layout });
}

/**
 * Persist the user's theme choice (MYND-110). Pass `"light"` / `"dark"` for an
 * explicit choice, or `null` for **system** (follow the OS) — `null` clears the
 * field on disk so the vault stays byte-identical to one that never picked a
 * theme. The backend atomic-writes vault.prefs disk-first with no native
 * side-effect; a rejected promise means the disk write failed, so the caller
 * must not treat the new theme as persisted (re-read disk truth). `theme` is a
 * non-load-bearing cosmetic preference — no clamp, no in-flight gating.
 */
export async function setTheme(theme: ThemeChoice | null): Promise<void> {
  await writePref("plugin:prefs|set_theme", { theme });
}

/**
 * Persist the active custom-theme selection (custom-themes epic, MYND-297). Pass
 * a theme name to select a user-authored custom theme (takes precedence over the
 * built-in `theme`), or `null` to clear it (fall back to `theme`). The backend
 * atomic-writes vault.prefs disk-first with no native side-effect; a rejected
 * promise means the disk write failed, so the caller must not treat the new
 * selection as persisted (re-read disk truth). `custom_theme` is a
 * non-load-bearing cosmetic preference — no clamp, no in-flight gating.
 */
export async function setCustomTheme(customTheme: string | null): Promise<void> {
  await writePref("plugin:prefs|set_custom_theme", { customTheme });
}

/**
 * Set the daily-notes date-format string (MYND-191), e.g. `YYYY-MM-DD`. The
 * backend atomic-writes vault.prefs disk-first with no native side-effect; a
 * rejected promise means the disk write failed. Non-load-bearing.
 */
export async function setDailyDateFormat(format: string): Promise<void> {
  await writePref("plugin:prefs|set_daily_date_format", { format });
}

/**
 * Set the daily-notes folder path (MYND-191), canonical trailing-slash form
 * (e.g. `Daily/`). Designating it also registers the folder in
 * `deliberate_folders` so it survives empty. Disk-first, no native side-effect.
 */
export async function setDailyFolder(folder: string): Promise<void> {
  await writePref("plugin:prefs|set_daily_folder", { folder });
}

/**
 * Set (or clear) the daily-notes template pointer (MYND-191). Pass a template
 * UUID to designate it, or `null` to clear it back to the "blank daily note"
 * state. Disk-first, no native side-effect; a rejected promise means the write
 * failed.
 */
export async function setDailyTemplate(templateId: string | null): Promise<void> {
  await writePref("plugin:prefs|set_daily_template", { templateId });
}

/**
 * Set the new-note default-location pair (MYND-462, "Files" settings panel) —
 * `location` is the mode ({@link NewNoteLocation}: `"root"`/`"current"`/
 * `"specific"`, or `null` to clear to the `"root"` default), and `folder` is the
 * canonical trailing-slash target folder used only when `location === "specific"`
 * (pass `null` otherwise). When a folder is given the backend also registers it
 * in `deliberate_folders` so it survives empty. Disk-first, no native
 * side-effect; a rejected promise means the write failed.
 *
 * Bumps the prefs nonce after a successful write so the sidebar's note-creation
 * path — which reads the location pref through its OWN `usePrefs` instance,
 * separate from the Settings modal's — sees the new value immediately.
 */
export async function setNewNoteLocation(
  location: string | null,
  folder: string | null,
): Promise<void> {
  await writePref("plugin:prefs|set_new_note_location", { location, folder });
}

/**
 * Set the startup-open pair (MYND-462, "Files" settings panel) — `mode` is the
 * startup behaviour ({@link StartupOpen}: `"last"`/`"empty"`/`"specific"`, or
 * `null` to clear to the `"last"` default), and `note` is the target note UUID
 * used only when `mode === "specific"` (pass `null` otherwise). Disk-first, no
 * native side-effect; a rejected promise means the write failed.
 */
export async function setStartupOpen(
  mode: string | null,
  note: string | null,
): Promise<void> {
  await writePref("plugin:prefs|set_startup_open", { mode, note });
}

/**
 * Persist the full item_colors map (MYND-184) — per-item color labels keyed by
 * note UUID or canonical trailing-slash folder path. The caller passes the
 * entire desired map; v0.1 single-device writes it verbatim. Clearing a color =
 * omit its key (an empty map omits the field on disk). Stale-key pruning (deleted
 * note/folder) is the caller's job. No native side-effect; a rejected promise
 * means the disk write failed and the caller's optimistic UI must revert.
 */
export async function setItemColors(colors: Record<string, string>): Promise<void> {
  await writePref("plugin:prefs|set_item_colors", { colors });
}

/**
 * Persist the full folder_icons map (MYND-185) — per-folder custom icons keyed
 * by canonical trailing-slash folder path. The caller passes the entire desired
 * map; resetting a folder to its default glyph = omit its key. Same
 * order-irrelevant, no-native-side-effect contract as {@link setItemColors}.
 */
export async function setFolderIcons(icons: Record<string, string>): Promise<void> {
  await writePref("plugin:prefs|set_folder_icons", { icons });
}

/**
 * Name ONE device (MYND-548) — `device_names[deviceIdHex] = name`, the label the
 * device list leads with. Unlike {@link setFolderIcons} this takes a single
 * entry, not the whole map: entries are written by different devices and merged
 * per key, so a whole-map write would let one client's stale view clobber a
 * peer's rename.
 *
 * There is deliberately **no clear/delete counterpart**. `device_names` merges
 * per key by UNION (`sync-protocol.md` §10.2), so removing a key does not
 * propagate — it resurrects from the first peer that still holds it. Renaming
 * always works (it stamps a fresh clock and wins LWW). The backend refuses a
 * blank name, so an empty submit is a no-op the caller should treat as "cancel".
 */
export async function setDeviceName(deviceIdHex: string, name: string): Promise<void> {
  await writePref("plugin:prefs|set_device_name", { deviceIdHex, name });
}

/**
 * The running device's platform token (MYND-548) — `"macos"`, `"windows"`,
 * `"linux"`, `"ios"`, `"android"`, straight from Rust's `std::env::consts::OS`.
 *
 * The enrollment forms seed their "Name this device" field from it, mapping the
 * token to a display word through the i18n catalogue. **Do not derive the
 * platform from `navigator` instead** — that would be a second default-name
 * heuristic diverging per client, which is exactly what keeping names in one
 * synced map is meant to prevent.
 *
 * Memoised, because the answer is a compile-time constant of the running binary
 * and this is an IPC round trip. Desktop has one caller today and mobile's twin
 * has four; the memo is here anyway so the two modules stay comparable, which is
 * how a fix to one reaches the other.
 *
 * Only a SUCCESS is cached. A rejected promise held here would turn one
 * transient IPC failure into a permanently wrong answer for the process.
 */
let platformProbe: Promise<string> | null = null;

export async function devicePlatform(): Promise<string> {
  platformProbe ??= invoke<string>("plugin:prefs|device_platform").catch((e: unknown) => {
    platformProbe = null;
    throw e;
  });
  return await platformProbe;
}

/**
 * Window event dispatched after a successful per-vault prefs write that the
 * in-app vault switcher projects (icon/label). Live-refresh consumers (e.g.
 * `VaultSwitcher`) listen for it and re-probe `listVaults()` so the chip + rows
 * update immediately, without polling or reopening the dropdown.
 */
export const VAULT_PREFS_CHANGED_EVENT = "myne:vault-prefs-changed";

/**
 * Tauri event the sync loop emits after merging a REMOTE `vault.prefs` change
 * onto disk (MYND-478; `PREFS_CHANGED_EVENT` in `core`). Never fired for the
 * user's own IPC writes (their own resolve is the signal). Contentless — the
 * listener re-reads. `Editor.tsx` bridges it into `VAULT_PREFS_CHANGED_EVENT`
 * + the prefs nonce so an incoming rename shows live.
 */
export const PREFS_SYNC_APPLIED_EVENT = "myne://prefs-changed";

/** Notify live-refresh listeners that a switcher-visible prefs field changed.
 *  No-op outside a DOM context (e.g. a non-browser test runner). Exported for
 *  the `PREFS_SYNC_APPLIED_EVENT` bridge (a sync-applied change needs the same
 *  window-level signal a local write dispatches). */
export function notifyVaultPrefsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VAULT_PREFS_CHANGED_EVENT));
  }
}

/**
 * Set (or clear) the active vault's human-readable label (MYND-205) — the name
 * the in-app vault switcher shows. Pass a string to set/rename it, or `null` to
 * clear it back to the neutral-fallback state. **Unlock-gated**: writing the
 * label needs the active vault's `prefs_key`, so you can only rename the vault
 * you currently have unlocked (a rejected promise with `SlotNotUnlocked` means
 * no vault was unlocked). The backend atomic-writes `vault.prefs` disk-first
 * with no native side-effect, then refreshes the per-session RAM label cache so
 * the switcher reflects the rename immediately. The label lives encrypted-only
 * at rest — it never touches disk in plaintext except as this input. On success
 * dispatches {@link VAULT_PREFS_CHANGED_EVENT} so the switcher live-refreshes.
 */
export async function setVaultLabel(label: string | null): Promise<void> {
  await writePref("plugin:prefs|vault_set_label", { label });
  notifyVaultPrefsChanged();
}

/**
 * Set (or clear) the active vault's decorative icon (vault-icons) — the curated
 * stroke-glyph the in-app vault switcher shows beside the vault name. Pass a
 * glyph name from {@link FOLDER_ICON_NAMES} to set it, or `null` to clear it
 * back to the neutral `M` wordmark. Twin of {@link setVaultLabel}:
 * **unlock-gated** (writing the icon needs the active vault's `prefs_key`, so a
 * rejected promise with `SlotNotUnlocked` means no vault was unlocked); the
 * backend atomic-writes `vault.prefs` disk-first with no native side-effect,
 * then refreshes the per-session RAM icon cache so the switcher reflects the
 * change immediately. The icon lives encrypted-only at rest.
 */
export async function setVaultIcon(icon: string | null): Promise<void> {
  await writePref("plugin:prefs|vault_set_icon", { icon });
  notifyVaultPrefsChanged();
}

/**
 * Set the spell-check enabled toggle (MYND-267). Persists an explicit choice;
 * the default-ON policy (SYNC-15) is applied host-side at read time when the
 * field is unset. Disk-first, no native side-effect; a rejected promise means
 * the write failed and the caller's optimistic UI must revert. Non-load-bearing.
 */
export async function setSpellEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_spell_enabled", { enabled });
}

/**
 * Set the active spell-check language set (MYND-267 / SYNC-11 union). The caller
 * passes the full desired set of BCP-47 tags; the backend NFC-sorts + dedupes
 * for canonical byte-stability. An empty array omits the field on disk (host
 * applies the {OS-locale ∪ en-US} default at read time). Disk-first, no native
 * side-effect; a rejected promise means the disk write failed.
 */
export async function setSpellLanguages(languages: string[]): Promise<void> {
  await writePref("plugin:prefs|set_spell_languages", { languages });
}

/**
 * Set, unbind, or remove ONE command's keymap override (hotkeys epic, MYND-304).
 * Three states via the `chords` argument:
 * - a non-empty array → override the command to those chords;
 * - an empty array (`[]`) → explicit-unbind (the command has no shortcut);
 * - `null` → remove the override entry (revert to the in-code default).
 *
 * The backend NFC-sorts + dedupes the chord set for canonical byte-stability, so
 * pass the raw desired set. Disk-first, no native side-effect; a rejected promise
 * means the write failed and the caller's optimistic UI must revert.
 * Non-load-bearing.
 *
 * Bumps the prefs nonce after a successful write so the live keybinding engine —
 * which reads the keymap through its OWN `usePrefs` instance, separate from the
 * Settings modal's — re-reads disk truth and the rebound shortcut takes effect
 * immediately (same chokepoint discipline as {@link setShowNoteTimestamps}).
 */
export async function setKeymapBinding(
  commandId: string,
  chords: string[] | null,
): Promise<void> {
  await writePref("plugin:prefs|set_keymap_binding", { commandId, chords });
}

/**
 * Set the sidebar per-note timestamp visibility (sidebar-note-timestamps). Pass
 * `false` to hide the "last edited" line under each sidebar note row, `true` to
 * show it (the default). Disk-first, no native side-effect; a rejected promise
 * means the write failed and the caller's optimistic UI must revert.
 * Non-load-bearing.
 *
 * Unlike the other simple setters, this bumps the prefs nonce after a
 * successful write so that the sidebar — which reads prefs through its OWN
 * `usePrefs` instance, separate from the Settings modal's — re-reads disk truth
 * and reflects the toggle live (same chokepoint discipline as the saved-view
 * setters).
 */
export async function setShowNoteTimestamps(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_show_note_timestamps", { enabled });
}

/**
 * Show or hide the note-task marker in the sidebar row and the tab (MYND-613).
 * Shared across devices (scalar LWW), unlike the timestamp toggle above.
 */
export async function setShowTaskMarker(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_show_task_marker", { enabled });
}

/**
 * Enable or disable speech-to-text for this vault's audio attachments
 * (MYND-592). Shared across devices (scalar LWW) for the same reason as the
 * task marker above: it is a preference, not a device capability.
 */
export async function setTranscriptionEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_transcription_enabled", { enabled });
}

/**
 * Enable or disable automatic on-device tag suggestion for this vault
 * (MYND-651). Default-off. Shared across devices (scalar LWW) for the same
 * reason as transcription above; the pass is co-gated on the device-local
 * `ai_enabled`, which the host re-reads alongside this one.
 */
export async function setAutoTagEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_auto_tag_enabled", { enabled });
}

/**
 * Set whether THIS DEVICE shows task reminders (MYND-618).
 *
 * Device-local: it never syncs, because whether a given machine should be
 * interrupted is a property of that machine rather than of the vault.
 */
export async function setRemindersEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_reminders_enabled", { enabled });
}

/**
 * Set how many days ahead this device registers reminders with the OS, or
 * `null` to fall back to the built-in horizon (MYND-618).
 *
 * Shorter is more private, not merely cheaper: pending reminder times leave the
 * AEAD envelope and sit in OS-owned plaintext (`threat-model.md` §7).
 */
export async function setReminderHorizonDays(days: number | null): Promise<void> {
  await writePref("plugin:prefs|set_reminder_horizon_days", { days });
}

/**
 * Set (or clear) the editor base text-size preset (editor-typography) — pass
 * `"sm"`/`"md"`/`"lg"`/`"xl"`, or `null` to clear back to the `"md"` default.
 * Disk-first, no native side-effect; a rejected promise means the write failed
 * and the caller's optimistic UI must revert. Bumps the prefs nonce on success
 * so the open editor (which reads prefs through its OWN `usePrefs`, separate
 * from the Settings modal's) re-reads disk truth and re-renders live — same
 * chokepoint discipline as {@link setShowNoteTimestamps}. Non-load-bearing.
 */
export async function setEditorTextSize(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_editor_text_size", { value });
}

/**
 * Set (or clear) the editor line-spacing preset (editor-typography) — pass
 * `"tight"`/`"normal"`/`"relaxed"`, or `null` to clear to the `"normal"`
 * default. Same disk-first + nonce-bump contract as {@link setEditorTextSize}.
 */
export async function setEditorLineSpacing(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_editor_line_spacing", { value });
}

/**
 * Set (or clear) the display date format (myne#279) — pass
 * `"system"`/`"iso"`/`"dmy"`/`"mdy"`/`"dmmmy"`, or `null` to clear to
 * `"system"`. Same contract as {@link setEditorTextSize}.
 */
export async function setDateFormat(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_date_format", { value });
}

/**
 * Set (or clear) the display time format (myne#279) — pass
 * `"system"`/`"24h"`/`"12h"`, or `null` to clear to `"system"`.
 */
export async function setTimeFormat(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_time_format", { value });
}

/**
 * Set (or clear) the DISPLAY timezone override (myne#279) — pass an IANA zone
 * identifier, or `null` to follow the host's own zone. Display only: it never
 * reaches a note, a blob or the sync wire.
 */
export async function setTimezone(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_timezone", { value });
}

/**
 * Set (or clear) the editor content-width preset (editor-typography) — pass
 * `"narrow"`/`"normal"`/`"wide"`/`"full"`, or `null` to clear to the
 * `"normal"` default. Same contract as {@link setEditorTextSize}.
 */
export async function setEditorContentWidth(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_editor_content_width", { value });
}

/**
 * Set (or clear) the editor font-family preset (editor-typography) — pass
 * `"mono"`/`"sans"`, or `null` to clear to the `"mono"` default. Same contract
 * as {@link setEditorTextSize}.
 */
export async function setEditorFontFamily(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_editor_font_family", { value });
}

/**
 * Set the editor line-number gutter toggle (editor-line-numbers, MYND-314). Pass
 * `true` to show the gutter, `false` to hide it (the default). Disk-first, no
 * native side-effect; a rejected promise means the write failed and the caller's
 * optimistic UI must revert. Bumps the prefs nonce on success so the open editor
 * (which reads prefs through its OWN `usePrefs`, separate from the Settings
 * modal's) re-reads disk truth and reconfigures its line-number compartment live
 * — same chokepoint discipline as {@link setEditorTextSize}. Non-load-bearing.
 */
export async function setEditorLineNumbers(value: boolean): Promise<void> {
  await writePref("plugin:prefs|set_editor_line_numbers", { enabled: value });
}

/**
 * Set the vim keyboard-mode toggle (vim-keyboard-mode, MYND-313). Pass `true` to
 * make the editor modal, `false` to return it to the plain editor (the default).
 * Disk-first, no native side-effect; a rejected promise means the write failed
 * and the caller's optimistic UI must revert. Bumps the prefs nonce on success so
 * the open editor (which reads prefs through its OWN `usePrefs`, separate from
 * the Settings modal's) re-reads disk truth and reconfigures its vim compartment
 * live — same chokepoint discipline as {@link setEditorLineNumbers}.
 * Non-load-bearing.
 */
export async function setEditorVimMode(value: boolean): Promise<void> {
  await writePref("plugin:prefs|set_editor_vim_mode", { enabled: value });
}

/**
 * Disable (or re-enable) the note-archive feature (archive-disable, MYND-…).
 * `true` hides the archive entry points; `false` (the default) keeps them.
 * Disk-first, no native side-effect; a rejected promise means the write failed
 * and the caller's optimistic UI must revert. Bumps the prefs nonce on success
 * so the open editor + sidebar (each reading prefs through their OWN `usePrefs`)
 * re-read disk truth and re-render their archive surfaces live — same chokepoint
 * discipline as {@link setEditorLineNumbers}. The auto-unarchive of existing
 * archived notes when disabling is orchestrated by the caller BEFORE this write.
 * Non-load-bearing.
 */
export async function setArchiveDisabled(value: boolean): Promise<void> {
  await writePref("plugin:prefs|set_archive_disabled", { enabled: value });
}

/**
 * Persist the `cli_rate_limit_disabled` toggle — removes the default-on CLI
 * socket rate limit (myne-cli epic, MYND-490). Always writes an explicit
 * `Some(disabled)` on the Rust side (the `archive_disabled` precedent); a
 * rejected promise means the disk write failed and the caller's optimistic UI
 * must revert. Same pattern as {@link setArchiveDisabled}.
 */
export async function setCliRateLimitDisabled(disabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_cli_rate_limit_disabled", { disabled });
}

/**
 * Set (or clear) the active workspace slot id (MYND-308) — pass the slot id, or
 * `null` to clear back to the host default workspace policy. Disk-first; bumps
 * the prefs nonce on success so open consumers re-read disk truth. Same contract
 * as {@link setEditorContentWidth}.
 */
export async function setActiveWorkspace(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_active_workspace", { value });
}

/**
 * Set (or clear) the editor default view-mode preset (MYND-299) — pass
 * `"live"`/`"reading"`/`"source"`, or `null` to clear to the host default. Same
 * contract as {@link setEditorContentWidth}.
 */
export async function setEditorDefaultViewMode(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_editor_default_view_mode", { value });
}

/**
 * Set the editor focus-mode dim-inactive toggle (MYND-348). Pass `true` to dim
 * inactive paragraphs, `false` to leave them lit. Disk-first, no native
 * side-effect; bumps the prefs nonce on success. Same contract as
 * {@link setEditorLineNumbers}. Non-load-bearing.
 */
export async function setEditorFocusDimInactive(value: boolean): Promise<void> {
  await writePref("plugin:prefs|set_editor_focus_dim_inactive", { enabled: value });
}

/**
 * Set the editor focus-mode typewriter-scrolling toggle (MYND-348). Pass `true`
 * to keep the caret vertically centered, `false` for normal scrolling.
 * Disk-first, no native side-effect; bumps the prefs nonce on success. Same
 * contract as {@link setEditorLineNumbers}. Non-load-bearing.
 */
export async function setEditorFocusTypewriter(value: boolean): Promise<void> {
  await writePref("plugin:prefs|set_editor_focus_typewriter", { enabled: value });
}

/**
 * Save or edit one saved view (MYND-273) — an upsert by `id` (replaces an
 * existing view with the same id, else appends; no duplicate). The caller passes
 * the full {@link SavedView}. The backend atomic-writes vault.prefs with no
 * native side-effect; an over-the-64-KiB-cap save rejects (`PrefsEncodeFailed`)
 * BEFORE any write, leaving the prior views intact. A rejected promise means the
 * write failed and the caller's optimistic UI must revert.
 */
export async function upsertSavedView(view: SavedView): Promise<void> {
  await writePref("plugin:prefs|upsert_saved_view", { view });
}

/**
 * Delete the saved view with `id` (MYND-273). Removes it from `saved_views` and
 * prunes the id from `view_order`. Deleting an absent id is an idempotent no-op
 * success. Disk-first, no native side-effect.
 */
export async function deleteSavedView(id: string): Promise<void> {
  await writePref("plugin:prefs|delete_saved_view", { id });
}

/**
 * Persist the full saved-view display order (MYND-273) — view ids in display
 * order, shown in the views list / sidebar Views section. Same order-preserving,
 * no-native-side-effect contract as {@link setItemOrder}; stale-id pruning is the
 * caller's job (no backend GC). A rejected promise means the write failed.
 */
export async function setViewOrder(order: string[]): Promise<void> {
  await writePref("plugin:prefs|set_view_order", { order });
}

/**
 * Persist the full color-group rule list (graph-connection-ux-polish) — a
 * WHOLE-LIST replace, not a per-item upsert/delete. Order is rule precedence
 * (first match wins), so unlike {@link setViewOrder} there is no separate
 * order field to reconcile: the caller passes the complete desired sequence
 * and the backend preserves it verbatim. Disk-first, no native side-effect;
 * the 64 KiB `vault.prefs` cap fails the write BEFORE touching disk, leaving
 * the prior rules intact. A rejected promise means the write failed and the
 * caller's optimistic UI must revert.
 */
export async function setColorGroups(groups: ColorGroup[]): Promise<void> {
  await writePref("plugin:prefs|set_color_groups", { groups });
}
