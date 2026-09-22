// SPDX-License-Identifier: AGPL-3.0
//! Head authority selection by vault generation (myne-md/myne#711, decisions
//! 0599).
//!
//! The vault head's authenticity is keyed off the vault's generation: an
//! `NTV6` (B2B) vault signs a head with the author's person keypair
//! (`head_format_version = 0x02`), because a member holds no `root_key`; an
//! `NTV5` single-user vault keeps the `root_key` HMAC (`0x01`). This type is the
//! one place the sync engine branches, so the authoring and verification paths
//! cannot disagree about which format a vault uses.

use protocol::person_key::{PersonKeyPair, PersonPublicHalf};
use protocol::vault_head::{
    head_author_id, open_signed_vault_head, sign_vault_head, SealedHead, VaultHead, VaultHeadError,
    HEAD_AUTHOR_ID_LEN, VAULT_HEAD_ACCOUNT_HASH_LEN, VAULT_HEAD_FORMAT_V2,
};

/// The signed (`0x02`) head context: the author's held person keypair, the
/// vault-scoped author id, the vault id, and the roster public halves a peer
/// resolves a head's signer against.
pub struct SignedHeadCtx {
    pub person: PersonKeyPair,
    pub author_id: [u8; HEAD_AUTHOR_ID_LEN],
    pub account_number_hash: [u8; VAULT_HEAD_ACCOUNT_HASH_LEN],
    pub roster_publics: Vec<PersonPublicHalf>,
}

impl SignedHeadCtx {
    /// Build the context from the held person identity and the roster's public
    /// halves.
    #[must_use]
    pub fn new(
        person: PersonKeyPair,
        account_number_hash: [u8; VAULT_HEAD_ACCOUNT_HASH_LEN],
        roster_publics: Vec<PersonPublicHalf>,
    ) -> Self {
        let author_id = head_author_id(&person.public_half(), &account_number_hash);
        Self {
            person,
            author_id,
            account_number_hash,
            roster_publics,
        }
    }

    /// Author a `0x02` signed head.
    pub fn sign(
        &self,
        head: &VaultHead,
        rng: &mut (impl rand_core::CryptoRng + ?Sized),
    ) -> Result<SealedHead, VaultHeadError> {
        sign_vault_head(head, &self.author_id, &self.person, rng)
    }

    /// Verify a `0x02` signed head peer-side against the roster public halves.
    pub fn open(&self, record: &[u8]) -> Result<VaultHead, VaultHeadError> {
        open_signed_vault_head(record, &self.roster_publics, &self.account_number_hash)
            .map(|(head, _author)| head)
    }
}

/// The authoring/verification authority for one vault.
pub enum HeadAuthority<'a> {
    /// `NTV5` single-user: the `root_key` HMAC.
    Mac { root_key: &'a [u8; 32] },
    /// `NTV6` B2B: the person-keypair signature.
    Signed(&'a SignedHeadCtx),
}

impl HeadAuthority<'_> {
    /// The `head_format_version` this authority authors and accepts: `0x01` for
    /// the `root_key` HMAC, `0x02` for the person-keypair signature.
    #[must_use]
    pub fn expected_format(&self) -> u8 {
        match self {
            HeadAuthority::Mac { .. } => protocol::vault_head::VAULT_HEAD_FORMAT_V1,
            HeadAuthority::Signed(_) => VAULT_HEAD_FORMAT_V2,
        }
    }

    /// Author a head in this vault's format. A `Signed` authority forces the
    /// `0x02` format byte; a `Mac` authority keeps whatever the head carries.
    pub fn seal(
        &self,
        head: &VaultHead,
        rng: &mut (impl rand_core::CryptoRng + ?Sized),
    ) -> Result<SealedHead, VaultHeadError> {
        match self {
            HeadAuthority::Mac { root_key } => head.seal(root_key),
            HeadAuthority::Signed(ctx) => ctx.sign(
                &VaultHead {
                    head_format_version: VAULT_HEAD_FORMAT_V2,
                    ..head.clone()
                },
                rng,
            ),
        }
    }

    /// Verify a head in this vault's format. A `Signed` authority requires
    /// `0x02` (a `0x01` record is refused as unsupported); a `Mac` authority
    /// requires `0x01`.
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
    use protocol::person_key::PersonKeyPair;
    use protocol::vault_head::{VvEntry, DEVICE_ID_LEN};

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
            dst[..n].copy_from_slice(&digest[..n]);
            Ok(())
        }
    }
    impl rand_core::TryCryptoRng for Rng {}

    fn head(account: [u8; 16]) -> VaultHead {
        VaultHead {
            head_format_version: protocol::vault_head::VAULT_HEAD_FORMAT_V1,
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

    #[test]
    fn signed_and_mac_authorities_do_not_accept_each_others_heads() {
        let account = [0x44u8; 16];
        let root = [0x11u8; 32];
        let person = PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32]);
        let ctx = SignedHeadCtx::new(person.clone(), account, vec![person.public_half()]);
        let signed = HeadAuthority::Signed(&ctx);
        let mac = HeadAuthority::Mac { root_key: &root };

        // The signed authority authors/verifies a `0x02` head.
        let sealed = signed.seal(&head(account), &mut Rng(1)).expect("sign");
        let opened = signed.open(&sealed.record).expect("open signed");
        assert_eq!(opened.head_format_version, VAULT_HEAD_FORMAT_V2);

        // The MAC authority refuses a signed head (format byte mismatch).
        assert!(mac.open(&sealed.record).is_err());

        // The MAC authority authors a `0x01` head the signed authority refuses.
        let mac_head = head(account);
        let sealed_mac = mac.seal(&mac_head, &mut Rng(2)).expect("mac sign");
        assert!(signed.open(&sealed_mac.record).is_err());
        assert_eq!(
            mac.open(&sealed_mac.record)
                .expect("open mac")
                .head_format_version,
            protocol::vault_head::VAULT_HEAD_FORMAT_V1
        );
    }
}
