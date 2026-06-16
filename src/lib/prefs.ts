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

import { invoke } from "@tauri-apps/api/core";
import { bumpPrefsNonce } from "../notes/prefsNonce";

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
   * Deliberately-created folder paths (canonical trailing-slash form) that
   * persist independently of whether any note carries them — the carrier for
   * empty folders in the virtual-folder model (MYND-144). Absent in pre-MYND-144
   * vaults → the Rust decoder defaults it to `[]`.
   */
  deliberate_folders: string[];
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
   * Favorited notes — an ordered list of note UUIDs surfaced in the sidebar's
   * Favorites section, in display order (MYND-183). A sequence: the backend
   * preserves element order verbatim. UUIDs only (folders are not favoritable).
   * Absent in vaults with no favorites → the Rust decoder defaults it to `[]`.
   */
  favorites: string[];
  /**
   * Unified manual sidebar order across the single interleaved file-tree
   * (MYND-183, superseding `note_order` + `folder_order`) — a flat,
   * heterogeneous list of note UUIDs and canonical trailing-slash folder paths
   * (discriminated by the trailing `/`). Each container sorts its own children
   * (sub-folders + notes, freely interleaved) by their index here; unlisted
   * children fall back to recency / folded name. Order is the payload — the
   * backend preserves it verbatim. Absent in pre-reorder vaults → defaults to
   * `[]`.
   */
  item_order: string[];
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
export async function setScreenCaptureProtection(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:prefs|set_screen_capture_protection", { enabled });
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
export async function setDeliberateFolders(folders: string[]): Promise<void> {
  await invoke<void>("plugin:prefs|set_deliberate_folders", { folders });
}

/**
 * Set the auto-lock-on-idle timeout (integer seconds, MYND-121). The backend
 * writes vault.prefs disk-first, then refreshes the idle timer's cached
 * effective timeout (clamped through the protective envelope). A rejected
 * promise means the disk write failed — the caller's optimistic UI must revert
 * (re-read disk truth, as the screen-capture toggle does).
 */
export async function setAutoLockTimeout(seconds: number): Promise<void> {
  await invoke<void>("plugin:prefs|set_auto_lock_timeout", { seconds });
}

/**
 * Persist the full item_order sequence — the unified manual sidebar order
 * across the interleaved file-tree (a heterogeneous list of note UUIDs +
 * canonical folder paths, MYND-183, superseding `setNoteOrder`/`setFolderOrder`).
 * The caller passes the entire desired order; v0.1 single-device writes it
 * verbatim (the backend preserves element order — the sequence IS the payload,
 * unlike the sorted+deduped `deliberate_folders`). No native side-effect; a
 * rejected promise means the disk write failed and the caller's optimistic UI
 * must revert.
 */
export async function setItemOrder(order: string[]): Promise<void> {
  await invoke<void>("plugin:prefs|set_item_order", { order });
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
  await invoke<void>("plugin:prefs|set_hidden_bar_items", { items });
}

/**
 * Persist the full favorites sequence — the user's favorited notes (note UUIDs)
 * in display order, shown in the sidebar's Favorites section. Same order-
 * preserving, no-native-side-effect contract as {@link setItemOrder}. A rejected
 * promise means the disk write failed and the caller's optimistic UI must revert.
 */
export async function setFavorites(favorites: string[]): Promise<void> {
  await invoke<void>("plugin:prefs|set_favorites", { order: favorites });
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
  await invoke<void>("plugin:prefs|set_editor_layout", { layout });
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
  await invoke<void>("plugin:prefs|set_theme", { theme });
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
  await invoke<void>("plugin:prefs|set_custom_theme", { customTheme });
}

/**
 * Set the daily-notes date-format string (MYND-191), e.g. `YYYY-MM-DD`. The
 * backend atomic-writes vault.prefs disk-first with no native side-effect; a
 * rejected promise means the disk write failed. Non-load-bearing.
 */
export async function setDailyDateFormat(format: string): Promise<void> {
  await invoke<void>("plugin:prefs|set_daily_date_format", { format });
}

/**
 * Set the daily-notes folder path (MYND-191), canonical trailing-slash form
 * (e.g. `Daily/`). Designating it also registers the folder in
 * `deliberate_folders` so it survives empty. Disk-first, no native side-effect.
 */
export async function setDailyFolder(folder: string): Promise<void> {
  await invoke<void>("plugin:prefs|set_daily_folder", { folder });
}

/**
 * Set (or clear) the daily-notes template pointer (MYND-191). Pass a template
 * UUID to designate it, or `null` to clear it back to the "blank daily note"
 * state. Disk-first, no native side-effect; a rejected promise means the write
 * failed.
 */
export async function setDailyTemplate(templateId: string | null): Promise<void> {
  await invoke<void>("plugin:prefs|set_daily_template", { templateId });
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
  await invoke<void>("plugin:prefs|set_item_colors", { colors });
}

/**
 * Persist the full folder_icons map (MYND-185) — per-folder custom icons keyed
 * by canonical trailing-slash folder path. The caller passes the entire desired
 * map; resetting a folder to its default glyph = omit its key. Same
 * order-irrelevant, no-native-side-effect contract as {@link setItemColors}.
 */
export async function setFolderIcons(icons: Record<string, string>): Promise<void> {
  await invoke<void>("plugin:prefs|set_folder_icons", { icons });
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
  await invoke<void>("plugin:prefs|vault_set_label", { label });
}

/**
 * Set the spell-check enabled toggle (MYND-267). Persists an explicit choice;
 * the default-ON policy (SYNC-15) is applied host-side at read time when the
 * field is unset. Disk-first, no native side-effect; a rejected promise means
 * the write failed and the caller's optimistic UI must revert. Non-load-bearing.
 */
export async function setSpellEnabled(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:prefs|set_spell_enabled", { enabled });
}

/**
 * Set the active spell-check language set (MYND-267 / SYNC-11 union). The caller
 * passes the full desired set of BCP-47 tags; the backend NFC-sorts + dedupes
 * for canonical byte-stability. An empty array omits the field on disk (host
 * applies the {OS-locale ∪ en-US} default at read time). Disk-first, no native
 * side-effect; a rejected promise means the disk write failed.
 */
export async function setSpellLanguages(languages: string[]): Promise<void> {
  await invoke<void>("plugin:prefs|set_spell_languages", { languages });
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
  await invoke<void>("plugin:prefs|set_keymap_binding", { commandId, chords });
  bumpPrefsNonce();
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
  await invoke<void>("plugin:prefs|set_show_note_timestamps", { enabled });
  bumpPrefsNonce();
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
  await invoke<void>("plugin:prefs|set_editor_text_size", { value });
  bumpPrefsNonce();
}

/**
 * Set (or clear) the editor line-spacing preset (editor-typography) — pass
 * `"tight"`/`"normal"`/`"relaxed"`, or `null` to clear to the `"normal"`
 * default. Same disk-first + nonce-bump contract as {@link setEditorTextSize}.
 */
export async function setEditorLineSpacing(value: string | null): Promise<void> {
  await invoke<void>("plugin:prefs|set_editor_line_spacing", { value });
  bumpPrefsNonce();
}

/**
 * Set (or clear) the editor content-width preset (editor-typography) — pass
 * `"narrow"`/`"normal"`/`"wide"`/`"full"`, or `null` to clear to the
 * `"normal"` default. Same contract as {@link setEditorTextSize}.
 */
export async function setEditorContentWidth(value: string | null): Promise<void> {
  await invoke<void>("plugin:prefs|set_editor_content_width", { value });
  bumpPrefsNonce();
}

/**
 * Set (or clear) the editor font-family preset (editor-typography) — pass
 * `"mono"`/`"sans"`, or `null` to clear to the `"mono"` default. Same contract
 * as {@link setEditorTextSize}.
 */
export async function setEditorFontFamily(value: string | null): Promise<void> {
  await invoke<void>("plugin:prefs|set_editor_font_family", { value });
  bumpPrefsNonce();
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
  await invoke<void>("plugin:prefs|upsert_saved_view", { view });
  // Post-mutation chokepoint: refresh every `usePrefs` consumer (e.g. the
  // sidebar Views section) regardless of which surface saved the view.
  bumpPrefsNonce();
}

/**
 * Delete the saved view with `id` (MYND-273). Removes it from `saved_views` and
 * prunes the id from `view_order`. Deleting an absent id is an idempotent no-op
 * success. Disk-first, no native side-effect.
 */
export async function deleteSavedView(id: string): Promise<void> {
  await invoke<void>("plugin:prefs|delete_saved_view", { id });
  bumpPrefsNonce();
}

/**
 * Persist the full saved-view display order (MYND-273) — view ids in display
 * order, shown in the views list / sidebar Views section. Same order-preserving,
 * no-native-side-effect contract as {@link setItemOrder}; stale-id pruning is the
 * caller's job (no backend GC). A rejected promise means the write failed.
 */
export async function setViewOrder(order: string[]): Promise<void> {
  await invoke<void>("plugin:prefs|set_view_order", { order });
  bumpPrefsNonce();
}
