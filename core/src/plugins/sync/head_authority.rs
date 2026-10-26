// SPDX-License-Identifier: AGPL-3.0
//! Head authority selection by vault generation and, now, by **who signs**
//! (myne-md/myne#711 decisions 0603; `decisions/protocol/0731` + `0733`).
//!
//! Three formats exist, and a vault accepts the ones its own history can contain:
//!
//! * `0x01`: the `root_key` HMAC of a `NTV5` single-user vault;
//! * `0x02`: the PERSON-key signature of a B2B vault, which is what every device
//!   authors before it holds a device key;
//! * `0x03`: the DEVICE-key signature (`decisions/protocol/0733`), authored once this
//!   device has a device key and a binding row that publishes its public halves.
//!
//! **A reader accepts both signed formats regardless of what it authors.** That is not
//! politeness: a vault is shared, so the peer that authored the head in hand may be an
//! older client (or a platform with no device-key rung yet, which is every non-Apple
//! platform today). Refusing `0x02` once a device key exists would break every mixed
//! fleet, and refusing `0x03` would make the change undeliverable.
//!
//! This type is the one place the sync engine branches, so the authoring and
//! verification paths cannot disagree about which format a vault uses.

use protocol::device_key::DeviceKeyPair;
use protocol::person_key::{PersonKeyPair, PersonPublicHalf};
use protocol::vault_head::{
    head_author_id, open_device_signed_vault_head, open_signed_vault_head, sign_device_vault_head,
    sign_vault_head, DeviceHeadSigner, SealedHead, VaultHead, VaultHeadError, DEVICE_ID_LEN,
    HEAD_AUTHOR_ID_LEN, VAULT_HEAD_ACCOUNT_HASH_LEN, VAULT_HEAD_FORMAT_V2, VAULT_HEAD_FORMAT_V3,
};

/// The device that signs this vault's heads on this box: its id (the VV actor) and the
/// pair itself.
pub struct DeviceSigner {
    /// The 16-byte VV-actor id this device authors under, from `sync-state.json`.
    pub device_id: [u8; DEVICE_ID_LEN],
    /// The device keypair, held in RAM for the process lifetime.
    pub key: DeviceKeyPair,
}

/// The signed head context: everything one vault's head path needs, for whichever
/// signer this device holds.
pub struct SignedHeadCtx {
    /// The author's held person keypair, when this session has one.
    ///
    /// `None` is the state `0731` stage 1 made legitimate: a device key signs the head, so
    /// the phrase is not needed to author one. It is also what a cold start looks like
    /// before the identity is unlocked, and refusing to build the context at all would
    /// stop sync from READING heads too, which needs no signer.
    pub person: Option<PersonKeyPair>,
    /// The vault-scoped author id `0x02` carries, derived from the person half above.
    pub author_id: Option<[u8; HEAD_AUTHOR_ID_LEN]>,
    pub account_number_hash: [u8; VAULT_HEAD_ACCOUNT_HASH_LEN],
    /// The roster's live public halves, which resolve a `0x02` signer.
    pub roster_publics: Vec<PersonPublicHalf>,
    /// This device's key, when it has one. `None` is the pre-change behaviour and the
    /// permanent state on a platform with no storage rung.
    pub device: Option<DeviceSigner>,
    /// The device public halves this vault's binding store carries, which resolve a
    /// `0x03` signer. Built from the same store the attribution path reads.
    pub device_signers: Vec<DeviceHeadSigner>,
}

impl SignedHeadCtx {
    /// Build the context from the held person identity and the roster's public
    /// halves, with no device key (the `0x02` shape, unchanged from before the
    /// device-key change).
    #[must_use]
    pub fn new(
        person: Option<PersonKeyPair>,
        account_number_hash: [u8; VAULT_HEAD_ACCOUNT_HASH_LEN],
        roster_publics: Vec<PersonPublicHalf>,
    ) -> Self {
        let author_id = person
            .as_ref()
            .map(|person| head_author_id(&person.public_half(), &account_number_hash));
        Self {
            person,
            author_id,
            account_number_hash,
            roster_publics,
            device: None,
            device_signers: Vec::new(),
        }
    }

    /// The same context with a device key, so heads are authored at `0x03`.
    ///
    /// The device's own public half is added to the verifier set: a device must be
    /// able to read back the head it just authored, and its binding row may not have
    /// synced back to it yet.
    #[must_use]
    pub fn with_device(
        mut self,
        device: DeviceSigner,
        mut device_signers: Vec<DeviceHeadSigner>,
    ) -> Self {
        let own = DeviceHeadSigner {
            device_id: device.device_id,
            public: device.key.public_half(),
        };
        if !device_signers
            .iter()
            .any(|s| s.device_id == own.device_id && s.public == own.public)
        {
            device_signers.push(own);
        }
        self.device = Some(device);
        self.device_signers = device_signers;
        self
    }

