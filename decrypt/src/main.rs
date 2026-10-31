// SPDX-License-Identifier: AGPL-3.0
//! `myne-decrypt`: export a Myne vault to plain markdown without the app
//! installed (myne-md/myne#166).
//!
//! The escape hatch behind the no-lock-in commitment (`vision.md`): "plain
//! markdown" is only true after decryption, so walking away without the app
//! requires a tool that decrypts. This binary reads a vault directory (or a
//! `.myne-backup` container) and writes the notes and attachments out as plain
//! `.md` files.
//!
//! Honest positioning: the source is not yet public, so the binary cannot be
//! independently verified. The help text says so rather than claiming a
//! verifiability the private source cannot deliver.

mod args;
mod destination;
mod password;
mod unlock;

use std::process::ExitCode;

const HELP: &str = "\
myne-decrypt: export a Myne vault to plain markdown without the app installed

USAGE:
    myne-decrypt [--recovery | --identity] [--history] [--yes] <vault-or-backup> <out-dir>

ARGUMENTS:
    <vault-or-backup>   A vault directory, or a .myne-backup container file
    <out-dir>           Where the plain markdown tree is written

OPTIONS:
    --identity          Unlock with the 24-word IDENTITY phrase instead of the
                        master password (a vault created from an identity has
                        that phrase as its second credential, not a vault one)
    --recovery          Unlock with the 24-word recovery phrase instead of
                        the master password
    --history           Also export note snapshots (version history)
    --yes               Skip the cloud-sync warning when <out-dir> is under a
                        known cloud-synced folder (iCloud, Dropbox, ...)

The master password (or recovery phrase) is read from the terminal with echo
off, or piped on stdin for scripting. There is no --password flag and no
MYNE_PASSWORD environment variable, so the credential never appears in a
process listing and interactive entry never lands in shell history. A piped
credential inherits the pipe's own exposure: `echo SECRET |` puts the secret
in the invoking shell's history and in the echo process argv. Prefer a
file-descriptor redirect or a file only the owner can read.

