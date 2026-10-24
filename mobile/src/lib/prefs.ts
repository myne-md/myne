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
import { bumpPrefsNonce } from "./prefsNonce";

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
/**
 * One graph colour-group rule (myne-md/myne#727). Mirrors Rust
 * `protocol::color_group::ColorGroup`, and `filter` reuses {@link FilterNode},
 * the single canonical filter AST also used by {@link SavedView}.
 *
 * It reached this client's prefs mirror when the graph did: `color_groups` is
 * SHARED, whole-value-LWW vault content, so a phone that could not read it drew
 * a graph with no colour groups while the desktop it synced with drew all of
 * them, from the same vault.
 */
export interface ColorGroup {
  id: string;
  name: string;
  /** A design-token palette key, never a hex value. */
  color: string;
  enabled: boolean;
  filter: FilterNode;
}

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
  /** Definition version (view-manifests): a non-negative integer the APP
   *  maintains. Declared here even though this client has no editor for it: the
   *  view sheet spreads the stored definition, so an optional field this type
   *  did not name would still survive a save, but a typed access to it would not
   *  compile and the next author would assume it is absent. */
  version?: number;
  /** The property keys this view may write: its ENTIRE write authority, checked
   *  by the host. Same reasoning as `version`: declared so a mobile edit cannot
   *  silently look like it cleared a desktop-authored declaration. */
  write_fields?: string[];
}