    /// The format this device AUTHORS: `0x03` with a device key, else `0x02`.
    ///
    /// `0x02` is reported even when no identity is held, because the question is which
    /// format this authority is FOR rather than whether it can sign this instant; a
    /// context with neither a device key nor a person half refuses at [`Self::sign`]
    /// (`VaultHeadError::NoAuthority`) instead of stamping a format it cannot produce.
    #[must_use]
    pub fn authors_format(&self) -> u8 {
        if self.device.is_some() {
            VAULT_HEAD_FORMAT_V3
        } else {
            VAULT_HEAD_FORMAT_V2
        }
    }

    /// Whether this context can author a head at all: a device key (`0x03`), or a held
    /// person identity (`0x02`).
    ///
    /// Asked by the cycle BEFORE it refuses a B2B cycle, so the refusal names the thing the
    /// user can fix (unlock the identity) rather than a generic failure that would send
    /// them looking at the network.
    #[must_use]
    pub fn can_author(&self) -> bool {
        self.device.is_some() || (self.person.is_some() && self.author_id.is_some())
    }

    /// Author a signed head in this device's format.
    pub fn sign(
        &self,
        head: &VaultHead,
        rng: &mut (impl rand_core::CryptoRng + ?Sized),
    ) -> Result<SealedHead, VaultHeadError> {
        match &self.device {
            Some(device) => sign_device_vault_head(
                &VaultHead {
                    head_format_version: VAULT_HEAD_FORMAT_V3,
                    ..head.clone()
                },
                &device.device_id,
                &device.key,
                rng,
            ),
            // The format byte is OURS to set, not the caller's: the `VaultHead` a sync
            // cycle builds carries `0x01` (the single-user shape) and the authority is
            // what stamps the signed generation, so the authoring path cannot disagree
            // with the verifier about which format this vault uses.
            None => {
                // No device key, so the phrase path is the only one left. A context built
                // without a held identity (a cold start) reaches here, and says so rather
                // than panicking: the caller treats it as "unlock and retry", which is the
                // failure class the cycle already reports.
                let (person, author_id) = match (&self.person, &self.author_id) {
                    (Some(person), Some(author_id)) => (person, author_id),
                    _ => return Err(protocol::vault_head::VaultHeadError::NoAuthority),
                };
                sign_vault_head(
                    &VaultHead {
                        head_format_version: VAULT_HEAD_FORMAT_V2,
                        ..head.clone()
                    },
                    author_id,
                    person,
                    rng,
                )
            }
        }
    }

    /// Verify a signed head of EITHER format peer-side.
    ///
    /// The format is read out of the record rather than guessed: both framings are
    /// `ed_sig || mldsa_sig || signer(16) || canonical`, and the canonical input
    /// carries the format byte at a fixed offset from its own start, so one byte read
    /// decides which verifier runs. Trying both would mean a second ML-DSA verification
    /// on every head from an unfamiliar signer.
    pub fn open(&self, record: &[u8]) -> Result<VaultHead, VaultHeadError> {
        match signed_record_format(record)? {
            VAULT_HEAD_FORMAT_V3 => open_device_signed_vault_head(
                record,
                &self.device_signers,
                &self.account_number_hash,
            )
            .map(|(head, _device)| head),
            _ => open_signed_vault_head(record, &self.roster_publics, &self.account_number_hash)
                .map(|(head, _author)| head),
        }
    }
}

/// Read the `head_format_version` byte out of a signed record.
///
/// Offset arithmetic, stated once: `ed25519_sig(64) || mldsa_sig(3309) || signer(16) ||
/// canonical`, and `canonical = domain_prefix(10) || protocol_version(1) ||
/// head_format_version(1) || …`. So the byte sits at `64 + 3309 + 16 + 10 + 1`.
fn signed_record_format(record: &[u8]) -> Result<u8, VaultHeadError> {
    let offset = protocol::person_key::PERSON_ED25519_SIG_LEN
        + protocol::person_key::PERSON_MLDSA_SIG_LEN
        + DEVICE_ID_LEN
        + protocol::vault_head::VAULT_HEAD_DOMAIN_PREFIX.len()
        + 1;
    record
        .get(offset)
        .copied()
        .ok_or(VaultHeadError::RecordTooShort)
}

