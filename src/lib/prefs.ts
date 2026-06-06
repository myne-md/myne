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
export type ThemeChoice = "light" | "dark";

/** Mirrors `protocol::PrefsView` (Rust side). */
export interface PrefsView {
  screen_capture_protection: boolean;
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
   * User theme preference (MYND-110). `null` ≡ **system** (follow the OS
   * `prefers-color-scheme`) — the canonical encoding of "no explicit choice",
   * omitted from the encrypted blob. `"light"` / `"dark"` are explicit
   * choices the client applies as `<html data-theme="…">`. Serialized from
   * Rust `Option<ThemeChoice>` (null | "light" | "dark").
   */
  theme: ThemeChoice | null;
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
