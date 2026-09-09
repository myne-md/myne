// SPDX-License-Identifier: AGPL-3.0
//! `.myne-backup` container codec — the read/verify half (spec
//! `docs/spec/protocol.md` §9.11).
//!
//! Moved out of the desktop crate so the `myne-decrypt` CLI can read a backup
//! container without pulling the desktop host. The writer (`write_container`,
//! `PhasedWriter`) and the disk-write restore staging (`extract_all_members`)
//! stay in `src-tauri`, where the export/restore engines live.
//!
//! Members are byte-for-byte ciphertext copies — this module never parses
//! member content and never touches key material.
//!
//! ## Layout (spec §9.11.1 / §9.11.2)
//!
//! ```text
//! Offset  Size  Field              Notes
//! ------  ----  -----------------  -----------------------------------
//! 0       4     magic              ASCII "MYB1"
//! 4       1     protocol_version   0x01
//! 5       1     reserved           0x00 (MUST)
//! 6       4     member_count       N, big-endian u32
//! 10      8     members_total_len  Σ member_len, big-endian u64
//! 18      4     member_table_len   T, big-endian u32
//! 22      T     member table       N records, sorted by raw path bytes
//! 22+T    ...   member data        concatenated, table order
//! ```
//!
//! Record: `path_len (u16 BE) || path || member_len (u64 BE) || sha256`.
//! The SHA-256 covers `path_len || path || member bytes` — path corruption
//! is as detectable as data corruption (§9.11.2 rationale).
//!
//! Per-member caps here are **allocation bounds** (the §9.5.4 discipline);
//! exact per-family enforcement happens in each family's own parser at
//! first unlock. Hashes are unkeyed: corruption detection only, never
//! tamper resistance (§9.11.4; tamper defense = per-blob AEAD).
//!
//! The read half takes `&mut dyn ReadSeek` rather than a `File`, so the
//! CLI can drive it over any seekable reader. No `tracing` in this module —
//! callers own observability and the DENY-list discipline (paths never leave
//! this layer in errors: the error enum carries only `std::io::ErrorKind`).

use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use thiserror::Error;

/// A seekable reader — the object-safe combination of `Read` + `Seek` the
/// container read half is written against. `dyn Read + Seek` is not a valid
/// trait object (only auto-traits may join a second trait), so this named
/// supertrait is the seam. `std::fs::File` implements it.
pub trait ReadSeek: Read + Seek {}
impl<T: Read + Seek> ReadSeek for T {}

/// Magic bytes at offset 0 — ASCII `"MYB1"` (§10.3 registry row).
pub const BACKUP_CONTAINER_MAGIC: [u8; 4] = *b"MYB1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const BACKUP_CONTAINER_PROTOCOL_VERSION: u8 = 0x01;

/// `reserved` byte at offset 5 — MUST be `0x00`.
pub const BACKUP_CONTAINER_RESERVED: u8 = 0x00;

/// Fixed header length (offsets 0..22).
pub const BACKUP_CONTAINER_HEADER_LEN: u64 = 22;

/// §9.11.2: `path_len` MUST be 1..=1024.
pub const MAX_MEMBER_PATH_LEN: usize = 1024;

/// Reference-implementation ceiling on `member_count` (§9.11.6).
pub const MAX_MEMBER_COUNT: u32 = 1 << 20;

/// Reference-implementation ceiling on `member_table_len` (§9.11.6).
pub const MAX_MEMBER_TABLE_LEN: u32 = 16 * 1024 * 1024;

/// Fixed (non-path) bytes of a member-table record:
/// `path_len (2) + member_len (8) + sha256 (32)`.
pub const RECORD_FIXED_LEN: u64 = 42;

/// Streaming copy/hash chunk size.
pub const CHUNK: usize = 64 * 1024;

