// SPDX-License-Identifier: AGPL-3.0
//! E2E fixture generator — unlockable `vaults/<id>/vault.meta` layouts
//! with known credentials (e2e-harness task 5; epic policy SYNC-2/9).
//!
//! Composes the SAME protocol public API the production creation path
//! does (`src-tauri/src/plugins/vault_creation/commands.rs::
//! {build_session, build_and_serialize_vault_meta}`), so a generated
//! fixture unlocks through the untouched production unlock path. Weak
//! KDF params are legal at read time because unlock derives from the
//! params stored INSIDE `vault.meta` (`protocol::parse_kdf_params`
//! imposes no minimums); production code keeps its pinned
//! `DEFAULT_V0_1_KDF_PARAMS` at creation — no production branch exists
//! or is added here (SYNC-9).
//!
//! Also the home of the byte-surgery offset table the TS fault-
//! injection helpers mirror (`e2e/support/fixtures.ts`). The tests pin
//! each offset SEMANTICALLY (tampering a field breaks exactly the
//! unwrap that field participates in), so a layout change in the
//! `vault.meta` serializer fails here before it can silently desync the
//! TS mirror. The offsets are generation-INDEPENDENT: `NTV5` is the same
//! 345-byte layout as `MYV1` with bytes 0..5 swapped (§10.4.1 md.6).

use std::fs;
use std::path::Path;

use protocol::{
    aad_password_wrap, aad_password_wrap_v0_2, aad_recovery_wrap, aad_recovery_wrap_v0_2,
    aad_vault_items_key_wrap, aad_vault_items_key_wrap_v0_2, aead_open_ctx, aead_seal_ctx,
    compute_attachment_id, derive_password_wrap_key, derive_password_wrap_key_v0_2,
    derive_recovery_wrap_key, derive_recovery_wrap_key_v0_2, derive_subkey,
    derive_subkey_versioned, encode_attachment_blob, encode_attachments_catalog, encode_new_note,
    generate_account_number, generate_recovery_phrase, generate_root_key, meta_version_of,
    parse_vault_meta_any, serialize_vault_meta_versioned, AttachmentMeta, AttachmentsCatalog,
    KdfParams, MetaVersion, ProtocolError, SubkeyRole, VaultMeta, ACCOUNT_NUMBER_HASH_LEN,
    AEAD_KEY_LEN, AEAD_NONCE_LEN, ARGON2_SALT_LEN, VAULT_META_LEN,
};
use zeroize::Zeroizing;

/// Weak Argon2id parameters for fast fixtures — mirrors
/// `src-tauri/src/test_support.rs::FAST_TEST_KDF`. Lives only in fixture
/// bytes, never in production code (SYNC-9).
///
/// `m_kib` is pinned to `protocol::MIN_KDF_M_KIB` (8 MiB), the floor
/// `validate_kdf_params` (5750b1d) enforces on vault-supplied cost
/// params before derivation. A sub-floor value (the old 8 KiB) makes the
/// real unlock/recover/quick-unlock/change-password paths reject the
/// fixture with `InvalidVaultMeta` → the editor never mounts and every
/// unlock-bearing E2E scenario times out. 8 MiB keeps a single Argon2id
/// pass in the low-millisecond range (vs 256 MiB production), so fixtures
/// stay fast while clearing the gate.
pub const WEAK_TEST_KDF: KdfParams = KdfParams {
    m_kib: protocol::MIN_KDF_M_KIB,
    t: 1,
    p: 1,
    argon2_version: 0x13,
};

/// § 9.3 byte offsets of `vault.meta` fields. The TS mirror lives in
/// `e2e/support/fixtures.ts` (`VAULT_META_OFFSETS`) — keep in lockstep;
/// the tests below pin the semantics of each entry.
pub mod offsets {
    /// The 4-byte family magic — `"MYV1"` (v0.1) or `"NTV5"` (v0.2).
    pub const MAGIC: usize = 0;
    pub const ACCOUNT_HASH: usize = 6;
    pub const KDF_PARAMS: usize = 22;
    pub const SALT_PASSWORD: usize = 33;
    pub const SALT_RECOVERY: usize = 49;
    pub const NONCE_PASSWORD_WRAP: usize = 65;
    pub const ENC_ROOT_KEY_PASSWORD: usize = 89;
    pub const NONCE_RECOVERY_WRAP: usize = 153;
    pub const ENC_ROOT_KEY_RECOVERY: usize = 177;
    pub const ITEMS_KEY_ID: usize = 241;
    pub const ITEMS_KEY_NONCE: usize = 257;
    pub const ENC_ITEMS_KEY: usize = 281;
    pub const END: usize = 345;
}

