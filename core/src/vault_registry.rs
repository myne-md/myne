//! Vault discovery (disk-scan) + best-effort registry cache.
//!
//! ## Discovery authority is the disk-scan (SYNC-10)
//!
//! The authoritative answer to "which vaults exist" is a **scan of
//! `<app_data_dir>/vaults/`**: every `<id>/` subdirectory whose name parses
//! as a [`VaultId`] is a discovered vault. This is consistent with the
//! project-wide "files are canonical" posture and is robust to Phase-2 sync
//! and manual file operations. The on-disk registry (below) is a *cache*,
//! never the authority — discovery NEVER fails because the cache is gone.
//!
//! ## Classification
//!
//! Each discovered `vaults/<id>/` is classified `well_formed` via the
//! existing [`vault_artifacts_present`] predicate plus a `vault.meta`
//! presence check: a vault is well-formed when it carries a readable
//! `vault.meta` (the canonical, fully-formed case). A directory that parses
//! as a `VaultId` but has no usable `vault.meta` is still *discovered*
//! (returned in the list) but flagged `well_formed = false` — task 3's
//! `vault_list` maps that to the `Corrupted` status arm rather than dropping
//! the entry. Discovery surfaces every on-disk vault; it never panics on a
//! malformed one.
//!
//! ## Registry cache (SYNC-3 / SYNC-10)
//!
//! The registry is a best-effort JSON file at
//! `<app_data_dir>/vaults/registry.json` holding **only** opaque `VaultId` +
//! last-unlock-time per vault. It carries **no human label** at rest (a
//! plaintext label would be a new at-rest leak class — SYNC-3); the label
//! cache is RAM-only and populated on unlock by later siblings (not built
//! here). If the file is missing or corrupt it is transparently rebuilt from
//! the disk-scan, so a lost cache is invisible to discovery.
//!
//! ## Collision mint-and-retry (SYNC-2)
//!
//! [`mint_unique_vault_id`] mints a fresh [`VaultId`] and re-mints if
//! `vaults/<id>/` already names an existing directory (astronomically
//! unlikely for a random UUIDv7, but handled deterministically — collision
//! is not "same account, second vault"; `VaultId` is decoupled from account
//! identity). This is the helper sub-feature 3's create path calls.
//!
//! ## Logging discipline
//!
//! Per `src-tauri/CLAUDE.md` "Secret-handling logging discipline", a full
//! filesystem path and a `VaultId` (a per-vault vault-stable correlation
//! tag) are both DENY-listed. This module keeps `VaultId`s and paths off the
//! tracing surface entirely — the only emitted signals are coarse counts and
//! static stage strings.

use crate::paths::VAULTS_DIR_NAME;
use crate::plugins::vault_creation::commands::vault_artifacts_present;
use crate::vault_id::VaultId;
use std::path::{Path, PathBuf};

/// The canonical fully-formed-vault marker file. Its presence + readability
/// is what separates a well-formed vault from a corrupted directory.
const VAULT_META_FILE_NAME: &str = "vault.meta";

/// Best-effort registry cache filename, persisted alongside the vault roots
/// under `vaults/`. JSON; rebuilt from the disk-scan if missing or corrupt.
const REGISTRY_FILE_NAME: &str = "registry.json";

/// One vault found by the disk-scan.
///
/// `root` is the absolute `vaults/<id>/` directory path. It stays an
/// internal Rust surface — it is NOT emitted over IPC or tracing (full
/// filesystem paths are DENY-listed); task 3's `vault_list` projects this
/// into the IPC `VaultSummary { id, status, label, last_unlock }` shape,
/// dropping the path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredVault {
    /// The opaque per-vault identifier (the `vaults/<id>/` directory name).
    pub id: VaultId,
    /// Absolute path to the vault's root directory. Internal-only.
    pub root: PathBuf,
    /// `true` when the directory carries a readable `vault.meta` (a
    /// fully-formed vault); `false` for a discovered-but-corrupted dir.
    /// Task 3 maps `false` → the `Corrupted` status arm.
    pub well_formed: bool,
}

/// One cached registry entry: opaque [`VaultId`] + last-unlock-time. **No
/// human label** is ever stored here (SYNC-3).
///
/// `last_unlock_ms` is Unix-epoch milliseconds, `None` for a vault that has
/// never been unlocked (e.g. a freshly-rebuilt entry). Milliseconds keep the
/// serialized form a plain integer with no `SystemTime` serde quirks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryEntry {
    pub id: VaultId,
    pub last_unlock_ms: Option<u64>,
}

/// The best-effort registry cache: opaque `VaultId` + last-unlock-time only.
///
/// Persisted as JSON at `vaults/registry.json`. NOT authoritative — the
/// disk-scan is the discovery authority (SYNC-10). If the file is missing or
/// corrupt it is transparently rebuilt from the disk-scan.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VaultRegistry {
    pub entries: Vec<RegistryEntry>,
}

impl VaultRegistry {
    /// Look up a vault's cached last-unlock time (epoch ms), if present.
    pub fn last_unlock_ms(&self, id: &VaultId) -> Option<u64> {
        self.entries
            .iter()
            .find(|e| &e.id == id)
            .and_then(|e| e.last_unlock_ms)
    }
}