export interface PrefsView {
  screen_capture_protection: boolean;
  /** Whether on-device voice-to-text is available (MYND-563/592). Opt-OUT —
   *  default true; a separate switch from the AI-beta `ai_enabled` opt-in
   *  (transcription ships a bundled model and is a product feature). The
   *  `transcribe` command re-reads this host-side before any decrypt. */
  transcription_enabled: boolean;
  /** Whether THIS DEVICE shows task reminders (MYND-618/619). Device-local:
   *  whether a phone should be interrupted is a property of that phone, so it
   *  never syncs. Default true — an absent key reads as ENABLED, because
   *  silently disabling reminders on every existing vault would be the worst
   *  available reading of a missing value. */
  reminders_enabled: boolean;
  /** How many days ahead this device registers reminders with the OS
   *  (MYND-618/619); null falls back to the client's built-in horizon. A
   *  PRIVACY bound before a resource one — pending times sit in OS-owned
   *  plaintext (`threat-model.md` §7), so a shorter horizon exposes less. */
  reminder_horizon_days: number | null;
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
   * Whether an imported image attachment is downscaled + re-encoded before it
   * is encrypted and stored (ingest-image-compression). `true` (the default)
   * ≡ compression on — the codec OMITS the field on disk when `true`, so a
   * vault that never touched the toggle is byte-identical to a pre-feature
   * `vault.prefs`. Serialized from Rust `bool` with `default = true`.
   *
   * **Shared** in the sync merge (`sync-protocol.md` §10.2) — a deliberate
   * divergence from device-local compute-budget toggles like `spell_enabled`:
   * this is a content-fidelity switch whose effect (irreversible pixel loss)
   * is vault-wide, so the switch must have the same reach as the effect.
   * Toggling it here changes policy for every device, not just this phone.
   * Write via {@link setAttachmentCompressionEnabled}.
   */
  attachment_compression_enabled: boolean;
  /**
   * Whether attachment text extraction may read images and scanned PDFs
   * (image OCR, MYND-441). **Defaults to `true`**, omitted from the encrypted
   * blob when true, so a vault predating the field reads as enabled. Turning it
   * off stops the background extraction worker but never deletes cached results.
   *
   * **DEVICE-LOCAL** (`sync-protocol.md` §10.2), deliberately unlike the
   * compression switch above it: this is a per-device compute budget, and OCR
   * runs in-process on the phone that imports the image, so the device paying
   * the cost owns the switch. Reached this client's mirror when the row that
   * writes it did (myne-md/myne#880); the import path already read the pref to
   * select its extractor, so the phone obeyed a value it could not set.
   */
  attachment_ocr_enabled: boolean;
  /**
   * The AI beta opt-in for THIS device (myne-md/myne#456). Device-local, and
   * after that issue removed `developer_mode` from the request-time gate it is
   * the only device-local switch on the remote path besides the consent below,
   * which is why that one became device-local in the same change.
   */
  ai_enabled: boolean;
  /**
   * The remote AI provider the user named, or `null`.
   *
   * Shared across devices (scalar LWW): naming a provider is a statement about
   * where this vault's notes may be sent, which is a fact about the account
   * rather than about this phone. Deliberately unlike {@link
   * PrefsView.ai_enabled} beside it.
   */
  ai_provider: string | null;
  /**
   * **Which provider** the consent was given for, or `null`. A gate, not a
   * display flag: the host's request path compares it to the active selection,
   * so a UI that skipped the screen still cannot send.
   *
   * A name rather than a boolean because consent is per provider, so a stale
   * approval for a different recipient is unusable rather than transferable.
   *
   * **Device-local** (myne-md/myne#456). The key still arrives by sync, so this
   * phone may hold a credential it has not been permitted to use, and that is
   * the intended shape: the credential is an account fact, the approval is a
   * decision a person makes at a device.
   */
  ai_provider_consent: string | null;
  /**
   * **Which model** at {@link PrefsView.ai_provider} answers, or `null`.
   *
   * There is no default and no fallback: the value comes from the list the
   * provider itself reports. `null` means *not chosen*, and the host refuses
   * rather than substituting one, because on a metered API a default nobody
   * chose is a bill nobody chose.
   */
  ai_provider_model: string | null;
  /**
   * Folders excluded from every AI read/index (local-ai epic, ai-ux-surface
   * MYND-408, SYNC-14), canonical trailing-slash form. Same encoding as
   * `deliberate_folders` (NFC-normalized, sorted, deduped set). Absent →
   * defaulted to `[]`.
   *
   * **An EGRESS CONTROL rather than a preference**, which is why
   * `sync-protocol.md` §10.2 classifies it `SetUnion { folded: true,
   * removals_propagate: false }`: an exclusion present on ANY device survives
   * every merge, so the union can only ever fail closed. The core honours it
   * (`hooks.ai_policy_changed`), and `src/lib/aiExcludedFolders.ts` is the
   * frontend mirror of the Rust `folder_matches_excluded`, so a note gated on
   * one path is gated on the other.
   *
   * Reached this client's mirror when the row that writes it did
   * (myne-md/myne#880): the phone already ENFORCED the list and reported its
   * count, and could not author it. Write via
   * {@link mutateAiExcludedFolders}, which takes verbs rather than a whole set.
   */
  ai_excluded_folders: string[];
  /**
   * Characters of chat history an agent run may be seeded with
   * (myne-md/myne#617), or `null` for the host's default.
   *
   * **DEVICE-LOCAL**: it bounds how much of THIS machine's plaintext one run
   * sends to a provider, multiplied by the loop's iteration ceiling, so a laptop
   * on a metered connection and a desktop on a fast one legitimately disagree.
   * A value that synced would let one device widen another's off-device volume
   * without anyone at that device choosing it.
   *
   * The host CLAMPS the write (`MAX_HISTORY_BUDGET` in the Rust history
   * module), so the stored value can be lower than the one sent. Reached this
   * client's mirror when the row that writes it did (myne-md/myne#880); the
   * phone already applied an inherited default it could not change.
   */
  chat_history_budget: number | null;
  /**
   * The instruction the meeting AI pass uses to turn a transcript into sections
   * (meeting-ai), or `null` for the built-in default.
   *
   * **SHARED / scalar last-write-wins**: it is vault content, so it reaches the
   * account's other devices. Reached this client's mirror when the row that
   * writes it did (myne-md/myne#880), which matters most here because the phone
   * is where meeting capture actually happens.
   */
  meeting_ai_prompt: string | null;
  /*
   * There is deliberately NO `ai_provider_key` here, and the absence is the
   * point. `prefs_read` serializes the whole host-side `PrefsView`, so a key in
   * that struct would reach page context on every read, and from there a DOM
   * snapshot or any script running in the page. The host marks it serde-skip
   * and answers `aiProviderHasKey` instead: the UI learns *whether*, never
   * *what*.
   */
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
   * Folder-archive set (MYND-331 / MYND-470): canonical trailing-slash folder
   * paths archived as a UNIT. A folder is archived by adding its path here; its
   * notes are NOT rewritten — they stay live (searchable/resolvable) but drop out
   * of the working-set tree. A note is folder-archived when its folder equals or
   * is nested under any entry. Absent in pre-folder-archive vaults → the Rust
   * decoder defaults it to `[]`. Synced via `vault.prefs`, so desktop-archived
   * folders arrive here after sync.
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
   * Active custom-theme name (custom-themes epic, MYND-297) — the file-stem of a
   * user-authored theme under `app_config_dir/themes/`. A non-`null` value takes
   * **precedence** over {@link PrefsView.theme}: when set, the client applies the
   * custom palette and ignores the built-in Light/Dark/System choice. `null` ≡ no
   * custom theme selected (use `theme`). Serialized from Rust `Option<String>`.
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
   * Display date format (myne#279, reached mobile in myne-md/myne#609):
   * `"system"` | `"iso"` | `"dmy"` | `"mdy"` | `"dmmmy"`. `null` ≡ `"system"`,
   * which resolves against the app's OWN language rather than the OS locale.
   *
   * A free enum string on the wire (Rust `Option<String>`) with no codec-level
   * validation, so a value written by a newer build decodes as unset rather than
   * failing the blob; the client maps an unknown value to the default. Omitted
   * from the encrypted blob when `null`. Non-load-bearing cosmetic. Canonical
   * key slot: after `daily_template`, before `deliberate_folders`.
   *
   * **Shared, scalar-LWW.** It arrives by sync from whichever device set it,
   * which is why this field existed on the wire for a while before this client
   * could read it: the phone received the value and disregarded it.
   */
  date_format: string | null;
  /**
   * Periodic-notes settings (myne#177): one entry per `<period>.<setting>`
   * pair, e.g. `weekly.folder` → `Weekly/`, `monthly.format` → `YYYY-MM`. The
   * three settings mirror what the `daily_*` fields above carry for the daily
   * period, which keeps its own three fields and is deliberately not migrated
   * in here (prefs merge per field, so a device on an older build would keep
   * writing the flat ones and the two would silently diverge).
   *
   * Flat rather than nested so the Phase 2 field clock is per SETTING: a folder
   * edit on one device and a template edit on another, to the same period in
   * the same round, both survive. An entry naming a period this build has no UI
   * for decodes and is ignored, which is what makes a fourth period free.
   * Absent in vaults that configured no period → the Rust decoder defaults it
   * to `{}`. Serialized from Rust `BTreeMap<String, String>`.
   *
   * **Read and written on mobile since myne-md/myne#880.** It used to be
   * read-only here, deliberately: the write half was withheld because mobile
   * shipped no periodic-notes settings panel, and a grant for a command the
   * WebView never sends would widen the reachable surface for nothing. The panel
   * landed (`mobile/src/components/PeriodicNotesBlock.tsx`) and the wrapper,
   * `setPeriodicNoteSetting`, arrived with it, which is the order the paragraph
   * that stood here asked for.
   */
  periodic_notes: Record<string, string>;
  /**
   * Favorited notes — an ordered list of note UUIDs surfaced in the sidebar's
   * Favorites section, in display order (MYND-183). A sequence: the backend
   * preserves element order verbatim. UUIDs only (folders are not favoritable).
   * Absent in vaults with no favorites → the Rust decoder defaults it to `[]`.
   */
  favorites: string[];
  /**
   * Unified manual sidebar order (MYND-183 + MYND-596) — a **container-keyed
   * map**, superseding the flat list. Each key is a container: `""` for the tree
   * root, or a folded folder key (`FolderNode.key`); each value is that
   * container's children in manual order — a heterogeneous sequence of note UUIDs
   * and child folder DISPLAY paths (trailing `/`), freely interleaved. Each
   * container is reordered and synced independently (MYND-596 per-container LWW),
   * so a reorder in one folder never clobbers another's order. Order within a
   * value is the payload — the backend preserves it verbatim; unlisted children
   * fall back to recency / folded name. Absent in pre-reorder vaults → the Rust
   * decoder defaults it to `{}`. Mirrors Rust `BTreeMap<String, Vec<String>>`.
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
   * User theme preference (MYND-110). `null` ≡ **system** (follow the OS
   * `prefers-color-scheme`) — the canonical encoding of "no explicit choice",
   * omitted from the encrypted blob. `"light"` / `"dark"` are explicit
   * choices the client applies as `<html data-theme="…">`. Serialized from
   * Rust `Option<ThemeChoice>` (null | "light" | "dark").
   */
  theme: ThemeChoice | null;
  /**
   * Display time format (myne#279, reached mobile in myne-md/myne#609):
   * `"system"` | `"24h"` | `"12h"`. `null` ≡ `"system"`. Same free-enum-string
   * discipline as {@link PrefsView.date_format}, and **shared** the same way, so
   * it too arrives by sync. Canonical key slot: after `theme`, before
   * `timezone`.
   */
  time_format: string | null;
  /**
   * Display timezone override (myne#279, reached mobile in myne-md/myne#609):
   * an IANA zone identifier, or `null` ≡ this device's own zone.
   *
   * **Display only.** It decides what the app treats as "today" and how a real
   * instant is printed. `dialect/src/taskFields.ts` keeps note times zone-free
   * wall-clock and this does not walk that back: a reminder written as 09:00
   * reads 09:00 on every device, and shifting it by an offset would invent an
   * instant nobody wrote.
   *
   * Be exact about the reach, because the looser claim was written here first:
   * it never enters a `.myn` file, so a note never records where its author
   * was. It DOES live in the encrypted `vault.prefs` blob, which is pushed and
   * pulled like every other prefs field; device-local is a MERGE classification
   * (`PrefClass::DeviceLocal`, sync-protocol.md 10.2), meaning the local value
   * survives the merge, and 10.2.1 has a newly enrolled device adopt it as a
   * starting default.
   *
   * **Device-local**, deliberately unlike its two siblings above. The right zone
   * is a property of where a given device IS, so a phone that travels and a
   * computer that does not should not have to agree, and the merge is what
   * enforces that: the local value always survives. So this is the one of the
   * three that a computer's choice never overwrites on a phone, and therefore
   * the one a phone most needs its own control for. Canonical key slot: after `time_format`, before
   * `transcription_enabled`.
   */
  timezone: string | null;
  /**
   * Per-folder custom sidebar icon (MYND-185) — a map from a canonical
   * trailing-slash folder path to an icon name (the client's curated stroke-glyph
   * set), replacing that folder's default glyph. Absent in vaults with no custom
   * folder icon → the Rust decoder defaults it to `{}`. Folders only. Serialized
   * from Rust `BTreeMap<String, String>`.
   */
  folder_icons: Record<string, string>;
  /**
   * Per-device friendly names (MYND-459 / SYNC-41) — a map from a 16-byte
   * `device_id` (hex) to a user-chosen display name, carried inside the AEAD'd
   * synced `MYP1` prefs so every client resolves the same name. Absent in vaults
   * with no named device → the Rust decoder defaults it to `{}` (the additive
   * field shifts no bytes for name-less vaults). The single home for device
   * friendly-names — no client ships a second default-name heuristic beyond the
   * `device_id`-prefix fallback used until a device is explicitly named.
   * Serialized from Rust `BTreeMap<String, String>`.
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
  /**
   * Editor format-bar display order (MYND-555 on mobile; MYND-336 on desktop) —
   * the format-action ids in the order the user arranged them. A sequence: the
   * backend preserves element order verbatim. Empty (the default — canonical
   * order) is byte-identical to a pre-feature vault. Absent → `[]`.
   *
   * **Device-local** in the sync merge policy (`sync-protocol.md` §10.2.1, "local
   * wins — screen-size-dependent UI layout"): a phone's above-keyboard bar and a
   * desktop's floating toolbar are the same preference on incomparable form
   * factors, so this never propagates between clients. Each client resolves the
   * stored ids against its OWN vocabulary and drops the rest
   * (`lib/formatBarItems.ts`), which is what makes a backup restore across
   * clients harmless.
   */
  editor_toolbar_order: string[];
  /**
   * Editor format-action ids the user hid (MYND-555). The backend canonicalizes
   * it (sorted + deduped); empty is the default (every action shown). Same
   * device-local classification and same drop-unknown-ids discipline as
   * {@link PrefsView.editor_toolbar_order}.
   */
  editor_toolbar_hidden: string[];
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
   * fallback. Drawn from the curated folder-icon glyph set (`FOLDER_ICON_NAMES`
   * in `@myne/decorations/folderIcons`, shared with desktop so an assigned name
   * resolves to the same glyph on both clients); an unknown name is ignored at
   * render, NOT normalized away on read — the field is `Shared(ScalarLww)`, so
   * rewriting an unrecognized value would clobber a newer client's choice on the
   * next merge. Twin of {@link PrefsView.label}: lives encrypted-only inside
   * `vault.prefs` (SYNC-3), decrypted into a per-session RAM cache on unlock.
   * Absent in vaults with no icon → the Rust decoder defaults it to `null`.
   * Serialized from Rust `Option<String>` (null | string).
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
   * The graph colour-group rules (myne-md/myne#727). Serialized from Rust
   * `Vec<ColorGroup>`; empty (the default) is byte-identical to a pre-feature
   * `vault.prefs`. Evaluated by the SHARED `resolveGraphColorGroups`, so both
   * clients agree about precedence and about an unsupported filter leaf.
   */
  color_groups: ColorGroup[];
  /**
   * Saved-view display order (MYND-273) — view ids in views-list / sidebar order
   * (SYNC-10). A sequence: the backend preserves element order verbatim (not
   * sorted/deduped; stale ids are the caller's to prune). Absent → `[]`.
   */
  view_order: string[];
  /** This DEVICE's approval of saved views (view-manifests): `{view id: approved
   *  version}`, device-local per `sync-protocol.md` §10.2. A view is approved when
   *  the value equals its `version`. Declared for the same reason as the two
   *  `SavedView` fields above: this client has no approval UI yet, and a field the
   *  type does not name reads as absent to the next author. Absent → `{}`. */
  view_approvals: Record<string, number>;
}

/** Read vault.prefs from the unlocked vault; defaults to safer state. */
export async function prefsRead(): Promise<PrefsView> {
  return await invoke<PrefsView>("plugin:prefs|prefs_read");
}

/**
 * The one path a `vault.prefs` WRITE takes: invoke, then bump the prefs nonce.
 * The twin of `src/lib/prefs.ts`'s chokepoint, and it exists for the same reason
 * (#251, ported to mobile by myne-md/myne#486).
 *
 * The bump is the ONLY mechanism by which sibling `usePrefs` instances re-read
 * (`./use-prefs.ts`), and mobile has four independent mount sites (`EditorFlow`,
 * `SettingsSheet`, `AttachmentsSheet`, `SyncSettingsPanels`), so a skipped bump
 * is a stale open editor rather than a latent defect. Why the rule exists, and
 * what the 29-scattered-call-sites shape it replaced cost, is in
 * `scripts/check-prefs-nonce.mjs`'s header, which now covers this module too.
 *
 * Bumps on SUCCESS only: a rejected `invoke` throws before the bump, so nothing
 * claims disk truth changed when it did not, and no re-read races a write that
 * is still in flight (`./prefsNonce.ts` states that ordering as its rule).
 * `mobile/tests/prefs-nonce.test.ts` holds this half specifically, because the
 * guard reads call shapes and would stay green with the bump hoisted above the
 * `invoke`. A few `EditorFlow` writers keep their own `.catch(ignorePrefsWriteFailure)`;
 * that catch is there to stop an unhandled rejection on a `void`-ed call, and
 * its own comment records why the bump inside it buys nothing.
 *
 * Skipping the bump stays possible via `{ bump: false }`, which costs an explicit
 * argument carrying its reason: a visible choice in review rather than an
 * invisible omission.
 */
async function writePref<T = void>(
  command: string,
  args: Record<string, unknown>,
  opts: { bump?: boolean } = {},
): Promise<T> {
  // Generic since myne-md/myne#613: the five set-union mutators return how many
  // additions the reserved byte budget refused, which is what makes a refusal
  // reportable instead of silent. Every other write ignores the result and gets
  // the `void` default. Twin: `src/lib/prefs.ts`.
  const out = await invoke<T>(command, args);
  if (opts.bump !== false) bumpPrefsNonce();
  return out;
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
export async function setScreenCaptureProtection(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_screen_capture_protection", { enabled });
}

/**
 * Persist the `attachment_compression_enabled` toggle (ingest-image-compression)
 * — whether a newly imported image attachment is downscaled + re-encoded before
 * it is encrypted and stored. This preference is **shared** (vault-wide): the
 * backend classifies it in the sync merge, so toggling it here also applies to
 * every other device on the vault, not just this phone. No native side-effect;
 * a rejected promise means the disk write failed and the caller's optimistic UI
 * must revert.
 */
export async function setAttachmentCompressionEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_attachment_compression_enabled", { enabled });
}

/**
 * Set whether THIS DEVICE shows task reminders (MYND-618/619).
 *
 * Device-local: it never syncs, because whether a given phone should be
 * interrupted is a property of that phone rather than of the vault. The field,
 * codec and core setter are the desktop feature's — mobile consumes them.
 */
export async function setRemindersEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_reminders_enabled", { enabled });
}

/**
 * Toggle on-device voice-to-text availability (MYND-563/592; opt-out, default
 * on). A rejected promise means the vault.prefs disk write failed, so an
 * optimistic UI must revert. The backend re-reads this before any decrypt, so
 * the toggle gates the feature, never bypasses the gate.
 */
export async function setTranscriptionEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_transcription_enabled", { enabled });
}