/// Everything a scenario needs to drive the generated vault.
pub struct Fixture {
    /// Canonical lowercase-hyphenated UUIDv7 — the `vaults/<id>/` dir name.
    pub vault_id: String,
    pub password: String,
    /// 24 space-joined lowercase BIP-39 words.
    pub phrase: String,
    /// 27-char display account number (`MY-` + 5×4 groups).
    pub account: String,
    /// The serialized 345-byte `vault.meta`.
    pub meta_bytes: [u8; VAULT_META_LEN],
    /// The generation everything in this fixture is built in. Travels with the
    /// fixture so a suite builder cannot seal blobs under the wrong one — a
    /// mismatch is invisible at runtime, since every blob decoder detects its
    /// own magic and would decode the hybrid happily.
    pub generation: MetaVersion,
    /// Account-number hash (§ 9.3 offset 6) — the AAD ingredient every
    /// vault-level blob (prefs / search / catalog / …) binds to.
    pub account_hash: [u8; ACCOUNT_NUMBER_HASH_LEN],
    /// The unwrapped root key — retained so suite builders (e.g.
    /// [`write_export_suite`]) can derive vault-level subkeys exactly
    /// like the unlocked production host. Fixture credentials are
    /// per-run throwaways; `Zeroizing` keeps the drop discipline anyway.
    pub root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    /// The unwrapped items key (`vault.meta` § 9.3 offset 281, opened).
    pub items_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    /// UUIDv7 bytes identifying [`Self::items_key`].
    pub items_key_id: [u8; 16],
}

fn random_bytes<const N: usize>() -> Result<[u8; N], ProtocolError> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf).map_err(|_| ProtocolError::Csprng)?;
    Ok(buf)
}

fn seal_32(
    wrap_key: &[u8; AEAD_KEY_LEN],
    plaintext: &[u8; AEAD_KEY_LEN],
    aad: &[u8],
) -> Result<([u8; AEAD_NONCE_LEN], [u8; 64]), ProtocolError> {
    let nonce: [u8; AEAD_NONCE_LEN] = random_bytes()?;
    let sealed = aead_seal_ctx(wrap_key, &nonce, plaintext, aad)?;
    let blob: [u8; 64] = sealed
        .as_slice()
        .try_into()
        .expect("32-byte plaintext + 32-byte CTX tag = 64 bytes");
    Ok((nonce, blob))
}

/// The generation a fixture is built in unless the caller says otherwise —
/// the same one the production creation path uses
/// (`vault_creation::BIRTH_GENERATION`).
///
/// Restated rather than imported: this crate depends on `protocol` alone by
/// design, and `BIRTH_GENERATION` is a product decision living in `myne-core`.
/// The two are therefore hand-kept in sync, and what catches a drift is the E2E
/// lane itself — a fixture in the wrong generation and an app that creates the
/// other one disagree the moment a scenario creates a vault and then reads a
/// seeded one.
pub const DEFAULT_FIXTURE_GENERATION: MetaVersion = MetaVersion::V0_2;

/// Build one in-memory fixture in the product's birth generation (mirror of the
/// production `build_session` + `build_and_serialize_vault_meta` composition).
///
/// A scenario that specifically needs a PRE-flip vault — the migration, and
/// anything asserting that an old vault still opens — calls
/// [`build_fixture_in`] with [`MetaVersion::V0_1`] and says why.
pub fn build_fixture(password: &str, kdf_params: KdfParams) -> Result<Fixture, ProtocolError> {
    build_fixture_in(DEFAULT_FIXTURE_GENERATION, password, kdf_params)
}

/// [`build_fixture`] in an explicit generation.
///
/// Every derivation and every AAD below is selected by `generation`, and the
/// generation travels out on the [`Fixture`] — a fixture that mixed generations
/// (a v0.2 `vault.meta` over v0.1 blobs, say) would still decode, because every
/// blob decoder detects its own magic, and would then be testing a vault shape
/// production never produces.
pub fn build_fixture_in(
    generation: MetaVersion,
    password: &str,
    kdf_params: KdfParams,
) -> Result<Fixture, ProtocolError> {
    let v0_2 = generation == MetaVersion::V0_2;
    let account = generate_account_number()?;
    let phrase = generate_recovery_phrase()?;
    let root_key = generate_root_key()?;

    let salt_password: [u8; ARGON2_SALT_LEN] = random_bytes()?;
    let salt_recovery: [u8; ARGON2_SALT_LEN] = random_bytes()?;

    let password_wrap_key = if v0_2 {
        derive_password_wrap_key_v0_2(password, &salt_password, &account.hash, &kdf_params)?
    } else {
        derive_password_wrap_key(password, &salt_password, &account.hash, &kdf_params)?
    };
    let recovery_wrap_key = if v0_2 {
        derive_recovery_wrap_key_v0_2(&phrase, &salt_recovery, &account.hash, &kdf_params)?
    } else {
        derive_recovery_wrap_key(&phrase, &salt_recovery, &account.hash, &kdf_params)?
    };

    let aad_pw = if v0_2 {
        aad_password_wrap_v0_2(&kdf_params)
    } else {
        aad_password_wrap(&kdf_params)
    };
    let (nonce_password_wrap, enc_root_key_password) =
        seal_32(&password_wrap_key, &root_key, &aad_pw)?;

    let aad_rec = if v0_2 {
        aad_recovery_wrap_v0_2(&kdf_params)
    } else {
        aad_recovery_wrap(&kdf_params)
    };
    let (nonce_recovery_wrap, enc_root_key_recovery) =
        seal_32(&recovery_wrap_key, &root_key, &aad_rec)?;

    let items_wrap_key = derive_subkey_versioned(generation, &root_key, SubkeyRole::ItemsKeyWrap);
    let items_key = generate_root_key()?;
    let items_key_id: [u8; 16] = *uuid::Uuid::now_v7().as_bytes();
    let aad_items = if v0_2 {
        aad_vault_items_key_wrap_v0_2(&items_key_id)
    } else {
        aad_vault_items_key_wrap(&items_key_id)
    };
    let (items_key_nonce, enc_items_key) = seal_32(&items_wrap_key, &items_key, &aad_items)?;

    let meta = VaultMeta {
        account_number_hash: account.hash,
        kdf_params,
        random_salt_password: salt_password,
        random_salt_recovery: salt_recovery,
        nonce_password_wrap,
        enc_root_key_password,
        nonce_recovery_wrap,
        enc_root_key_recovery,
        items_key_id,
        items_key_nonce,
        enc_items_key,
    };

    Ok(Fixture {
        vault_id: uuid::Uuid::now_v7().hyphenated().to_string().to_lowercase(),
        password: password.to_string(),
        phrase: phrase.words().join(" "),
        account: account.display.clone(),
        meta_bytes: serialize_vault_meta_versioned(generation, &meta),
        generation,
        account_hash: account.hash,
        root_key,
        items_key,
        items_key_id,
    })
}

