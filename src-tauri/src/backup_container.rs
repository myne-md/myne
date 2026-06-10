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
pub fn read_and_verify_members_tolerant(
    path: &Path,
    hooks: &ContainerHooks,
) -> Result<TolerantVerify, BackupContainerError> {
    // Strict structural pass first (stages 1–3 + equations): reuse the
    // hooked verifier's parsing by re-running it and downgrading ONLY
    // hash mismatches. Implementation note: the strict verifier fails
    // fast on the first bad hash, so the tolerant pass re-reads the
    // table itself and hash-checks member by member.
    let mut file = File::open(path)?;
    let file_len = file.metadata()?.len();
    if file_len < BACKUP_CONTAINER_HEADER_LEN {
        return Err(BackupContainerError::HeaderTooShort);
    }
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

    // Tolerant stage 4: per-member hash check; failures join `skipped`
    // (the records themselves stay in the full list for offset math).
    let mut skipped: Vec<String> = Vec::new();
    let mut buf = vec![0u8; CHUNK];
    let total = records.len() as u32;
    for (done, record) in records.iter().enumerate() {
        hooks.check_cancel()?;
        let mut hasher = path_seeded_hasher(&record.path);
        let mut remaining = record.len;
        while remaining > 0 {
            hooks.check_cancel()?;
            let want = remaining.min(CHUNK as u64) as usize;
            file.read_exact(&mut buf[..want])?;
            hasher.update(&buf[..want]);
            remaining -= want as u64;
        }
        let got: [u8; 32] = hasher.finalize().into();
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
        let path = std::str::from_utf8(&table[fixed_end..fixed_end + path_len])
            .map_err(|_| BackupContainerError::PathInvalid)?
            .to_owned();
        validate_member_path(&path)?;
        let family = classify_member_path(&path).ok_or(BackupContainerError::PathNotAllowlisted)?;
        if let Some(prev) = records.last() {
            match prev.path.as_bytes().cmp(path.as_bytes()) {
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
        records.push(MemberRecord { path, len, sha256 });
        cursor = rec_end;
    }
    if cursor != table.len() || sum_member_len != members_total_len {
        return Err(BackupContainerError::LengthsInconsistent);
    }

    // Stage 4: streamed hash verification (path prefix + data, §9.11.2).
    let mut buf = vec![0u8; CHUNK];
    let total_records = records.len() as u32;
    for (done, record) in records.iter().enumerate() {
        hooks.check_cancel()?;
        let mut hasher = path_seeded_hasher(&record.path);
        let mut remaining = record.len;
        while remaining > 0 {
            hooks.check_cancel()?;
            let want = remaining.min(CHUNK as u64) as usize;
            file.read_exact(&mut buf[..want])?;
            hasher.update(&buf[..want]);
            remaining -= want as u64;
        }
        let got: [u8; 32] = hasher.finalize().into();
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
    fn allowlist_classifier_matches_spec_9_11_3() {
        use MemberFamily::*;
        let cases: &[(&str, Option<MemberFamily>)] = &[
            ("vault.meta", Some(VaultMeta)),
            ("vault.prefs", Some(VaultPrefs)),
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
}