/**
 * Set how many days ahead this device registers reminders with the OS, or
 * `null` to fall back to the built-in horizon (MYND-618/619).
 *
 * **No mobile build hands a reminder to an operating system yet** (myne#508):
 * `reminderPass.ts` has no production caller, which `remindersReachTheOs()` in
 * `./reminders.ts` states and the settings screen gates its OS claims on. The
 * sentence below is therefore the reading this preference takes on from the
 * change that gives that pass a caller, not a description of today. The value
 * is written and persisted regardless, device-locally.
 *
 * Shorter is more private, not merely cheaper: pending reminder times leave the
 * AEAD envelope and sit in OS-owned plaintext (`threat-model.md` §7).
 */
export async function setReminderHorizonDays(days: number | null): Promise<void> {
  await writePref("plugin:prefs|set_reminder_horizon_days", { days });
}

/**
 * What a caller did to a `vault.prefs` set field: entries it added, entries it
 * removed (myne-md/myne#613).
 *
 * There is deliberately no "make the set equal this list" form. The backend used
 * to receive a whole set and derive the removals by diffing it against the
 * stored one, so a caller holding a view that predated a peer's addition claimed
 * a deletion it never made, and the merge then applied it on every device.
 */
export interface SetMutation {
  /** Entries to add. Already present is a no-op, not an error. */
  add?: string[];
  /** Entries to remove, matched by the field's own identity. */
  remove?: string[];
  /**
   * Subtrees to remove: every STORED entry at or under one of these folded
   * prefixes, whether or not this caller has ever seen it.
   *
   * `remove` cannot express a folder deletion honestly, because the caller's
   * list is the `usePrefs` cache: it starts at `DEFAULT_PREFS` and catches up
   * only through a nonce-bump round trip, and myne#613 gave this tree
   * fire-and-forget at-fill registrations that write behind it. A delete inside
   * that window states no removal for the just-registered entry, which then
   * survives on disk carrying a newer add clock than the removal, so the folder
   * comes back empty on every device.
   *
   * An entry that folds to the empty string is ignored by the core rather than
   * treated as the root. Pass nothing for a no-op, never a sentinel.
   */
  /**
   * Entries to add ONLY where no removal of them is on record: absent from the
   * stored set AND carrying a removal clock.
   *
   * For a REPAIR rather than a user act. The unlock back-fill registers folders
   * that LIVE notes prove exist, and that is a state a peer's deletion has not
   * reached yet, because notes and prefs travel separately. With a plain `add`
   * the repair is stamped `now_ms`, beats the peer's removal clock, and puts the
   * folder back on every device permanently with nobody having asked for it.
   *
   * A genuine user act still wins, because at-fill uses `add`.
   */
  addUnlessRemoved?: string[];
  removePrefix?: string[];
  /**
   * Subtrees to re-root: every STORED entry at or under `from` is rewritten with
   * `to` in place of that prefix. One verb, so a rename cannot half-apply under
   * the byte budget and become a synchronised delete.
   */
  renamePrefix?: { from: string; to: string }[];
}