/// §9.11.3 closed-allowlist member families.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberFamily {
    /// `vault.meta` — REQUIRED member (§9.3 fixed-length layout).
    VaultMeta,
    /// `vault.prefs` (§9.5).
    VaultPrefs,
    /// `vault.dictionary` (§9.13) — personal dictionary, authoritative user
    /// data and a Class-1 sync member, so `sync ⊆ backup` requires it here.
    VaultDictionary,
    /// `vault.themes` (§9.21) — custom-theme palettes (`MYT1`), authoritative
    /// user data and a Class-1 sync member, so `sync ⊆ backup` requires it here
    /// (MYND-486).
    VaultThemes,
    /// `notes/<uuid>.myn` (§9.2).
    Note,
    /// `snapshots/<note-uuid>__<snap-uuid>.myn` (§9.2 envelope).
    Snapshot,
    /// `vault.attachments` catalog (§9.10).
    AttachmentsCatalog,
    /// `attachments/<64-hex attachment id>` (§9.9).
    AttachmentBlob,
}

/// Allocation-bound cap for a member of `family` (§9.11.6 — the exact cap
/// lives in each family's own parser; these bound the container layer's
/// pre-hash work).
pub fn family_member_cap(family: MemberFamily) -> u64 {
    match family {
        // §9.3: fixed-length serialization; anything longer is not a
        // v0.1 vault.meta.
        MemberFamily::VaultMeta => protocol::vault_meta::VAULT_META_LEN as u64,
        // §9.2: 16 MiB plaintext cap + envelope overhead, rounded up.
        MemberFamily::Note | MemberFamily::Snapshot => 17 * 1024 * 1024,
        // §9.5.4: 64 KiB plaintext cap + 34-byte header + 32-byte CTX tag
        // (a strict third-party consumer rejects an over-sized prefs
        // member, so the export must too — adversarial-review F3).
        MemberFamily::VaultPrefs => {
            (protocol::prefs::MAX_PREFS_PLAINTEXT_LEN + protocol::prefs::PREFS_BLOB_HEADER_LEN + 32)
                as u64
        }
        // §9.13.4: 4 MiB plaintext cap + 34-byte header + 32-byte CTX tag
        // (a strict consumer rejects an over-sized dictionary member, so the
        // export must too — mirrors the VaultPrefs bound above).
        MemberFamily::VaultDictionary => {
            (protocol::dictionary_blob::MAX_DICTIONARY_PLAINTEXT_LEN
                + protocol::dictionary_blob::DICTIONARY_BLOB_HEADER_LEN
                + 32) as u64
        }
        // §9.21.4: 4 MiB plaintext cap + 34-byte header + 32-byte CTX tag
        // (a strict consumer rejects an over-sized themes member, so the
        // export must too — mirrors the VaultDictionary bound above).
        MemberFamily::VaultThemes => {
            (protocol::themes_blob::MAX_THEMES_PLAINTEXT_LEN
                + protocol::themes_blob::THEMES_BLOB_HEADER_LEN
                + 32) as u64
        }
        // §9.10.4: 16 MiB catalog ceiling + envelope, rounded up.
        MemberFamily::AttachmentsCatalog => 17 * 1024 * 1024,
        // §9.9: 64 MiB plaintext cap + envelope overhead, rounded up.
        MemberFamily::AttachmentBlob => 65 * 1024 * 1024,
    }
}

/// One member-table record (§9.11.2), in table (= lexicographic) order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberRecord {
    /// Vault-relative member path (allowlist-validated).
    pub path: String,
    /// Member byte length.
    pub len: u64,
    /// SHA-256 over `path_len (2 B BE) || path || member bytes`.
    pub sha256: [u8; 32],
}