The source of this tool is not yet public, so the binary cannot be
independently verified. It exports your vault to plain markdown without the
app installed; it does not claim to work without us.";

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match args::parse(&raw) {
        Ok(p) => p,
        Err(msg) => {
            eprintln!("myne-decrypt: {msg}\n");
            eprintln!("{HELP}");
            return ExitCode::from(2);
        }
    };

    if parsed.help {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }

    // Credential entry: TTY prompt with echo off, or stdin pipe. The BIP-39
    // checksum is validated here (recovery mode) BEFORE the Argon2id KDF, so
    // a typo is caught in milliseconds rather than after a 1-3 s derivation.
    let credential = match password::read_credential(parsed.recovery, parsed.identity) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("myne-decrypt: {e}");
            return ExitCode::FAILURE;
        }
    };

    // Plaintext destination care: resolve the output dir, warn + require --yes
    // on a detected cloud root, and create it 0700. The unconditional closing
    // line is printed on every run (task 8).
    let out_dir = destination::absolutize(&parsed.out_dir);
    if let Some(provider) = destination::detect_cloud_root(&out_dir) {
        if !parsed.yes {
            eprintln!(
                "myne-decrypt: {} is under {}, which syncs to the cloud.\n\
                 Your notes would be uploaded as plaintext. Re-run with --yes to proceed anyway.",
                out_dir.display(),
                provider
            );
            return ExitCode::FAILURE;
        }
    }
    if let Err(e) = destination::create_output_dir(&out_dir) {
        eprintln!("myne-decrypt: could not create {}: {e}", out_dir.display());
        return ExitCode::FAILURE;
    }

    // Unlock: derive root_key + items_key from the credential, then run the
    // shared export walk (the same one the desktop app runs).
    //
    // The source is either a vault directory or a `.myne-backup` container
    // file. A container is read + verified, then its members are materialised
    // into a temp directory the unlock path can read.
    let source = std::path::PathBuf::from(&parsed.source);
    let (vault_dir, _temp) = match materialize_source(&source) {
        Ok(v) => v,
        Err(msg) => {
            eprintln!("myne-decrypt: {msg}");
            return ExitCode::FAILURE;
        }
    };
    let unlocked = match &credential {
        password::Credential::Password(pw) => unlock::unlock_with_password(&vault_dir, pw),
        password::Credential::RecoveryPhrase(phrase) => {
            unlock::unlock_with_phrase(&vault_dir, phrase)
        }
        password::Credential::IdentityPhrase(phrase) => {
            unlock::unlock_with_identity(&vault_dir, phrase)
        }
    };
    let vault = match unlocked {
        Ok(v) => v,
        Err(unlock::UnlockError::InvalidCredentialOrVault) => {
            eprintln!("myne-decrypt: wrong password/phrase, or the vault is damaged");
            eprintln!(
                "  A vault created from an identity opens with the master password or --identity, \
                 not with a vault recovery phrase."
            );
            return ExitCode::FAILURE;
        }
        Err(unlock::UnlockError::InvalidVaultMeta) => {
            eprintln!("myne-decrypt: not a valid Myne vault (vault.meta unreadable)");
            return ExitCode::FAILURE;
        }
        Err(unlock::UnlockError::UnsupportedGeneration(magic)) => {
            // Named, not a parse error. A user holding a vault a newer Myne wrote
            // has one action (upgrade this tool) and cannot infer it from
            // "unreadable"; a user whose file is corrupt needs the opposite
            // advice, so the two must not read the same.
            eprintln!("myne-decrypt: this vault.meta is a generation this build does not know");
            eprintln!(
                "  found magic {} ({}), expected MYV1, NTV5, NTV6, NTV7 or NTV8",
                printable_magic(&magic),
                magic.iter().map(|b| format!("{b:02x}")).collect::<String>()
            );
            eprintln!(
                "  A newer Myne wrote this vault. Upgrade myne-decrypt to a release that \
                 knows that generation, or open the vault in the app that wrote it."
            );
            return ExitCode::FAILURE;
        }
        Err(unlock::UnlockError::NotPersonWrapped) => {
            eprintln!(
                "myne-decrypt: this vault has no identity wrap, so the identity phrase is \
                 not a credential for it"
            );
            eprintln!(
                "  Open it with the master password. Since NTV8 the password is the only \
                 vault credential; the identity phrase names you and opens nothing on disk."
            );
            return ExitCode::FAILURE;
        }
    };

    // The export walk. The destination is the new tree directory itself; the
    // vault dir is the one forbidden root (never export plaintext into the
    // vault).
    let items_key = vault.items_key.clone();
    let params = myne_format::export_walk::StageParams {
        vault_dir: vault_dir.clone(),
        forbidden_roots: vec![vault_dir.clone()],
        destination: out_dir.clone(),
        scope: None,
        items_key: items_key.clone(),
        items_key_id: vault.items_key_id,
        root_key: Some(vault.root_key),
        group_key: vault.group_key,
        version: vault.version,
        trashed: myne_format::export_walk::TrashedMode::Trash,
        best_effort: true,
        history: parsed.history,
    };
    let hooks = myne_format::export_walk::NoopExportHooks;
    let staged = match myne_format::export_walk::stage_export_tree(params, &hooks) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("myne-decrypt: export failed: {}", export_error_message(&e));
            return ExitCode::FAILURE;
        }
    };
    let summary = match myne_format::export_walk::finalize_export(
        staged,
        &vault_dir,
        items_key,
        vault.items_key_id,
        &hooks,
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("myne-decrypt: export failed: {}", export_error_message(&e));
            return ExitCode::FAILURE;
        }
    };

    // Report the device-local families the tool cannot open, if present.
    report_unreachable(&vault_dir);

    // The unconditional closing line naming the plaintext directory.
    println!("{}", destination::closing_line(&out_dir));
    eprintln!(
        "myne-decrypt: exported {} note(s), {} attachment(s), {} folder(s), {} trashed, {} snapshot(s), {} failed",
        summary.notes,
        summary.attachments,
        summary.folders,
        summary.trashed,
        summary.snapshots,
        summary.failed
    );
    if summary.failed > 0 {
        eprintln!(
            "myne-decrypt: {} item(s) could not be decrypted; see _undecodable/ and _FAILED.txt",
            summary.failed
        );
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

/// A temp directory that removes itself on drop. Used to materialise a
/// `.myne-backup` container into a directory the unlock path can read.
struct TempDirGuard(std::path::PathBuf);

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if let Err(e) = std::fs::remove_dir_all(&self.0) {
            eprintln!(
                "myne-decrypt: warning: temp dir cleanup failed ({}): {}",
                self.0.to_string_lossy(),
                e
            );
        }
    }
}