/**
 * The mutation a caller performed, derived from ITS OWN before and after.
 *
 * The distinction from the defect is the two sides: both are the caller's own
 * values, so an entry the caller never saw is in neither and is never claimed.
 * Kept byte-identical to `src/lib/prefs.ts::mutationFrom`; the two trees keep
 * separate prefs modules because each has its own `writePref` chokepoint.
 */
export function mutationFrom(
  before: readonly string[],
  after: readonly string[],
): SetMutation {
  const had = new Set(before);
  const has = new Set(after);
  return {
    add: after.filter((e) => !had.has(e)),
    remove: before.filter((e) => !has.has(e)),
  };
}

/**
 * Persist the full deliberate_folders set (the carrier for empty /
 * deliberately-created folders, MYND-144). The caller passes the entire
 * desired set; v0.1 single-device writes it verbatim. Folded-identity dedup
 * (case-insensitivity) is the caller's responsibility — the Rust codec only
 * sorts + exact-dedups for canonical byte-stability. No native side-effect; a
 * rejected promise means the disk write failed and the caller's optimistic UI
 * must revert.
 */
export async function mutateDeliberateFolders(
  mutation: SetMutation,
): Promise<number> {
  return await writePref<number>("plugin:prefs|set_deliberate_folders", { mutation });
}