/// Closed failure surface for container encode/decode. Carries no path
/// strings and no raw `io::Error` (DENY-list-safe to map upward).
#[derive(Debug, Error, PartialEq, Eq)]
pub enum BackupContainerError {
    /// Shorter than the 22-byte fixed header.
    #[error("backup container too short to parse a header")]
    HeaderTooShort,
    /// Magic is not `MYB1` (a `MYB5` next-major container also lands here; the
    /// caller maps it to migration wording by re-checking the bytes).
    #[error("backup container magic mismatch (expected MYB1)")]
    MagicMismatch,
    /// `protocol_version` byte is not `0x01`.
    #[error("backup container protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `reserved` byte is not `0x00`.
    #[error("backup container reserved byte must be 0x00")]
    ReservedByteNonZero,
    /// `member_count` exceeds [`MAX_MEMBER_COUNT`].
    #[error("backup container member_count exceeds the reference ceiling")]
    MemberCountOverflow,
    /// `member_table_len` exceeds [`MAX_MEMBER_TABLE_LEN`].
    #[error("backup container member table exceeds the reference ceiling")]
    MemberTableOverflow,
    /// A member path violates the §9.11.2 path rules.
    #[error("backup container member path is invalid")]
    PathInvalid,
    /// A member path is outside the §9.11.3 closed allowlist.
    #[error("backup container member path is not allowlisted")]
    PathNotAllowlisted,
    /// Two records carry the same path.
    #[error("backup container has a duplicate member path")]
    DuplicatePath,
    /// Records are not sorted by raw path bytes.
    #[error("backup container member table is not in canonical order")]
    PathOrderViolation,
    /// A `member_len` exceeds its family's allocation bound.
    #[error("backup container member length exceeds its family cap")]
    MemberLenOverflow,
    /// One of the §9.11.6 consistency equations fails (file length,
    /// table length, totals) — covers truncation past the header.
    #[error("backup container length fields are inconsistent")]
    LengthsInconsistent,
    /// A member's recomputed SHA-256 does not match its record.
    #[error("backup container member hash mismatch (file is damaged)")]
    HashMismatch,
    /// The operation was cancelled via [`VerifyHooks::check_cancel`];
    /// the partial output has been removed (SYNC-7: cancel discards).
    #[error("backup container operation cancelled")]
    Cancelled,
    /// Filesystem failure, reduced to the closed kind.
    #[error("backup container io failure")]
    Io(std::io::ErrorKind),
}

impl From<std::io::Error> for BackupContainerError {
    fn from(e: std::io::Error) -> Self {
        BackupContainerError::Io(e.kind())
    }
}

/// Side-channel hooks for the long-running read/verify passes: counts-only
/// progress ticks (`done`, `total`, `phase` — never paths, never ids; the
/// DENY-list discipline) and cooperative cancellation (checked per member and
/// per 64 KiB chunk of deferred-blob streaming).
///
/// Host-free by design: the desktop's `ContainerHooks` (tokio `mpsc` +
/// `AtomicBool`) implements this trait; the CLI supplies a no-op.
pub trait VerifyHooks {
    /// Cooperative cancel check. Return [`BackupContainerError::Cancelled`]
    /// to abort the pass.
    fn check_cancel(&self) -> Result<(), BackupContainerError> {
        Ok(())
    }

    /// Progress tick: `(done_members, total_members, phase)` where phase is
    /// one of `"verify"` / `"restore"`.
    fn tick(&self, _done: u32, _total: u32, _phase: &'static str) {}
}

/// A no-op [`VerifyHooks`] for callers that need neither progress nor cancel.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopHooks;

impl VerifyHooks for NoopHooks {}

/// §9.11.2 path rules: 1..=1024 bytes, UTF-8, `/` separator, no leading
/// `/`, no `.` / `..` segments, no `\`, no empty segment, no NUL.
pub fn validate_member_path(path: &str) -> Result<(), BackupContainerError> {
    let bytes = path.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_MEMBER_PATH_LEN {
        return Err(BackupContainerError::PathInvalid);
    }
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return Err(BackupContainerError::PathInvalid);
    }
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(BackupContainerError::PathInvalid);
        }
    }
    Ok(())
}

/// Strict lowercase-hyphenated UUID check (36 chars, hyphens at 8/13/18/23,
/// lowercase hex elsewhere) — the on-disk filename form for notes and
/// snapshots. Deliberately stricter than `uuid::Uuid::parse_str` (which
/// tolerates uppercase/braced forms that never appear on disk) and
/// deliberately NOT `NoteId::parse` (v7-strict — §9.11.3's grammar carries
/// no version constraint; reusing the v7 validator would silently shrink
/// backup membership).
fn is_disk_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, &c)| match i {
        8 | 13 | 18 | 23 => c == b'-',
        _ => c.is_ascii_digit() || (b'a'..=b'f').contains(&c),
    })
}

