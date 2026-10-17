// SPDX-License-Identifier: AGPL-3.0
//! Detached (pop-out) note window spawn command (myne-md/myne#678, epic #173).
//!
//! `detached_window_open` is a MAIN-window command (granted by
//! `detached-window:default` in `capabilities/default.json`) that host-spawns one
//! `WebviewWindow` per note, labelled `note-<id>` (SYNC-1), and records it in the
//! [`DetachedWindowRegistry`] (SYNC-4). The window carries the narrow
//! `detached-note` capability (myne#677, the `note-*` glob); page context has no
//! window-create grant of its own, which is why creation is a host command.
//!
//! The note id is routed by ARGUMENT and injected into the window as an init
//! global; plaintext arrives later via `note_read`, never a key over IPC.
//!
//! Out of scope here (later tasks / siblings): the screen-capture apply in the
//! create->show sequence (myne#680 supplies the window-parameterized `apply_to`,
//! SYNC-5), single-instance routing + move (task 5 / #681), persistence (task 6),
//! lock-teardown wiring (#679).
//!
//! Logging: see `src-tauri/AGENTS.md` "Secret-handling logging discipline": stage
//! tags + closed error kinds; never the note id or a path.

use super::state::DetachedWindowRegistry;
use crate::plugins::attachments::scheme::DETACHED_NOTE_LABEL_PREFIX;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};

/// Broadcast to every window when a detached (pop-out) window is destroyed
/// (user close, or a failed `show()` cleaning itself up). The main window listens
/// so it can drop the note from its detached set and open it as a plain tab next
/// time rather than trying to reveal a window that is gone (SYNC-6 reveal-vs-spawn,
/// myne#681). Carries the note id only, never plaintext.
pub const DETACHED_CLOSED_EVENT: &str = "detached://closed";

/// Broadcast to every window when a note is opened (or revealed) in a detached
/// (pop-out) window. EVERY window listens and records the note as detached, so
/// the SYNC-6 "one note, one surface" reveal-guard holds no matter which window
/// performed the detach: a detach initiated from one pop-out is seen by the main
/// window and the others, so none of them later opens that note as a second live
/// surface (myne#681). The paired `DETACHED_CLOSED_EVENT` reverses it. Note id
/// only, never plaintext.
pub const DETACHED_OPENED_EVENT: &str = "detached://opened";

/// Serialize-able error surfaced to the caller. No secret material.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DetachedWindowError {
    /// The note id was not a plausible id (letters, digits, dashes).
    InvalidNoteId,
    /// The OS refused to create the window.
    WindowCreateFailed,
    /// The window was created but could not be shown.
    WindowShowFailed,
}

/// A detached window's geometry in PHYSICAL coordinates (myne#678 task 6, SYNC-10).
///
/// Physical throughout, deliberately: the snapshot reads the window's physical
/// outer position + size, the frontend clamps them against the monitor list
/// (also physical, `Monitor.position`/`size`), and the spawn applies them back as
/// a physical position + size. Keeping ONE space end to end avoids per-monitor
/// scale-factor conversion, which does not compose into a single logical plane on
/// a mixed-DPI setup. `f64` because it crosses IPC as JSON; the values are whole
/// pixels. Never a secret: window bounds, not content.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One open detached window in a snapshot: the note it holds and where it is.
/// The frontend persists these into the device-local MYW1 workspace blob (SYNC-10)
/// so a relaunch can restore them (clamped onto a connected display).
///
/// `camelCase` so `note_id` reaches the frontend as `noteId`, matching the
/// `DetachedEntry` shape `src/notes/detachedRestore.ts` reads.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachedSnapshotEntry {
    pub note_id: String,
    pub geometry: WindowGeometry,
}

/// The detached window label for a note: `note-<id>` (SYNC-1). Built from the one
/// shared prefix constant so the capability glob, the `attachment://` fence and the
/// teardown enumeration all key off the same string.
pub fn detached_label_for_note(note_id: &str) -> String {
    format!("{DETACHED_NOTE_LABEL_PREFIX}{note_id}")
}

/// The note id carried by a detached window label, or `None` for a non-detached
/// label (`main`, `pdf-export`, ...). Used by [`detached_window_snapshot`] to map
/// each open window back to its note id (SYNC-1).
pub fn note_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix(DETACHED_NOTE_LABEL_PREFIX)
}