/**
 * What a deliberate-folders registration ended up doing (myne-md/myne#613).
 *
 * Three outcomes rather than a boolean, because the two failures need opposite
 * user treatment and collapsing them produces a notice that is wrong for one of
 * them. `budget-full` is actionable (delete a folder) and permanent until the
 * user acts; `failed` is not actionable and is usually transient.
 */
export type DeliberateWriteOutcome = "ok" | "budget-full" | "failed";

/** How long to wait before the single retry below. */
const DELIBERATE_RETRY_MS = 300;

/**
 * Register folders, retrying ONCE on a transient failure, and classify the
 * result for a surface that shows a notice.
 *
 * The split is on whether the user can do anything:
 *
 *   - A thrown write is retried after {@link DELIBERATE_RETRY_MS}, because there
 *     is nothing for the user to do about a disk hiccup and a notice they
 *     cannot act on trains them to dismiss notices. Only a SECOND failure is
 *     reported.
 *   - A budget refusal is reported immediately and is NOT retried: the reserve
 *     is full, the next attempt refuses identically, and the remedy (delete a
 *     folder) is the user's.
 *
 * One retry, not a backoff loop. The caller is a click, the surface is already
 * showing the folder optimistically, and a second failure 300 ms later is
 * evidence enough that this is not a hiccup. A longer schedule would leave a
 * folder on screen for seconds that is not going to land.
 */
export async function registerDeliberateFolders(
  mutation: SetMutation,
): Promise<DeliberateWriteOutcome> {
  try {
    return (await mutateDeliberateFolders(mutation)) > 0 ? "budget-full" : "ok";
  } catch {
    // Transient, probably. Give it one more go before saying anything.
  }
  await new Promise((r) => setTimeout(r, DELIBERATE_RETRY_MS));
  try {
    return (await mutateDeliberateFolders(mutation)) > 0 ? "budget-full" : "ok";
  } catch {
    return "failed";
  }
}

/**
 * Persist the full archived_folders set (folder-archive, MYND-470). The caller
 * passes the entire desired set — restoring a folder means calling this with the
 * folder (and its nested archived descendants) removed. The Rust codec sorts +
 * exact-dedups for canonical byte-stability; folded-identity dedup is the
 * caller's responsibility. No native side-effect; a rejected promise means the
 * disk write failed and the caller's optimistic UI must revert.
 */