fn is_lower_hex(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// §9.11.3 closed allowlist: classify a member path into its blob family,
/// or `None` when the path is not a permitted member (writers MUST NOT
/// include it; readers MUST reject it).
pub fn classify_member_path(path: &str) -> Option<MemberFamily> {
    match path {
        "vault.meta" => return Some(MemberFamily::VaultMeta),
        "vault.prefs" => return Some(MemberFamily::VaultPrefs),
        "vault.dictionary" => return Some(MemberFamily::VaultDictionary),
        "vault.themes" => return Some(MemberFamily::VaultThemes),
        "vault.attachments" => return Some(MemberFamily::AttachmentsCatalog),
        _ => {}
    }
    if let Some(rest) = path.strip_prefix("notes/") {
        let stem = rest.strip_suffix(".myn")?;
        return is_disk_uuid(stem).then_some(MemberFamily::Note);
    }
    if let Some(rest) = path.strip_prefix("snapshots/") {
        let stem = rest.strip_suffix(".myn")?;
        let (note, snap) = stem.split_once("__")?;
        return (is_disk_uuid(note) && is_disk_uuid(snap)).then_some(MemberFamily::Snapshot);
    }
    if let Some(rest) = path.strip_prefix("attachments/") {
        return (rest.len() == 64 && is_lower_hex(rest)).then_some(MemberFamily::AttachmentBlob);
    }
    None
}

/// Seed a hasher with the record's `path_len || path` prefix (§9.11.2).
pub fn path_seeded_hasher(path: &str) -> Sha256 {
    let mut h = Sha256::new();
    h.update((path.len() as u16).to_be_bytes());
    h.update(path.as_bytes());
    h
}

/// Stages 1–3 of container verification (§9.11), shared by the strict and
/// tolerant readers: validate the fixed header (magic / version / reserved /
/// ceilings / the §9.11.6 file-length equation), read the member table, and
/// parse + STRICTLY validate every record (UTF-8 + length-bounded path,
/// allowlist family, canonical lexicographic order, the per-family allocation
/// cap, and the `Σ member_len` / table-consumption equations). Returns the
/// reader positioned at the start of the member DATA region (header + table
/// already consumed) alongside the table-order record set. The per-member DATA
/// hash pass (stage 4) is the caller's — it differs by mode (fail-fast for the
/// strict reader, tolerant-skip for salvage), so it stays out of this shared
/// prefix.
fn open_and_parse_member_table(
    reader: &mut dyn ReadSeek,
) -> Result<Vec<MemberRecord>, BackupContainerError> {
    let file_len = reader.seek(SeekFrom::End(0))?;
    reader.seek(SeekFrom::Start(0))?;
    if file_len < BACKUP_CONTAINER_HEADER_LEN {
        return Err(BackupContainerError::HeaderTooShort);
    }

    // Stage 1: fixed header.
    let mut header = [0u8; BACKUP_CONTAINER_HEADER_LEN as usize];
    reader.read_exact(&mut header)?;
    if header[0..4] != BACKUP_CONTAINER_MAGIC {
        return Err(BackupContainerError::MagicMismatch);
    }
    if header[4] != BACKUP_CONTAINER_PROTOCOL_VERSION {
        return Err(BackupContainerError::ProtocolVersionMismatch);
    }
    if header[5] != BACKUP_CONTAINER_RESERVED {
        return Err(BackupContainerError::ReservedByteNonZero);
    }
    let member_count = u32::from_be_bytes(header[6..10].try_into().expect("4 bytes"));
    let members_total_len = u64::from_be_bytes(header[10..18].try_into().expect("8 bytes"));
    let table_len = u32::from_be_bytes(header[18..22].try_into().expect("4 bytes"));

    // Stage 2: ceilings + the §9.11.6 file-length equation.
    if member_count > MAX_MEMBER_COUNT {
        return Err(BackupContainerError::MemberCountOverflow);
    }
    if table_len > MAX_MEMBER_TABLE_LEN {
        return Err(BackupContainerError::MemberTableOverflow);
    }
    if file_len
        != BACKUP_CONTAINER_HEADER_LEN
            .checked_add(table_len as u64)
            .and_then(|v| v.checked_add(members_total_len))
            .ok_or(BackupContainerError::LengthsInconsistent)?
    {
        return Err(BackupContainerError::LengthsInconsistent);
    }

    // Stage 3: member table.
    let mut table = vec![0u8; table_len as usize];
    reader.read_exact(&mut table)?;
    let mut records: Vec<MemberRecord> = Vec::with_capacity(member_count as usize);
    let mut cursor = 0usize;
    let mut sum_member_len: u64 = 0;
    for _ in 0..member_count {
        let fixed_end = cursor + 2;
        if fixed_end > table.len() {
            return Err(BackupContainerError::LengthsInconsistent);
        }
        let path_len =
            u16::from_be_bytes(table[cursor..fixed_end].try_into().expect("2 bytes")) as usize;
        if path_len == 0 || path_len > MAX_MEMBER_PATH_LEN {
            return Err(BackupContainerError::PathInvalid);
        }
        let rec_end = fixed_end + path_len + 40;
        if rec_end > table.len() {
            return Err(BackupContainerError::LengthsInconsistent);
        }
        let member_path = std::str::from_utf8(&table[fixed_end..fixed_end + path_len])
            .map_err(|_| BackupContainerError::PathInvalid)?
            .to_owned();
        validate_member_path(&member_path)?;
        let family =
            classify_member_path(&member_path).ok_or(BackupContainerError::PathNotAllowlisted)?;
        if let Some(prev) = records.last() {
            match prev.path.as_bytes().cmp(member_path.as_bytes()) {
                std::cmp::Ordering::Less => {}
                std::cmp::Ordering::Equal => return Err(BackupContainerError::DuplicatePath),
                std::cmp::Ordering::Greater => {
                    return Err(BackupContainerError::PathOrderViolation)
                }
            }
        }
        let len = u64::from_be_bytes(
            table[fixed_end + path_len..fixed_end + path_len + 8]
                .try_into()
                .expect("8 bytes"),
        );
        if len > family_member_cap(family) {
            return Err(BackupContainerError::MemberLenOverflow);
        }
        let mut sha256 = [0u8; 32];
        sha256.copy_from_slice(&table[fixed_end + path_len + 8..rec_end]);
        sum_member_len = sum_member_len
            .checked_add(len)
            .ok_or(BackupContainerError::LengthsInconsistent)?;
        records.push(MemberRecord {
            path: member_path,
            len,
            sha256,
        });
        cursor = rec_end;
    }
    if cursor != table.len() || sum_member_len != members_total_len {
        return Err(BackupContainerError::LengthsInconsistent);
    }

    Ok(records)
}

/// Stream `record.len` bytes from `reader`'s CURRENT position in `CHUNK`-sized
/// reads — feeding the §9.11.2 path-seeded hasher and honouring cooperative
/// cancel per chunk — and return the recomputed digest. Advances `reader` past
/// the member's data region (the callers read members back-to-back in table
/// order, so this leaves the cursor at the next member).
fn stream_member_hash(
    reader: &mut dyn ReadSeek,
    record: &MemberRecord,
    buf: &mut [u8],
    hooks: &dyn VerifyHooks,
) -> Result<[u8; 32], BackupContainerError> {
    let mut hasher = path_seeded_hasher(&record.path);
    let mut remaining = record.len;
    while remaining > 0 {
        hooks.check_cancel()?;
        let want = remaining.min(CHUNK as u64) as usize;
        reader.read_exact(&mut buf[..want])?;
        hasher.update(&buf[..want]);
        remaining -= want as u64;
    }
    Ok(hasher.finalize().into())
}

/// `(full table-order records, damaged-member paths)` — see
/// [`read_and_verify_members_tolerant`].
pub type TolerantVerify = (Vec<MemberRecord>, Vec<String>);

/// Tolerant stage-4 verification for the SALVAGE posture (SYNC-5d):
/// container structure (stages 1–3) must hold STRICTLY — a damaged
/// header/table is unsalvageable — but per-member hash failures are
/// collected instead of fatal. Returns the FULL table-order record list
/// (damaged members included — container offsets are computed over the
/// full set) plus the damaged members' paths. Never silently complete:
/// the caller MUST surface `skipped`.
pub fn read_and_verify_members_tolerant(
    reader: &mut dyn ReadSeek,
    hooks: &dyn VerifyHooks,
) -> Result<TolerantVerify, BackupContainerError> {
    // Strict structural pass first (stages 1–3 + equations); the tolerant
    // posture downgrades ONLY per-member hash mismatches (stage 4 below) to
    // `skipped`, never a structural fault.
    let records = open_and_parse_member_table(reader)?;

    // Tolerant stage 4: per-member hash check; failures join `skipped`
    // (the records themselves stay in the full list for offset math).
    let mut skipped: Vec<String> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    let total = records.len() as u32;
    for (done, record) in records.iter().enumerate() {
        hooks.check_cancel()?;
        let got = stream_member_hash(reader, record, &mut buf, hooks)?;
        if got != record.sha256 {
            skipped.push(record.path.clone());
        }
        hooks.tick((done + 1) as u32, total, "verify");
    }
    Ok((records, skipped))
}

/// Per-member absolute data offsets for a verified record set, in table
/// order (data starts at `22 + member_table_len` and members are
/// concatenated without padding — §9.11.1).
pub fn member_data_offsets(records: &[MemberRecord]) -> Vec<u64> {
    let table_len: u64 = records
        .iter()
        .map(|r| RECORD_FIXED_LEN + r.path.len() as u64)
        .sum();
    let mut pos = BACKUP_CONTAINER_HEADER_LEN + table_len;
    records
        .iter()
        .map(|r| {
            let here = pos;
            pos += r.len;
            here
        })
        .collect()
}

/// Extract ONE member's bytes from a container whose `records` were
/// already verified. Intended for small singletons (the restore engine's
/// stage-5 `vault.meta` parse); callers cap via the family bounds, so the
/// full read here is fine.
pub fn extract_member(
    reader: &mut dyn ReadSeek,
    records: &[MemberRecord],
    member_path: &str,
) -> Result<Option<Vec<u8>>, BackupContainerError> {
    let Some(idx) = records.iter().position(|r| r.path == member_path) else {
        return Ok(None);
    };
    let offset = member_data_offsets(records)[idx];
    reader.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0u8; records[idx].len as usize];
    reader.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}