/// The authoring/verification authority for one vault.
pub enum HeadAuthority<'a> {
    /// `NTV5` single-user: the `root_key` HMAC.
    Mac { root_key: &'a [u8; 32] },
    /// `NTV6`/`NTV7` B2B: a signature, by the device key (`0x03`) or the person key
    /// (`0x02`).
    Signed(&'a SignedHeadCtx),
}

impl HeadAuthority<'_> {
    /// The `head_format_version` this authority AUTHORS: `0x01` for the `root_key`
    /// HMAC, `0x02` for a person signature, `0x03` once this device holds a key.
    #[must_use]
    pub fn authors_format(&self) -> u8 {
        match self {
            HeadAuthority::Mac { .. } => protocol::vault_head::VAULT_HEAD_FORMAT_V1,
            HeadAuthority::Signed(ctx) => ctx.authors_format(),
        }
    }

    /// Whether a `head_format_version` byte is one this authority can OPEN. Used by the
    /// device-local baseline reader, which must keep reading a head it no longer
    /// authors: a device whose key was lost has to be able to read the `0x03` head it
    /// wrote last week in order to know its own version vector.
    #[must_use]
    pub fn accepts_format(&self, format: u8) -> bool {
        match self {
            HeadAuthority::Mac { .. } => format == protocol::vault_head::VAULT_HEAD_FORMAT_V1,
            HeadAuthority::Signed(_) => {
                format == VAULT_HEAD_FORMAT_V2 || format == VAULT_HEAD_FORMAT_V3
            }
        }
    }

    /// Author a head in this vault's format.
    pub fn seal(
        &self,
        head: &VaultHead,
        rng: &mut (impl rand_core::CryptoRng + ?Sized),
    ) -> Result<SealedHead, VaultHeadError> {
        match self {
            HeadAuthority::Mac { root_key } => head.seal(root_key),
            HeadAuthority::Signed(ctx) => ctx.sign(head, rng),
        }
    }

    /// Verify a head in this vault's format. A signed vault accepts BOTH signed
    /// formats; a MAC vault requires `0x01`.
    pub fn open(&self, record: &[u8]) -> Result<VaultHead, VaultHeadError> {
        match self {
            HeadAuthority::Mac { root_key } => {
                protocol::vault_head::open_vault_head(root_key, record)
            }
            HeadAuthority::Signed(ctx) => ctx.open(record),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::vault_head::{VvEntry, VAULT_HEAD_FORMAT_V1};

    struct Rng(u64);
    impl rand_core::TryRng for Rng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            Ok(0)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            Ok(0)
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            use sha2::Digest as _;
            let ctr = self.0.wrapping_add(1);
            self.0 = ctr;
            let digest = sha2::Sha256::digest(ctr.to_le_bytes());
            let n = dst.len();
            for chunk in dst.chunks_mut(digest.len()) {
                chunk.copy_from_slice(&digest[..chunk.len()]);
            }
            let _ = n;
            Ok(())
        }
    }
    impl rand_core::TryCryptoRng for Rng {}

    fn head(account: [u8; 16]) -> VaultHead {
        VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash: account,
            manifest_hash: [9u8; 32],
            seq: 1,
            prev_head_hash: vec![],
            version_vector: vec![VvEntry {
                device_id: [1u8; DEVICE_ID_LEN],
                counter: 1,
            }],
        }
    }

    fn device(seed: u8, id: u8) -> DeviceSigner {
        DeviceSigner {
            device_id: [id; DEVICE_ID_LEN],
            key: DeviceKeyPair::generate_raw(&[seed; 32], &[seed ^ 0x5a; 32]),
        }
    }

    /// `0731` stage 1's whole point, pinned: a device key authors a head with NO person
    /// half in memory. The phrase is not in the sync path any more, so the code must not
    /// quietly reintroduce the dependency by requiring a context it cannot build.
    #[test]
    fn a_device_key_authors_without_the_person_half() {
        let account = [0x51u8; 16];
        let signer = device(0x41, 0x0d);
        let own = DeviceHeadSigner {
            device_id: signer.device_id,
            public: signer.key.public_half(),
        };
        let ctx = SignedHeadCtx::new(None, account, Vec::new()).with_device(signer, vec![own]);

        assert!(ctx.can_author(), "a device key is an authority on its own");
        assert_eq!(ctx.authors_format(), VAULT_HEAD_FORMAT_V3);

        let sealed = ctx.sign(&head(account), &mut Rng(7)).expect("device sign");
        // Read it back through the same context, which is what the next cycle does.
        let opened = ctx.open(&sealed.record).expect("device head verifies");
        assert_eq!(opened.head_format_version, VAULT_HEAD_FORMAT_V3);
        assert_eq!(opened.seq, 1);
    }

    /// And the other side of the same coin: with neither authority the context refuses
    /// rather than stamping a format, so the caller can say "unlock and retry" instead of
    /// surfacing a signature failure it cannot explain.
    #[test]
    fn neither_key_cannot_author() {
        let account = [0x52u8; 16];
        let ctx = SignedHeadCtx::new(None, account, Vec::new());
        assert!(!ctx.can_author());
        assert_eq!(
            ctx.sign(&head(account), &mut Rng(8)).unwrap_err(),
            protocol::vault_head::VaultHeadError::NoAuthority
        );
    }

    #[test]
    fn signed_and_mac_authorities_do_not_accept_each_others_heads() {
        let account = [0x44u8; 16];
        let root = [0x11u8; 32];
        let person = PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32]);
        let ctx = SignedHeadCtx::new(Some(person.clone()), account, vec![person.public_half()]);
        let signed = HeadAuthority::Signed(&ctx);
        let mac = HeadAuthority::Mac { root_key: &root };

        let sealed = signed.seal(&head(account), &mut Rng(1)).expect("sign");
        let opened = signed.open(&sealed.record).expect("open signed");
        assert_eq!(opened.head_format_version, VAULT_HEAD_FORMAT_V2);
        assert_eq!(signed.authors_format(), VAULT_HEAD_FORMAT_V2);

        assert!(mac.open(&sealed.record).is_err());

        let sealed_mac = mac.seal(&head(account), &mut Rng(2)).expect("mac sign");
        assert!(signed.open(&sealed_mac.record).is_err());
        assert_eq!(
            mac.open(&sealed_mac.record)
                .expect("open mac")
                .head_format_version,
            VAULT_HEAD_FORMAT_V1
        );
    }

    #[test]
    fn a_device_key_authors_v3_and_the_same_authority_reads_both_formats() {
        let account = [0x77u8; 16];
        let person = PersonKeyPair::generate_raw(&[4u8; 64], &[5u8; 32], &[6u8; 32]);
        // The pre-change context authors `0x02`; the device context authors `0x03`.
        let publics = vec![person.public_half()];
        let person_only = SignedHeadCtx::new(Some(person.clone()), account, publics.clone());
        let with_device = SignedHeadCtx::new(Some(person), account, publics)
            .with_device(device(0x21, 0x0a), Vec::new());

        let v2 = HeadAuthority::Signed(&person_only)
            .seal(&head(account), &mut Rng(3))
            .expect("sign v2");
        let v3 = HeadAuthority::Signed(&with_device)
            .seal(&head(account), &mut Rng(4))
            .expect("sign v3");
        assert_eq!(with_device.authors_format(), VAULT_HEAD_FORMAT_V3);

        // The device context reads BOTH: its own `0x03` and the older `0x02` a peer
        // may still be authoring. This is the property that makes a mixed fleet work.
        let ctx = HeadAuthority::Signed(&with_device);
        assert_eq!(
            ctx.open(&v3.record).expect("read v3").head_format_version,
            VAULT_HEAD_FORMAT_V3
        );
        assert_eq!(
            ctx.open(&v2.record).expect("read v2").head_format_version,
            VAULT_HEAD_FORMAT_V2
        );

        // And the person-only context refuses `0x03`, because it cannot resolve the
        // device: a device signature is not a person signature.
        assert!(HeadAuthority::Signed(&person_only)
            .open(&v3.record)
            .is_err());
    }

    #[test]
    fn the_baseline_reader_accepts_a_format_it_no_longer_authors() {
        // A device whose key was lost still has to read the `0x03` head it wrote, so
        // the accepted set is wider than the authored one.
        let account = [0x12u8; 16];
        let person = PersonKeyPair::generate_raw(&[7u8; 64], &[8u8; 32], &[9u8; 32]);
        let ctx = SignedHeadCtx::new(Some(person), account, vec![]);
        let auth = HeadAuthority::Signed(&ctx);
        assert!(auth.accepts_format(VAULT_HEAD_FORMAT_V2));
        assert!(auth.accepts_format(VAULT_HEAD_FORMAT_V3));
        assert!(!auth.accepts_format(VAULT_HEAD_FORMAT_V1));
        assert_eq!(auth.authors_format(), VAULT_HEAD_FORMAT_V2);
    }

    #[test]
    fn an_unbound_device_cannot_have_its_head_read() {
        // A `0x03` head whose signer is absent from the binding set is AuthorUnknown,
        // not a signature failure: "nobody bound this device" is a different answer.
        let account = [0x13u8; 16];
        let person = PersonKeyPair::generate_raw(&[0x0a; 64], &[0x0b; 32], &[0x0c; 32]);
        let authoring =
            SignedHeadCtx::new(Some(person.clone()), account, vec![person.public_half()])
                .with_device(device(0x31, 0x0b), Vec::new());
        let sealed = authoring.sign(&head(account), &mut Rng(5)).expect("sign");

        let reader_publics = vec![person.public_half()];
        let reader = SignedHeadCtx::new(Some(person), account, reader_publics);
        // Drop the self-published half: the reader now has no device to resolve.
        assert!(reader.open(&sealed.record).is_err());
    }
}