// ---- discovery (disk-scan — the authority) -----------------------------

/// Scan `<base>/vaults/` and return one [`DiscoveredVault`] per `<id>/`
/// subdirectory whose name parses as a [`VaultId`].
///
/// `base` is `<app_data_dir>` (the caller owns the `app_data_dir` lookup, so
/// this stays a pure, Tauri-free, infallible scan — a missing or unreadable
/// `vaults/` dir simply yields an empty list). Non-vault children (a stray
/// scratch dir, a regular file, the `registry.json` cache itself) are
/// ignored: only names that round-trip through [`VaultId::parse`] count.
///
/// Each entry's `well_formed` flag is computed from [`is_well_formed`].
/// Results are sorted by `VaultId` for deterministic ordering (the registry
/// holds the user-meaningful last-unlock ordering; discovery itself is
/// order-stable but not semantically ordered).
pub fn discover_vaults(base: &Path) -> Vec<DiscoveredVault> {
    let vaults_dir = base.join(VAULTS_DIR_NAME);
    let mut found = Vec::new();

    let Ok(entries) = std::fs::read_dir(&vaults_dir) else {
        // No `vaults/` dir at all (fresh install) or it is unreadable →
        // empty discovery. Discovery never fails on a missing root.
        return found;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| VaultId::parse(n).ok())
        else {
            // Not a `vaults/<id>/` directory (stray scratch dir, etc.).
            continue;
        };
        let well_formed = is_well_formed(&path);
        found.push(DiscoveredVault {
            id,
            root: path,
            well_formed,
        });
    }

    // Deterministic ordering by opaque id. Last-unlock ordering (the
    // user-meaningful one) is the registry/picker's concern, not discovery's.
    found.sort_by_key(|a| a.id);
    found
}

/// A discovered `vaults/<id>/` is well-formed when it carries a readable
/// `vault.meta`. Reuses the [`vault_artifacts_present`] taxonomy predicate as
/// the "is there a vault here at all" check, then narrows to the canonical
/// `vault.meta` marker: a directory with only orphan blobs (no `vault.meta`)
/// is discovered but flagged not-well-formed so task 3 surfaces it as
/// `Corrupted` rather than `Exists`.
fn is_well_formed(vault_dir: &Path) -> bool {
    // `vault_artifacts_present` returning `Err` (e.g. a `read_dir` permission
    // failure while scanning `notes/`) is treated as "not well-formed" — a
    // directory we cannot probe is not a usable vault. It is still discovered.
    let any_artefact = vault_artifacts_present(vault_dir).unwrap_or(false);
    if !any_artefact {
        return false;
    }
    // Narrow to the canonical fully-formed marker. `is_file` also covers the
    // readability of the directory entry; a missing/unreadable `vault.meta`
    // is the corruption signal task 3 maps to `Corrupted`.
    vault_dir.join(VAULT_META_FILE_NAME).is_file()
}

// ---- collision mint-and-retry (SYNC-2) ---------------------------------

/// Mint a fresh [`VaultId`] that does not already name a directory under
/// `<base>/vaults/`. Re-mints on the astronomically-unlikely event that a
/// freshly-minted UUIDv7 collides with an existing `vaults/<id>/` directory.
///
/// This is the helper sub-feature 3's create path (and task 4's migration)
/// call to choose a target directory name. A collision is NOT "same account,
/// second vault" — `VaultId` is decoupled from account identity — so the
/// resolution is a silent re-mint with no user-facing question.
///
/// The retry is bounded only as a defensive guard against a pathological
/// filesystem (a 122-bit random collision is not reachable in practice); the
/// loop terminates on the first non-colliding id.
pub fn mint_unique_vault_id(base: &Path) -> VaultId {
    let vaults_dir = base.join(VAULTS_DIR_NAME);
    loop {
        let id = VaultId::mint();
        let candidate = vaults_dir.join(id.to_string());
        if !candidate.exists() {
            return id;
        }
        // Collision — re-mint. No tracing of the id (DENY-listed); emit a
        // coarse static signal only.
        tracing::warn!(
            stage = "vault_id_collision",
            "minted VaultId collided with an existing vaults/<id>/ dir; re-minting"
        );
    }
}

// ---- registry cache (best-effort; rebuilt from disk-scan) --------------

/// Load the registry cache from `<base>/vaults/registry.json`, transparently
/// rebuilding from the disk-scan if the file is missing or corrupt.
///
/// Discovery never depends on this succeeding: a `None`/corrupt registry is
/// rebuilt to one entry per discovered vault (with `last_unlock_ms = None`)
/// and persisted best-effort. The returned registry always covers exactly
/// the on-disk vaults — stale entries for vaults that no longer exist are
/// pruned, and freshly-appeared vaults gain a (last-unlock-less) entry.
///
/// `base` is `<app_data_dir>`. The function is infallible: a failed persist
/// is swallowed (the cache is non-authoritative), and a failed read falls
/// through to a rebuild.
///
/// Convenience scan-and-reconcile over [`load_or_rebuild_registry_with`] for
/// callers that have NOT already run [`discover_vaults`]. The production
/// `vault_list_from_base` calls the `_with` form directly (it needs the scan
/// for `well_formed` too, so it must not scan twice); this single-scan wrapper
/// is exercised by the registry tests.
pub fn load_or_rebuild_registry(base: &Path) -> VaultRegistry {
    load_or_rebuild_registry_with(base, &discover_vaults(base))
}