/// Write `fixture` as `<base>/vaults/<vault_id>/vault.meta`.
/// `base` is the app-data dir (`<XDG_DATA_HOME>/md.myne.desktop`).
pub fn write_fixture(base: &Path, fixture: &Fixture) -> std::io::Result<()> {
    let dir = base.join("vaults").join(&fixture.vault_id);
    fs::create_dir_all(&dir)?;
    fs::write(dir.join("vault.meta"), fixture.meta_bytes)
}

/// Verification helper used by the tests (and reusable from future
/// vector work): unwrap `root_key` from serialized meta bytes via the
/// password side — the same math the production unlock performs.
pub fn unwrap_root_key_with_password(
    bytes: &[u8],
    password: &str,
) -> Result<Zeroizing<Vec<u8>>, ProtocolError> {
    let v0_2 = meta_version_of(bytes) == Some(MetaVersion::V0_2);
    let meta = parse_vault_meta_any(bytes)?;
    let wrap = if v0_2 {
        derive_password_wrap_key_v0_2(
            password,
            &meta.random_salt_password,
            &meta.account_number_hash,
            &meta.kdf_params,
        )?
    } else {
        derive_password_wrap_key(
            password,
            &meta.random_salt_password,
            &meta.account_number_hash,
            &meta.kdf_params,
        )?
    };
    let aad = if v0_2 {
        aad_password_wrap_v0_2(&meta.kdf_params)
    } else {
        aad_password_wrap(&meta.kdf_params)
    };
    aead_open_ctx(
        &wrap,
        &meta.nonce_password_wrap,
        &meta.enc_root_key_password,
        &aad,
    )
}

/// Recovery-side twin of [`unwrap_root_key_with_password`].
pub fn unwrap_root_key_with_phrase(
    bytes: &[u8],
    normalized_phrase: &str,
) -> Result<Zeroizing<Vec<u8>>, ProtocolError> {
    let v0_2 = meta_version_of(bytes) == Some(MetaVersion::V0_2);
    let meta = parse_vault_meta_any(bytes)?;
    let wrap = if v0_2 {
        protocol::derive_recovery_wrap_key_from_normalized_v0_2(
            normalized_phrase,
            &meta.random_salt_recovery,
            &meta.account_number_hash,
            &meta.kdf_params,
        )?
    } else {
        protocol::derive_recovery_wrap_key_from_normalized(
            normalized_phrase,
            &meta.random_salt_recovery,
            &meta.account_number_hash,
            &meta.kdf_params,
        )?
    };
    let aad = if v0_2 {
        aad_recovery_wrap_v0_2(&meta.kdf_params)
    } else {
        aad_recovery_wrap(&meta.kdf_params)
    };
    aead_open_ctx(
        &wrap,
        &meta.nonce_recovery_wrap,
        &meta.enc_root_key_recovery,
        &aad,
    )
}

// ---- Note-export E2E suite (MYND-116 task 5) ----------------------------
//
// Pre-baked note + attachment content for `e2e/note-export.e2e.ts`:
// one note WITHOUT attachments (byte-verbatim export assert) and one
// note WITH two canonical form-C embeds whose catalog filenames
// COLLIDE (exercising the export-side " (1)" suffix-dedup). Composed
// from the protocol public API only (`encode_new_note`,
// `encode_attachment_blob`, `encode_attachments_catalog`), the same
// calls the production write paths make — the blobs decrypt through
// the untouched production read/export paths.

/// One attachment of the export suite, as the TS harness needs it.
pub struct ExportSuiteAttachment {
    /// 64-char lowercase-hex content-addressed attachment-id — the
    /// `attachments/<id>` blob filename and the form-C embed target.
    pub id_hex: String,
    /// Catalog display filename (BOTH suite attachments share it, so
    /// the export dedups the second to `"… (1).png"`).
    pub filename: String,
    /// Plaintext file bytes (ASCII by construction — JSON-emittable).
    pub contents: String,
    /// Catalog MIME hint.
    pub content_type: String,
}