/// Resolve the source argument to a vault directory. A `.myne-backup` container
/// is read + verified and its members materialised into a temp directory; a
/// plain directory is used as-is. Returns the vault dir plus a guard that
/// removes the temp dir (if any) on drop.
fn materialize_source(
    source: &std::path::Path,
) -> Result<(std::path::PathBuf, Option<TempDirGuard>), String> {
    if source.is_dir() {
        return Ok((source.to_path_buf(), None));
    }
    // A container file: read + verify, then extract members into a temp dir.
    let records = myne_format::backup_container::with_container_file(source, |reader| {
        myne_format::backup_container::read_and_verify_container(reader)
    })
    .map_err(|e| format!("not a valid .myne-backup container: {e}"))?;

    // A randomized, create-new temp dir: a predictable pid-based name is a
    // symlink-clobber target, and `create_dir_all` would happily write through
    // a pre-planted symlink. `create_dir` (create-new) fails on an existing
    // path, and the UUID suffix makes the name unguessable. Owner-only
    // permissions: the members include vault.meta, the complete offline
    // password-cracking target, so sibling local accounts must not read it.
    let temp =
        std::env::temp_dir().join(format!("myne-decrypt-container-{}", uuid::Uuid::new_v4()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(false)
            .mode(0o700)
            .create(&temp)
            .map_err(|e| format!("could not create temp dir: {e}"))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir(&temp).map_err(|e| format!("could not create temp dir: {e}"))?;
    }
    if let Err(e) = myne_format::backup_container::with_container_file(source, |reader| {
        myne_format::backup_container::extract_all_members(reader, &records, &temp)
    }) {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(format!("could not extract container: {e}"));
    }
    Ok((temp.clone(), Some(TempDirGuard(temp))))
}

/// Report the device-local families the tool cannot open, if present. These are
/// sealed under a device-local keychain key, so no credential reaches them.
fn report_unreachable(vault_dir: &std::path::Path) {
    for (dir, what) in [
        ("captures", "watch-dictated notes"),
        (
            "pending-shares/sealed",
            "files shared into the app while locked",
        ),
    ] {
        let path = vault_dir.join(dir);
        if path.is_dir()
            && std::fs::read_dir(&path)
                .map(|mut e| e.next().is_some())
                .unwrap_or(false)
        {
            eprintln!(
                "myne-decrypt: {what} in {dir}/ cannot be opened here (sealed under a device-local key); recover them from inside the app on the device that made them"
            );
        }
    }
}

/// A human-readable, non-distinguishing message for an export failure.
/// The four magic bytes as a printable label. A vault from the future carries
/// ASCII magic, so `FUT9` reads as `FUT9`; a corrupt file may carry anything, so
/// every non-printable byte becomes `.` and the hex printed beside it stays the
/// authority.
fn printable_magic(magic: &[u8; 4]) -> String {
    magic
        .iter()
        .map(|b| {
            if b.is_ascii_graphic() {
                (*b as char).to_string()
            } else {
                ".".to_string()
            }
        })
        .collect()
}

fn export_error_message(e: &myne_format::export_error::VaultExportError) -> String {
    use myne_format::export_error::VaultExportError as E;
    match e {
        E::VaultNotUnlocked => "vault is not unlocked".to_string(),
        E::AuthOperationInProgress => "another operation is in progress".to_string(),
        E::VaultNotFound => "no vault found at that path".to_string(),
        E::InvalidDestination => "destination is invalid".to_string(),
        E::DestinationNotAllowed => "destination is inside the vault".to_string(),
        E::DestinationAlreadyExists => "destination already exists".to_string(),
        E::CannotDecrypt => "a note could not be decrypted".to_string(),
        E::InvalidPlaintextEncoding => "a note's plaintext is not valid UTF-8".to_string(),
        E::InvalidVaultMeta => "vault metadata is invalid".to_string(),
        E::AttachmentMissing => "a referenced attachment is missing".to_string(),
        E::AttachmentCorrupt => "a referenced attachment could not be decrypted".to_string(),
        E::Cancelled => "export cancelled".to_string(),
        E::Io { .. } => "an IO error occurred".to_string(),
        E::JoinFailure => "an internal error occurred".to_string(),
    }
}