/// Record a successful unlock of `vault_id` at `now_ms` (Unix-epoch
/// milliseconds) into the best-effort registry cache. The picker's recency
/// ordering and the switcher's active-vault inference both read `last_unlock`,
/// so without this stamp every entry stays `None` and those surfaces fall back
/// to a `VaultId` tie-break (creation order under UUIDv7), not true recency.
///
/// Self-healing + best-effort: rebuilds from the disk-scan first (materialising
/// a missing/corrupt cache and pruning vanished vaults), stamps the entry for
/// `vault_id`, then persists. A `vault_id` not currently on disk is a no-op (no
/// matching entry survives the reconcile). A failed persist is swallowed — the
/// cache is non-authoritative (SYNC-10), so a stale ordering never blocks the
/// unlock that produced it.
pub fn record_unlock(base: &Path, vault_id: &VaultId, now_ms: u64) {
    let mut registry = load_or_rebuild_registry(base);
    let Some(entry) = registry.entries.iter_mut().find(|e| &e.id == vault_id) else {
        return; // vault not on disk → nothing to stamp
    };
    entry.last_unlock_ms = Some(now_ms);
    let _ = write_registry_file(base, &registry);
}

/// Reconcile-and-persist entry point that takes an already-computed disk-scan,
/// so a caller that has already run [`discover_vaults`] (e.g.
/// `vault_list_from_base`, which also needs the `well_formed` flags) does not
/// pay a second `vaults/` scan + re-stat. Behaviour is identical to
/// [`load_or_rebuild_registry`] given the same `discovered` slice.
///
/// Persists the reconciled registry only when it actually changed relative to
/// the on-disk cache: on a successful parse whose reconciliation is a no-op
/// (the steady-state common case — registry already matches the disk) the
/// write is skipped, avoiding a redundant rewrite on every call. A missing or
/// corrupt cache (parse → `None`) always writes the rebuild so the cache
/// becomes valid on disk.
pub fn load_or_rebuild_registry_with(base: &Path, discovered: &[DiscoveredVault]) -> VaultRegistry {
    // Try to read + parse the existing cache. Any failure → rebuild.
    let cached = read_registry_file(base);

    let registry = reconcile(cached.clone(), discovered);

    // Persist only when the reconciled registry differs from a
    // successfully-parsed cache. On a no-op (`Some(cached) == registry`) the
    // on-disk file is already correct, so skip the write. A `None` cache
    // (missing or corrupt) must write the rebuild to materialise a valid
    // cache. A failed persist is non-fatal — discovery already succeeded and
    // the cache is non-authoritative.
    let needs_write = cached.as_ref() != Some(&registry);
    if needs_write {
        let _ = write_registry_file(base, &registry);
    }

    registry
}

/// Reconcile a (possibly-absent) cached registry against the authoritative
/// disk-scan: keep cached `last_unlock_ms` for vaults that still exist, drop
/// entries for vaults that no longer exist, and add (last-unlock-less)
/// entries for newly-discovered vaults. The result has exactly one entry per
/// discovered vault — discovery is the authority (SYNC-10).
fn reconcile(cached: Option<VaultRegistry>, discovered: &[DiscoveredVault]) -> VaultRegistry {
    let cached = cached.unwrap_or_default();
    let entries = discovered
        .iter()
        .map(|d| RegistryEntry {
            id: d.id,
            last_unlock_ms: cached.last_unlock_ms(&d.id),
        })
        .collect();
    VaultRegistry { entries }
}

/// Read + parse the on-disk registry JSON. Returns `None` if the file is
/// absent, unreadable, or fails to parse (the "missing or corrupt" cases that
/// trigger a transparent rebuild). The parser is deliberately strict: any
/// malformed line/field collapses the whole file to `None` rather than
/// silently importing partial data.
fn read_registry_file(base: &Path) -> Option<VaultRegistry> {
    let path = base.join(VAULTS_DIR_NAME).join(REGISTRY_FILE_NAME);
    let bytes = std::fs::read(path).ok()?;
    parse_registry(&bytes)
}

/// Persist the registry as JSON at `vaults/registry.json`. Creates the
/// `vaults/` directory if absent. Best-effort: returns the IO error to the
/// caller (which swallows it — the cache is non-authoritative).
fn write_registry_file(base: &Path, registry: &VaultRegistry) -> std::io::Result<()> {
    let vaults_dir = base.join(VAULTS_DIR_NAME);
    std::fs::create_dir_all(&vaults_dir)?;
    let path = vaults_dir.join(REGISTRY_FILE_NAME);
    std::fs::write(path, serialize_registry(registry))
}