/// IDs + plaintexts the note-export E2E scenario asserts against.
pub struct ExportSuite {
    /// Note WITHOUT attachment refs (canonical lowercase-hyphenated UUID).
    pub plain_note_id: String,
    /// Its exact decrypted plaintext (the byte-verbatim export oracle).
    pub plain_note_plaintext: String,
    /// Note WITH the two form-C embeds.
    pub attachments_note_id: String,
    /// Its exact decrypted plaintext (embeds reference [`Self::attachments`]).
    pub attachments_note_plaintext: String,
    /// The two attachments, in first-appearance (= export-naming) order.
    pub attachments: Vec<ExportSuiteAttachment>,
    /// Note WITH one form-C `.pdf` embed — the MYND-255 PDF-export
    /// exclusion-notice bait (a `.pdf` attachment cannot be embedded in
    /// the generated PDF, so exporting this note raises the notice).
    pub pdf_note_id: String,
    /// Its exact decrypted plaintext (embeds [`Self::pdf_attachment`]).
    pub pdf_note_plaintext: String,
    /// The `.pdf` attachment the pdf note embeds.
    pub pdf_attachment: ExportSuiteAttachment,
}

/// Lowercase-hex render of an attachment id.
fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

const PLAIN_NOTE_PLAINTEXT: &str = "---\ntitle: Plain Note\n---\n\n# Plain Note\n\nVerbatim export proof body — line one.\nLine two stays byte-identical through the round trip.\n";

const ATTACHMENT_ONE_CONTENTS: &str = "fixture-attachment-bytes:one\n";
const ATTACHMENT_TWO_CONTENTS: &str = "fixture-attachment-bytes:two (different from one)\n";
const ATTACHMENT_SHARED_FILENAME: &str = "evidence.png";
const ATTACHMENT_CONTENT_TYPE: &str = "image/png";
const ATTACHMENT_CREATED_AT: u64 = 1_770_000_000;

// MYND-255 PDF-note bait: the FILENAME extension (`.pdf`) is what the
// HTML projection's exclusion logic keys on; the bytes are ASCII
// placeholder content (the scenario never opens them as a PDF).
const PDF_ATTACHMENT_CONTENTS: &str = "fixture-attachment-bytes:pdf placeholder\n";
const PDF_ATTACHMENT_FILENAME: &str = "report.pdf";
const PDF_ATTACHMENT_CONTENT_TYPE: &str = "application/pdf";

/// Map a protocol-side encode failure into `io::Error` so the writer
/// keeps [`write_fixture`]'s `io::Result` surface (a fixture binary —
/// the message is for the harness operator, nothing secret rides it).
fn proto_io<E: core::fmt::Debug>(e: E) -> std::io::Error {
    std::io::Error::other(format!("protocol encode failed: {:?}", e))
}

