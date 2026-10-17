// SPDX-License-Identifier: AGPL-3.0
//! `importer` plugin: the import command namespace (MYND-53, SYNC-1;
//! myne-md/myne#464).
//!
//! ## What this header used to say, and why it is no longer true
//!
//! It described "two Tauri commands that hold no state and touch no vault
//! crypto". That was accurate for the original seam and stopped being accurate
//! when vault-to-vault import landed here: six of the commands below hold a
//! SECOND vault's `root_key` and `items_key` in a dedicated slot, run Argon2id,
//! open AEAD blobs and write re-sealed attachments. A module header that
//! understates what its commands can do is worse than none, because the next
//! reader takes it as the reason not to look.
//!
//! ## The two halves
//!
//! **The directory read seam.** `import_read_dir` + `import_read_file` are the
//! ONLY path by which the WebView reads an external (Obsidian vault) directory.
//! No general `fs:allow-read-text-file` / `fs:read-dir` / read `fs:scope` is
//! granted — this path-validating seam replaces them (least-privilege, TB6; the
//! rationale is recorded in `docs/decisions.md`). These two hold no state and
//! touch no vault crypto; the TS engine assembles plaintext and calls the
//! slot-gated `note_create` for ingest.
//!
//! **The vault-to-vault import.** The `import_source_*` commands open a second
//! LOCAL vault read-only, through a `Slot::ImportSource` that is not and never
//! becomes an `Unlocked` slot. They are registered here rather than in the
//! plugins whose subjects they touch so that the whole feature lands in ONE ACL
//! namespace the web dispatcher already classifies `Class::Unsupported`. The
//! window two vaults' keys are resident is `threat-model.md` A6's amendment.
//!
//! Capability ACL: `importer:default` (`permissions/importer/default.toml` +
//! `build.rs InlinedPlugin::commands` lock-stepped — adding a command without
//! the matching `commands.allow` entry is a security regression).

pub mod backup_source;
pub mod commands;
pub mod error;
pub mod hold;
/// Reading a SOURCE vault's added dictionary words during a vault import
/// (myne-md/myne#464). Desktop-side because the personal dictionary's payload
/// type and spell engine are, and `myne-core` cannot reach them.
pub mod source_dictionary;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Construct the `importer` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("importer")
        .invoke_handler(tauri::generate_handler![
            commands::import_read_dir,
            commands::import_read_file,
            hold::import_set_hold,
            // Vault import (myne-md/myne#464). The CORE lives in
            // `myne-core`'s vault-unlock plugin, beside the derivation steps it
            // reuses; the commands are registered HERE so they land in the
            // `importer:` ACL namespace. That is deliberate rather than
            // incidental: the web dispatcher classifies this whole plugin
            // `Class::Unsupported`, so the feature adds no command surface to
            // the web or mobile clients and nothing new needs classifying.
            myne_core::plugins::vault_unlock::import_source::import_source_open,
            myne_core::plugins::vault_unlock::import_source::import_source_close,
            myne_core::plugins::vault_unlock::import_source::import_source_list_notes,
            myne_core::plugins::vault_unlock::import_source::import_source_read_note,
            myne_core::plugins::vault_unlock::import_source::import_source_reseal_attachment,
            // Opening a `.myne-backup` container as an import source
            // (myne-md/myne#816). Desktop-side because it stages the container
            // with the `backup_container` reader, which lives in this crate.
            backup_source::import_source_open_backup,
            backup_source::import_source_close_backup,
            // Only the MERGE is registered. `import_source_dictionary` is the
            // read half and has no caller across IPC: the frontend needs the
            // read and the write together, so registering the read alone would
            // be command surface with no consumer.
            source_dictionary::import_source_merge_dictionary,
        ])
        .setup(|app, _api| {
            // The auto-lock lease a running import takes (myne-md/myne#223).
            // Managed here rather than in `lib.rs` so it stays scoped to the
            // one plugin allowed to take it.
            app.manage(hold::ImportHold::default());
            Ok(())
        })
        .build()
}