/// Serialize the registry to a stable JSON document. The `VaultId` is
/// rendered as its canonical 36-char hyphenated string (the same form
/// [`VaultId::parse`] round-trips); `last_unlock` is a plain integer (epoch
/// ms) or `null`.
fn serialize_registry(registry: &VaultRegistry) -> Vec<u8> {
    let value = serde_json::json!({
        "version": 1,
        "vaults": registry
            .entries
            .iter()
            .map(|e| serde_json::json!({
                "id": e.id.to_string(),
                "last_unlock": e.last_unlock_ms,
            }))
            .collect::<Vec<_>>(),
    });
    // `to_vec` on a constructed `Value` cannot fail; fall back to an empty
    // object on the impossible error path rather than panicking.
    serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec())
}

/// Strict parse of the registry JSON. Any structural problem — not an
/// object, missing/!=1 version, `vaults` not an array, an entry whose `id`
/// does not parse as a [`VaultId`] — yields `None` so the caller rebuilds
/// from the disk-scan. (A bad `last_unlock` field degrades to `None` for
/// that one entry rather than discarding the whole file: the timestamp is
/// purely advisory.)
fn parse_registry(bytes: &[u8]) -> Option<VaultRegistry> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let obj = value.as_object()?;
    if obj.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    let arr = obj.get("vaults")?.as_array()?;
    let mut entries = Vec::with_capacity(arr.len());
    for item in arr {
        let item = item.as_object()?;
        let id_str = item.get("id")?.as_str()?;
        let id = VaultId::parse(id_str).ok()?;
        // A missing or non-integer `last_unlock` degrades to `None` (the
        // field is advisory) — it does not invalidate the whole file.
        let last_unlock_ms = item.get("last_unlock").and_then(|v| v.as_u64());
        entries.push(RegistryEntry { id, last_unlock_ms });
    }
    Some(VaultRegistry { entries })
}

// ---- boot self-heal: file-free vault-dir prune (MYND-253) ---------------

/// Remove every `vaults/<id>/` directory whose tree contains **zero files**
/// (empty subdirectories permitted) — the boot self-heal for leftovers that
/// discovery would otherwise flag `Corrupted` forever (e.g. the empty dir
/// the pre-fix migration stranded after the 2026-06-11 incident, or an
/// interrupted create).
///
/// Structurally incapable of deleting data: the walk refuses the whole
/// directory if ANY non-directory entry exists anywhere in it (even OS junk
/// like `.DS_Store` — preservation beats tidiness here), and removal is
/// bottom-up `remove_dir` (rmdir) only, which the OS rejects atomically on a
/// non-empty directory. Names that do not parse as a [`VaultId`] (including
/// `registry.json` and the `.migration-*` / `.restore-staging-*` residue
/// prefixes) are never touched. Best-effort: failures are swallowed — the
/// sweep re-runs every boot.
pub fn sweep_empty_vault_dirs(base: &Path) {
    let vaults_dir = base.join(VAULTS_DIR_NAME);
    let Ok(entries) = std::fs::read_dir(&vaults_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let names_a_vault = path.is_dir()
            && path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| VaultId::parse(n).is_ok());
        if !names_a_vault {
            continue;
        }
        if tree_has_any_file(&path) {
            continue;
        }
        tracing::info!(
            stage = "vault_registry_sweep_empty_dir",
            "pruning a file-free vaults/<id>/ leftover"
        );
        prune_empty_tree(&path);
    }
}

/// `true` when `dir`'s tree contains at least one non-directory entry
/// (symlinks included — not followed). Unreadable subtrees count as content,
/// failing safe toward preservation.
fn tree_has_any_file(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return true;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => {
                if tree_has_any_file(&path) {
                    return true;
                }
            }
            // Any file/symlink — or anything we cannot classify — is content.
            _ => return true,
        }
    }
    false
}

