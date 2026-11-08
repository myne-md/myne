// SPDX-License-Identifier: AGPL-3.0
//! Android "hand the user the file" bridge (myne-md/myne#505), the OUTBOUND peer
//! of `tauri-plugin-share-intent`.
//!
//! Every mobile export writes its file into the app's own `Documents` directory
//! (`getExternalFilesDir(DIRECTORY_DOCUMENTS)`), which the system Files app has
//! refused to open since Android 11 (API 30) while `minSdk` here is 24. On iOS
//! the share sheet is the user's route to that file; on Android there was none,
//! so the write WAS the delivery and nothing delivered. This plugin supplies the
//! missing route: a Storage Access Framework `ACTION_CREATE_DOCUMENT` picker,
//! which is the platform's own "where do you want this?" dialog: the user picks
//! the destination (Downloads, Drive, an SD card, any provider) and the bytes are
//! written there.
//!
//! **The app's own copy stays**, deliberately: the picker can be dismissed, and
//! for the recovery-phrase file a dismissal that deleted the only copy would be
//! the worst failure this client can have. The copy is already excluded from the
//! platform's automatic cloud backup (`backup_exclude`, myne-md/myne#491), so
//! what remains is the `threat-model.md` TB3 user-initiated egress exception.
//!
//! ## Why a directory arrives as a `.zip`
//!
//! The whole-vault markdown export is a FOLDER, and `ACTION_CREATE_DOCUMENT`
//! saves exactly one document. The Kotlin side therefore zips a directory into
//! the app cache, hands that file to the picker, and deletes the temporary
//! archive. A single document is also what every other export already is, which
//! keeps this plugin's surface to one command. The archive holds every note in
//! plaintext, so it is removed on every path the process survives, and the plugin
//! sweeps leftover archives into `load` for the exit it does not survive (a
//! swipe-away, an OOM kill, a crash in the copy thread).
//!
//! ## Threading
//!
//! The command reaches the activity through the Android main pipe, and the answer
//! comes back on that same loop, so a caller that awaits it FROM the main thread
//! deadlocks (`screen_guard::ScreenGuard::set_secure` and `ShareIntentPlugin`
//! carry the same contract). [`SaveFile::save`] uses `run_mobile_plugin_async`,
//! which parks nothing, and it still must not be awaited on the main thread,
//! because the response is delivered by the loop it would be blocking. The answer
//! arrives only after the user has chosen a destination, which can be minutes, so
//! the caller (`share_file::present`) runs it in a background task.
//!
//! ## Verification status
//!
//! The committed Kotlin compiles against the generated gradle project, and its
//! effect is device-verified through `agent-tooling/docs/dev/device-matrix.md` §8 row 8.8, not
//! in this change, the same bar `pdf_export.rs`, `screen_guard.rs` and
//! `ShareIntentPlugin.kt` are held to, because no CI lane in this repo runs an
//! Android device.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Java package of the committed Kotlin plugin class (its `class_name` is
/// `SaveFilePlugin`). Distinct from the app id `md.myne.mobile`.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "md.myne.savefile";

/// `run_mobile_plugin("saveFile", …)` args. The mime type and the suggested file
/// name are decided in Rust (`share_file::destination_hint`) because that is
/// where the export's shape is known: a directory becomes `application/zip` with
/// a `.zip` name, a file keeps its own extension.
#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileArgs {
    path: String,
    mime: String,
    suggested_name: String,
    /// Whether Kotlin must zip `path` first. Decided by the caller
    /// (`share_file::destination_hint`), never re-derived from the filesystem on
    /// the Kotlin side, so the suggested name, the MIME type and the bytes
    /// cannot describe different shapes.
    zips: bool,
}

/// What the Kotlin side reports once the picker has closed. `saved` means the
/// bytes reached the user's chosen document; `cancelled` means the user dismissed
/// the picker; `error` carries a class name only (never a path or a filename, so
/// it stays safe for the diagnostic log).
#[cfg(target_os = "android")]
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SaveOutcome {
    pub saved: bool,
    pub cancelled: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// Managed handle to the Kotlin plugin, registered on Android so
/// `share_file::present` can reach it via `app.try_state::<SaveFile<R>>()`.
#[cfg(target_os = "android")]
pub struct SaveFile<R: Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> Clone for SaveFile<R> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}

#[cfg(target_os = "android")]
impl<R: Runtime> SaveFile<R> {
    /// Open the platform save picker for `path` and write it to whatever the user
    /// chooses.
    ///
    /// **Does not block the calling thread's runtime**: the answer arrives only
    /// after a human decision, so this is async on purpose and the caller must not
    /// hold the main thread while it runs.
    pub async fn save(
        &self,
        path: String,
        mime: String,
        suggested_name: String,
        zips: bool,
    ) -> Result<SaveOutcome, String> {
        let args = SaveFileArgs {
            path,
            mime,
            suggested_name,
            zips,
        };
        self.0
            .run_mobile_plugin_async::<SaveOutcome>("saveFile", args)
            .await
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("save-file")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "SaveFilePlugin")?;
                _app.manage(SaveFile(handle));
            }
            Ok(())
        })
        .build()
}