/// Hook-free convenience over [`read_and_verify_container_hooked`] —
/// production export verifies hooked; this serves tests and the restore
/// engine's fixture round-trips (MYND-218).
pub fn read_and_verify_container(
    reader: &mut dyn ReadSeek,
) -> Result<Vec<MemberRecord>, BackupContainerError> {
    read_and_verify_container_hooked(reader, &NoopHooks)
}

/// [`read_and_verify_container`] with progress ticks (`"verify"`, one per
/// member) and cooperative cancellation — the long pass both SYNC-4 ends
/// share (export read-back now; restore pre-placement verify, MYND-218).
pub fn read_and_verify_container_hooked(
    reader: &mut dyn ReadSeek,
    hooks: &dyn VerifyHooks,
) -> Result<Vec<MemberRecord>, BackupContainerError> {
    // Stages 1–3: header + member-table structural verification (shared).
    let records = open_and_parse_member_table(reader)?;

    // Stage 4: streamed hash verification (path prefix + data, §9.11.2).
    // Strict posture — the first mismatch is fatal.
    let mut buf = vec![0u8; CHUNK];
    let total_records = records.len() as u32;
    for (done, record) in records.iter().enumerate() {
        hooks.check_cancel()?;
        let got = stream_member_hash(reader, record, &mut buf, hooks)?;
        if got != record.sha256 {
            return Err(BackupContainerError::HashMismatch);
        }
        hooks.tick((done + 1) as u32, total_records, "verify");
    }
    Ok(records)
}