/// A note id is safe to place in a window label and an init-script string only if
/// it is letters/digits/dashes (UUIDv7 form). Rejecting anything else keeps the
/// label a clean `note-<id>` and the injected global free of quotes/markup.
fn is_plausible_note_id(note_id: &str) -> bool {
    !note_id.is_empty()
        && note_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Open (or, once task 5 lands, reveal) a detached window holding `note_id`.
///
/// Task 1 scope: validate the id, build the `note-<id>` window (bundled
/// `index.html`, static "Myne" title, the note id injected as an init global,
/// `visible:false` then `show()`), and register it. The window-parameterized
/// screen-capture apply between build and show is myne#680 (SYNC-5); single
/// instance routing is task 5.
#[tauri::command]
pub async fn detached_window_open<R: Runtime>(
    note_id: String,
    geometry: Option<WindowGeometry>,
    app: AppHandle<R>,
    registry: State<'_, DetachedWindowRegistry>,
) -> Result<(), DetachedWindowError> {
    if !is_plausible_note_id(&note_id) {
        tracing::warn!(stage = "detached_open", error_kind = "invalid-note-id");
        return Err(DetachedWindowError::InvalidNoteId);
    }
    let label = detached_label_for_note(&note_id);

    // Single-instance (SYNC-6): a note lives in exactly one surface. If it is
    // already popped out, REVEAL that window instead of spawning a duplicate.
    if registry.label_for_note(&note_id).is_some() {
        if let Some(window) = app.get_webview_window(&label) {
            // myne#680: raise it through the shared protected-raise, not a
            // hand-rolled unminimize/set_focus. A pop-out coming back to focus is
            // a plaintext window whose Windows capture affinity may have reset
            // across the hide/show (tauri#14189), so protection is re-applied on
            // both sides of the show, mirroring the main window's state.
            crate::screen_capture::raise_protected(&app, &window, "detached_window_reveal");
        }
        // Re-announce even on a reveal, so a window that did not perform the
        // original detach (and so never saw the first open) still learns the note
        // is in a pop-out and stops offering it as a plain tab (SYNC-6).
        let _ = app.emit(DETACHED_OPENED_EVENT, &note_id);
        tracing::info!(event = "detached_window_revealed");
        return Ok(());
    }

    // The note id is the only interpolated value and it passed is_plausible_note_id
    // (letters/digits/dashes), so it cannot break out of the string literal.
    let init_script = format!(
        "window.__MYNE_DETACHED__ = true; window.__MYNE_DETACHED_NOTE_ID__ = \"{note_id}\";"
    );

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Myne") // static, never the note title (OS window lists)
        .initialization_script(&init_script)
        .visible(false)
        .build()
        .map_err(|_| {
            tracing::error!(stage = "detached_open", error_kind = "window-create-failed");
            DetachedWindowError::WindowCreateFailed
        })?;

    // Register + arm the close handler BEFORE the first show. A `.visible(false)`
    // window has already booted its WebView, so it can hold note plaintext from
    // the moment it is built; putting it in the registry now means a vault lock
    // firing during setup finds it (`teardown_on_lock` enumerates the registry
    // and then clears it) and a failed `show()` can destroy it without orphaning
    // a registry-invisible plaintext surface the teardown would never reach
    // (myne#679 / A6).
    //
    // myne#681 task 4 (SYNC-11): when this pop-out is CLOSED, drop its registry
    // entry so single-instance routing (SYNC-6) knows the note is free to pop out
    // again and the lock-teardown enumeration does not chase a destroyed label,
    // and broadcast DETACHED_CLOSED_EVENT so the main window reopens the note as a
    // plain tab. Closing the window closes the note entirely (a tab-close, not a
    // return-to-main round-trip): the note already moved off the main window's
    // tabs when it was popped out.
    let close_label = label.clone();
    let close_note_id = note_id.clone();
    let opened_note_id = note_id.clone();
    let close_app = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            if let Some(reg) = close_app.try_state::<DetachedWindowRegistry>() {
                reg.remove(&close_label);
            }
            // Note id only, never plaintext (see: src-tauri/AGENTS.md
            // "Secret-handling logging discipline" for what may cross a channel).
            let _ = close_app.emit(DETACHED_CLOSED_EVENT, &close_note_id);
            tracing::info!(event = "detached_window_closed");
        }
    });
    registry.register(label, note_id);

    // myne#678 task 6 (SYNC-10): restore the saved PHYSICAL geometry before the
    // first show, already clamped onto a connected display by the frontend
    // (`clampDetachedGeometry`). Set while `visible:false` so there is no
    // move/resize flash. Best-effort: a rejected set never fails the spawn (the
    // window still opens at the OS default). Absent on a fresh pop-out.
    if let Some(g) = geometry {
        let _ = window.set_position(tauri::PhysicalPosition::new(g.x as i32, g.y as i32));
        let _ = window.set_size(tauri::PhysicalSize::new(
            g.width.max(0.0) as u32,
            g.height.max(0.0) as u32,
        ));
    }

    // myne#680 (SYNC-5): protect the detached window with the RESOLVED value (the
    // main window's state folded with the device-wide override, via apply_to)
    // BEFORE the first show, so the first painted frame is protected on Windows
    // 19041+, exactly as screen_capture::init does for the main window.
    crate::screen_capture::apply_to(&app, &window, "detached_window_create");

    if window.show().is_err() {
        tracing::error!(stage = "detached_open", error_kind = "window-show-failed");
        // Already registered, so destroy() rather than leak a plaintext-bearing
        // window: Destroyed fires, dropping the registry entry and emitting the
        // closed event, so no orphan escapes the lock teardown.
        let _ = window.destroy();
        return Err(DetachedWindowError::WindowShowFailed);
    }

    // Re-apply after show(): the Windows capture affinity is reported to reset
    // across a show (tauri#14189), so both-sides-of-show is the #483 discipline.
    crate::screen_capture::apply_to(&app, &window, "detached_window_create");

    // Announce the (now shown) pop-out to every window so all of them record the
    // note as detached (SYNC-6 reveal-vs-spawn holds cross-window, not just in the
    // window that detached). Note id only, never plaintext. A failed show above
    // returned early, so this fires only for a window that is really up.
    let _ = app.emit(DETACHED_OPENED_EVENT, &opened_note_id);
    tracing::info!(event = "detached_window_opened");
    Ok(())
}