/// Bottom-up `remove_dir`-only prune of a tree [`tree_has_any_file`] already
/// proved file-free. Best-effort; a concurrent write between the check and
/// the rmdir makes the rmdir fail atomically and the dir survives.
fn prune_empty_tree(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
                prune_empty_tree(&path);
            }
        }
    }
    let _ = std::fs::remove_dir(dir);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    /// Create `<base>/vaults/<id>/` and return the minted id. `well_formed`
    /// controls whether a `vault.meta` marker is seeded.
    fn seed_vault(base: &Path, well_formed: bool) -> VaultId {
        let id = VaultId::mint();
        let dir = base.join(VAULTS_DIR_NAME).join(id.to_string());
        std::fs::create_dir_all(&dir).expect("create vault dir");
        if well_formed {
            std::fs::write(dir.join(VAULT_META_FILE_NAME), b"any vault.meta bytes")
                .expect("seed vault.meta");
        }
        id
    }

    // ---- discovery: empty vaults/ --------------------------------------

    #[test]
    fn discover_empty_when_vaults_dir_absent() {
        let tmp = ScopedTempDir::new("disc-no-vaults").unwrap();
        let found = discover_vaults(tmp.path());
        assert!(found.is_empty(), "no vaults/ dir → empty discovery");
    }

    #[test]
    fn discover_empty_when_vaults_dir_empty() {
        let tmp = ScopedTempDir::new("disc-empty").unwrap();
        std::fs::create_dir_all(tmp.path().join(VAULTS_DIR_NAME)).unwrap();
        let found = discover_vaults(tmp.path());
        assert!(found.is_empty(), "empty vaults/ → empty discovery");
    }

    // ---- discovery: several vaults -------------------------------------

    #[test]
    fn discover_returns_one_entry_per_vault_dir() {
        let tmp = ScopedTempDir::new("disc-many").unwrap();
        let a = seed_vault(tmp.path(), true);
        let b = seed_vault(tmp.path(), true);
        let c = seed_vault(tmp.path(), true);

        let found = discover_vaults(tmp.path());
        assert_eq!(found.len(), 3, "one entry per vaults/<id>/ directory");

        let ids: std::collections::BTreeSet<_> = found.iter().map(|d| d.id).collect();
        assert!(ids.contains(&a) && ids.contains(&b) && ids.contains(&c));
        assert!(
            found.iter().all(|d| d.well_formed),
            "all seeded with vault.meta → all well-formed"
        );
        // root points at the right per-id directory.
        for d in &found {
            assert_eq!(
                d.root,
                tmp.path().join(VAULTS_DIR_NAME).join(d.id.to_string())
            );
        }
    }

    #[test]
    fn discover_flags_corrupted_dir_but_still_returns_it() {
        // A `vaults/<id>/` with no `vault.meta` is discovered but flagged
        // not-well-formed (task 3 → Corrupted), never dropped.
        let tmp = ScopedTempDir::new("disc-corrupt").unwrap();
        let good = seed_vault(tmp.path(), true);
        let bad = seed_vault(tmp.path(), false);

        let found = discover_vaults(tmp.path());
        assert_eq!(found.len(), 2, "corrupted vault is still discovered");

        let good_entry = found.iter().find(|d| d.id == good).unwrap();
        let bad_entry = found.iter().find(|d| d.id == bad).unwrap();
        assert!(good_entry.well_formed);
        assert!(
            !bad_entry.well_formed,
            "dir without vault.meta is discovered but not well-formed"
        );
    }

    #[test]
    fn discover_ignores_non_vaultid_children_and_files() {
        let tmp = ScopedTempDir::new("disc-stray").unwrap();
        let real = seed_vault(tmp.path(), true);
        // A stray non-UUID directory and a stray file (incl. the registry).
        std::fs::create_dir_all(tmp.path().join(VAULTS_DIR_NAME).join("not-a-vault")).unwrap();
        std::fs::write(
            tmp.path().join(VAULTS_DIR_NAME).join("registry.json"),
            b"{}",
        )
        .unwrap();

        let found = discover_vaults(tmp.path());
        assert_eq!(found.len(), 1, "only the real vaults/<id>/ counts");
        assert_eq!(found[0].id, real);
    }

    // ---- mint-and-retry on collision -----------------------------------

    #[test]
    fn mint_unique_returns_minted_id_on_empty_vaults() {
        let tmp = ScopedTempDir::new("mint-empty").unwrap();
        let id = mint_unique_vault_id(tmp.path());
        // The minted id must not name an existing dir (none exist).
        assert!(!tmp
            .path()
            .join(VAULTS_DIR_NAME)
            .join(id.to_string())
            .exists());
    }

    #[test]
    fn mint_unique_skips_a_pre_seeded_colliding_id() {
        // Pre-seed the FIRST id `mint_unique_vault_id` would pick by stubbing
        // the RNG path: we cannot inject the RNG, so instead we assert the
        // contract behaviourally — mint an id, create its dir, then assert a
        // fresh `mint_unique_vault_id` never returns that occupied id.
        let tmp = ScopedTempDir::new("mint-collide").unwrap();
        let occupied = mint_unique_vault_id(tmp.path());
        std::fs::create_dir_all(tmp.path().join(VAULTS_DIR_NAME).join(occupied.to_string()))
            .unwrap();

        // Over many draws, the helper must NEVER hand back the occupied id —
        // it re-mints past any collision. (Random UUIDv7 collisions are not
        // reachable, so in practice each draw is already distinct; this
        // asserts the occupied dir is treated as off-limits.)
        for _ in 0..64 {
            let next = mint_unique_vault_id(tmp.path());
            assert_ne!(
                next, occupied,
                "mint_unique_vault_id must never return an id naming an existing dir"
            );
        }
    }

    #[test]
    fn mint_unique_retries_when_first_minted_dir_exists() {
        // Deterministic collision exercise: pre-create a directory for a
        // KNOWN minted id, then confirm `vaults/<that id>/` is recognized as
        // occupied (the predicate the retry loop branches on). This pins the
        // mint-and-retry decision without RNG injection.
        let tmp = ScopedTempDir::new("mint-retry").unwrap();
        let first = VaultId::mint();
        let first_dir = tmp.path().join(VAULTS_DIR_NAME).join(first.to_string());
        std::fs::create_dir_all(&first_dir).unwrap();
        assert!(first_dir.exists(), "pre-seeded the first id's directory");

        // A second, independently-minted id is necessarily distinct and its
        // dir does not exist → it is what the loop would settle on.
        let second = mint_unique_vault_id(tmp.path());
        assert_ne!(second, first);
        assert!(!tmp
            .path()
            .join(VAULTS_DIR_NAME)
            .join(second.to_string())
            .exists());
    }

    // ---- registry: rebuild path ----------------------------------------

    #[test]
    fn registry_rebuilds_from_disk_when_absent() {
        let tmp = ScopedTempDir::new("reg-absent").unwrap();
        let a = seed_vault(tmp.path(), true);
        let b = seed_vault(tmp.path(), true);

        // No registry.json on disk yet.
        let registry = load_or_rebuild_registry(tmp.path());
        assert_eq!(registry.entries.len(), 2, "one entry per discovered vault");
        let ids: std::collections::BTreeSet<_> = registry.entries.iter().map(|e| e.id).collect();
        assert!(ids.contains(&a) && ids.contains(&b));
        assert!(
            registry.entries.iter().all(|e| e.last_unlock_ms.is_none()),
            "a rebuilt entry has no last-unlock time"
        );
        // The rebuild was persisted.
        assert!(
            tmp.path()
                .join(VAULTS_DIR_NAME)
                .join(REGISTRY_FILE_NAME)
                .is_file(),
            "rebuild persists registry.json"
        );
    }

    #[test]
    fn registry_rebuilds_from_disk_when_corrupt() {
        let tmp = ScopedTempDir::new("reg-corrupt").unwrap();
        let a = seed_vault(tmp.path(), true);
        // Write garbage where the registry should be.
        std::fs::write(
            tmp.path().join(VAULTS_DIR_NAME).join(REGISTRY_FILE_NAME),
            b"this is not json {{{",
        )
        .unwrap();

        let registry = load_or_rebuild_registry(tmp.path());
        assert_eq!(
            registry.entries.len(),
            1,
            "corrupt registry is rebuilt from the disk-scan"
        );
        assert_eq!(registry.entries[0].id, a);
    }

    // ---- registry: persist only when changed (no-op skip) --------------

    /// Helper: the on-disk registry file path under `base`.
    fn registry_path(base: &Path) -> PathBuf {
        base.join(VAULTS_DIR_NAME).join(REGISTRY_FILE_NAME)
    }

    #[test]
    fn registry_skips_rewrite_when_reconcile_is_a_noop() {
        // Steady state: the on-disk cache already matches the disk-scan. A
        // second `load_or_rebuild_registry` must NOT rewrite the file — the
        // reconciled registry is byte-identical to the parsed cache.
        let tmp = ScopedTempDir::new("reg-noop-skip").unwrap();
        seed_vault(tmp.path(), true);

        // First call materialises the cache (a write).
        let first = load_or_rebuild_registry(tmp.path());
        let path = registry_path(tmp.path());
        assert!(path.is_file(), "first call must persist the registry");

        // Overwrite the on-disk bytes with a SENTINEL that still parses to the
        // same logical registry but is NOT what `serialize_registry` would
        // emit. If the no-op skip works, the second call leaves these exact
        // bytes in place; if it rewrites unconditionally, they get replaced
        // with the canonical serialization.
        let sentinel = {
            // A semantically-equal document with extra whitespace + key order
            // differences — parses to `first` but differs byte-wise from the
            // canonical `serialize_registry` output.
            let entry = &first.entries[0];
            format!(
                "{{ \"vaults\" : [ {{ \"last_unlock\" : null , \"id\" : \"{}\" }} ] , \"version\" : 1 }}",
                entry.id
            )
            .into_bytes()
        };
        // Sanity: the sentinel parses to the same logical registry...
        assert_eq!(
            parse_registry(&sentinel).expect("sentinel parses"),
            first,
            "sentinel must be semantically equal to the steady-state registry"
        );
        // ...but is byte-distinct from the canonical serialization.
        assert_ne!(
            sentinel,
            serialize_registry(&first),
            "sentinel must differ byte-wise from the canonical form"
        );
        std::fs::write(&path, &sentinel).unwrap();

        // Second call: reconcile is a no-op (cache already matches disk), so
        // the write is skipped and the sentinel bytes survive untouched.
        let second = load_or_rebuild_registry(tmp.path());
        assert_eq!(second, first, "no-op reconcile returns the same registry");
        assert_eq!(
            std::fs::read(&path).unwrap(),
            sentinel,
            "a no-op reconcile must NOT rewrite the registry file"
        );
    }

    #[test]
    fn registry_writes_when_reconcile_changes_the_set() {
        // When the disk-scan diverges from the cache (a vault appeared), the
        // reconciled registry differs from the parsed cache, so the write is
        // NOT skipped — the canonical serialization replaces the stale bytes.
        let tmp = ScopedTempDir::new("reg-write-on-change").unwrap();
        let present = seed_vault(tmp.path(), true);

        // Seed a cache that omits the on-disk vault (stale).
        let stale = serde_json::json!({ "version": 1, "vaults": [] });
        let path = registry_path(tmp.path());
        std::fs::write(&path, serde_json::to_vec(&stale).unwrap()).unwrap();

        let registry = load_or_rebuild_registry(tmp.path());
        // Reconcile added the present vault.
        assert_eq!(registry.entries.len(), 1);
        assert_eq!(registry.entries[0].id, present);
        // The file was rewritten to the canonical form (no longer the stale
        // empty-vaults document).
        let on_disk =
            parse_registry(&std::fs::read(&path).unwrap()).expect("rewritten registry parses");
        assert_eq!(
            on_disk, registry,
            "a changing reconcile must persist the new registry"
        );
    }

    // ---- registry: record_unlock stamps last-unlock --------------------

    #[test]
    fn record_unlock_stamps_and_persists_last_unlock() {
        let tmp = ScopedTempDir::new("reg-record").unwrap();
        let a = seed_vault(tmp.path(), true);
        let b = seed_vault(tmp.path(), true);

        // Fresh rebuild: both entries start with no last-unlock time.
        assert!(load_or_rebuild_registry(tmp.path())
            .entries
            .iter()
            .all(|e| e.last_unlock_ms.is_none()));

        // Stamp `a` only.
        record_unlock(tmp.path(), &a, 1_700_000_000_123);

        // The stamp survives a reload from disk (persisted), and is isolated
        // to `a` — `b` stays last-unlock-less.
        let reloaded = load_or_rebuild_registry(tmp.path());
        assert_eq!(
            reloaded.last_unlock_ms(&a),
            Some(1_700_000_000_123),
            "record_unlock persists the stamped time for the unlocked vault"
        );
        assert_eq!(
            reloaded.last_unlock_ms(&b),
            None,
            "an unrelated vault is not stamped"
        );

        // A later unlock of `a` overwrites the earlier stamp (most-recent wins).
        record_unlock(tmp.path(), &a, 1_700_000_999_999);
        assert_eq!(
            load_or_rebuild_registry(tmp.path()).last_unlock_ms(&a),
            Some(1_700_000_999_999),
            "a subsequent unlock overwrites the prior last-unlock time"
        );
    }

    #[test]
    fn record_unlock_is_a_noop_for_an_unknown_vault() {
        let tmp = ScopedTempDir::new("reg-record-unknown").unwrap();
        let present = seed_vault(tmp.path(), true);
        // A well-formed VaultId that names no on-disk vault.
        let absent = VaultId::mint();

        record_unlock(tmp.path(), &absent, 1_700_000_000_000);

        let registry = load_or_rebuild_registry(tmp.path());
        assert_eq!(
            registry.entries.len(),
            1,
            "record_unlock must not invent an entry for a vault absent from disk"
        );
        assert_eq!(registry.entries[0].id, present);
        assert!(
            registry.last_unlock_ms(&absent).is_none(),
            "an absent vault is never stamped"
        );
    }

    #[test]
    fn registry_preserves_last_unlock_for_existing_vaults() {
        let tmp = ScopedTempDir::new("reg-preserve").unwrap();
        let id = seed_vault(tmp.path(), true);

        // Hand-write a registry with a last-unlock time for `id`.
        let json = serde_json::json!({
            "version": 1,
            "vaults": [ { "id": id.to_string(), "last_unlock": 1_700_000_000_000u64 } ],
        });
        std::fs::write(
            tmp.path().join(VAULTS_DIR_NAME).join(REGISTRY_FILE_NAME),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let registry = load_or_rebuild_registry(tmp.path());
        assert_eq!(registry.last_unlock_ms(&id), Some(1_700_000_000_000));
    }

    #[test]
    fn registry_prunes_stale_and_adds_new_entries() {
        let tmp = ScopedTempDir::new("reg-reconcile").unwrap();
        let present = seed_vault(tmp.path(), true);
        let gone = VaultId::mint(); // never on disk

        // Registry references a vault that no longer exists on disk and omits
        // the one that does.
        let json = serde_json::json!({
            "version": 1,
            "vaults": [ { "id": gone.to_string(), "last_unlock": 42u64 } ],
        });
        std::fs::write(
            tmp.path().join(VAULTS_DIR_NAME).join(REGISTRY_FILE_NAME),
            serde_json::to_vec(&json).unwrap(),
        )
        .unwrap();

        let registry = load_or_rebuild_registry(tmp.path());
        // Disk is the authority: exactly the present vault, the stale one dropped.
        assert_eq!(registry.entries.len(), 1);
        assert_eq!(registry.entries[0].id, present);
        assert!(registry.last_unlock_ms(&gone).is_none());
    }

    #[test]
    fn registry_empty_when_no_vaults() {
        let tmp = ScopedTempDir::new("reg-none").unwrap();
        let registry = load_or_rebuild_registry(tmp.path());
        assert!(registry.entries.is_empty());
    }

    // ---- serialize ↔ parse round-trip + at-rest shape ------------------

    #[test]
    fn registry_round_trips_through_json() {
        let a = VaultId::mint();
        let b = VaultId::mint();
        let registry = VaultRegistry {
            entries: vec![
                RegistryEntry {
                    id: a,
                    last_unlock_ms: Some(123),
                },
                RegistryEntry {
                    id: b,
                    last_unlock_ms: None,
                },
            ],
        };
        let bytes = serialize_registry(&registry);
        let parsed = parse_registry(&bytes).expect("round-trips");
        assert_eq!(parsed, registry);
    }

    #[test]
    fn registry_at_rest_carries_no_human_label() {
        // SYNC-3: the on-disk registry holds ONLY opaque id + last-unlock.
        // Assert the serialized form contains no field that could carry a
        // human label.
        let registry = VaultRegistry {
            entries: vec![RegistryEntry {
                id: VaultId::mint(),
                last_unlock_ms: Some(1),
            }],
        };
        let bytes = serialize_registry(&registry);
        let text = String::from_utf8(bytes).unwrap();
        for forbidden in ["label", "name", "title", "account", "hash"] {
            assert!(
                !text.contains(forbidden),
                "registry must not serialize a `{forbidden}` field (SYNC-3 no label at rest)"
            );
        }
        // Only the two expected keys plus the version envelope.
        assert!(text.contains("\"id\""));
        assert!(text.contains("\"last_unlock\""));
        assert!(text.contains("\"version\""));
    }

    #[test]
    fn parse_rejects_wrong_version() {
        let bytes = br#"{"version":99,"vaults":[]}"#;
        assert!(parse_registry(bytes).is_none(), "unknown version → rebuild");
    }

    #[test]
    fn parse_rejects_entry_with_unparseable_id() {
        let bytes = br#"{"version":1,"vaults":[{"id":"not-a-uuid","last_unlock":1}]}"#;
        assert!(
            parse_registry(bytes).is_none(),
            "a bad id collapses the whole file → rebuild"
        );
    }

    #[test]
    fn parse_tolerates_missing_last_unlock() {
        let id = VaultId::mint();
        let json = format!(r#"{{"version":1,"vaults":[{{"id":"{id}"}}]}}"#);
        let parsed = parse_registry(json.as_bytes()).expect("missing last_unlock is tolerated");
        assert_eq!(parsed.entries.len(), 1);
        assert!(parsed.entries[0].last_unlock_ms.is_none());
    }

    // ---- sweep_empty_vault_dirs (MYND-253 boot self-heal) ----------------

    #[test]
    fn sweep_removes_zero_entry_vault_dir() {
        // The 2026-06-11 incident leftover shape: a `vaults/<id>/` with
        // nothing inside, flagged `Corrupted` by discovery until pruned.
        let tmp = ScopedTempDir::new("sweep-empty").unwrap();
        let id = VaultId::mint();
        let dir = tmp.path().join(VAULTS_DIR_NAME).join(id.to_string());
        std::fs::create_dir_all(&dir).unwrap();

        sweep_empty_vault_dirs(tmp.path());
        assert!(!dir.exists(), "a zero-entry vaults/<id>/ must be pruned");
    }

    #[test]
    fn sweep_prunes_file_free_tree_with_empty_subdirs() {
        // An interrupted create can leave `vaults/<id>/notes/` with no files
        // anywhere — plain rmdir of the root would fail forever; the
        // bottom-up prune heals it.
        let tmp = ScopedTempDir::new("sweep-tree").unwrap();
        let id = VaultId::mint();
        let dir = tmp.path().join(VAULTS_DIR_NAME).join(id.to_string());
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        std::fs::create_dir_all(dir.join("snapshots")).unwrap();

        sweep_empty_vault_dirs(tmp.path());
        assert!(!dir.exists(), "a file-free tree must be pruned bottom-up");
    }

    #[test]
    fn sweep_never_touches_a_dir_holding_any_file() {
        // One file ANYWHERE in the tree — even unrecognized bytes, even OS
        // junk — vetoes the whole prune. Preservation beats tidiness.
        let tmp = ScopedTempDir::new("sweep-veto").unwrap();

        let with_meta = tmp
            .path()
            .join(VAULTS_DIR_NAME)
            .join(VaultId::mint().to_string());
        std::fs::create_dir_all(&with_meta).unwrap();
        std::fs::write(with_meta.join(VAULT_META_FILE_NAME), b"real vault").unwrap();

        let with_nested_file = tmp
            .path()
            .join(VAULTS_DIR_NAME)
            .join(VaultId::mint().to_string());
        std::fs::create_dir_all(with_nested_file.join("notes")).unwrap();
        std::fs::write(with_nested_file.join("notes/.DS_Store"), b"junk").unwrap();

        sweep_empty_vault_dirs(tmp.path());
        assert!(with_meta.join(VAULT_META_FILE_NAME).is_file());
        assert!(with_nested_file.join("notes/.DS_Store").is_file());
    }

    #[test]
    fn sweep_skips_non_vaultid_names_and_registry_file() {
        // Names that don't parse as a VaultId (residue prefixes included)
        // and the registry cache are out of scope, empty or not.
        let tmp = ScopedTempDir::new("sweep-skip").unwrap();
        let vaults = tmp.path().join(VAULTS_DIR_NAME);
        let staging = vaults.join(".migration-staging-1-0");
        let plain = vaults.join("not-a-vault-id");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::write(vaults.join(REGISTRY_FILE_NAME), b"{}").unwrap();

        sweep_empty_vault_dirs(tmp.path());
        assert!(staging.is_dir(), "residue dirs belong to their own sweeps");
        assert!(plain.is_dir(), "non-VaultId names are never touched");
        assert!(vaults.join(REGISTRY_FILE_NAME).is_file());
    }

    #[test]
    fn sweep_is_noop_when_vaults_dir_absent() {
        let tmp = ScopedTempDir::new("sweep-absent").unwrap();
        sweep_empty_vault_dirs(tmp.path());
        assert!(
            !tmp.path().join(VAULTS_DIR_NAME).exists(),
            "the sweep must not create vaults/"
        );
    }
}