/// Write the note-export suite into `<base>/vaults/<vault_id>/`:
/// `notes/<id>.myn` ×3, `attachments/<id-hex>` ×3, and the `MYC1`
/// `vault.attachments` catalog. Call once per fixture, right after
/// [`write_fixture`].
///
/// **`MetaVersion::V0_1` only, and asserted.** The blobs written here are
/// `MY01` / `MYA1` / `MYC1`, and a v0.2 vault's notes are `NC05` — an Automerge
/// document this crate cannot build, because it depends on `protocol` alone by
/// design. Pairing these blobs with a v0.2 `vault.meta` would produce a hybrid
/// vault that decodes perfectly (every decoder detects its own magic) while
/// being a shape production never writes, so the scenarios using this suite seed
/// an explicitly v0.1 fixture and are, by that fact, the lane's **legacy-vault**
/// coverage: proof that a pre-flip vault still opens, reads and exports.
pub fn write_export_suite(base: &Path, fixture: &Fixture) -> std::io::Result<ExportSuite> {
    assert_eq!(
        fixture.generation,
        MetaVersion::V0_1,
        "the export suite writes MY01/MYA1/MYC1 blobs — build its fixture with \
         build_fixture_in(MetaVersion::V0_1, ..)"
    );
    let vault_dir = base.join("vaults").join(&fixture.vault_id);
    // Build attachment ids first — the notes' plaintexts embed them.
    // The first two are the MYND-116 dedup bait (shared image filename);
    // the third is the MYND-255 `.pdf` exclusion bait.
    let files = [
        (
            ATTACHMENT_ONE_CONTENTS,
            ATTACHMENT_SHARED_FILENAME,
            ATTACHMENT_CONTENT_TYPE,
        ),
        (
            ATTACHMENT_TWO_CONTENTS,
            ATTACHMENT_SHARED_FILENAME,
            ATTACHMENT_CONTENT_TYPE,
        ),
        (
            PDF_ATTACHMENT_CONTENTS,
            PDF_ATTACHMENT_FILENAME,
            PDF_ATTACHMENT_CONTENT_TYPE,
        ),
    ];
    let mut attachments = Vec::with_capacity(files.len());
    let mut catalog = AttachmentsCatalog::empty();
    let attachments_dir = vault_dir.join("attachments");
    fs::create_dir_all(&attachments_dir)?;
    for (contents, filename, content_type) in files {
        let id = compute_attachment_id(&fixture.root_key, contents.as_bytes());
        let id_hex = hex_lower(&id);
        let blob = encode_attachment_blob(
            &fixture.items_key,
            &fixture.items_key_id,
            &id,
            content_type.as_bytes(),
            contents.as_bytes(),
        )
        .map_err(proto_io)?;
        fs::write(attachments_dir.join(&id_hex), &blob)?;
        catalog.entries.insert(
            id_hex.clone(),
            AttachmentMeta::live(
                content_type.to_string(),
                ATTACHMENT_CREATED_AT,
                filename.to_string(),
                contents.len() as u64,
            ),
        );
        attachments.push(ExportSuiteAttachment {
            id_hex,
            filename: filename.to_string(),
            contents: contents.to_string(),
            content_type: content_type.to_string(),
        });
    }
    // Split the `.pdf` bait off — `attachments` stays the MYND-116
    // two-image dedup pair the markdown scenarios index into.
    let pdf_attachment = attachments.pop().expect("three files were pushed");

    // MYC1 catalog under the canonical subkey + account-hash AAD — the
    // exact composition `attachments::commands::read_catalog` reverses.
    let catalog_key = derive_subkey(&fixture.root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog_blob = encode_attachments_catalog(&catalog_key, &fixture.account_hash, &catalog)
        .map_err(proto_io)?;
    fs::write(vault_dir.join("vault.attachments"), &catalog_blob)?;

    // The attachments note: two canonical form-C embeds
    // (`![[att:<id>|<name>]]`), shared display filename → dedup.
    let attachments_note_plaintext = format!(
        "---\ntitle: Attachments Note\n---\n\n# Attachments Note\n\nFirst: ![[att:{id1}|{name}]]\n\nSecond (same display name, different bytes): ![[att:{id2}|{name}]]\n",
        id1 = attachments[0].id_hex,
        id2 = attachments[1].id_hex,
        name = ATTACHMENT_SHARED_FILENAME,
    );

    // The pdf note: one form-C `.pdf` embed — the projection excludes
    // it, so the MYND-255 pre-export notice fires on this note.
    let pdf_note_plaintext = format!(
        "---\ntitle: PDF Note\n---\n\n# PDF Note\n\nEmbedded report: ![[att:{id}|{name}]]\n",
        id = pdf_attachment.id_hex,
        name = PDF_ATTACHMENT_FILENAME,
    );

    let notes_dir = vault_dir.join("notes");
    fs::create_dir_all(&notes_dir)?;
    let write_note = |plaintext: &str| -> std::io::Result<String> {
        let note_uuid = uuid::Uuid::now_v7();
        let blob = encode_new_note(
            &fixture.items_key,
            &fixture.items_key_id,
            note_uuid.as_bytes(),
            plaintext.as_bytes(),
        )
        .map_err(proto_io)?;
        let id = note_uuid.hyphenated().to_string().to_lowercase();
        fs::write(notes_dir.join(format!("{}.myn", id)), &blob)?;
        Ok(id)
    };
    let plain_note_id = write_note(PLAIN_NOTE_PLAINTEXT)?;
    let attachments_note_id = write_note(&attachments_note_plaintext)?;
    let pdf_note_id = write_note(&pdf_note_plaintext)?;

    Ok(ExportSuite {
        plain_note_id,
        plain_note_plaintext: PLAIN_NOTE_PLAINTEXT.to_string(),
        attachments_note_id,
        attachments_note_plaintext,
        attachments,
        pdf_note_id,
        pdf_note_plaintext,
        pdf_attachment,
    })
}

// ── vault-import source suite (myne-md/myne#464) ────────────────────────────

/// Names the import-source suite lays down, so a scenario asserts against the
/// same strings the generator wrote rather than against re-typed copies.
pub struct ImportSourceSuite {
    /// Title of the note that links to `COLLIDING_LINKED_TITLE`. Imported.
    pub linking_note_title: String,
    /// Collides with a note in the TARGET vault AND is linked to. Must arrive
    /// under a renamed title, and the link must move with it.
    pub colliding_linked_title: String,
    /// Collides with the target and nothing links to it. Must be skipped.
    pub colliding_unlinked_title: String,
    /// Has no frontmatter `title:`. Must arrive untitled, not titled `019…`.
    pub untitled_body: String,
    /// In the source's trash. Must NOT arrive.
    pub trashed_title: String,
    /// A template. Must NOT arrive.
    pub template_title: String,
    /// Referenced by an imported note. Must cross.
    pub referenced_attachment_id: String,
    /// In the source's catalog, referenced by nothing. Must NOT cross.
    pub unreferenced_attachment_id: String,
    /// Embedded by an imported note, absent from the source catalog. Must stay
    /// pointing at this id, so it renders as a tombstone in the target too.
    pub tombstoned_attachment_id: String,
    /// A link that was ALREADY broken in the source. The accepted residual.
    pub broken_link_target: String,
    /// The word this suite WOULD have put in the source's added-dictionary set.
    ///
    /// Reported but NOT written: see the comment at the dictionary step for why
    /// this crate cannot seal that blob without keeping a second copy of the
    /// payload format. A scenario reads these two to state, in its own output,
    /// which part of the feature it is not covering.
    pub dictionary_word_not_written: String,
    /// The ignore-set word, same caveat.
    pub ignored_word_not_written: String,
}

/// Lay a SOURCE vault out for the vault-import scenario.
///
/// One vault holding one instance of every rule the feature decided, so a
/// single import run can assert all of them. One run rather than one per rule
/// because each run pays a full Argon2id derivation at the source's KDF cost
/// inside the scenario's own budget.
///
/// The TARGET side (the colliding titles this suite is built to collide WITH)
/// is created by the scenario through the real UI, not here: a collision the
/// generator manufactured on both sides would prove the generator agrees with
/// itself.
pub fn write_import_source_suite(
    base: &Path,
    fixture: &Fixture,
) -> std::io::Result<ImportSourceSuite> {
    assert_eq!(
        fixture.generation,
        MetaVersion::V0_1,
        "the import-source suite writes MY01/MYA1/MYC1 blobs — build its fixture \
         with build_fixture_in(MetaVersion::V0_1, ..)"
    );
    let vault_dir = base.join("vaults").join(&fixture.vault_id);
    let notes_dir = vault_dir.join("notes");
    let attachments_dir = vault_dir.join("attachments");
    fs::create_dir_all(&notes_dir)?;
    fs::create_dir_all(&attachments_dir)?;

    // Two real attachments, one referenced and one not. Distinct bytes, because
    // the id is content-derived and identical bytes would be one attachment.
    let referenced = b"import-source referenced attachment bytes";
    let unreferenced = b"import-source UNreferenced attachment bytes";
    let mut catalog = AttachmentsCatalog::empty();
    let mut seal = |contents: &[u8], filename: &str| -> std::io::Result<String> {
        let id = compute_attachment_id(&fixture.root_key, contents);
        let id_hex = hex_lower(&id);
        let blob = encode_attachment_blob(
            &fixture.items_key,
            &fixture.items_key_id,
            &id,
            ATTACHMENT_CONTENT_TYPE.as_bytes(),
            contents,
        )
        .map_err(proto_io)?;
        fs::write(attachments_dir.join(&id_hex), &blob)?;
        catalog.entries.insert(
            id_hex.clone(),
            AttachmentMeta::live(
                ATTACHMENT_CONTENT_TYPE.to_string(),
                1_700_000_000,
                filename.to_string(),
                contents.len() as u64,
            ),
        );
        Ok(id_hex)
    };
    let referenced_id = seal(referenced, "referenced.png")?;
    let unreferenced_id = seal(unreferenced, "unreferenced.png")?;

    // The tombstone bait: an id an imported note embeds and the catalog does
    // NOT carry. No blob is written for it, which is exactly the state a
    // deleted attachment leaves behind.
    let tombstoned_id = "9".repeat(64);

    let catalog_key = derive_subkey(&fixture.root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog_blob = encode_attachments_catalog(&catalog_key, &fixture.account_hash, &catalog)
        .map_err(proto_io)?;
    fs::write(vault_dir.join("vault.attachments"), &catalog_blob)?;

    let write_note = |plaintext: &str| -> std::io::Result<()> {
        let note_uuid = uuid::Uuid::now_v7();
        let blob = encode_new_note(
            &fixture.items_key,
            &fixture.items_key_id,
            note_uuid.as_bytes(),
            plaintext.as_bytes(),
        )
        .map_err(proto_io)?;
        let id = note_uuid.hyphenated().to_string().to_lowercase();
        fs::write(notes_dir.join(format!("{}.myn", id)), &blob)?;
        Ok(())
    };

    let linking = "Import Linking Note";
    let colliding_linked = "Shared Title Linked";
    let colliding_unlinked = "Shared Title Unlinked";
    let trashed = "Import Trashed Note";
    let template = "Import Template Note";
    let broken_target = "Never Existed Here";
    let untitled_body = "An untitled scratch note from the source vault.";
    let dictionary_word = "Kubernetes";
    let ignored_word = "definately";

    // The note that carries every link and embed the rewrite has to handle.
    write_note(&format!(
        "---\ntitle: {linking}\n---\n\nLinks to [[{colliding_linked}]].\n\n\
         A link that is already broken here: [[{broken_target}]].\n\n\
         Referenced: ![[att:{referenced_id}|referenced.png]]\n\n\
         Already deleted in this vault: ![[att:{tombstoned_id}|gone.png]]\n"
    ))?;
    write_note(&format!(
        "---\ntitle: {colliding_linked}\n---\n\nThe linked one.\n"
    ))?;
    write_note(&format!(
        "---\ntitle: {colliding_unlinked}\n---\n\nNothing here links to me.\n"
    ))?;
    // No `title:` at all — the case `conflict.ts` used to call unreachable.
    write_note(&format!("---\nfolder: null\n---\n\n{untitled_body}\n"))?;
    // `trashed:` is a value-strict RFC-3339 timestamp; its PRESENCE is the flag.
    write_note(&format!(
        "---\ntitle: {trashed}\ntrashed: 2026-01-01T00:00:00Z\n---\n\nDeleted here.\n"
    ))?;
    write_note(&format!(
        "---\ntitle: {template}\ntemplate: true\n---\n\nA template.\n"
    ))?;

    // NO `vault.dictionary` is written here, deliberately.
    //
    // The `MYD1` framing is in `protocol`, but its INNER payload is a postcard
    // encoding of `PersonalDictionaryData`, which lives in
    // `src-tauri/src/spell/dictionary.rs` and is not reachable from this crate.
    // Writing the bytes by hand from a tuple would encode a SECOND opinion about
    // that payload's shape, and the moment the real one gained a field the
    // fixture would keep producing something the app no longer writes — a
    // divergence that shows up as a passing test.
    //
    // The dictionary carry is covered instead where it can be covered honestly:
    // `tests/notes/import/myneDictionary.test.ts` for the union and the
    // ignore-set exclusion, and `plugins::importer::source_dictionary::tests` in
    // `myne-desktop` for the read, which seals a real blob through the real
    // encoder. The two names are still reported below so a scenario can say what
    // this suite does NOT cover rather than implying it does.

    Ok(ImportSourceSuite {
        linking_note_title: linking.to_string(),
        colliding_linked_title: colliding_linked.to_string(),
        colliding_unlinked_title: colliding_unlinked.to_string(),
        untitled_body: untitled_body.to_string(),
        trashed_title: trashed.to_string(),
        template_title: template.to_string(),
        referenced_attachment_id: referenced_id,
        unreferenced_attachment_id: unreferenced_id,
        tombstoned_attachment_id: tombstoned_id,
        broken_link_target: broken_target.to_string(),
        dictionary_word_not_written: dictionary_word.to_string(),
        ignored_word_not_written: ignored_word.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The items-key-wrap AAD for `generation`. The two AAD builders have no
    /// versioned wrapper in `protocol` (the production call sites all sit inside
    /// an explicit branch), so the tests pick here rather than hardcode v0.1.
    fn items_wrap_aad(generation: MetaVersion, items_key_id: &[u8; 16]) -> Vec<u8> {
        match generation {
            MetaVersion::V0_1 => aad_vault_items_key_wrap(items_key_id),
            MetaVersion::V0_2 => aad_vault_items_key_wrap_v0_2(items_key_id),
        }
    }

    const PW: &str = "e2e-fixture-password-1";

    #[test]
    fn weak_fixture_round_trips_both_unwrap_paths() {
        let f = build_fixture(PW, WEAK_TEST_KDF).expect("build");
        assert_eq!(f.meta_bytes.len(), VAULT_META_LEN);

        // Password side opens (the production unlock math).
        let root_pw = unwrap_root_key_with_password(&f.meta_bytes, PW).expect("password unwrap");
        // Recovery side opens to the SAME root key.
        let root_rec =
            unwrap_root_key_with_phrase(&f.meta_bytes, &f.phrase).expect("phrase unwrap");
        assert_eq!(root_pw.as_slice(), root_rec.as_slice());

        // Items key unwraps under the derived subkey (the post-unlock step) —
        // under the fixture's OWN generation, so this stays an independent
        // check rather than a restatement of one version.
        let meta = parse_vault_meta_any(&f.meta_bytes).expect("parse");
        let root: [u8; 32] = root_pw.as_slice().try_into().expect("32-byte root");
        let items_wrap = derive_subkey_versioned(f.generation, &root, SubkeyRole::ItemsKeyWrap);
        let aad = items_wrap_aad(f.generation, &meta.items_key_id);
        aead_open_ctx(
            &items_wrap,
            &meta.items_key_nonce,
            &meta.enc_items_key,
            &aad,
        )
        .expect("items key unwrap");
    }

    #[test]
    fn wrong_password_and_wrong_phrase_fail_closed() {
        let f = build_fixture(PW, WEAK_TEST_KDF).expect("build");
        assert!(unwrap_root_key_with_password(&f.meta_bytes, "not-the-password").is_err());
        let wrong_phrase = "abandon ".repeat(23) + "about";
        assert!(unwrap_root_key_with_phrase(&f.meta_bytes, &wrong_phrase).is_err());
    }

    /// Pins the § 9.3 offset table SEMANTICALLY: a single tampered byte
    /// at `ENC_ROOT_KEY_RECOVERY` must break exactly the recovery
    /// unwrap while the password unwrap stays green (and vice versa).
    /// If `serialize_vault_meta`'s layout ever shifts, this fails before
    /// the TS mirror (`e2e/support/fixtures.ts`) can drift silently.
    #[test]
    fn byte_surgery_offsets_hit_the_advertised_fields() {
        let f = build_fixture(PW, WEAK_TEST_KDF).expect("build");

        // Tamper recovery wrap → recovery fails, password unaffected.
        let mut tampered = f.meta_bytes;
        tampered[offsets::ENC_ROOT_KEY_RECOVERY] ^= 0xff;
        assert!(unwrap_root_key_with_password(&tampered, PW).is_ok());
        assert!(unwrap_root_key_with_phrase(&tampered, &f.phrase).is_err());

        // Tamper password wrap → password fails, recovery unaffected.
        let mut tampered = f.meta_bytes;
        tampered[offsets::ENC_ROOT_KEY_PASSWORD] ^= 0xff;
        assert!(unwrap_root_key_with_password(&tampered, PW).is_err());
        assert!(unwrap_root_key_with_phrase(&tampered, &f.phrase).is_ok());

        // Tamper items wrap → both root unwraps fine, items unwrap fails.
        let mut tampered = f.meta_bytes;
        tampered[offsets::ENC_ITEMS_KEY] ^= 0xff;
        let root = unwrap_root_key_with_password(&tampered, PW).expect("root ok");
        let meta = parse_vault_meta_any(&tampered).expect("parse ok");
        let root: [u8; 32] = root.as_slice().try_into().unwrap();
        let items_wrap = derive_subkey_versioned(f.generation, &root, SubkeyRole::ItemsKeyWrap);
        let aad = items_wrap_aad(f.generation, &meta.items_key_id);
        assert!(aead_open_ctx(
            &items_wrap,
            &meta.items_key_nonce,
            &meta.enc_items_key,
            &aad
        )
        .is_err());

        // Tamper magic → structural parse failure (fail-closed class).
        // Through `parse_vault_meta_any`, so this asserts the byte matches
        // NEITHER generation's magic rather than merely not being `MYV1`.
        let mut tampered = f.meta_bytes;
        tampered[offsets::MAGIC] ^= 0xff;
        assert!(parse_vault_meta_any(&tampered).is_err());
        assert_eq!(meta_version_of(&tampered), None);

        // Layout arithmetic stays glued to the protocol constants.
        assert_eq!(offsets::END, VAULT_META_LEN);
        assert_eq!(
            offsets::ENC_ROOT_KEY_PASSWORD + 64,
            offsets::NONCE_RECOVERY_WRAP
        );
        assert_eq!(offsets::ENC_ROOT_KEY_RECOVERY + 64, offsets::ITEMS_KEY_ID);
        assert_eq!(offsets::ENC_ITEMS_KEY + 64, offsets::END);
    }

    /// The export-suite artifacts must open through the SAME protocol
    /// read math the production export commands run: `decode_note`
    /// under (items_key, items_key_id), `decode_attachment_blob` under
    /// the catalog's content_type AAD, and the MYC1 catalog under the
    /// `AttachmentsCatalogKey` subkey + account-hash AAD. Also pins the
    /// dedup-bait shape: two DISTINCT ids sharing one display filename,
    /// both embedded in the attachments note's plaintext.
    #[test]
    fn export_suite_round_trips_the_production_read_paths() {
        // v0.1 on purpose: the suite writes MY01/MYA1/MYC1 (see its doc), so
        // this doubles as the legacy-vault read path.
        let f = build_fixture_in(MetaVersion::V0_1, PW, WEAK_TEST_KDF).expect("build");
        let tmp = std::env::temp_dir().join(format!("fixture-gen-export-suite-{}", f.vault_id));
        write_fixture(&tmp, &f).expect("write fixture");
        let suite = write_export_suite(&tmp, &f).expect("write export suite");
        let vault_dir = tmp.join("vaults").join(&f.vault_id);

        // Notes decrypt to the advertised plaintexts.
        for (id, expected) in [
            (&suite.plain_note_id, &suite.plain_note_plaintext),
            (
                &suite.attachments_note_id,
                &suite.attachments_note_plaintext,
            ),
            (&suite.pdf_note_id, &suite.pdf_note_plaintext),
        ] {
            let blob = std::fs::read(vault_dir.join("notes").join(format!("{}.myn", id)))
                .expect("read note blob");
            let uuid = uuid::Uuid::parse_str(id).expect("canonical uuid");
            let decrypted =
                protocol::decode_note(&blob, uuid.as_bytes(), &f.items_key, &f.items_key_id)
                    .expect("note decrypts");
            assert_eq!(decrypted.plaintext(), expected.as_bytes());
        }

        // Two image attachments: distinct ids, shared filename,
        // content-addressed. The `.pdf` bait (MYND-255) rides separately:
        // a distinct id, a `.pdf` filename, embedded in the pdf note.
        assert_eq!(suite.attachments.len(), 2);
        assert_ne!(suite.attachments[0].id_hex, suite.attachments[1].id_hex);
        assert_eq!(suite.attachments[0].filename, suite.attachments[1].filename);
        assert!(suite.pdf_attachment.filename.ends_with(".pdf"));
        assert!(suite.pdf_note_plaintext.contains(&format!(
            "![[att:{}|{}]]",
            suite.pdf_attachment.id_hex, suite.pdf_attachment.filename
        )));
        for att in suite.attachments.iter().chain([&suite.pdf_attachment]) {
            if att.id_hex != suite.pdf_attachment.id_hex {
                assert!(suite
                    .attachments_note_plaintext
                    .contains(&format!("![[att:{}|{}]]", att.id_hex, att.filename)));
            }
            let blob = std::fs::read(vault_dir.join("attachments").join(&att.id_hex))
                .expect("read attachment blob");
            let mut id = [0u8; 32];
            for (i, byte) in id.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&att.id_hex[i * 2..i * 2 + 2], 16).expect("hex");
            }
            assert_eq!(
                id,
                compute_attachment_id(&f.root_key, att.contents.as_bytes())
            );
            let decrypted = protocol::decode_attachment_blob(
                &blob,
                &id,
                att.content_type.as_bytes(),
                &f.items_key,
                &f.items_key_id,
            )
            .expect("attachment decrypts");
            assert_eq!(decrypted.as_slice(), att.contents.as_bytes());
        }

        // Catalog opens under the canonical subkey + account-hash AAD
        // and carries exactly the three entries (two images + the pdf).
        let catalog_key = derive_subkey(&f.root_key, SubkeyRole::AttachmentsCatalogKey);
        let catalog_blob =
            std::fs::read(vault_dir.join("vault.attachments")).expect("read catalog");
        let catalog =
            protocol::decode_attachments_catalog(&catalog_key, &f.account_hash, &catalog_blob)
                .expect("catalog decrypts");
        assert_eq!(catalog.entries.len(), 3);
        for att in suite.attachments.iter().chain([&suite.pdf_attachment]) {
            let meta = catalog.entries.get(&att.id_hex).expect("entry present");
            assert_eq!(meta.filename, att.filename);
            assert_eq!(meta.size, att.contents.len() as u64);
        }

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn write_fixture_lays_out_the_vaults_dir() {
        let f = build_fixture(PW, WEAK_TEST_KDF).expect("build");
        let tmp = std::env::temp_dir().join(format!("fixture-gen-test-{}", f.vault_id));
        write_fixture(&tmp, &f).expect("write");
        let on_disk = std::fs::read(tmp.join("vaults").join(&f.vault_id).join("vault.meta"))
            .expect("read back");
        assert_eq!(on_disk, f.meta_bytes);
        std::fs::remove_dir_all(&tmp).ok();
    }
}
