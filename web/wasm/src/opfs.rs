// SPDX-License-Identifier: AGPL-3.0
//! [`VaultIo`] over OPFS (phase3-web-client task 17).
//!
//! # Where the two halves live, and why
//!
//! `myne-core` defines the [`VaultIo`] trait and provides the native
//! `std::fs` arm. The **OPFS arm lives here, in the entry crate**, not in
//! `myne-core`'s wasm arm — so that `myne-core` gains no `web-sys`, no
//! `wasm-bindgen`-for-IO, and keeps exactly the dependency graph desktop and
//! mobile already compile. This crate is the JS-boundary crate by definition;
//! that is what it is for.
//!
//! The mechanics themselves are in `web/src/worker/opfs.ts`. This file is the
//! binding: it declares the bridge functions, awaits their promises, and maps
//! their failures onto the closed [`IoFailureKind`]. Deliberately thin — every
//! line of OPFS behaviour lives on the JS side where the API is native, and this
//! file is where a reviewer checks that the boundary is honest.

use myne_core::double_buffer as container;
use myne_core::io_failure_kind::IoFailureKind;
use myne_core::vault_io::{DirEntry, IoResult, VaultIo, WriteOpts};
use std::path::Path;
use wasm_bindgen::prelude::*;

// The bridge `web/src/worker/opfs.ts` installs on `globalThis.__myneOpfs`
// before the wasm module is instantiated. One explicit, greppable list — a
// missing installation surfaces as an immediate `is not a function`, not as a
// silently wrong result.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = read, catch)]
    async fn opfs_read(path: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = readPrefix, catch)]
    async fn opfs_read_prefix(path: &str, len: usize) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = write, catch)]
    async fn opfs_write(path: &str, bytes: &[u8], replace: bool) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = removeFile, catch)]
    async fn opfs_remove_file(path: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = removeDirAll, catch)]
    async fn opfs_remove_dir_all(path: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = createDirAll, catch)]
    async fn opfs_create_dir_all(path: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = readDir, catch)]
    async fn opfs_read_dir(path: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = exists, catch)]
    async fn opfs_exists(path: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = stat, catch)]
    async fn opfs_stat(path: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = isDir, catch)]
    async fn opfs_is_dir(path: &str) -> Result<JsValue, JsValue>;

    #[wasm_bindgen(js_namespace = ["globalThis", "__myneOpfs"], js_name = rename, catch)]
    async fn opfs_rename(from: &str, to: &str) -> Result<JsValue, JsValue>;
}

/// Numeric mirror of [`IoFailureKind`], matching `IO_KIND` in `opfs.ts`.
///
/// Numbers rather than strings because they cross the boundary on every failing
/// call and are matched exhaustively. The two sides are kept in lockstep by
/// [`crate::opfs_contract`], whose test reads the TypeScript source and compares
/// — a comment saying "keep these in sync" is not a mechanism. That module is
/// compiled on every target so `cargo test --workspace` covers it; this one is
/// wasm-only and is beyond every gate that runs in `pre-push`.
fn kind_from_js(e: &JsValue) -> IoFailureKind {
    // The thrown value is a `MyneIoError` carrying `.kind`. Anything else — a
    // native `TypeError` from a missing bridge, say — has no `.kind` and falls
    // to `Other`, which is correct: it is not a storage condition.
    let kind = js_sys::Reflect::get(e, &JsValue::from_str("kind"))
        .ok()
        .and_then(|v| v.as_f64());
    match kind {
        Some(0.0) => IoFailureKind::PermissionDenied,
        Some(1.0) => IoFailureKind::NotFound,
        Some(2.0) => IoFailureKind::NoSpace,
        _ => IoFailureKind::Other,
    }
}

