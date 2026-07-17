//! `.myne-backup` container codec — spec `docs/spec/protocol.md` §9.11.
//!
//! Single home for the vault-backup container's byte layout: the streaming
//! writer (export side, MYND-32), the read-back verifier (both ends of the
//! SYNC-4 "success = verified" contract), and the §9.11.3 closed-allowlist
//! classifier (shared with the restore engine, MYND-218). Members are
//! byte-for-byte ciphertext copies — this module never parses member
//! content and never touches key material.
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
//! No `tracing` in this module — callers own observability and the
//! DENY-list discipline (paths never leave this layer in errors: the
//! error enum carries only `std::io::ErrorKind`).

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

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
const RECORD_FIXED_LEN: u64 = 42;

/// Streaming copy/hash chunk size.
const CHUNK: usize = 64 * 1024;

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
fn family_member_cap(family: MemberFamily) -> u64 {
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
    /// Magic is not `MYB1` (a `MYB5` v005 container also lands here; the
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
    /// The operation was cancelled via [`ContainerHooks::cancelled`];
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

/// Side-channel hooks for the long-running container passes (SYNC-7):
/// counts-only progress ticks (`done`, `total`, `phase` — never paths,
/// never ids; the DENY-list discipline) and cooperative cancellation
/// (checked per member and per 64 KiB chunk of deferred-blob streaming;
/// a cancelled pass removes its partial output).
#[derive(Default, Clone)]
pub struct ContainerHooks {
    /// Progress sink — `(done_members, total_members, phase)` where phase
    /// is one of `"copy"` (phase one), `"blobs"` (phase two), `"verify"`.
    pub progress: Option<tokio::sync::mpsc::UnboundedSender<(u32, u32, &'static str)>>,
    /// Cooperative cancel flag (set by the `backup_cancel` command).
    pub cancelled: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl ContainerHooks {
    pub(crate) fn tick(&self, done: u32, total: u32, phase: &'static str) {
        if let Some(tx) = &self.progress {
            let _ = tx.send((done, total, phase));
        }
    }

    /// Clear the cooperative cancel flag — each backup operation resets it
    /// at the point the flag becomes "its own" (export: after the permit;
    /// restore: at start). The positions are semantically load-bearing —
    /// see the call sites.
    pub(crate) fn reset_cancel(&self) {
        if let Some(flag) = &self.cancelled {
            flag.store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }

    pub(crate) fn check_cancel(&self) -> Result<(), BackupContainerError> {
        match &self.cancelled {
            Some(flag) if flag.load(std::sync::atomic::Ordering::Relaxed) => {
                Err(BackupContainerError::Cancelled)
            }
            _ => Ok(()),
        }
    }
}

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
fn path_seeded_hasher(path: &str) -> Sha256 {
    let mut h = Sha256::new();
    h.update((path.len() as u16).to_be_bytes());
    h.update(path.as_bytes());
    h
}

/// Write a `.myne-backup` container at `dest` from `members`
/// (`(member_path, source_file)` pairs, any order — the writer sorts).
///
/// Streaming, single read pass: header and a placeholder table are written
/// first, member data is streamed in 64 KiB chunks (hashing as it copies,
/// never buffering a member), then the table and totals are back-patched
/// and the file is `sync_all`'d. On ANY error the partial `dest` is
/// removed — a container file exists only if the write completed (the
/// read-back verification + rename remain the caller's job, per SYNC-4).
///
/// Returns the records in table order.
/// Single-phase convenience: phase one with every member inline + finish.
/// Production export uses the phased pair directly (SYNC-6); this wrapper
/// serves tests and fixture producers (the restore engine's round-trip
/// suite, MYND-218).
#[cfg_attr(not(test), allow(dead_code))]
pub fn write_container(
    dest: &Path,
    members: &[(String, PathBuf)],
) -> Result<Vec<MemberRecord>, BackupContainerError> {
    let all_inline: Vec<(String, PathBuf, bool)> = members
        .iter()
        .map(|(p, s)| (p.clone(), s.clone(), false))
        .collect();
    write_container_phase_one(dest, &all_inline, ContainerHooks::default())?.finish()
}

/// A deferred member awaiting its data copy in [`PhasedWriter::finish`].
struct PendingMember {
    /// Index into [`PhasedWriter::records`].
    record_idx: usize,
    /// Source file (content-addressed, immutable post-ingest).
    source: PathBuf,
    /// Absolute offset of the member's reserved data region.
    data_offset: u64,
}

/// Two-phase container writer (SYNC-6 bounded-lock-hold refinement,
/// MYND-32).
///
/// **Phase one** ([`write_container_phase_one`], run under the writer-
/// quiescence lock): header + full member table + the data bytes of every
/// NON-deferred member, with seek-holes reserved for deferred members at
/// their canonical positions (data order is table order — lexicographic —
/// so `attachments/*` blobs sort FIRST; holes keep the layout exact
/// without copying the big immutable blobs inside the lock window).
/// Deferred members' lengths come from `fs::metadata` — safe because the
/// §9.9 blobs are content-addressed and immutable post-ingest; the only
/// possible mutation is deletion, which surfaces as an honest error in
/// phase two.
///
/// **Phase two** ([`PhasedWriter::finish`], run after the lock drops):
/// stream each deferred member into its reserved hole (hashing as it
/// copies), back-patch its table hash, enforce the exact stat length
/// (a shorter/longer source ⇒ the immutability assumption broke ⇒
/// [`BackupContainerError::LengthsInconsistent`]), then `sync_all`.
///
/// On ANY error in either phase the partial `dest` file is removed.
pub struct PhasedWriter {
    file: File,
    dest: PathBuf,
    records: Vec<MemberRecord>,
    patch_offsets: Vec<u64>,
    pending: Vec<PendingMember>,
    end_offset: u64,
    hooks: ContainerHooks,
}

/// Phase one of the two-phase write. `members` entries are
/// `(member_path, source_file, defer)`; see [`PhasedWriter`].
pub fn write_container_phase_one(
    dest: &Path,
    members: &[(String, PathBuf, bool)],
    hooks: ContainerHooks,
) -> Result<PhasedWriter, BackupContainerError> {
    let result = phase_one_inner(dest, members, hooks);
    if result.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    result
}

fn phase_one_inner(
    dest: &Path,
    members: &[(String, PathBuf, bool)],
    hooks: ContainerHooks,
) -> Result<PhasedWriter, BackupContainerError> {
    // Validate + classify + sort by raw path bytes (canonical order).
    let mut sorted: Vec<(&String, &PathBuf, bool, MemberFamily)> = members
        .iter()
        .map(|(path, src, defer)| {
            validate_member_path(path)?;
            let family =
                classify_member_path(path).ok_or(BackupContainerError::PathNotAllowlisted)?;
            Ok((path, src, *defer, family))
        })
        .collect::<Result<_, BackupContainerError>>()?;
    sorted.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    for pair in sorted.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err(BackupContainerError::DuplicatePath);
        }
    }

    let member_count =
        u32::try_from(sorted.len()).map_err(|_| BackupContainerError::MemberCountOverflow)?;
    if member_count > MAX_MEMBER_COUNT {
        return Err(BackupContainerError::MemberCountOverflow);
    }
    let table_len: u64 = sorted
        .iter()
        .map(|(p, _, _, _)| RECORD_FIXED_LEN + p.len() as u64)
        .sum();
    if table_len > MAX_MEMBER_TABLE_LEN as u64 {
        return Err(BackupContainerError::MemberTableOverflow);
    }

    let mut file = File::create(dest)?;

    // Header with a zero members_total_len placeholder (back-patched at
    // the end of phase one, when every length is known).
    file.write_all(&BACKUP_CONTAINER_MAGIC)?;
    file.write_all(&[BACKUP_CONTAINER_PROTOCOL_VERSION, BACKUP_CONTAINER_RESERVED])?;
    file.write_all(&member_count.to_be_bytes())?;
    file.write_all(&0u64.to_be_bytes())?;
    file.write_all(&(table_len as u32).to_be_bytes())?;

    // Placeholder table: real path fields, zeroed len/sha (back-patched).
    let mut patch_offsets: Vec<u64> = Vec::with_capacity(sorted.len());
    let mut cursor = BACKUP_CONTAINER_HEADER_LEN;
    for (path, _, _, _) in &sorted {
        file.write_all(&(path.len() as u16).to_be_bytes())?;
        file.write_all(path.as_bytes())?;
        file.write_all(&[0u8; 40])?; // member_len (8) + sha256 (32)
        patch_offsets.push(cursor + 2 + path.len() as u64);
        cursor += RECORD_FIXED_LEN + path.len() as u64;
    }

    // Data pass: inline members stream-copy + hash NOW (caps enforced as
    // the bytes flow, never trusting a pre-stat length); deferred members
    // reserve a stat-sized hole (cap-checked) and join `pending`.
    let mut records: Vec<MemberRecord> = Vec::with_capacity(sorted.len());
    let mut pending: Vec<PendingMember> = Vec::new();
    let mut total: u64 = 0;
    let mut pos = BACKUP_CONTAINER_HEADER_LEN + table_len;
    let mut buf = vec![0u8; CHUNK];
    let total_members = sorted.len() as u32;
    for (idx, (path, src, defer, family)) in sorted.iter().enumerate() {
        hooks.check_cancel()?;
        let cap = family_member_cap(*family);
        if *defer {
            let len = std::fs::metadata(src)?.len();
            if len > cap {
                return Err(BackupContainerError::MemberLenOverflow);
            }
            pending.push(PendingMember {
                record_idx: records.len(),
                source: (*src).clone(),
                data_offset: pos,
            });
            records.push(MemberRecord {
                path: (*path).clone(),
                len,
                sha256: [0u8; 32], // patched in finish()
            });
            pos += len;
            total += len;
            file.seek(SeekFrom::Start(pos))?;
            hooks.tick((idx + 1) as u32, total_members, "copy");
            continue;
        }
        let mut hasher = path_seeded_hasher(path);
        let mut reader = File::open(src)?;
        let mut len: u64 = 0;
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            len += n as u64;
            if len > cap {
                return Err(BackupContainerError::MemberLenOverflow);
            }
            hasher.update(&buf[..n]);
            file.write_all(&buf[..n])?;
        }
        pos += len;
        total += len;
        records.push(MemberRecord {
            path: (*path).clone(),
            len,
            sha256: hasher.finalize().into(),
        });
        hooks.tick((idx + 1) as u32, total_members, "copy");
    }
    // A trailing hole (last member deferred) must still materialize the
    // final file length so the §9.11.6 file-length equation holds.
    file.set_len(pos)?;

    // Back-patch the header total + every known len/sha (deferred shas
    // stay zero until finish()).
    file.seek(SeekFrom::Start(10))?;
    file.write_all(&total.to_be_bytes())?;
    for (record, offset) in records.iter().zip(&patch_offsets) {
        file.seek(SeekFrom::Start(*offset))?;
        file.write_all(&record.len.to_be_bytes())?;
        file.write_all(&record.sha256)?;
    }

    Ok(PhasedWriter {
        file,
        dest: dest.to_path_buf(),
        records,
        patch_offsets,
        pending,
        end_offset: pos,
        hooks,
    })
}

impl PhasedWriter {
    /// True when phase one deferred at least one member.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// Phase two: stream every deferred member into its reserved hole,
    /// back-patch its hash, and make the container durable. Consumes the
    /// writer; on error the partial `dest` is removed.
    pub fn finish(self) -> Result<Vec<MemberRecord>, BackupContainerError> {
        let dest = self.dest.clone();
        let result = self.finish_inner();
        if result.is_err() {
            let _ = std::fs::remove_file(&dest);
        }
        result
    }

    fn finish_inner(mut self) -> Result<Vec<MemberRecord>, BackupContainerError> {
        let mut buf = vec![0u8; CHUNK];
        let total_pending = self.pending.len() as u32;
        for (done, pending) in self.pending.iter().enumerate() {
            self.hooks.check_cancel()?;
            let record = &self.records[pending.record_idx];
            let expected = record.len;
            let mut hasher = path_seeded_hasher(&record.path);
            let mut reader = File::open(&pending.source)?;
            self.file.seek(SeekFrom::Start(pending.data_offset))?;
            let mut copied: u64 = 0;
            loop {
                self.hooks.check_cancel()?;
                let n = reader.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                copied += n as u64;
                // A grown source ⇒ the immutability assumption broke
                // between the phase-one stat and now.
                if copied > expected {
                    return Err(BackupContainerError::LengthsInconsistent);
                }
                hasher.update(&buf[..n]);
                self.file.write_all(&buf[..n])?;
            }
            if copied != expected {
                return Err(BackupContainerError::LengthsInconsistent);
            }
            let sha: [u8; 32] = hasher.finalize().into();
            self.records[pending.record_idx].sha256 = sha;
            // Patch this record's sha (len was already written in phase one).
            let sha_offset = self.patch_offsets[pending.record_idx] + 8;
            self.file.seek(SeekFrom::Start(sha_offset))?;
            self.file.write_all(&sha)?;
            self.hooks.tick((done + 1) as u32, total_pending, "blobs");
        }
        debug_assert_eq!(self.file.metadata()?.len(), self.end_offset);
        self.file.sync_all()?;
        Ok(self.records)
    }
}

/// Parse and fully verify a `.myne-backup` container (§9.11.6 stages 1–4):
/// header → caps + consistency equations → member table (path rules,
/// allowlist, canonical order, family caps) → streamed per-member SHA-256.
/// Credential-free by construction. Returns the verified records in table
/// order; the embedded `vault.meta` structural parse (stage 5) is the
/// restore engine's job.
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
/// Stages 1–3 of container verification (§9.11), shared by the strict and
/// tolerant readers: open the file, validate the fixed header (magic /
/// version / reserved / ceilings / the §9.11.6 file-length equation), read
/// the member table, and parse + STRICTLY validate every record (UTF-8 +
/// length-bounded path, allowlist family, canonical lexicographic order, the
/// per-family allocation cap, and the `Σ member_len` / table-consumption
/// equations). Returns the open `File` positioned at the start of the member
/// DATA region (header + table already consumed) alongside the table-order
/// record set. The per-member DATA hash pass (stage 4) is the caller's — it
/// differs by mode (fail-fast for the strict reader, tolerant-skip for
/// salvage), so it stays out of this shared prefix.
fn open_and_parse_member_table(
    path: &Path,
) -> Result<(File, Vec<MemberRecord>), BackupContainerError> {
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < BACKUP_CONTAINER_HEADER_LEN {
        return Err(BackupContainerError::HeaderTooShort);
    }

    // Stage 1: fixed header.
    let mut header = [0u8; BACKUP_CONTAINER_HEADER_LEN as usize];
    file.read_exact(&mut header)?;
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
    file.read_exact(&mut table)?;
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

    Ok((file, records))
}

/// Stream `record.len` bytes from `file`'s CURRENT position in `CHUNK`-sized
/// reads — feeding the §9.11.2 path-seeded hasher and honouring cooperative
/// cancel per chunk — and return the recomputed digest. Advances `file` past
/// the member's data region (the callers read members back-to-back in table
/// order, so this leaves the cursor at the next member).
fn stream_member_hash(
    file: &mut File,
    record: &MemberRecord,
    buf: &mut [u8],
    hooks: &ContainerHooks,
) -> Result<[u8; 32], BackupContainerError> {
    let mut hasher = path_seeded_hasher(&record.path);
    let mut remaining = record.len;
    while remaining > 0 {
        hooks.check_cancel()?;
        let want = remaining.min(CHUNK as u64) as usize;
        file.read_exact(&mut buf[..want])?;
        hasher.update(&buf[..want]);
        remaining -= want as u64;
    }
    Ok(hasher.finalize().into())
}

pub fn read_and_verify_members_tolerant(
    path: &Path,
    hooks: &ContainerHooks,
) -> Result<TolerantVerify, BackupContainerError> {
    // Strict structural pass first (stages 1–3 + equations); the tolerant
    // posture downgrades ONLY per-member hash mismatches (stage 4 below) to
    // `skipped`, never a structural fault.
    let (mut file, records) = open_and_parse_member_table(path)?;

    // Tolerant stage 4: per-member hash check; failures join `skipped`
    // (the records themselves stay in the full list for offset math).
    let mut skipped: Vec<String> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    let total = records.len() as u32;
    for (done, record) in records.iter().enumerate() {
        hooks.check_cancel()?;
        let got = stream_member_hash(&mut file, record, &mut buf, hooks)?;
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
/// already verified by [`read_and_verify_container_hooked`]. Intended for
/// small singletons (the restore engine's stage-5 `vault.meta` parse);
/// callers cap via the family bounds, so the full read here is fine.
pub fn extract_member(
    container: &Path,
    records: &[MemberRecord],
    member_path: &str,
) -> Result<Option<Vec<u8>>, BackupContainerError> {
    let Some(idx) = records.iter().position(|r| r.path == member_path) else {
        return Ok(None);
    };
    let offset = member_data_offsets(records)[idx];
    let mut file = File::open(container)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = vec![0u8; records[idx].len as usize];
    file.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}

/// Stream every member of a verified container into `dest_root` at its
/// exact relative path (creating the needed subdirectories) — the restore
/// engine's staging pass (MYND-218). Per-member `"restore"` progress ticks
/// plus cooperative cancel. Plain writes, no per-file atomicity: the whole
/// staged directory is the atomicity unit. It is invisible to discovery
/// until the single commit rename, and the stale-staging sweep reclaims a
/// crashed pass.
pub fn extract_all_members(
    container: &Path,
    records: &[MemberRecord],
    dest_root: &Path,
    hooks: &ContainerHooks,
    skip: &[String],
) -> Result<(), BackupContainerError> {
    let mut file = File::open(container)?;
    // Offsets are positions in the CONTAINER, so they must be computed
    // over the FULL table-order record set — `skip` (the salvage mode's
    // damaged members, SYNC-5d) only suppresses the write, never the
    // offset accounting.
    let offsets = member_data_offsets(records);
    let total = records.len() as u32;
    let mut buf = vec![0u8; CHUNK];
    for (i, (record, offset)) in records.iter().zip(&offsets).enumerate() {
        hooks.check_cancel()?;
        if skip.iter().any(|s| s == &record.path) {
            hooks.tick((i + 1) as u32, total, "restore");
            continue;
        }
        let dest = dest_root.join(&record.path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        file.seek(SeekFrom::Start(*offset))?;
        let mut out = File::create(&dest)?;
        let mut remaining = record.len;
        while remaining > 0 {
            hooks.check_cancel()?;
            let want = remaining.min(CHUNK as u64) as usize;
            file.read_exact(&mut buf[..want])?;
            out.write_all(&buf[..want])?;
            remaining -= want as u64;
        }
        out.sync_all()?;
        hooks.tick((i + 1) as u32, total, "restore");
    }
    Ok(())
}

/// Hook-free convenience over [`read_and_verify_container_hooked`] —
/// production export verifies hooked; this serves tests and the restore
/// engine's fixture round-trips (MYND-218).
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_and_verify_container(path: &Path) -> Result<Vec<MemberRecord>, BackupContainerError> {
    read_and_verify_container_hooked(path, &ContainerHooks::default())
}

/// [`read_and_verify_container`] with progress ticks (`"verify"`, one per
/// member) and cooperative cancellation — the long pass both SYNC-4 ends
/// share (export read-back now; restore pre-placement verify, MYND-218).
pub fn read_and_verify_container_hooked(
    path: &Path,
    hooks: &ContainerHooks,
) -> Result<Vec<MemberRecord>, BackupContainerError> {
    // Stages 1–3: header + member-table structural verification (shared).
    let (mut file, records) = open_and_parse_member_table(path)?;

    // Stage 4: streamed hash verification (path prefix + data, §9.11.2).
    // Strict posture — the first mismatch is fatal.
    let mut buf = vec![0u8; CHUNK];
    let total_records = records.len() as u32;
    for (done, record) in records.iter().enumerate() {
        hooks.check_cancel()?;
        let got = stream_member_hash(&mut file, record, &mut buf, hooks)?;
        if got != record.sha256 {
            return Err(BackupContainerError::HashMismatch);
        }
        hooks.tick((done + 1) as u32, total_records, "verify");
    }
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;
    use std::fs;
    use std::path::PathBuf;

    /// Fixed member fixtures: a fake vault.meta (345 bytes — §9.3 fixed
    /// length) and two fake notes. Content bytes are arbitrary ciphertext
    /// stand-ins; the container never parses member content.
    fn fixture_members(dir: &ScopedTempDir) -> Vec<(String, PathBuf)> {
        let meta = dir.path().join("vault.meta");
        fs::write(&meta, vec![0xAB; 345]).unwrap();
        let note_a = dir.path().join("a.myn");
        fs::write(&note_a, b"note-a-ciphertext-bytes").unwrap();
        let note_b = dir.path().join("b.myn");
        fs::write(&note_b, vec![0xCD; 4096]).unwrap();
        vec![
            // Deliberately unsorted input: writer must sort by raw path bytes.
            (
                "notes/0190a000-0000-7000-8000-00000000000b.myn".into(),
                note_b,
            ),
            ("vault.meta".into(), meta),
            (
                "notes/0190a000-0000-7000-8000-00000000000a.myn".into(),
                note_a,
            ),
        ]
    }

    fn write_fixture_container(dir: &ScopedTempDir) -> (PathBuf, Vec<MemberRecord>) {
        let dest = dir.path().join("out.myne-backup");
        let records = write_container(&dest, &fixture_members(dir)).expect("write");
        (dest, records)
    }

    // ---- byte layout (§9.11.1 / §9.11.2 pins) --------------------------

    #[test]
    fn header_bytes_pin_spec_9_11_1() {
        let dir = ScopedTempDir::new("bc-header").unwrap();
        let (dest, records) = write_fixture_container(&dir);
        let bytes = fs::read(&dest).unwrap();

        assert_eq!(&bytes[0..4], b"MYB1");
        assert_eq!(bytes[4], 0x01);
        assert_eq!(bytes[5], 0x00);
        // member_count = 3, big-endian u32.
        assert_eq!(&bytes[6..10], &3u32.to_be_bytes());
        // members_total_len = 345 + 23 + 4096.
        let total = 345u64 + 23 + 4096;
        assert_eq!(&bytes[10..18], &total.to_be_bytes());
        // member_table_len = Σ (42 + path_len): two 46-char note paths
        // ("notes/" 6 + uuid 36 + ".myn" 4) + "vault.meta" (10).
        let t = (42 + 46) + (42 + 46) + (42 + 10);
        assert_eq!(&bytes[18..22], &(t as u32).to_be_bytes());
        // File length equation (§9.11.6).
        assert_eq!(bytes.len() as u64, 22 + t as u64 + total);
        // Records sorted lexicographically by raw path bytes: notes/...a.myn,
        // notes/...b.myn, vault.meta ('n' < 'v').
        assert_eq!(
            records[0].path,
            "notes/0190a000-0000-7000-8000-00000000000a.myn"
        );
        assert_eq!(
            records[1].path,
            "notes/0190a000-0000-7000-8000-00000000000b.myn"
        );
        assert_eq!(records[2].path, "vault.meta");
        // First record bytes: path_len BE u16 then path.
        assert_eq!(&bytes[22..24], &(46u16).to_be_bytes());
        assert_eq!(
            &bytes[24..70],
            "notes/0190a000-0000-7000-8000-00000000000a.myn".as_bytes()
        );
    }

    #[test]
    fn same_member_set_encodes_identical_bytes() {
        // Canonical encoding (§9.11.2): two producers with the same member
        // set emit identical bytes regardless of input order.
        let dir = ScopedTempDir::new("bc-canon").unwrap();
        let mut members = fixture_members(&dir);
        let dest_a = dir.path().join("a.myne-backup");
        write_container(&dest_a, &members).expect("write a");
        members.reverse();
        let dest_b = dir.path().join("b.myne-backup");
        write_container(&dest_b, &members).expect("write b");
        assert_eq!(fs::read(&dest_a).unwrap(), fs::read(&dest_b).unwrap());
    }

    // ---- writer rejections (§9.11.2 / §9.11.3) -------------------------

    #[test]
    fn writer_rejects_duplicate_and_invalid_and_unlisted_paths() {
        let dir = ScopedTempDir::new("bc-reject").unwrap();
        let src = dir.path().join("x");
        fs::write(&src, b"x").unwrap();
        let dest = dir.path().join("out");

        let dup = vec![
            ("vault.meta".into(), src.clone()),
            ("vault.meta".into(), src.clone()),
        ];
        assert!(matches!(
            write_container(&dest, &dup),
            Err(BackupContainerError::DuplicatePath)
        ));

        for bad in [
            "/vault.meta",         // leading '/'
            "notes/../vault.meta", // dot segment
            "notes\\a.myn",        // backslash
            "",                    // empty
        ] {
            let m = vec![(bad.to_string(), src.clone())];
            assert!(
                matches!(
                    write_container(&dest, &m),
                    Err(BackupContainerError::PathInvalid)
                ),
                "path {bad:?} must be PathInvalid",
            );
        }

        for unlisted in [
            "vault.search",         // OUT — rebuildable cache
            "vault.meta.tmp",       // *.tmp residue
            "registry.json",        // never a member
            "notes/not-a-uuid.myn", // allowlist pattern mismatch
        ] {
            let m = vec![(unlisted.to_string(), src.clone())];
            assert!(
                matches!(
                    write_container(&dest, &m),
                    Err(BackupContainerError::PathNotAllowlisted)
                ),
                "path {unlisted:?} must be PathNotAllowlisted",
            );
        }
    }

    #[test]
    fn writer_failure_leaves_no_partial_file() {
        let dir = ScopedTempDir::new("bc-cleanup").unwrap();
        let dest = dir.path().join("out.myne-backup");
        // Source file does not exist → Io failure mid-stream.
        let m = vec![("vault.meta".to_string(), dir.path().join("missing-source"))];
        assert!(matches!(
            write_container(&dest, &m),
            Err(BackupContainerError::Io(_))
        ));
        assert!(!dest.exists(), "failed write must not leave a partial file");
    }

    // ---- verifier (§9.11.4 / §9.11.6 pins) -----------------------------

    #[test]
    fn round_trip_verifies_and_returns_records() {
        let dir = ScopedTempDir::new("bc-roundtrip").unwrap();
        let (dest, written) = write_fixture_container(&dir);
        let verified = read_and_verify_container(&dest).expect("verify");
        assert_eq!(verified, written);
    }

    #[test]
    fn flipped_data_byte_is_detected() {
        let dir = ScopedTempDir::new("bc-flip-data").unwrap();
        let (dest, _) = write_fixture_container(&dir);
        let mut bytes = fs::read(&dest).unwrap();
        let last = bytes.len() - 1; // inside the last member's data
        bytes[last] ^= 0x01;
        fs::write(&dest, &bytes).unwrap();
        assert!(matches!(
            read_and_verify_container(&dest),
            Err(BackupContainerError::HashMismatch)
        ));
    }

    #[test]
    fn flipped_but_still_valid_path_byte_is_detected() {
        // The F1 pin: hash covers path_len || path || data, so a corrupted
        // path byte that still parses as allowlist-valid (one hex digit of a
        // UUID, order preserved) MUST fail hash verification — it must never
        // survive to first unlock.
        let dir = ScopedTempDir::new("bc-flip-path").unwrap();
        let (dest, _) = write_fixture_container(&dir);
        let mut bytes = fs::read(&dest).unwrap();
        // First record's path at offset 24..70; flip a UUID hex digit
        // DOWNWARD ('1' → '0' at uuid index 1) so the path stays valid hex
        // AND lexicographically before the second record ("0090…" < the
        // sibling's "0190…") — order and allowlist checks must pass; only
        // the hash may catch this.
        let idx = 24 + 7; // path[7] = uuid char index 1
        assert_eq!(bytes[idx], b'1');
        bytes[idx] = b'0';
        fs::write(&dest, &bytes).unwrap();
        assert!(matches!(
            read_and_verify_container(&dest),
            Err(BackupContainerError::HashMismatch)
        ));
    }

    #[test]
    fn truncation_and_header_tamper_are_detected() {
        let dir = ScopedTempDir::new("bc-tamper").unwrap();
        let (dest, _) = write_fixture_container(&dir);
        let bytes = fs::read(&dest).unwrap();

        // Truncated mid-data.
        fs::write(&dest, &bytes[..bytes.len() - 7]).unwrap();
        assert!(matches!(
            read_and_verify_container(&dest),
            Err(BackupContainerError::LengthsInconsistent)
        ));

        // Bad magic.
        let mut b = bytes.clone();
        b[0] = b'X';
        fs::write(&dest, &b).unwrap();
        assert!(matches!(
            read_and_verify_container(&dest),
            Err(BackupContainerError::MagicMismatch)
        ));

        // v005 reservation refused.
        let mut b = bytes.clone();
        b[3] = b'5'; // "MYB5"
        fs::write(&dest, &b).unwrap();
        assert!(matches!(
            read_and_verify_container(&dest),
            Err(BackupContainerError::MagicMismatch)
        ));

        // Wrong protocol version.
        let mut b = bytes.clone();
        b[4] = 0x02;
        fs::write(&dest, &b).unwrap();
        assert!(matches!(
            read_and_verify_container(&dest),
            Err(BackupContainerError::ProtocolVersionMismatch)
        ));

        // Non-zero reserved byte.
        let mut b = bytes.clone();
        b[5] = 0x01;
        fs::write(&dest, &b).unwrap();
        assert!(matches!(
            read_and_verify_container(&dest),
            Err(BackupContainerError::ReservedByteNonZero)
        ));

        // Tampered members_total_len → consistency equations fail.
        let mut b = bytes.clone();
        b[17] ^= 0x01;
        fs::write(&dest, &b).unwrap();
        assert!(matches!(
            read_and_verify_container(&dest),
            Err(BackupContainerError::LengthsInconsistent)
        ));

        // Too short for a header at all.
        fs::write(&dest, &bytes[..10]).unwrap();
        assert!(matches!(
            read_and_verify_container(&dest),
            Err(BackupContainerError::HeaderTooShort)
        ));
    }

    #[test]
    fn family_member_cap_is_enforced_by_verifier() {
        // A vault.meta member larger than the §9.3 fixed length must reject
        // at the table-parse layer (allocation-bound discipline).
        let dir = ScopedTempDir::new("bc-cap").unwrap();
        let big_meta = dir.path().join("vault.meta");
        fs::write(&big_meta, vec![0xAB; 5000]).unwrap();
        let dest = dir.path().join("out");
        assert!(matches!(
            write_container(&dest, &[("vault.meta".into(), big_meta)]),
            Err(BackupContainerError::MemberLenOverflow)
        ));
    }

    #[test]
    fn oversized_vault_prefs_member_is_rejected() {
        // §9.11.6: member_len MUST NOT exceed the member's own family cap —
        // prefs caps at 64 KiB plaintext + envelope (adversarial-review F3:
        // a generous shared bound would make a strict third-party consumer
        // reject containers this writer produced).
        let dir = ScopedTempDir::new("bc-prefscap").unwrap();
        let meta = dir.path().join("vault.meta");
        fs::write(&meta, vec![0xAB; 345]).unwrap();
        let prefs = dir.path().join("vault.prefs");
        fs::write(&prefs, vec![0x01; 65 * 1024 + 128]).unwrap(); // > 64 KiB + envelope
        let dest = dir.path().join("out");
        assert!(matches!(
            write_container(
                &dest,
                &[("vault.meta".into(), meta), ("vault.prefs".into(), prefs)]
            ),
            Err(BackupContainerError::MemberLenOverflow)
        ));
    }

    #[test]
    fn vault_dictionary_round_trips_as_allowlisted_member() {
        // §9.11.3: vault.dictionary is an IN member (Class-1 sync ⊆ backup).
        // A container carrying it must write, re-verify, and classify cleanly.
        let dir = ScopedTempDir::new("bc-dict").unwrap();
        let meta = dir.path().join("vault.meta");
        fs::write(&meta, vec![0xAB; 345]).unwrap();
        let dict = dir.path().join("vault.dictionary");
        let dict_body = b"dictionary-ciphertext-stand-in".to_vec();
        fs::write(&dict, &dict_body).unwrap();
        let dest = dir.path().join("dict.myne-backup");

        let records = write_container(
            &dest,
            &[
                ("vault.meta".into(), meta),
                ("vault.dictionary".into(), dict),
            ],
        )
        .expect("write with dictionary member");

        // Re-verify from disk (consumer path) and pin the dictionary record.
        let verified = read_and_verify_container(&dest).expect("re-verify");
        assert_eq!(records, verified, "writer records must match verifier");
        let d = verified
            .iter()
            .find(|r| r.path == "vault.dictionary")
            .expect("dictionary member present");
        assert_eq!(d.len, dict_body.len() as u64);
        assert_eq!(
            classify_member_path(&d.path),
            Some(MemberFamily::VaultDictionary)
        );
    }

    #[test]
    fn oversized_vault_dictionary_member_is_rejected() {
        // §9.13.4: dictionary caps at 4 MiB plaintext + envelope; a stricter
        // consumer rejects an over-sized member, so the writer must too
        // (mirrors oversized_vault_prefs_member_is_rejected).
        let dir = ScopedTempDir::new("bc-dictcap").unwrap();
        let meta = dir.path().join("vault.meta");
        fs::write(&meta, vec![0xAB; 345]).unwrap();
        let dict = dir.path().join("vault.dictionary");
        // > 4 MiB + 34-byte header + 32-byte tag.
        fs::write(&dict, vec![0x01; 4 * 1024 * 1024 + 128]).unwrap();
        let dest = dir.path().join("out");
        assert!(matches!(
            write_container(
                &dest,
                &[
                    ("vault.meta".into(), meta),
                    ("vault.dictionary".into(), dict)
                ]
            ),
            Err(BackupContainerError::MemberLenOverflow)
        ));
    }

    #[test]
    fn allowlist_classifier_matches_spec_9_11_3() {
        use MemberFamily::*;
        let cases: &[(&str, Option<MemberFamily>)] = &[
            ("vault.meta", Some(VaultMeta)),
            ("vault.prefs", Some(VaultPrefs)),
            ("vault.dictionary", Some(VaultDictionary)),
            ("vault.themes", Some(VaultThemes)),
            ("vault.attachments", Some(AttachmentsCatalog)),
            ("notes/0190a000-0000-7000-8000-000000000001.myn", Some(Note)),
            (
                "snapshots/0190a000-0000-7000-8000-000000000001__0190a000-0000-7000-8000-000000000002.myn",
                Some(Snapshot),
            ),
            (
                "attachments/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                Some(AttachmentBlob),
            ),
            ("vault.search", None),
            ("vault.workspace", None),
            ("vault.indices", None),
            ("attachments-text/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", None),
            ("notes/whatever.txt", None),
            ("notes/0190a000-0000-7000-8000-000000000001.myn.tmp", None),
            ("attachments/XYZ", None),
            ("snapshots/0190a000-0000-7000-8000-000000000001.myn", None),
        ];
        for (path, want) in cases {
            assert_eq!(classify_member_path(path), *want, "path {path:?}");
        }
    }

    // ---- phased writer (SYNC-6 bounded lock hold) ----------------------

    const BLOB_ID: &str = "abababababababababababababababababababababababababababababababab";

    fn phased_members(dir: &ScopedTempDir) -> Vec<(String, PathBuf, bool)> {
        let meta = dir.path().join("vault.meta");
        fs::write(&meta, vec![0xAB; 345]).unwrap();
        let note = dir.path().join("n.myn");
        fs::write(&note, b"note-bytes").unwrap();
        let blob = dir.path().join("blob");
        fs::write(&blob, vec![0xEE; 100_000]).unwrap();
        vec![
            ("vault.meta".into(), meta, false),
            (
                "notes/0190a000-0000-7000-8000-00000000000a.myn".into(),
                note,
                false,
            ),
            // Deferred immutable blob — sorts FIRST in the data section.
            (format!("attachments/{BLOB_ID}"), blob, true),
        ]
    }

    #[test]
    fn phased_write_equals_inline_write_byte_for_byte() {
        let dir = ScopedTempDir::new("bc-phased-eq").unwrap();
        let members = phased_members(&dir);

        let dest_phased = dir.path().join("phased.myne-backup");
        let writer = write_container_phase_one(&dest_phased, &members, ContainerHooks::default())
            .expect("phase one");
        assert!(writer.has_pending());
        // Deferred record's sha is still zeroed after phase one (the blob
        // bytes were NOT copied inside the lock window).
        assert_eq!(writer.records[0].sha256, [0u8; 32]);
        let records = writer.finish().expect("finish");
        assert_ne!(records[0].sha256, [0u8; 32]);

        let inline: Vec<(String, PathBuf)> = members
            .iter()
            .map(|(p, s, _)| (p.clone(), s.clone()))
            .collect();
        let dest_inline = dir.path().join("inline.myne-backup");
        let inline_records = write_container(&dest_inline, &inline).expect("inline write");

        assert_eq!(records, inline_records);
        assert_eq!(
            fs::read(&dest_phased).unwrap(),
            fs::read(&dest_inline).unwrap(),
            "phased and inline writes must produce identical bytes",
        );
        read_and_verify_container(&dest_phased).expect("phased output verifies");
    }

    #[test]
    fn deferred_source_deleted_mid_copy_fails_honestly() {
        // The grill-ratified tear class: an attachment deleted between the
        // phase-one stat and the phase-two copy must fail the export
        // honestly and leave no partial file.
        let dir = ScopedTempDir::new("bc-phased-del").unwrap();
        let members = phased_members(&dir);
        let dest = dir.path().join("out.myne-backup");
        let writer = write_container_phase_one(&dest, &members, ContainerHooks::default())
            .expect("phase one");
        fs::remove_file(dir.path().join("blob")).unwrap();
        assert!(matches!(
            writer.finish(),
            Err(BackupContainerError::Io(std::io::ErrorKind::NotFound))
        ));
        assert!(!dest.exists(), "failed finish must remove the partial file");
    }

    #[test]
    fn deferred_source_grown_mid_copy_is_rejected() {
        let dir = ScopedTempDir::new("bc-phased-grow").unwrap();
        let members = phased_members(&dir);
        let dest = dir.path().join("out.myne-backup");
        let writer = write_container_phase_one(&dest, &members, ContainerHooks::default())
            .expect("phase one");
        let mut grown = fs::read(dir.path().join("blob")).unwrap();
        grown.extend_from_slice(b"mutated");
        fs::write(dir.path().join("blob"), grown).unwrap();
        assert!(matches!(
            writer.finish(),
            Err(BackupContainerError::LengthsInconsistent)
        ));
        assert!(!dest.exists());
    }

    // ---- companion test vectors (MYND-254) -----------------------------
    //
    // The `backup-container` family is the first whose generator + runner
    // live OUTSIDE the protocol crate: the codec is std/fs/streaming-bound
    // (file-path API, tokio hooks) and cannot move into the no_std
    // protocol crate, so the vectors are minted and verified here. Both
    // follow the protocol/tests/vectors.rs conventions: skip-if-missing
    // runner, lowercase hex, `vector_id` uniqueness, coverage floors.

    fn hex_encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            out.push_str(&format!("{b:02x}"));
        }
        out
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        assert!(
            s.bytes().all(|b| b.is_ascii_hexdigit()),
            "hex string must contain only ASCII hex digits, got {s:?}"
        );
        assert!(s.len().is_multiple_of(2), "hex string length must be even");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("ASCII-hex pre-validated"))
            .collect()
    }

    /// Map a `MemberFamily` to the vector family string (schema enum).
    fn family_str(family: MemberFamily) -> &'static str {
        match family {
            MemberFamily::VaultMeta => "vault-meta",
            MemberFamily::VaultPrefs => "vault-prefs",
            MemberFamily::VaultDictionary => "vault-dictionary",
            MemberFamily::VaultThemes => "vault-themes",
            MemberFamily::Note => "note",
            MemberFamily::Snapshot => "snapshot",
            MemberFamily::AttachmentsCatalog => "attachments-catalog",
            MemberFamily::AttachmentBlob => "attachment-blob",
        }
    }

    /// Hand-assemble `header || table || data` with caller-chosen header
    /// fields — for fixtures `write_container` refuses to produce
    /// (non-canonical tables, hostile ceilings).
    fn raw_container(
        member_count: u32,
        members_total_len: u64,
        member_table_len: u32,
        table: &[u8],
        data: &[u8],
    ) -> Vec<u8> {
        let mut out = Vec::with_capacity(22 + table.len() + data.len());
        out.extend_from_slice(&BACKUP_CONTAINER_MAGIC);
        out.push(BACKUP_CONTAINER_PROTOCOL_VERSION);
        out.push(BACKUP_CONTAINER_RESERVED);
        out.extend_from_slice(&member_count.to_be_bytes());
        out.extend_from_slice(&members_total_len.to_be_bytes());
        out.extend_from_slice(&member_table_len.to_be_bytes());
        out.extend_from_slice(table);
        out.extend_from_slice(data);
        out
    }

    /// One §9.11.2 record: `path_len (u16 BE) || path || member_len (u64
    /// BE) || sha256`.
    fn raw_record(path: &str, member_len: u64, sha256: &[u8; 32]) -> Vec<u8> {
        let mut out = Vec::with_capacity(RECORD_FIXED_LEN as usize + path.len());
        out.extend_from_slice(&(path.len() as u16).to_be_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&member_len.to_be_bytes());
        out.extend_from_slice(sha256);
        out
    }

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/backup-container/v0.1/cases.json` as a
    /// pretty-printed JSON file at
    /// `/tmp/myne_backup_container_vectors.json`, ready to copy verbatim
    /// into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a
    /// side effect of `cargo test`. Run with:
    /// `cargo test -p myne-desktop --lib emit_backup_container_vectors_for_paste -- --ignored`
    ///
    /// 32 cases pin (MYND-254 / §9.11), self-asserted at mint:
    /// - 2 `encode` — deterministic member-set → container bytes:
    ///   minimal (vault.meta only) + full-allowlist (one member per
    ///   §9.11.3 family, input deliberately UNSORTED to pin writer-sorts
    ///   canonical raw-byte lexicographic order).
    /// - 2 `verify_ok` — the same two containers parsed back to their
    ///   `(path, len, sha256)` record triples; the sha256 values
    ///   independently pin the §9.11.2 hash formula
    ///   `SHA-256(path_len_be16 || path || member_bytes)`.
    /// - 14 `verify_fail` — every vectorable `BackupContainerError`
    ///   variant (13) + the MYB5 v005-reservation magic case. The two
    ///   ceiling cases are 22-byte header-only files, pinning the
    ///   §9.11.6 stage order (ceilings BEFORE the file-length equation).
    /// - 14 `classify_path` — the §9.11.3 closed-allowlist grammar from
    ///   BOTH directions: one accept per family + 8 load-bearing rejects
    ///   (reserved-out singletons, *.tmp, vault-external, uppercase /
    ///   wrong-length hex, malformed snapshot pair).
    ///
    /// `Cancelled` + `Io` are runtime conditions, not byte-derivable —
    /// not vectored (documented in the category's `schema.md`).
    #[test]
    #[ignore]
    fn emit_backup_container_vectors_for_paste() {
        fn json_escape(input: &str) -> String {
            let mut out = String::with_capacity(input.len() + 2);
            for c in input.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => {
                        out.push_str(&format!("\\u{:04x}", c as u32));
                    }
                    c => out.push(c),
                }
            }
            out
        }

        let dir = ScopedTempDir::new("bc-vectors").unwrap();

        // ---- encode fixtures ----------------------------------------
        // Member bodies are arbitrary ciphertext stand-ins — the
        // container never parses member content (§9.11.4 scope).
        const ATT_ID: &str = "abababababababababababababababababababababababababababababababab";
        let note_path = "notes/0190a000-0000-7000-8000-00000000000a.myn";
        let snap_path =
            "snapshots/0190a000-0000-7000-8000-00000000000a__0190a000-0000-7000-8000-00000000000b.myn";
        let att_path = format!("attachments/{ATT_ID}");

        let member_bodies: Vec<(&str, Vec<u8>)> = vec![
            ("vault.meta", vec![0xAB; 345]),
            ("vault.prefs", b"prefs-ciphertext-stand-in".to_vec()),
            (note_path, b"note-ciphertext-stand-in".to_vec()),
            (snap_path, b"snapshot-ciphertext-stand-in".to_vec()),
            ("vault.attachments", b"catalog-ciphertext-stand-in".to_vec()),
            (&att_path, vec![0xEE; 32]),
        ];
        let body_of = |path: &str| -> &[u8] {
            &member_bodies
                .iter()
                .find(|(p, _)| *p == path)
                .expect("known member path")
                .1
        };
        // Write each body to a temp source file.
        let src_of = |idx: usize, body: &[u8]| -> PathBuf {
            let src = dir.path().join(format!("m{idx}"));
            fs::write(&src, body).unwrap();
            src
        };
        let sources: Vec<PathBuf> = member_bodies
            .iter()
            .enumerate()
            .map(|(i, (_, body))| src_of(i, body))
            .collect();

        // Minimal: vault.meta only.
        let minimal_members: Vec<(String, PathBuf)> =
            vec![("vault.meta".into(), sources[0].clone())];
        let minimal_dest = dir.path().join("minimal.myne-backup");
        let minimal_records = write_container(&minimal_dest, &minimal_members).expect("minimal");
        let minimal_bytes = fs::read(&minimal_dest).unwrap();
        assert_eq!(minimal_bytes.len(), 22 + 52 + 345, "minimal layout pin");

        // Full allowlist: one member per family, input DELIBERATELY
        // unsorted (the writer sorts by raw path bytes).
        let full_members_unsorted: Vec<(String, PathBuf)> = vec![
            ("vault.meta".into(), sources[0].clone()),
            (snap_path.into(), sources[3].clone()),
            (att_path.clone(), sources[5].clone()),
            ("vault.prefs".into(), sources[1].clone()),
            (note_path.into(), sources[2].clone()),
            ("vault.attachments".into(), sources[4].clone()),
        ];
        let full_dest = dir.path().join("full.myne-backup");
        let full_records = write_container(&full_dest, &full_members_unsorted).expect("full");
        let full_bytes = fs::read(&full_dest).unwrap();
        // Canonical order pin: attachments/* < notes/* < snapshots/* <
        // vault.attachments < vault.meta < vault.prefs.
        let expected_order: Vec<&str> = vec![
            &att_path,
            note_path,
            snap_path,
            "vault.attachments",
            "vault.meta",
            "vault.prefs",
        ];
        assert_eq!(
            full_records
                .iter()
                .map(|r| r.path.as_str())
                .collect::<Vec<_>>(),
            expected_order,
            "writer must sort members by raw path bytes",
        );

        // ---- verify_fail fixtures (self-asserted below) --------------
        let zero_sha = [0u8; 32];

        let vf_header_short = minimal_bytes[..10].to_vec();
        let mut vf_magic = minimal_bytes.clone();
        vf_magic[0] = b'X';
        let mut vf_myb5 = minimal_bytes.clone();
        vf_myb5[3] = b'5'; // "MYB5"
        let mut vf_version = minimal_bytes.clone();
        vf_version[4] = 0x02;
        let mut vf_reserved = minimal_bytes.clone();
        vf_reserved[5] = 0x01;
        // 22-byte header-only files: ceilings fire BEFORE the file-length
        // equation (§9.11.6 stage order pin).
        let vf_count_overflow = raw_container(MAX_MEMBER_COUNT + 1, 0, 0, &[], &[]);
        let vf_table_overflow = raw_container(1, 0, MAX_MEMBER_TABLE_LEN + 1, &[], &[]);
        // Hand-assembled tables the writer refuses to produce.
        let rec_traversal = raw_record("..", 0, &zero_sha);
        let vf_path_invalid = raw_container(1, 0, rec_traversal.len() as u32, &rec_traversal, &[]);
        let rec_search = raw_record("vault.search", 0, &zero_sha);
        let vf_not_allowlisted = raw_container(1, 0, rec_search.len() as u32, &rec_search, &[]);
        let rec_meta_empty = raw_record("vault.meta", 0, &zero_sha);
        let mut dup_table = rec_meta_empty.clone();
        dup_table.extend_from_slice(&rec_meta_empty);
        let vf_duplicate = raw_container(2, 0, dup_table.len() as u32, &dup_table, &[]);
        let rec_prefs_empty = raw_record("vault.prefs", 0, &zero_sha);
        let mut misorder_table = rec_prefs_empty.clone();
        misorder_table.extend_from_slice(&rec_meta_empty);
        let vf_order = raw_container(2, 0, misorder_table.len() as u32, &misorder_table, &[]);
        // vault.meta declared + carried at 346 bytes: the equations hold,
        // the §9.3-derived family cap (<= 345) fires at table parse.
        let rec_meta_346 = raw_record("vault.meta", 346, &zero_sha);
        let vf_len_overflow = raw_container(
            1,
            346,
            rec_meta_346.len() as u32,
            &rec_meta_346,
            &vec![0xAB; 346],
        );
        let vf_lengths = minimal_bytes[..minimal_bytes.len() - 1].to_vec();
        let mut vf_hash = minimal_bytes.clone();
        let last = vf_hash.len() - 1;
        vf_hash[last] ^= 0x01;

        let verify_fail_cases: Vec<(&str, &str, &Vec<u8>, BackupContainerError)> = vec![
            (
                "verify-fail-header-too-short",
                "First 10 bytes of the minimal container — no room for the 22-byte fixed header. Rejected before any field read (§9.11.6 stage 1).",
                &vf_header_short,
                BackupContainerError::HeaderTooShort,
            ),
            (
                "verify-fail-magic-mismatch",
                "First byte of the MYB1 magic corrupted to 'X'. Rejected at offset 0 before any other work (§9.11.6 stage 1).",
                &vf_magic,
                BackupContainerError::MagicMismatch,
            ),
            (
                "verify-fail-magic-myb5-reserved",
                "Magic reads 'MYB5' — the reserved v005 container magic (§10.3). A v0.1 consumer MUST reject it; it collapses to the same magic_mismatch variant (the caller re-checks the bytes to phrase a migration prompt, §9.11.6).",
                &vf_myb5,
                BackupContainerError::MagicMismatch,
            ),
            (
                "verify-fail-protocol-version-mismatch",
                "protocol_version byte (offset 4) set to 0x02 instead of 0x01 (§9.11.6 stage 1).",
                &vf_version,
                BackupContainerError::ProtocolVersionMismatch,
            ),
            (
                "verify-fail-reserved-byte-nonzero",
                "reserved byte (offset 5) set to 0x01 — §9.11.1 says MUST be 0x00.",
                &vf_reserved,
                BackupContainerError::ReservedByteNonZero,
            ),
            (
                "verify-fail-member-count-overflow",
                "22-byte header-only file advertising member_count = 2^20 + 1 (above the §9.11.6 reference ceiling) with zero totals. The ceiling check fires at stage 2 BEFORE the file-length equation — this case pins the validation order, not just the variant.",
                &vf_count_overflow,
                BackupContainerError::MemberCountOverflow,
            ),
            (
                "verify-fail-member-table-overflow",
                "22-byte header-only file advertising member_table_len = 16 MiB + 1 (above the §9.11.6 reference ceiling). A port that checks the file-length equation first would mislabel this lengths_inconsistent — the ceiling MUST fire first (stage-order pin).",
                &vf_table_overflow,
                BackupContainerError::MemberTableOverflow,
            ),
            (
                "verify-fail-path-invalid",
                "Hand-assembled single-member container whose record path is '..' (a dot segment, §9.11.2 path-rule violation; the traversal pin). Length equations hold; the path rules fire at table parse (stage 3).",
                &vf_path_invalid,
                BackupContainerError::PathInvalid,
            ),
            (
                "verify-fail-path-not-allowlisted",
                "Hand-assembled single-member container whose record path is 'vault.search' — structurally a valid path but reserved OUT of the §9.11.3 closed allowlist (rebuildable cache). Readers MUST reject, not skip.",
                &vf_not_allowlisted,
                BackupContainerError::PathNotAllowlisted,
            ),
            (
                "verify-fail-duplicate-path",
                "Hand-assembled container with two identical 'vault.meta' records. Duplicates MUST reject (§9.11.2).",
                &vf_duplicate,
                BackupContainerError::DuplicatePath,
            ),
            (
                "verify-fail-path-order-violation",
                "Hand-assembled container whose records appear as vault.prefs then vault.meta — violating the canonical raw-path-byte lexicographic order ('vault.meta' < 'vault.prefs', §9.11.2).",
                &vf_order,
                BackupContainerError::PathOrderViolation,
            ),
            (
                "verify-fail-member-len-overflow",
                "vault.meta member declared AND carried at 346 bytes — one over the §9.3-derived family cap (<= 345 at the container layer; the exact-345 structural check is the restore engine's stage 5). The length equations hold, so only the family-cap check (stage 3) can reject.",
                &vf_len_overflow,
                BackupContainerError::MemberLenOverflow,
            ),
            (
                "verify-fail-lengths-inconsistent",
                "The minimal container truncated by one byte: file_length no longer equals 22 + member_table_len + members_total_len (§9.11.6 stage 2). Covers any truncation past the header.",
                &vf_lengths,
                BackupContainerError::LengthsInconsistent,
            ),
            (
                "verify-fail-hash-mismatch",
                "Last data byte of the minimal container XOR 0x01. Header, table and equations all hold; only the streamed per-member SHA-256 (stage 4) catches it. Unkeyed hash — corruption detection, NOT tamper resistance (§9.11.4).",
                &vf_hash,
                BackupContainerError::HashMismatch,
            ),
        ];

        // ---- classify_path fixtures -----------------------------------
        let classify_cases: Vec<(&str, &str, &str, &str)> = vec![
            (
                "classify-vault-meta",
                "vault.meta — the REQUIRED member (§9.11.3).",
                "vault.meta",
                "vault-meta",
            ),
            (
                "classify-vault-prefs",
                "vault.prefs — IN when present (§9.11.3).",
                "vault.prefs",
                "vault-prefs",
            ),
            (
                "classify-note",
                "notes/<uuid>.myn with a strict lowercase-hyphenated disk-format UUID (36 chars, hyphens at 8/13/18/23). Filenames are AAD-load-bearing — a renamed member fails AEAD at first unlock.",
                "notes/0190a000-0000-7000-8000-000000000001.myn",
                "note",
            ),
            (
                "classify-snapshot",
                "snapshots/<note-uuid>__<snap-uuid>.myn — two disk-format UUIDs joined by a double underscore.",
                "snapshots/0190a000-0000-7000-8000-000000000001__0190a000-0000-7000-8000-000000000002.myn",
                "snapshot",
            ),
            (
                "classify-attachments-catalog",
                "vault.attachments — the §9.10 catalog singleton, IN when present.",
                "vault.attachments",
                "attachments-catalog",
            ),
            (
                "classify-attachment-blob",
                "attachments/<64-lowercase-hex> — content-addressed §9.9 blob id (the filename IS the content address; load-bearing).",
                "attachments/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "attachment-blob",
            ),
            (
                "classify-reject-vault-search",
                "vault.search is reserved OUT (§9.11.3) — a rebuildable cache; including it would only grow the container.",
                "vault.search",
                "rejected",
            ),
            (
                "classify-reject-vault-workspace",
                "vault.workspace is reserved OUT (§9.11.3) — session state, rebuildable by design (§9.7.4 fall-back-to-default).",
                "vault.workspace",
                "rejected",
            ),
            (
                "classify-reject-registry-json",
                "registry.json lives OUTSIDE the vault root (per-install plaintext) — never a member.",
                "registry.json",
                "rejected",
            ),
            (
                "classify-reject-tmp-residue",
                "A *.tmp atomic-write residue under notes/ — excluded by the closed grammar (the '.myn' suffix match is exact).",
                "notes/0190a000-0000-7000-8000-000000000001.myn.tmp",
                "rejected",
            ),
            (
                "classify-reject-uppercase-attachment-hex",
                "attachments/<64-UPPERCASE-hex> — attachment ids are lowercase hex on disk; the grammar is case-sensitive.",
                "attachments/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
                "rejected",
            ),
            (
                "classify-reject-short-attachment-hex",
                "attachments/<63-hex> — the id MUST be exactly 64 hex chars (a 32-byte content address).",
                "attachments/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde",
                "rejected",
            ),
            (
                "classify-reject-uppercase-uuid",
                "notes/<UPPERCASE-uuid>.myn — disk-format UUIDs are strict lowercase; uuid-library leniency (uppercase/braced forms) MUST NOT leak into the grammar.",
                "notes/0190A000-0000-7000-8000-000000000001.myn",
                "rejected",
            ),
            (
                "classify-reject-snapshot-missing-pair",
                "snapshots/<uuid>.myn without the '__<snap-uuid>' pair — the snapshot grammar requires both UUIDs.",
                "snapshots/0190a000-0000-7000-8000-000000000001.myn",
                "rejected",
            ),
        ];

        // ---- self-assertions at mint ----------------------------------
        let scratch = dir.path().join("scratch.bin");
        for (slug, _, bytes, expected) in &verify_fail_cases {
            fs::write(&scratch, bytes).unwrap();
            match read_and_verify_container(&scratch) {
                Err(e) if e == *expected => {}
                other => panic!("{slug}: expected Err({expected:?}), got {other:?}"),
            }
        }
        for (slug, _, path, family) in &classify_cases {
            let got = validate_member_path(path)
                .ok()
                .and_then(|()| classify_member_path(path))
                .map(family_str)
                .unwrap_or("rejected");
            assert_eq!(got, *family, "{slug}: classifier disagrees at mint");
        }
        let verified_minimal = read_and_verify_container(&minimal_dest).expect("minimal verifies");
        assert_eq!(verified_minimal, minimal_records);
        let verified_full = read_and_verify_container(&full_dest).expect("full verifies");
        assert_eq!(verified_full, full_records);

        // ---- emission --------------------------------------------------
        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"backup-container\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.11\",\n");
        dump.push_str("  \"description\": \"Pins the MYB1 .myne-backup container codec (MYND-254; codec landed MYND-217, spec §9.11): write_container + read_and_verify_container + the §9.11.3 closed-allowlist classifier in src-tauri/src/backup_container.rs (package myne-desktop — the first family whose reference implementation lives OUTSIDE the protocol crate; the codec is std/fs-bound by design). The container is a credential-free, UNKEYED integrity layer: per-member SHA-256 over path_len_be16 || path || member_bytes detects accidental corruption, never tampering (tamper defense = per-blob AEAD). Member content is opaque at this layer; vault.meta presence + exact-345 structural parse is the restore engine's stage 5 and is deliberately NOT vectored here. 32 cases: 2 encode (minimal vault.meta-only + full-allowlist; input member order is deliberately UNSORTED — the writer must sort by raw path bytes, so same member set always yields identical container bytes) + 2 verify_ok (records with independently checkable sha256_hex) + 14 verify_fail (all 13 vectorable BackupContainerError variants + the MYB5 v005-reservation magic case; the two ceiling cases are 22-byte header-only files pinning the §9.11.6 stage order: ceilings BEFORE the file-length equation) + 14 classify_path (one accept per family + 8 load-bearing rejects). Cases generated by `cargo test -p myne-desktop --lib emit_backup_container_vectors_for_paste -- --ignored` (in src-tauri/src/backup_container.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        let emit_encode = |dump: &mut String,
                           slug: &str,
                           description: &str,
                           members: &[(String, PathBuf)],
                           container: &[u8]| {
            dump.push_str("    {\n");
            dump.push_str(&format!(
                "      \"vector_id\": \"backup-container/v0.1/{slug}\",\n"
            ));
            dump.push_str(&format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"encode\",\n");
            dump.push_str("      \"input_members\": [\n");
            for (i, (path, _)) in members.iter().enumerate() {
                dump.push_str(&format!(
                    "        {{ \"path\": \"{}\", \"bytes_hex\": \"{}\" }}{}\n",
                    json_escape(path),
                    hex_encode(body_of(path)),
                    if i + 1 == members.len() { "" } else { "," }
                ));
            }
            dump.push_str("      ],\n");
            dump.push_str(&format!(
                "      \"expected_container_hex\": \"{}\"\n",
                hex_encode(container)
            ));
            dump.push_str("    },\n");
        };

        emit_encode(
            &mut dump,
            "encode-minimal-vault-meta-only",
            "The smallest valid container: the single REQUIRED member vault.meta (345 bytes, §9.3 fixed length; content is an opaque 0xAB fill — the container never parses member bytes). Layout: 22-byte header + one 52-byte record (42 fixed + 10-byte path) + 345 data bytes = 419 total.",
            &minimal_members,
            &minimal_bytes,
        );
        emit_encode(
            &mut dump,
            "encode-full-allowlist-canonical-order",
            "One member per §9.11.3 family, presented in DELIBERATELY unsorted input order. The writer MUST sort records by raw path bytes (attachments/* < notes/* < snapshots/* < vault.attachments < vault.meta < vault.prefs) and lay data in table order — so the same member set always encodes to identical bytes regardless of input order (§9.11.2 canonical-encoding pin).",
            &full_members_unsorted,
            &full_bytes,
        );

        let emit_verify_ok = |dump: &mut String,
                              slug: &str,
                              description: &str,
                              container: &[u8],
                              records: &[MemberRecord]| {
            dump.push_str("    {\n");
            dump.push_str(&format!(
                "      \"vector_id\": \"backup-container/v0.1/{slug}\",\n"
            ));
            dump.push_str(&format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"verify_ok\",\n");
            dump.push_str(&format!(
                "      \"input_container_hex\": \"{}\",\n",
                hex_encode(container)
            ));
            dump.push_str("      \"expected_member_records\": [\n");
            for (i, rec) in records.iter().enumerate() {
                dump.push_str(&format!(
                    "        {{ \"path\": \"{}\", \"len\": {}, \"sha256_hex\": \"{}\" }}{}\n",
                    json_escape(&rec.path),
                    rec.len,
                    hex_encode(&rec.sha256),
                    if i + 1 == records.len() { "" } else { "," }
                ));
            }
            dump.push_str("      ]\n");
            dump.push_str("    },\n");
        };

        emit_verify_ok(
            &mut dump,
            "verify-ok-minimal",
            "Parse + verify the minimal container back to its single record. The sha256_hex value is independently checkable: SHA-256(path_len_be16 || path || member_bytes) per §9.11.2 — the hash formula pin.",
            &minimal_bytes,
            &minimal_records,
        );
        emit_verify_ok(
            &mut dump,
            "verify-ok-full-allowlist",
            "Parse + verify the full-allowlist container back to its six records in table (canonical) order.",
            &full_bytes,
            &full_records,
        );

        let emit_verify_fail =
            |dump: &mut String,
             slug: &str,
             description: &str,
             container: &[u8],
             expected_error: &BackupContainerError| {
                dump.push_str("    {\n");
                dump.push_str(&format!(
                    "      \"vector_id\": \"backup-container/v0.1/{slug}\",\n"
                ));
                dump.push_str(&format!(
                    "      \"description\": \"{}\",\n",
                    json_escape(description)
                ));
                dump.push_str("      \"case_kind\": \"verify_fail\",\n");
                dump.push_str(&format!(
                    "      \"input_container_hex\": \"{}\",\n",
                    hex_encode(container)
                ));
                dump.push_str(&format!(
                    "      \"expected_error\": \"{}\"\n",
                    error_str(expected_error)
                ));
                dump.push_str("    },\n");
            };

        for (slug, description, bytes, expected) in &verify_fail_cases {
            emit_verify_fail(&mut dump, slug, description, bytes, expected);
        }

        let total_classify = classify_cases.len();
        for (i, (slug, description, path, family)) in classify_cases.iter().enumerate() {
            dump.push_str("    {\n");
            dump.push_str(&format!(
                "      \"vector_id\": \"backup-container/v0.1/{slug}\",\n"
            ));
            dump.push_str(&format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"classify_path\",\n");
            dump.push_str(&format!(
                "      \"input_member_path\": \"{}\",\n",
                json_escape(path)
            ));
            dump.push_str(&format!("      \"expected_family\": \"{family}\"\n"));
            if i + 1 < total_classify {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        }

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        fs::write("/tmp/myne_backup_container_vectors.json", dump.as_bytes())
            .expect("write backup-container vectors dump");
    }

    /// `expected_error` string for a vectorable [`BackupContainerError`]
    /// variant — kept in lockstep with the runner's reverse match and the
    /// companion schema's enum. `Cancelled` / `Io` are runtime conditions,
    /// not byte-derivable, and never appear in vectors.
    fn error_str(e: &BackupContainerError) -> &'static str {
        match e {
            BackupContainerError::HeaderTooShort => "header_too_short",
            BackupContainerError::MagicMismatch => "magic_mismatch",
            BackupContainerError::ProtocolVersionMismatch => "protocol_version_mismatch",
            BackupContainerError::ReservedByteNonZero => "reserved_byte_nonzero",
            BackupContainerError::MemberCountOverflow => "member_count_overflow",
            BackupContainerError::MemberTableOverflow => "member_table_overflow",
            BackupContainerError::PathInvalid => "path_invalid",
            BackupContainerError::PathNotAllowlisted => "path_not_allowlisted",
            BackupContainerError::DuplicatePath => "duplicate_path",
            BackupContainerError::PathOrderViolation => "path_order_violation",
            BackupContainerError::MemberLenOverflow => "member_len_overflow",
            BackupContainerError::LengthsInconsistent => "lengths_inconsistent",
            BackupContainerError::HashMismatch => "hash_mismatch",
            BackupContainerError::Cancelled | BackupContainerError::Io(_) => {
                unreachable!("runtime-only variants are never vectored")
            }
        }
    }

    /// Byte-level integration runner against the `myne-test-vectors/`
    /// companion checkout — the src-tauri sibling of
    /// `protocol/tests/vectors.rs`. Skips with an explanatory message when
    /// the companion repo is not checked out.
    #[test]
    fn backup_container_vectors() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("myne-test-vectors")
            .join("vectors")
            .join("backup-container")
            .join("v0.1")
            .join("cases.json");

        if !path.exists() {
            eprintln!(
                "[skip] backup-container: companion repo fixture not present at {}",
                path.display()
            );
            return;
        }

        let raw =
            fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        let doc: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {}: {e}", path.display()));

        assert_eq!(doc["schema"], "backup-container");
        assert_eq!(doc["protocol_version"], "v0.1");

        let cases = doc["cases"].as_array().expect("cases must be a JSON array");
        assert!(
            cases.len() >= 32,
            "backup-container must carry at least 32 vectors (2 encode + 2 verify_ok + 14 verify_fail + 14 classify_path); found {}",
            cases.len()
        );
        let mut seen_ids = std::collections::HashSet::with_capacity(cases.len());
        for case in cases {
            let id = case["vector_id"]
                .as_str()
                .expect("vector_id must be a string");
            assert!(
                seen_ids.insert(id),
                "[backup-container] duplicate vector_id '{id}' in cases array"
            );
        }

        let dir = ScopedTempDir::new("bc-vector-run").unwrap();
        let mut seen_kinds = std::collections::HashSet::new();
        let mut seen_errors = std::collections::HashSet::new();
        let mut accepted_families = std::collections::HashSet::new();
        let mut rejected_paths = std::collections::HashSet::new();

        for (case_idx, case) in cases.iter().enumerate() {
            let id = case["vector_id"]
                .as_str()
                .expect("vector_id must be a string");
            let case_kind = case["case_kind"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
            seen_kinds.insert(case_kind.to_string());

            match case_kind {
                "encode" => {
                    let members_json = case["input_members"]
                        .as_array()
                        .unwrap_or_else(|| panic!("[{id}] missing input_members"));
                    // Pass members through in the order given — the
                    // vectors present them unsorted to pin writer-sorts.
                    let mut members: Vec<(String, PathBuf)> =
                        Vec::with_capacity(members_json.len());
                    for (i, m) in members_json.iter().enumerate() {
                        let member_path = m["path"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] member {i} missing path"));
                        let bytes = hex_decode(
                            m["bytes_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] member {i} missing bytes_hex")),
                        );
                        let src = dir.path().join(format!("case{case_idx}-m{i}"));
                        fs::write(&src, &bytes).unwrap();
                        members.push((member_path.to_string(), src));
                    }
                    let expected = hex_decode(
                        case["expected_container_hex"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] missing expected_container_hex")),
                    );

                    let dest = dir.path().join(format!("case{case_idx}.myne-backup"));
                    write_container(&dest, &members)
                        .unwrap_or_else(|e| panic!("[{id}] write_container failed: {e:?}"));
                    let actual = fs::read(&dest).unwrap();
                    assert_eq!(
                        actual,
                        expected,
                        "[{id}] backup-container encode mismatch ({} bytes)",
                        expected.len(),
                    );
                }
                "verify_ok" => {
                    let bytes = hex_decode(
                        case["input_container_hex"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] missing input_container_hex")),
                    );
                    let expected_records = case["expected_member_records"]
                        .as_array()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_member_records"));

                    let dest = dir.path().join(format!("case{case_idx}.myne-backup"));
                    fs::write(&dest, &bytes).unwrap();
                    let records = read_and_verify_container(&dest)
                        .unwrap_or_else(|e| panic!("[{id}] verify failed: {e:?}"));

                    assert_eq!(
                        records.len(),
                        expected_records.len(),
                        "[{id}] record count mismatch"
                    );
                    for (i, (rec, exp)) in records.iter().zip(expected_records).enumerate() {
                        assert_eq!(
                            rec.path,
                            exp["path"].as_str().unwrap_or_else(|| panic!(
                                "[{id}] expected record {i} missing path"
                            )),
                            "[{id}] record {i} path mismatch (table order is canonical)"
                        );
                        assert_eq!(
                            rec.len,
                            exp["len"].as_u64().unwrap_or_else(|| panic!(
                                "[{id}] expected record {i} missing len"
                            )),
                            "[{id}] record {i} len mismatch"
                        );
                        assert_eq!(
                            hex_encode(&rec.sha256),
                            exp["sha256_hex"].as_str().unwrap_or_else(|| panic!(
                                "[{id}] expected record {i} missing sha256_hex"
                            )),
                            "[{id}] record {i} sha256 mismatch (hash = SHA-256(path_len_be16 || path || member_bytes))"
                        );
                    }
                }
                "verify_fail" => {
                    let bytes = hex_decode(
                        case["input_container_hex"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] missing input_container_hex")),
                    );
                    let expected_error = case["expected_error"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                    seen_errors.insert(expected_error.to_string());

                    let expected_variant = match expected_error {
                        "header_too_short" => BackupContainerError::HeaderTooShort,
                        "magic_mismatch" => BackupContainerError::MagicMismatch,
                        "protocol_version_mismatch" => {
                            BackupContainerError::ProtocolVersionMismatch
                        }
                        "reserved_byte_nonzero" => BackupContainerError::ReservedByteNonZero,
                        "member_count_overflow" => BackupContainerError::MemberCountOverflow,
                        "member_table_overflow" => BackupContainerError::MemberTableOverflow,
                        "path_invalid" => BackupContainerError::PathInvalid,
                        "path_not_allowlisted" => BackupContainerError::PathNotAllowlisted,
                        "duplicate_path" => BackupContainerError::DuplicatePath,
                        "path_order_violation" => BackupContainerError::PathOrderViolation,
                        "member_len_overflow" => BackupContainerError::MemberLenOverflow,
                        "lengths_inconsistent" => BackupContainerError::LengthsInconsistent,
                        "hash_mismatch" => BackupContainerError::HashMismatch,
                        other => panic!(
                            "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with BackupContainerError (and error_str)"
                        ),
                    };

                    let dest = dir.path().join(format!("case{case_idx}.myne-backup"));
                    fs::write(&dest, &bytes).unwrap();
                    match read_and_verify_container(&dest) {
                        Err(e) if e == expected_variant => {}
                        Err(other) => panic!(
                            "[{id}] expected verify_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                        ),
                        Ok(records) => panic!(
                            "[{id}] expected verify_fail '{expected_error}', read_and_verify_container returned Ok ({} records)",
                            records.len()
                        ),
                    }
                }
                "classify_path" => {
                    let member_path = case["input_member_path"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_member_path"));
                    let expected_family = case["expected_family"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_family"));

                    let got = validate_member_path(member_path)
                        .ok()
                        .and_then(|()| classify_member_path(member_path))
                        .map(family_str)
                        .unwrap_or("rejected");
                    assert_eq!(
                        got, expected_family,
                        "[{id}] §9.11.3 allowlist classification mismatch for {member_path:?}"
                    );
                    if got == "rejected" {
                        rejected_paths.insert(member_path.to_string());
                    } else {
                        accepted_families.insert(got);
                    }
                }
                other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
            }
        }

        // Coverage floors (vault-search parity): every case_kind, every
        // vectorable error variant, every family accepted at least once,
        // and the two reserved-out singletons rejected at least once.
        for kind in ["encode", "verify_ok", "verify_fail", "classify_path"] {
            assert!(
                seen_kinds.contains(kind),
                "backup-container missing every case of case_kind '{kind}' — coverage regression"
            );
        }
        for err in [
            "header_too_short",
            "magic_mismatch",
            "protocol_version_mismatch",
            "reserved_byte_nonzero",
            "member_count_overflow",
            "member_table_overflow",
            "path_invalid",
            "path_not_allowlisted",
            "duplicate_path",
            "path_order_violation",
            "member_len_overflow",
            "lengths_inconsistent",
            "hash_mismatch",
        ] {
            assert!(
                seen_errors.contains(err),
                "backup-container missing verify_fail coverage for BackupContainerError '{err}' — every vectorable reject must be pinned"
            );
        }
        for family in [
            "vault-meta",
            "vault-prefs",
            "note",
            "snapshot",
            "attachments-catalog",
            "attachment-blob",
        ] {
            assert!(
                accepted_families.contains(family),
                "backup-container missing a classify_path accept for family '{family}' — the §9.11.3 grammar must be pinned from the accept side too"
            );
        }
        for must_reject in ["vault.search", "vault.workspace"] {
            assert!(
                rejected_paths.contains(must_reject),
                "backup-container missing the classify_path reject for '{must_reject}' — the reserved-out singletons are load-bearing"
            );
        }
    }
}