/// Snapshot the open detached windows' note ids + current geometry (myne#678
/// task 6, SYNC-10).
///
/// The MAIN window calls this from its workspace-staging path and persists the
/// result into the device-local MYW1 `vault.workspace` blob (never synced, no
/// prefs field per decision 0136), so a relaunch can restore the pop-outs, each
/// clamped onto a currently-connected display by the frontend.
///
/// Best-effort per window: one whose geometry cannot be read (mid-teardown, or a
/// backend that reports no position) is skipped rather than failing the whole
/// snapshot. Returns note ids + PHYSICAL geometry (the window's raw
/// `outer_position`/`outer_size`, no scale-factor math, matching `WindowGeometry`
/// and the restore path), never plaintext.
#[tauri::command]
pub async fn detached_window_snapshot<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, DetachedWindowRegistry>,
) -> Result<Vec<DetachedSnapshotEntry>, DetachedWindowError> {
    let mut out = Vec::new();
    for label in registry.all_labels() {
        let Some(note_id) = note_id_from_label(&label) else {
            continue;
        };
        let Some(window) = app.get_webview_window(&label) else {
            continue;
        };
        // Physical outer position + size: the same space the monitor list and
        // the restore spawn use (see `WindowGeometry`). No scale-factor math.
        let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            continue;
        };
        out.push(DetachedSnapshotEntry {
            note_id: note_id.to_string(),
            geometry: WindowGeometry {
                x: f64::from(pos.x),
                y: f64::from(pos.y),
                width: f64::from(size.width),
                height: f64::from(size.height),
            },
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn label_round_trips_through_the_shared_prefix() {
        let id = "0192f0a1-b2c3-d4e5-f607-18293a4b5c6d";
        let label = detached_label_for_note(id);
        assert_eq!(label, format!("note-{id}"));
        assert_eq!(note_id_from_label(&label), Some(id));
    }

    #[test]
    fn non_detached_labels_carry_no_note_id() {
        assert_eq!(note_id_from_label("main"), None);
        assert_eq!(note_id_from_label("pdf-export"), None);
        assert_eq!(note_id_from_label("notemain"), None);
    }

    #[test]
    fn note_id_validation_admits_ids_and_rejects_injection() {
        assert!(is_plausible_note_id("0192f0a1-b2c3-d4e5-f607-18293a4b5c6d"));
        assert!(is_plausible_note_id("abc123"));
        for bad in ["", "a b", "a\"b", "a<b", "a/b", "a;b", "a\nb"] {
            assert!(!is_plausible_note_id(bad), "must reject {bad:?}");
        }
    }

    #[test]
    fn registry_registers_finds_and_clears() {
        let reg = DetachedWindowRegistry::default();
        reg.register("note-a".into(), "a".into());
        reg.register("note-b".into(), "b".into());
        assert_eq!(reg.label_for_note("a").as_deref(), Some("note-a"));
        assert_eq!(reg.label_for_note("missing"), None);
        assert_eq!(reg.all_labels().len(), 2);
        reg.remove("note-a");
        assert_eq!(reg.label_for_note("a"), None);
        reg.clear();
        assert!(reg.all_labels().is_empty());
    }
}