export async function mutateArchivedFolders(
  mutation: SetMutation,
): Promise<number> {
  return await writePref<number>("plugin:prefs|set_archived_folders", { mutation });
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
 * Persist the full item_order MAP — the unified manual sidebar order, keyed by
 * container (`""` = tree root, else a folded folder key; MYND-183 + MYND-596).
 * The caller passes the entire desired map; the backend preserves each
 * container's sequence verbatim (the order IS the payload, unlike the
 * sorted+deduped `deliberate_folders`) and merges per-container on sync. No
 * native side-effect; a rejected promise means the disk write failed and the
 * caller's optimistic UI must revert. The IPC payload key (`order`) matches the
 * Rust command's `order: BTreeMap<String, Vec<String>>` parameter.
 */
export async function setItemOrder(order: Record<string, string[]>): Promise<void> {
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
 * Persist the full editor format-bar display order (MYND-555) — the format-action
 * ids in the order the user arranged them. The caller passes the entire desired
 * order; the backend preserves element order verbatim (the sequence IS the
 * payload, unlike the sorted+deduped `editor_toolbar_hidden`). No native
 * side-effect; a rejected promise means the disk write failed and the caller's
 * optimistic UI must revert. The IPC payload key (`order`) matches the Rust
 * command's `order: Vec<String>` parameter.
 *
 * The command body is the SHARED `myne-core` prefs core desktop uses — mobile
 * only registers it. Device-local field: see {@link PrefsView.editor_toolbar_order}.
 */
export async function setEditorToolbarOrder(order: string[]): Promise<void> {
  await writePref("plugin:prefs|set_editor_toolbar_order", { order });
}

/**
 * Persist the full hidden-format-action set (MYND-555). The backend
 * canonicalizes it (sorted + deduped); an empty array is the default (every
 * action shown). No native side-effect; a rejected promise means the disk write
 * failed and the caller's optimistic UI must revert. The IPC payload key
 * (`items`) matches the Rust command's `items: Vec<String>` parameter.
 */
export async function setEditorToolbarHidden(items: string[]): Promise<void> {
  await writePref("plugin:prefs|set_editor_toolbar_hidden", { items });
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
 * Set (or clear) the display date format (myne#279). Pass
 * `"system"`/`"iso"`/`"dmy"`/`"mdy"`/`"dmmmy"`, or `null` to clear to
 * `"system"`. Shared: the choice syncs to every device on this vault.
 */
export async function setDateFormat(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_date_format", { value });
}

/**
 * Set (or clear) the display time format (myne#279). Pass
 * `"system"`/`"24h"`/`"12h"`, or `null` to clear to `"system"`. Shared, like
 * {@link setDateFormat}.
 */
export async function setTimeFormat(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_time_format", { value });
}

/**
 * Set (or clear) the DISPLAY timezone override (myne#279). Pass an IANA zone
 * identifier, or `null` to follow this device's own zone.
 *
 * Display only: it never reaches a note. Device-local in the merge sense, so
 * unlike the two above a computer's choice never overwrites it here, which is
 * why a phone needs this control of its own. The value itself still rides the
 * encrypted prefs blob like every other field.
 */
export async function setTimezone(value: string | null): Promise<void> {
  await writePref("plugin:prefs|set_timezone", { value });
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
 * Persist the full colour-group rule list (graph-connection-ux-polish, reached
 * mobile in myne-md/myne#880), a **WHOLE-LIST replace**, not a per-group
 * upsert/delete.
 *
 * Order is rule precedence (first match wins), so unlike {@link setViewOrder}
 * there is no separate order field to reconcile: the caller passes the complete
 * desired sequence and the backend preserves it verbatim. A per-group merge
 * would be wrong in both directions: it could not express a reorder, and a
 * concurrent desktop edit to a different group would be silently lost rather
 * than last-writer-wins.
 *
 * Disk-first, no native side-effect; the 64 KiB `vault.prefs` cap fails the
 * write BEFORE touching disk, leaving the prior rules intact. A rejected promise
 * means the write failed and the caller's optimistic UI must revert.
 *
 * Twin of `src/lib/prefs.ts::setColorGroups`.
 */
export async function setColorGroups(groups: ColorGroup[]): Promise<void> {
  await writePref("plugin:prefs|set_color_groups", { groups });
}

/**
 * Add to and remove from the `ai_excluded_folders` set (local-ai epic,
 * ai-ux-surface MYND-408, SYNC-14): the folders AI never reads or indexes.
 * Reached mobile in myne-md/myne#880.
 *
 * **Takes VERBS, not the whole set**, and that is a correctness requirement
 * rather than a style: the sync stamper derives removals from `before \ after`,
 * so a caller holding a stale view would claim a deletion it never made and
 * travel it to every device. The wrapper took the whole desired set until
 * myne-md/myne#613; `mutationFrom` below is how a caller derives the verbs from
 * its OWN before and after, so an entry it never saw is claimed by neither.
 *
 * Returns how many additions the reserved byte budget refused, which is what
 * makes a refusal reportable instead of silent.
 *
 * §10.2 classifies this field `SetUnion { folded: true, removals_propagate:
 * false }`, deliberately unlike its neighbours: it is an EGRESS CONTROL, so its
 * union is monotone and a removal is never inherited from a peer. A client
 * cannot change that from here, and must not try.
 *
 * Twin of `src/lib/prefs.ts::mutateAiExcludedFolders`.
 */
export async function mutateAiExcludedFolders(mutation: SetMutation): Promise<number> {
  return await writePref<number>("plugin:prefs|set_ai_excluded_folders", { mutation });
}

/**
 * Characters of chat history an agent run may be seeded with (myne-md/myne#617),
 * or `null` to restore the host's default. Reached mobile in
 * myne-md/myne#880.
 *
 * **DEVICE-LOCAL**, unlike its neighbours in the AI cluster: it bounds how much
 * of this machine's plaintext one run sends to a provider, multiplied by the
 * loop's iteration ceiling, so a laptop on a metered connection and a desktop on
 * a fast one legitimately disagree. A value that synced would let one device
 * widen another's off-device volume without anyone at that device choosing it.
 *
 * **The value is CLAMPED host-side, and this wrapper deliberately does not clamp
 * it.** The bound is what limits the plaintext a run can send, so it has to hold
 * for every path that reaches the command rather than for the one that happened
 * to render a control. A second clamp here would read as the control and hide
 * the day the real one stopped working. The row renders `max` from the SHARED
 * {@link CHAT_HISTORY_BUDGET_MAX}, which `tests/lib/chatHistoryBudget.test.ts`
 * holds to the Rust clamp, so the two cannot drift silently.
 *
 * Twin of `src/lib/prefs.ts::setChatHistoryBudget`.
 */
export async function setChatHistoryBudget(budget: number | null): Promise<void> {
  await writePref("plugin:prefs|set_chat_history_budget", { budget });
}

/**
 * Whether attachment text extraction may read images and scanned PDFs (image
 * OCR, MYND-441). Reached mobile in myne-md/myne#880, and the remedy here is a
 * control rather than a feature: OCR already RUNS in-process on this device
 * (`mobile/src-tauri/src/plugins/attachments/import_mobile.rs` injects the shared
 * `extract_image_only` into the import path), so the device paying the compute
 * cost had no way to turn it off.
 *
 * **DEVICE-LOCAL** (`sync-protocol.md` §10.2): per-device compute budget, so a
 * desktop toggle cannot reach a phone. **Defaults to `true`**, and turning it off
 * stops the extraction worker but never deletes cached results.
 *
 * An unreadable prefs blob reads as ON in the import path, matching desktop: a
 * prefs read failure must not silently disable a search feature.
 *
 * Twin of `src/lib/prefs.ts::setAttachmentOcrEnabled`.
 */
export async function setAttachmentOcrEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_attachment_ocr_enabled", { enabled });
}

/**
 * Replace the meeting AI prompt, or pass `null` to restore the built-in default
 * (meeting-ai). Reached mobile in myne-md/myne#880, which matters more here than
 * elsewhere: the phone is where meeting capture actually happens, so the device
 * that records the meeting could not author the instruction that processes it.
 *
 * An all-whitespace value is treated as a clear host-side, and a value longer
 * than 4000 bytes is refused. **SHARED / scalar last-write-wins**, so it reaches
 * the account's other devices; the value is user text stored in the encrypted
 * `vault.prefs`.
 *
 * Twin of `src/lib/prefs.ts::setMeetingAiPrompt`.
 */
export async function setMeetingAiPrompt(prompt: string | null): Promise<void> {
  await writePref("plugin:prefs|set_meeting_ai_prompt", { prompt });
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

/** The three things one period configures (myne#177). Twin of the desktop
 *  `PeriodSetting`, and the backend refuses a setting outside the three. */
export type PeriodSetting = "folder" | "format" | "template";

/**
 * Set (or clear) one weekly/monthly periodic-note setting (myne#177).
 *
 * The `periodic_notes` map is keyed `<period>.<setting>`, flat so the Phase 2
 * field clock is per SETTING: a folder edit on one device and a template edit on
 * another, to the same period in the same round, both survive. Pass
 * `value = null` to clear the entry; the backend removes the key, which the
 * merge represents as a stamped absence rather than as "never had it".
 *
 * A `folder` value is also registered as a deliberate folder backend-side, so
 * the folder shows in the sidebar before its first note exists.
 *
 * **Landed with the panel, which is the order the `periodic_notes` field
 * comment asked for.** That comment said the write half was deliberately absent
 * because mobile shipped no periodic-notes settings panel, and that a grant for
 * a command the WebView never sends would widen the reachable surface for
 * nothing. The panel landed in `mobile/src/components/PeriodicNotesBlock.tsx`
 * (myne-md/myne#880), so the wrapper, the ACL row and the surface arrive
 * together.
 *
 * Twin of `src/lib/prefs.ts::setPeriodicNoteSetting`.
 */
export async function setPeriodicNoteSetting(
  period: string,
  setting: PeriodSetting,
  value: string | null,
): Promise<void> {
  await writePref("plugin:prefs|set_periodic_note_setting", { period, setting, value });
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
 * device list leads with. A single entry, not the whole map: entries are written
 * by different devices and merged per key, so a whole-map write would let this
 * client's stale view clobber a peer's rename.
 *
 * There is deliberately **no clear/delete counterpart**. `device_names` merges
 * per key by UNION (`sync-protocol.md` §10.2), so removing a key does not
 * propagate — it resurrects from the first peer that still holds it. The backend
 * refuses a blank name, so an empty submit is a no-op the caller treats as
 * "cancel".
 */
export async function setDeviceName(deviceIdHex: string, name: string): Promise<void> {
  await writePref("plugin:prefs|set_device_name", { deviceIdHex, name });
}

/**
 * The running device's platform token (MYND-548) — `"ios"`, `"android"`, …,
 * straight from Rust's `std::env::consts::OS`. Seeds the enrollment forms'
 * suggested device name. **Do not sniff `navigator` instead** — one source keeps
 * the two clients from drifting into two default-name heuristics.
 *
 * Memoised, because the answer is a compile-time constant of the running binary
 * and this is an IPC round trip. Four callers ask it now (the enrollment form,
 * the clipboard-tier predicate, the device-name default, and the secret-save
 * delivery), and two of those are on paths where the user is waiting.
 *
 * Only a SUCCESS is cached. A rejected promise held here would turn one
 * transient IPC failure into a permanently wrong answer for the process, and
 * two of the callers read this to decide what a secret-handling affordance may
 * claim.
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
 * Set (or clear) the active vault's human-readable label (MYND-205) — the name
 * the in-app vault switcher shows. Pass a string to set/rename it, or `null` to
 * clear it back to the neutral-fallback state. **Unlock-gated**: writing the
 * label needs the active vault's `prefs_key`, so you can only rename the vault
 * you currently have unlocked (a rejected promise with `SlotNotUnlocked` means
 * no vault was unlocked). The backend atomic-writes `vault.prefs` disk-first
 * with no native side-effect, then refreshes the per-session RAM label cache so
 * the switcher reflects the rename immediately. The label lives encrypted-only
 * at rest — it never touches disk in plaintext except as this input.
 */
export async function setVaultLabel(label: string | null): Promise<void> {
  await writePref("plugin:prefs|vault_set_label", { label });
}

/**
 * Set (or clear) the active vault's decorative icon (vault-icons) — the curated
 * glyph the in-app vault switcher shows beside the vault name. Pass a
 * `FOLDER_ICON_NAMES` member to set it, or `null` to clear it back to the
 * neutral `M` wordmark. The exact twin of {@link setVaultLabel}: **unlock-gated**
 * (the write needs the active vault's `prefs_key`), backend atomic-writes
 * `vault.prefs` disk-first with no native side-effect, then refreshes the
 * per-session RAM icon cache so `vault_list` reflects the change immediately.
 * Like every other mobile prefs setter it bumps the prefs nonce through
 * {@link writePref}, so every mounted `usePrefs` re-reads.
 */
export async function setVaultIcon(icon: string | null): Promise<void> {
  await writePref("plugin:prefs|vault_set_icon", { icon });
}

/**
 * Tauri event the sync loop emits after merging a REMOTE `vault.prefs` change
 * onto disk (MYND-478; `PREFS_CHANGED_EVENT` in `core`). Never fired for this
 * device's own IPC writes (their own resolve is the signal). Contentless — the
 * listener re-reads. `EditorFlow` bridges it into `bumpPrefsNonce()` so an
 * incoming vault rename / shared-pref change shows live in the header and
 * settings; the switcher list re-fetches on its next open.
 */
export const PREFS_SYNC_APPLIED_EVENT = "myne://prefs-changed";

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
export async function mutateSpellLanguages(
  mutation: SetMutation,
): Promise<number> {
  return await writePref<number>("plugin:prefs|set_spell_languages", { mutation });
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

/* ---- AI (myne-md/myne#456) -------------------------------------------------
 *
 * Five writes and one read. The read is the odd one and it is the interesting
 * one: the key must never cross into page context, so there is no getter for it
 * anywhere and the UI decides between "Add key" and "Replace key" from a
 * boolean.
 */

/**
 * Turn the AI beta on or off for THIS device.
 *
 * Device-local, so switching it off here does not switch it off on a laptop
 * that shares the vault. Since myne-md/myne#456 removed `developer_mode` from
 * the request-time gate, this is the only device-local switch on the remote
 * path besides the consent below.
 */
export async function setAiEnabled(enabled: boolean): Promise<void> {
  await writePref("plugin:prefs|set_ai_enabled", { enabled });
}

/**
 * Name the remote provider, or pass `null` to clear it.
 *
 * Clearing also clears the consent and the key HOST-SIDE, and that pairing is
 * why this is one call rather than three: a key for a provider nobody selected
 * is a credential with no owner, and a surviving consent would silently
 * pre-approve the next provider the user picks.
 *
 * A value outside the host's known set is refused rather than stored, so the
 * promise rejects instead of leaving a selection the request path ignores.
 */
export async function setAiProvider(provider: string | null): Promise<void> {
  await writePref("plugin:prefs|set_ai_provider", { provider });
}

/**
 * Record (or withdraw) the consent for the named provider.
 *
 * **This is the persistence, not the enforcement.** The host re-reads it before
 * every remote request, so calling it without having shown the screen buys a
 * stored value and nothing else. The screen is what the user consented to; this
 * is only where that fact is kept.
 */
export async function setAiProviderConsent(
  grantedFor: string | null,
): Promise<void> {
  await writePref("plugin:prefs|set_ai_provider_consent", { grantedFor });
}

/**
 * Store the provider API key, or pass `null` to **revoke** it.
 *
 * One-way by design: the value goes in and never comes back out. There is no
 * command that returns it and {@link PrefsView} carries no field for it.
 *
 * Revocation propagates to the account's other devices as an LWW write of
 * `null`, which is what makes "revoke" mean more than "revoke here": and it is
 * why the key stays shared while the consent does not.
 */
export async function setAiProviderKey(key: string | null): Promise<void> {
  await writePref("plugin:prefs|set_ai_provider_key", { key });
}

/**
 * Choose which of the provider's models answers, or `null` to clear it.
 *
 * The candidate list comes from the provider itself, never from a constant in
 * this tree: a pinned model tag rots faster than the release that pinned it.
 */
export async function setAiProviderModel(model: string | null): Promise<void> {
  await writePref("plugin:prefs|set_ai_provider_model", { model });
}

/**
 * Whether a provider key is stored, without ever handing the key over.
 *
 * A boolean rather than the value, for the reason {@link PrefsView}'s comment
 * gives: the key is serde-skipped host-side precisely so it cannot reach page
 * context, and a getter here would be the door that reopens.
 *
 * Not a `writePref`, so no prefs-nonce bump: this reads.
 */
export async function aiProviderHasKey(): Promise<boolean> {
  return await invoke<boolean>("plugin:prefs|ai_provider_has_key");
}