/// Open a container file at `path` and run `f` over it as a seekable reader.
///
/// The read half is written against `&mut dyn ReadSeek` so the CLI can
/// drive it over any seekable source; this helper is the `std::fs::File`
/// convenience for the desktop callers.
pub fn with_container_file<T>(
    path: &Path,
    f: impl FnOnce(&mut dyn ReadSeek) -> Result<T, BackupContainerError>,
) -> Result<T, BackupContainerError> {
    let mut file = std::fs::File::open(path)?;
    f(&mut file)
}

/// Stream every member of a verified container into `dest_root` at its exact
/// relative path (creating the needed subdirectories). The CLI's container
/// path uses this to materialise a `.myne-backup` into a directory the export
/// walk can then read. Plain writes, no per-file atomicity: the whole staged
/// directory is the atomicity unit.
pub fn extract_all_members(
    reader: &mut dyn ReadSeek,
    records: &[MemberRecord],
    dest_root: &Path,
) -> Result<(), BackupContainerError> {
    let offsets = member_data_offsets(records);
    let mut buf = vec![0u8; CHUNK];
    for (record, offset) in records.iter().zip(&offsets) {
        let dest = dest_root.join(&record.path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        reader.seek(SeekFrom::Start(*offset))?;
        let mut out = std::fs::File::create(&dest)?;
        let mut remaining = record.len;
        while remaining > 0 {
            let want = remaining.min(CHUNK as u64) as usize;
            reader.read_exact(&mut buf[..want])?;
            out.write_all(&buf[..want])?;
            remaining -= want as u64;
        }
        out.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Hand-assemble a minimal container (vault.meta only) in memory and
    /// verify it through a `Cursor` — proving the read half works over any
    /// seekable reader, not just a `File`.
    fn minimal_container() -> Vec<u8> {
        let path = "vault.meta";
        let body = vec![0xABu8; 345];
        let mut hasher = path_seeded_hasher(path);
        hasher.update(&body);
        let sha: [u8; 32] = hasher.finalize().into();

        let mut out = Vec::new();
        out.extend_from_slice(&BACKUP_CONTAINER_MAGIC);
        out.push(BACKUP_CONTAINER_PROTOCOL_VERSION);
        out.push(BACKUP_CONTAINER_RESERVED);
        out.extend_from_slice(&1u32.to_be_bytes());
        out.extend_from_slice(&(body.len() as u64).to_be_bytes());
        let table_len = (RECORD_FIXED_LEN + path.len() as u64) as u32;
        out.extend_from_slice(&table_len.to_be_bytes());
        out.extend_from_slice(&(path.len() as u16).to_be_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&(body.len() as u64).to_be_bytes());
        out.extend_from_slice(&sha);
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn read_half_verifies_a_minimal_container_over_a_cursor() {
        let bytes = minimal_container();
        let mut cursor = Cursor::new(bytes);
        let records = read_and_verify_container(&mut cursor).expect("verify");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].path, "vault.meta");
        assert_eq!(records[0].len, 345);
    }

    #[test]
    fn read_half_extracts_a_member_over_a_cursor() {
        let bytes = minimal_container();
        let mut cursor = Cursor::new(bytes.clone());
        let records = read_and_verify_container(&mut cursor).expect("verify");
        let mut cursor2 = Cursor::new(bytes);
        let meta = extract_member(&mut cursor2, &records, "vault.meta")
            .expect("extract")
            .expect("present");
        assert_eq!(meta, vec![0xABu8; 345]);
    }

    #[test]
    fn read_half_rejects_a_flipped_data_byte() {
        let mut bytes = minimal_container();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        let mut cursor = Cursor::new(bytes);
        assert!(matches!(
            read_and_verify_container(&mut cursor),
            Err(BackupContainerError::HashMismatch)
        ));
    }
}