/// OPFS paths are `/`-separated strings; `Path` is the seam's currency.
///
/// Lossy conversion is safe here in a way it would not be on a real filesystem:
/// every path this crate constructs comes from `myne_core::paths`, whose
/// components are hex, UUIDs, and fixed ASCII literals. There is no user-supplied
/// component that could be non-UTF-8 — and on wasm `Path` is UTF-8 anyway.
fn as_str(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// [`VaultIo`] backed by the origin-private filesystem.
///
/// A unit struct, holding no handles. That is not an oversight: an OPFS
/// `FileSystemSyncAccessHandle` is an **exclusive lock**, so a cache of open
/// handles turns any second acquisition — a retry, a concurrent command, a
/// re-entrant path — into an intermittent `NoModificationAllowedError`. The
/// measured per-file cost (0.42 ms Safari / 1.21 Chrome / 2.92 Firefox at 4 KiB)
/// is the budget a cache would spend against, and it does not yet justify that
/// failure mode. `core-io-seam-design.md` §7 records it as revisitable against a
/// measurement.
///
/// Being handle-free is also what keeps it `Send + Sync`, which the trait
/// requires on both arms.
#[derive(Debug, Default, Clone, Copy)]
pub struct OpfsVaultIo;

/// The same OPFS bridges, WITHOUT the double-buffer layer (task 19).
///
/// `myne_core::double_buffer` is written against a raw [`VaultIo`] — one whose
/// `write` puts bytes at the path it is handed — because it constructs the `.a` /
/// `.b` paths itself. Handing it [`OpfsVaultIo`] would double-buffer the
/// double-buffering and produce `vault.prefs.a.a`.
///
/// So the container logic lives in core (host-compiled, fault-injectable, run by
/// `cargo test --workspace`) and this is the store it drives. What is left in
/// this file is the OPFS boundary and the *policy* — which paths are singletons —
/// and nothing that decides recency or framing.
#[derive(Debug, Default, Clone, Copy)]
struct RawOpfs;

#[async_trait::async_trait(?Send)]
impl VaultIo for RawOpfs {
    async fn read(&self, path: &Path) -> IoResult<Vec<u8>> {
        let value = opfs_read(&as_str(path))
            .await
            .map_err(|e| kind_from_js(&e))?;
        Ok(js_sys::Uint8Array::new(&value).to_vec())
    }

    async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>> {
        let value = opfs_read_prefix(&as_str(path), len)
            .await
            .map_err(|e| kind_from_js(&e))?;
        Ok(js_sys::Uint8Array::new(&value).to_vec())
    }

    async fn write(&self, path: &Path, bytes: &[u8], opts: WriteOpts) -> IoResult<()> {
        opfs_write(&as_str(path), bytes, opts.replace)
            .await
            .map_err(|e| kind_from_js(&e))?;
        Ok(())
    }

    async fn remove_file(&self, path: &Path) -> IoResult<()> {
        opfs_remove_file(&as_str(path))
            .await
            .map_err(|e| kind_from_js(&e))?;
        Ok(())
    }

    // The container never calls these; they exist because the trait does.
    async fn remove_dir_all(&self, path: &Path) -> IoResult<()> {
        OpfsVaultIo.remove_dir_all(path).await
    }
    async fn create_dir_all(&self, path: &Path) -> IoResult<()> {
        OpfsVaultIo.create_dir_all(path).await
    }
    async fn read_dir(&self, path: &Path) -> IoResult<Vec<DirEntry>> {
        OpfsVaultIo.read_dir(path).await
    }
    async fn exists(&self, path: &Path) -> IoResult<bool> {
        let value = opfs_exists(&as_str(path))
            .await
            .map_err(|e| kind_from_js(&e))?;
        value.as_bool().ok_or(IoFailureKind::Other)
    }
    async fn stat(&self, path: &Path) -> IoResult<Option<myne_core::vault_io::FileStat>> {
        OpfsVaultIo.stat(path).await
    }
    async fn is_dir(&self, path: &Path) -> IoResult<bool> {
        OpfsVaultIo.is_dir(path).await
    }
    async fn rename(&self, from: &Path, to: &Path) -> IoResult<()> {
        OpfsVaultIo.rename(from, to).await
    }
}

#[async_trait::async_trait(?Send)]
impl VaultIo for OpfsVaultIo {
    async fn read(&self, path: &Path) -> IoResult<Vec<u8>> {
        let name = as_str(path);
        if container::is_container(&name) {
            // A double-buffered singleton has no single file to read, so this
            // returns the newest copy that is structurally intact — the one
            // `read_candidates` would list first. Callers that can verify (i.e.
            // decrypt) should go through `singleton::open_newest` instead, which
            // is what makes the fallback real; this arm exists so that callers
            // which only need *some* current bytes — a length probe, a
            // presence check — keep working unchanged.
            //
            // It does NOT sweep (myne#298). `sweep_orphans` keeps the newest
            // RANKABLE slot, and this arm cannot verify — so a slot torn
            // mid-write whose 8-byte generation stamp landed ranks first,
            // survives the sweep, and the intact older copy beside it is
            // unlinked. The read would have returned the torn bytes either way;
            // what the sweep added was that the intact bytes were gone from
            // disk, so the loss became irreversible — no repair tool and not the
            // `open_newest` fallback this comment recommends could get them
            // back. For a note not yet pushed to sync, that was the only copy
            // anywhere. Cleanup now happens where a survivor has been PROVEN:
            // `singleton::sweep_after_verified_open`.
            let mut found = container::candidates(&RawOpfs, path).await?;
            return if found.is_empty() {
                Err(IoFailureKind::NotFound)
            } else {
                Ok(found.remove(0))
            };
        }
        let value = opfs_read(&name).await.map_err(|e| kind_from_js(&e))?;
        Ok(js_sys::Uint8Array::new(&value).to_vec())
    }

    async fn read_candidates(&self, path: &Path) -> IoResult<Vec<Vec<u8>>> {
        let name = as_str(path);
        if !container::is_container(&name) {
            // Everything else keeps the trait's default meaning: the file is the
            // only copy. Spelled out rather than inherited, because this impl
            // overrides `read` too and a reader of one method must be able to
            // see what the other does.
            return match self.read(path).await {
                Ok(bytes) => Ok(vec![bytes]),
                Err(IoFailureKind::NotFound) => Ok(Vec::new()),
                Err(e) => Err(e),
            };
        }
        container::candidates(&RawOpfs, path).await
    }

    async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>> {
        // Container-aware, and the previous version's reasoning for not being
        // was a single wrong word with a very large consequence.
        //
        // It said a per-note blob "is never double-buffered". True of the
        // DOUBLED mode and false of the question that matters: `mode_for`
        // returns `SingleLive` for `notes/<uuid>.myn`, which is still a
        // CONTAINER — the bytes live at `<path>.a` or `<path>.b` behind an
        // 8-byte generation frame. So a raw prefix read of `<path>` found no
        // file at all.
        //
        // What that cost, measured on the deployed origin: `read_prefix`'s one
        // production caller is `note_nonce::scan_on_disk_manifest`, which
        // `continue`s past any note whose header will not read — and that scan
        // is what `sync::unsynced::scan_unsynced` walks to decide which notes
        // need pushing. Every note failed the header read, the unsynced set was
        // always empty, and **a browser pushed nothing it wrote.** Not an
        // error, not a stalled indicator: the editor said "Saved", the vault
        // held the note, the sync loop pulled 45 times in 20 minutes, and the
        // server never received a byte of it. Only the FIRST sync got through,
        // via the whole-corpus sweep an un-synced device is permitted; once
        // `corpus_complete` flipped, the incremental path took over and went
        // silently blind.
        //
        // `candidates` reads the whole slot rather than a prefix of it. That is
        // the honest cost and it is small: the caller reads 47 bytes of a
        // ~300-byte note blob, so the saving never existed. `SingleLive` also
        // makes the "which slot" objection moot — there is one live slot, and
        // `candidates` returns newest-first for the doubled case anyway.
        if !container::is_container(&as_str(path)) {
            return RawOpfs.read_prefix(path, len).await;
        }
        let found = container::candidates(&RawOpfs, path).await?;
        let Some(first) = found.into_iter().next() else {
            return Err(IoFailureKind::NotFound);
        };
        Ok(first.into_iter().take(len).collect())
    }

    async fn write(&self, path: &Path, bytes: &[u8], opts: WriteOpts) -> IoResult<()> {
        // `opts.private` and `opts.unclobbered` are deliberately dropped, and
        // this is the one place to say why rather than silently ignoring them:
        //   - `private` (0600) has no meaning on an origin-scoped store; there
        //     is no other principal on the origin to exclude.
        //   - `unclobbered` guards a *temp sibling* against clobbering a user's
        //     own file at an export destination. There is no temp file here and
        //     no user-owned destination — OPFS is not user-visible.
        // Both are native-durability mechanics, not semantics a caller reads
        // back, so dropping them changes no observable behaviour.
        let name = as_str(path);
        if container::is_container(&name) {
            // The durability this seam's doc comment says the wasm arm "cannot
            // promise" — now it can, for the singletons (task 18). Read both
            // generations, write the one that is NOT the newest, one generation
            // above the highest. A crash during this write therefore cannot
            // touch the newest complete copy, which is the whole guarantee.
            return match container::mode_for(&name) {
                // Singletons keep both copies: they are small, rewritten
                // constantly, and the previous one IS the recovery.
                container::Mode::Doubled => container::write_next(&RawOpfs, path, bytes).await,
                // A note keeps the crash property and drops the storage cost —
                // the previous copy is retired once the new one has landed
                // (task 20). Order matters: removing first would open a window
                // with no copy at all.
                container::Mode::SingleLive => {
                    container::write_single_live(&RawOpfs, path, bytes).await
                }
                container::Mode::Plain => unreachable!("guarded by is_container"),
            };
        }
        opfs_write(&name, bytes, opts.replace)
            .await
            .map_err(|e| kind_from_js(&e))?;
        Ok(())
    }

    async fn remove_file(&self, path: &Path) -> IoResult<()> {
        let name = as_str(path);
        if container::is_container(&name) {
            // BOTH slots, or the delete is a lie: a vault-delete that removed one
            // copy would leave the other, and the next open would resurrect the
            // vault from it.
            return container::remove_all(&RawOpfs, path).await;
        }
        opfs_remove_file(&name)
            .await
            .map_err(|e| kind_from_js(&e))?;
        Ok(())
    }

    async fn remove_dir_all(&self, path: &Path) -> IoResult<()> {
        opfs_remove_dir_all(&as_str(path))
            .await
            .map_err(|e| kind_from_js(&e))?;
        Ok(())
    }

    async fn create_dir_all(&self, path: &Path) -> IoResult<()> {
        opfs_create_dir_all(&as_str(path))
            .await
            .map_err(|e| kind_from_js(&e))?;
        Ok(())
    }

    async fn read_dir(&self, path: &Path) -> IoResult<Vec<DirEntry>> {
        let value = opfs_read_dir(&as_str(path))
            .await
            .map_err(|e| kind_from_js(&e))?;
        let rows = js_sys::Array::from(&value);
        let mut out: Vec<DirEntry> = Vec::with_capacity(rows.length() as usize);
        for row in rows.iter() {
            let pair = js_sys::Array::from(&row);
            let raw = pair.get(0).as_string().ok_or(IoFailureKind::Other)?;
            let is_dir = pair.get(1).as_bool().ok_or(IoFailureKind::Other)?;
            // **The container must not be visible above this seam** (task 20).
            // A `notes/` listing physically contains `019f-….myn.a`, and core
            // parses entries as note ids — so an unmapped listing invents a note
            // whose id ends in `.myn.a`, and during a save invents a second copy
            // of a real one. Map back to the base name and de-duplicate; the two
            // slots of one item are one entry.
            let name = container::strip_slot_suffix(&raw)
                .map(|base| base.to_string())
                .unwrap_or(raw);
            if !out.iter().any(|e| e.name == name) {
                out.push(DirEntry { name, is_dir });
            }
        }
        Ok(out)
    }

    async fn exists(&self, path: &Path) -> IoResult<bool> {
        let name = as_str(path);
        if container::is_container(&name) {
            // "Exists" must mean the same thing the open path means, or
            // `vault_status` and `unlock` disagree: a vault whose only copy is a
            // torn slot would report present and then fail to open, or report
            // absent and route the user to vault creation on top of a real
            // vault. Both are worse than either answer alone. So: a usable copy
            // exists iff at least one slot carries a valid generation.
            return Ok(!container::candidates(&RawOpfs, path).await?.is_empty());
        }
        let value = opfs_exists(&name).await.map_err(|e| kind_from_js(&e))?;
        // A non-boolean here means the bridge returned something unexpected,
        // which must not read as "absent" — the recoveries for "no" and "I could
        // not tell" are opposite. Same reason the native arm uses `try_exists`
        // rather than `exists`.
        value.as_bool().ok_or(IoFailureKind::Other)
    }

    /// Size + last-modified, from the `File` a handle hands back — one handle
    /// acquisition and no bytes read.
    ///
    /// The bridge answers `null` for anything that is not a readable file, and
    /// that becomes `None` here rather than an error: the caller is decorating a
    /// row it already has, and one racing delete must not lose the listing.
    async fn stat(&self, path: &Path) -> IoResult<Option<myne_core::vault_io::FileStat>> {
        let value = opfs_stat(&as_str(path))
            .await
            .map_err(|e| kind_from_js(&e))?;
        if value.is_null() || value.is_undefined() {
            return Ok(None);
        }
        // `[size, lastModified]` — a pair rather than an object, matching how
        // `read_dir` returns `[name, isDir]`.
        let arr = js_sys::Array::from(&value);
        let size = arr.get(0).as_f64().ok_or(IoFailureKind::Other)? as u64;
        let modified = arr.get(1).as_f64();
        Ok(Some(myne_core::vault_io::FileStat {
            size,
            // `lastModified` is milliseconds since the epoch already. A
            // non-finite value (some browsers report `NaN` for a file with no
            // recorded time) reads as "unknown" rather than as epoch zero.
            modified_epoch_ms: modified.filter(|m| m.is_finite()).map(|m| m as u64),
        }))
    }

    async fn is_dir(&self, path: &Path) -> IoResult<bool> {
        let value = opfs_is_dir(&as_str(path))
            .await
            .map_err(|e| kind_from_js(&e))?;
        value.as_bool().ok_or(IoFailureKind::Other)
    }

    async fn rename(&self, from: &Path, to: &Path) -> IoResult<()> {
        opfs_rename(&as_str(from), &as_str(to))
            .await
            .map_err(|e| kind_from_js(&e))?;
        Ok(())
    }
}
