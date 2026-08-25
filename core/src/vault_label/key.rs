// SPDX-License-Identifier: AGPL-3.0
//! Per-vault wrap key for the sealed label store (`MYL1`, `protocol.md`
//! § 9.22.2).
//!
//! A 32-byte symmetric key held in the OS keychain, used to seal one vault's
//! name so the locked picker can show it before any unlock. It is the third
//! device-local key in this crate and it is keyed differently from the other
//! two, deliberately.
//!
//! **One key per vault, not one per device.** `captures` (`MYK1`) and
//! `share_import` (`MYF1`) each mint a single `KEYCHAIN_ACCOUNT =
//! "device-wrap-key"` because an entry is enqueued before anyone knows which
//! vault it will land in. A label belongs to exactly one vault, and vault
//! deletion carries a per-`VaultId` cryptographic-erase guarantee. Under a
//! shared key, deleting a vault would leave that vault's name readable (the one
//! artefact a person actually recognises), so the guarantee would be weakened in
//! its most visible place. Keying the item by [`VaultId`] is what lets
//! [`destroy_key`] erase exactly one vault's name and nothing else.
//!
//! **There is no `DeriveSubkey` role.** A `root_key`-derived KEK fails twice
//! over: the label must be readable while the vault is LOCKED (so `root_key`
//! does not exist yet), and a derived subkey cannot be destroyed on its own
//! while its root survives, so it would only look like per-vault erase.
//!
//! **Its own keychain service string**, `md.myne.vaultlabel`, DISTINCT from
//! `md.myne.quickunlock`, `md.myne.captures` and `md.myne.shareimport`, the way
//! those three are distinct from each other so no two device-local keys collide.
//!
//! ## Platform status
//!
//! Apple (macOS / iOS) has a real backend here. Every other target returns
//! [`VaultLabelError::KeychainUnavailable`], which is a first-class state
//! rather than a failure: the store then writes nothing, and the picker falls
//! back to the neutral label. Wiring the Linux secret service or the Windows
//! credential store means adding a dependency, which is a security decision in
//! its own right (root `CLAUDE.md`) and not something to slip in behind a
//! feature. What must never happen on those platforms is the other fallback,
//! writing the name in plaintext, because it would look identical on screen
//! while voiding the erase guarantee.
//!
//! ⚠️ **UNVERIFIED on hardware**, like its two siblings: compile-checked on
//! macOS/iOS, but the keychain accessibility and non-prompting behaviour cannot
//! be confirmed without a real device. The checklist is the same one
//! `captures::device_key` carries: confirm the item is created with NO biometric
//! prompt, that a read succeeds while the vault is locked, and that the item is
//! `ThisDeviceOnly` (absent from an iCloud-Keychain-synced sibling device).

use crate::vault_id::VaultId;
use crate::vault_label::error::VaultLabelError;
use zeroize::Zeroizing;

/// Length of a per-vault wrap key (256-bit XChaCha20-Poly1305 key).
pub const VAULT_LABEL_WRAP_KEY_LEN: usize = 32;

/// Keychain service string for the sealed label store, DISTINCT from
/// `md.myne.quickunlock`, `md.myne.captures` and `md.myne.shareimport`. Frozen:
/// the OS matches it byte-for-byte, so changing it strands every key already
/// minted under it (the names would go quiet rather than break, which is the
/// worst kind of drift).
pub const KEYCHAIN_SERVICE: &str = "md.myne.vaultlabel";

/// The keychain operations this store needs, behind a trait for the same reason
/// `quick_unlock::apple`'s `KeychainOps` is. The per-vault account routing, the
/// property the erase guarantee rests on, has to be testable on a machine with
/// no keychain at all, which is what CI runs on. [`platform_keychain`] returns
/// the only production implementation.
pub trait LabelKeychain: Send + Sync {
    /// Read an item. `Ok(None)` is "no such item", which is an ordinary answer
    /// (this vault has never been unlocked here, or its key was destroyed) and
    /// not an error.
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultLabelError>;
    /// Store `secret` under `account`, replacing any existing item.
    fn store(&self, account: &str, secret: &[u8]) -> Result<(), VaultLabelError>;
    /// Remove an item. An already-absent item is a successful delete: the
    /// post-condition callers care about is "the key is gone", and it is.
    fn delete(&self, account: &str) -> Result<(), VaultLabelError>;
}

/// The account the availability probe writes, and the only account this module
/// ever addresses that is not a vault's.
///
/// An item by this name **can** exist: [`keychain_available`] stores one byte
/// under it and deletes it best-effort, so a probe interrupted between the two
/// calls leaves one behind. One fact makes that leftover harmless and rules out
/// a collision with a real key at the same time: every real account is a
/// canonical 36-char `VaultId` rendering and this string parses as none, so no
/// reader in this module ever loads it as a wrap key.
pub const KEYCHAIN_PROBE_ACCOUNT: &str = "availability-probe";

/// Is there a usable keychain on this device at all?
///
/// The one failure this store has that a user can be told something true about,
/// and the reason it is asked as its own question: on a device with no secret
/// service the feature cannot store a name at all, and the Privacy row has to
/// say so. Without it the row toggles, nothing happens, and it looks broken
/// forever with no explanation.
///
/// **Answered by attempting a WRITE, not a read, and that is the whole point.**
/// This probe used to `get` an account that does not exist and treat "no such
/// item" as proof the facility works. On macOS it is not: an ad-hoc-signed build
/// (every `tauri dev` run) can READ the data-protection keychain and gets a
/// clean `errSecItemNotFound`, while every `SecItemAdd` fails with
/// `errSecMissingEntitlement` (-34018). So the read probe answered "available",
/// the row promised the picker would show names, and each unlock silently wrote
/// nothing. That is precisely the looks-fine-does-nothing state this function
/// exists to prevent, reached through the one door nobody checked.
///
/// So it stores a one-byte value under the probe account and deletes it again.
/// Two keychain calls on a Settings-panel mount is nothing, and it asks the
/// question the caller actually has: can this device STORE a name. The delete is
/// best-effort; a leftover probe item is inert (it is not a `VaultId`, so
/// nothing reads it as a wrap key) and the next probe overwrites it.
///
/// **A permanent refusal reports unavailable whatever its code, and the retry is
/// how that is decided without enumerating codes.** An earlier version keyed the
/// verdict on `errSecMissingEntitlement` alone and mapped every other refusal to
/// `Backend`, which `!matches!` then read as available: `errSecParam`,
/// `errSecInteractionNotAllowed` and `errSecAuthFailed` all landed in exactly the
/// looks-fine-does-nothing state this function exists to prevent, one code away
/// from the one it caught. Enumerating the rest would be a denylist, and a
/// denylist is wrong here by construction, because the next OSStatus nobody
/// anticipated defaults to "available".
///
/// So the probe tries twice. `KeychainUnavailable` answers immediately, since
/// the facility named itself. A `Backend` error is retried once, and a second
/// failure of any kind reports unavailable. The asymmetry is deliberate and it
/// runs the safe way: reporting available when it is not costs the user a
/// feature that silently stores nothing forever, while reporting unavailable on
/// a genuinely transient blip costs one Settings mount, because this probe runs
/// on every one and the next answer corrects it. Telling someone their device
/// cannot store vault names on the strength of ONE bad call would be a claim
/// about the machine rather than about the call; saying it after two is a claim
/// about the call, twice.
///
/// **This is a probe, not a fallback.** Nothing anywhere reacts to a `false` by
/// writing the name in the clear; the store simply holds nothing on such a
/// device (`decisions.md` 2026-08-15).
pub fn keychain_available(ops: &dyn LabelKeychain) -> bool {
    let available = match ops.store(KEYCHAIN_PROBE_ACCOUNT, &[0u8]) {
        Ok(()) => true,
        // The facility named itself. No retry can change that answer.
        Err(VaultLabelError::KeychainUnavailable) => false,
        // Anything else is one bad call OR a permanent refusal wearing another
        // OSStatus, and a single attempt cannot tell them apart. A second one
        // can: a transient failure passes, a permanent refusal repeats.
        Err(_) => ops.store(KEYCHAIN_PROBE_ACCOUNT, &[0u8]).is_ok(),
    };
    let _ = ops.delete(KEYCHAIN_PROBE_ACCOUNT);
    available
}

/// The keychain account component for one vault: the canonical 36-char
/// `VaultId` rendering. **Frozen encoding**: the OS matches it byte-for-byte.
///
/// No `account_number_hash` half here, unlike `quick_unlock`'s
/// `hex(hash):vault_id`. That composite exists because two vault directories can
/// belong to one account and the earlier account-only key made them collide; the
/// `VaultId` alone is already the finer of the two, so adding the hash would
/// name the same set of items with more bytes.
pub fn keychain_account(vault_id: VaultId) -> String {
    vault_id.to_string()
}

/// Fetch this vault's wrap key, minting one on first use. The write path.
///
/// A stored item of the wrong length is corrupt or foreign; it is dropped and
/// re-minted, which loses nothing (the only thing it could have opened is a
/// `vault.label` file that would then be rewritten by the caller anyway).
pub fn get_or_create_key(
    ops: &dyn LabelKeychain,
    vault_id: VaultId,
) -> Result<Zeroizing<[u8; VAULT_LABEL_WRAP_KEY_LEN]>, VaultLabelError> {
    let account = keychain_account(vault_id);
    match ops.get(&account)? {
        Some(bytes) if bytes.len() == VAULT_LABEL_WRAP_KEY_LEN => Ok(fixed_key(&bytes)),
        // Present but wrong length (corrupt / foreign) -> drop and re-mint.
        Some(_) => {
            ops.delete(&account)?;
            mint(ops, &account)
        }
        None => mint(ops, &account),
    }
}

/// Fetch this vault's wrap key WITHOUT minting one. The read path.
///
/// Returns [`VaultLabelError::KeyMissing`] when no key exists, which is what
/// separates "this device has never named that vault" from "the keychain is
/// broken": the first is normal and silent, the second is reportable. A
/// wrong-length item reads as missing for the same reason it does on the write
/// path, and minting one here would be wrong, because a fresh key opens nothing.
pub fn existing_key(
    ops: &dyn LabelKeychain,
    vault_id: VaultId,
) -> Result<Zeroizing<[u8; VAULT_LABEL_WRAP_KEY_LEN]>, VaultLabelError> {
    match ops.get(&keychain_account(vault_id))? {
        Some(bytes) if bytes.len() == VAULT_LABEL_WRAP_KEY_LEN => Ok(fixed_key(&bytes)),
        Some(_) | None => Err(VaultLabelError::KeyMissing),
    }
}

/// Destroy one vault's wrap key. THIS is the erase.
///
/// Every path that has to make a name unreadable ends here: vault deletion, and
/// the device-wide hide-vault-names option's sweep. Removing the `MYL1` file
/// without this leaves recoverable ciphertext beside a live key and is not
/// sufficient; destroying the key without removing the file leaves an orphan
/// that reads as unreadable, which is correct but untidy. Callers do both
/// (`super::store::erase`).
pub fn destroy_key(ops: &dyn LabelKeychain, vault_id: VaultId) -> Result<(), VaultLabelError> {
    ops.delete(&keychain_account(vault_id))
}

/// Mint a fresh 32-byte key and store it.
fn mint(
    ops: &dyn LabelKeychain,
    account: &str,
) -> Result<Zeroizing<[u8; VAULT_LABEL_WRAP_KEY_LEN]>, VaultLabelError> {
    // Filled IN PLACE inside the wrapper. Minting into a bare array and then
    // moving it into `Zeroizing` wipes the destination slot, never the stack
    // array the CSPRNG actually wrote. The shape `quick_unlock::apple` and
    // `captures::device_key::create` both record.
    let mut key = Zeroizing::new([0u8; VAULT_LABEL_WRAP_KEY_LEN]);
    getrandom::getrandom(key.as_mut_slice()).map_err(|_| VaultLabelError::Backend)?;
    ops.store(account, key.as_slice())?;
    Ok(key)
}

/// Narrow a keychain item's bytes to a fixed-size key. The caller has already
/// checked the length.
fn fixed_key(bytes: &[u8]) -> Zeroizing<[u8; VAULT_LABEL_WRAP_KEY_LEN]> {
    let mut key = Zeroizing::new([0u8; VAULT_LABEL_WRAP_KEY_LEN]);
    key.copy_from_slice(bytes);
    key
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::*;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password_options,
    };
    use security_framework::passwords_options::PasswordOptions;

    /// `errSecItemNotFound`: the keychain item is absent (never created /
    /// destroyed).
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    /// `errSecMissingEntitlement`: this PROCESS may not use the keychain at
    /// all, which is the whole facility being unusable rather than one item
    /// being absent. The dominant cause is an unsigned build (`tauri dev`).
    const ERR_SEC_MISSING_ENTITLEMENT: i32 = -34018;

    /// The production [`LabelKeychain`], the Apple Keychain itself.
    pub struct AppleKeychain;

    impl LabelKeychain for AppleKeychain {
        fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultLabelError> {
            // `Zeroizing` goes on the returned `Vec` ITSELF, not on a fixed-size
            // copy taken from it later: this `Vec` holds a wrap key, and the
            // wrong-length arm never reaches a copy at all, so wrapping at the
            // copy would leave that arm's allocation intact.
            //
            // **Honest limit** (`docs/threat-model.md` §7 defers forensic-grade
            // scrubbing): `security_framework` builds that `Vec` from a `CFData`
            // it then releases without wiping, so a CoreFoundation-side residue
            // survives this. Reaching it would mean dropping to
            // `SecItemCopyMatching` directly.
            match get_generic_password(KEYCHAIN_SERVICE, account).map(Zeroizing::new) {
                Ok(bytes) => Ok(Some(bytes)),
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
                Err(e) if e.code() == ERR_SEC_MISSING_ENTITLEMENT => {
                    log_keychain_err("get", &e);
                    Err(VaultLabelError::KeychainUnavailable)
                }
                Err(e) => {
                    log_keychain_err("get", &e);
                    Err(VaultLabelError::Backend)
                }
            }
        }

        fn store(&self, account: &str, secret: &[u8]) -> Result<(), VaultLabelError> {
            // No SecAccessControl flags (0) -> no biometric / user-presence
            // gate: the picker reads this while the vault is locked, on every
            // launch, and a Face ID prompt to render a list would be absurd.
            // AfterFirstUnlockThisDeviceOnly -> readable after the first
            // post-boot device unlock, and never synced off this device, which
            // is what keeps the erase local to the machine that ran it.
            let access_control = SecAccessControl::create_with_protection(
                Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly),
                0,
            )
            .map_err(|e| {
                log_keychain_err("access_control_create", &e);
                VaultLabelError::Backend
            })?;
            let mut options = PasswordOptions::new_generic_password(KEYCHAIN_SERVICE, account);
            options.set_access_control(access_control);
            set_generic_password_options(secret, options).map_err(|e| {
                log_keychain_err("store", &e);
                match e.code() {
                    ERR_SEC_MISSING_ENTITLEMENT => VaultLabelError::KeychainUnavailable,
                    _ => VaultLabelError::Backend,
                }
            })
        }

        fn delete(&self, account: &str) -> Result<(), VaultLabelError> {
            match delete_generic_password(KEYCHAIN_SERVICE, account) {
                Ok(()) => Ok(()),
                // Already gone is the post-condition the caller wanted.
                Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
                Err(e) => {
                    log_keychain_err("delete", &e);
                    // An erase that failed must NOT report success: the whole
                    // option is a claim about the disk.
                    Err(VaultLabelError::Backend)
                }
            }
        }
    }

    /// Log a keychain failure with its OSStatus code (an OS status code is not
    /// key material, so it is safe to emit, and it is the diagnostic a hardware review
    /// needs, e.g. `-34018` errSecMissingEntitlement). The vault id and the
    /// label never appear.
    fn log_keychain_err(op: &'static str, e: &security_framework::base::Error) {
        tracing::warn!(
            stage = "vault_label_key",
            op,
            errsec_code = e.code(),
            "vault-label keychain operation failed"
        );
    }
}

/// A keychain that is not there. Every operation reports
/// [`VaultLabelError::KeychainUnavailable`], which is the state the Privacy row
/// renders rather than an error anyone has to handle as a surprise.
///
/// `pub` because it is also the honest stand-in a test uses for the Linux user
/// with no secret-service daemon.
pub struct UnavailableKeychain;

impl LabelKeychain for UnavailableKeychain {
    fn get(&self, _account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultLabelError> {
        Err(VaultLabelError::KeychainUnavailable)
    }
    fn store(&self, _account: &str, _secret: &[u8]) -> Result<(), VaultLabelError> {
        Err(VaultLabelError::KeychainUnavailable)
    }
    fn delete(&self, _account: &str) -> Result<(), VaultLabelError> {
        Err(VaultLabelError::KeychainUnavailable)
    }
}

/// The keychain this platform actually has. Apple gets the real one; everything
/// else gets [`UnavailableKeychain`]. See the module header for why a plaintext
/// fallback is not the other option.
pub fn platform_keychain() -> &'static dyn LabelKeychain {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        &imp::AppleKeychain
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        &UnavailableKeychain
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_label::fake_keychain::FakeKeychain;
    use crate::vault_label::test_ids::{vault, VAULT_A, VAULT_B};

    #[test]
    fn the_service_string_is_distinct_from_the_other_device_local_keys() {
        // Three device-local keys share one keychain; a collision would have one
        // feature's key silently answer another's read.
        assert_eq!(KEYCHAIN_SERVICE, "md.myne.vaultlabel");
        assert_ne!(KEYCHAIN_SERVICE, "md.myne.quickunlock");
        assert_ne!(KEYCHAIN_SERVICE, "md.myne.captures");
        assert_ne!(KEYCHAIN_SERVICE, "md.myne.shareimport");
    }

    #[test]
    fn the_account_component_is_the_canonical_vault_id() {
        assert_eq!(keychain_account(vault(VAULT_A)), VAULT_A);
    }

    #[test]
    fn each_vault_gets_its_own_key() {
        let fake = FakeKeychain::empty();
        let a = get_or_create_key(&fake, vault(VAULT_A)).expect("mint A");
        let b = get_or_create_key(&fake, vault(VAULT_B)).expect("mint B");

        assert_ne!(a.as_slice(), b.as_slice(), "two vaults, two keys");
        let mut accounts = fake.accounts();
        accounts.sort();
        assert_eq!(accounts, vec![VAULT_A.to_string(), VAULT_B.to_string()]);
    }

    #[test]
    fn a_second_call_returns_the_same_key_rather_than_re_minting() {
        let fake = FakeKeychain::empty();
        let first = get_or_create_key(&fake, vault(VAULT_A)).expect("mint");
        let second = get_or_create_key(&fake, vault(VAULT_A)).expect("fetch");
        assert_eq!(first.as_slice(), second.as_slice());
    }

    #[test]
    fn destroying_one_vaults_key_leaves_the_other_untouched() {
        // The per-vault erase guarantee, asserted by reading the keychain back
        // rather than by trusting the call returned Ok.
        let fake = FakeKeychain::empty();
        let a = get_or_create_key(&fake, vault(VAULT_A)).expect("mint A");
        let b = get_or_create_key(&fake, vault(VAULT_B)).expect("mint B");

        destroy_key(&fake, vault(VAULT_A)).expect("destroy A");

        assert!(fake.read(VAULT_A).is_none(), "A's key is gone");
        assert_eq!(
            fake.read(VAULT_B).as_deref(),
            Some(b.as_slice()),
            "B's key survives"
        );
        // And A's is really gone, not merely unreachable through one accessor.
        assert_eq!(
            existing_key(&fake, vault(VAULT_A)),
            Err(VaultLabelError::KeyMissing)
        );
        drop(a);
    }

    #[test]
    fn destroying_an_absent_key_succeeds() {
        // The post-condition is "the key is gone", and it is.
        let fake = FakeKeychain::empty();
        assert_eq!(destroy_key(&fake, vault(VAULT_A)), Ok(()));
    }

    #[test]
    fn the_read_path_never_mints() {
        let fake = FakeKeychain::empty();
        assert_eq!(
            existing_key(&fake, vault(VAULT_A)),
            Err(VaultLabelError::KeyMissing)
        );
        assert!(
            fake.accounts().is_empty(),
            "a fresh key would open nothing, so reading must not create one"
        );
        assert_eq!(fake.calls(), vec![format!("get {VAULT_A}")]);
    }

    #[test]
    fn a_wrong_length_item_is_re_minted_on_write_and_missing_on_read() {
        let fake = FakeKeychain::empty();
        fake.put(VAULT_A, vec![0x77; VAULT_LABEL_WRAP_KEY_LEN - 1]);

        assert_eq!(
            existing_key(&fake, vault(VAULT_A)),
            Err(VaultLabelError::KeyMissing),
            "a short item opens nothing"
        );

        let key = get_or_create_key(&fake, vault(VAULT_A)).expect("re-mint");
        assert_eq!(key.len(), VAULT_LABEL_WRAP_KEY_LEN);
        assert_eq!(
            fake.read(VAULT_A).as_deref(),
            Some(key.as_slice()),
            "the corrupt item was replaced"
        );
    }

    #[test]
    fn a_failed_store_surfaces_rather_than_returning_an_unstored_key() {
        // Handing back a key the keychain did not keep would seal a file nothing
        // can ever open.
        let fake = FakeKeychain::failing_store();
        assert_eq!(
            get_or_create_key(&fake, vault(VAULT_A)),
            Err(VaultLabelError::Backend)
        );
    }

    #[test]
    fn the_probe_reports_a_working_keychain_that_holds_nothing_as_available() {
        // The distinction the probe exists to draw: "no item for that vault" is
        // the ordinary state of a device that has never named a vault, and it is
        // not the same fact as "this device has no keychain".
        let fake = FakeKeychain::empty();
        assert!(keychain_available(&fake));
    }

    #[test]
    fn the_probe_reports_a_device_with_no_keychain_as_unavailable() {
        assert!(!keychain_available(&UnavailableKeychain));
    }

    #[test]
    fn the_probe_writes_and_then_cleans_up_after_itself() {
        // It has to WRITE, because writing is the thing the caller wants to know
        // about. It must also leave nothing behind: a probe that kept its item
        // would add a keychain entry on every Settings-panel mount.
        let fake = FakeKeychain::empty();
        assert!(keychain_available(&fake));
        assert!(fake.accounts().is_empty(), "the probe left its item behind");
        assert_eq!(
            fake.calls(),
            vec![
                format!("store {KEYCHAIN_PROBE_ACCOUNT}"),
                format!("delete {KEYCHAIN_PROBE_ACCOUNT}"),
            ]
        );
    }

    #[test]
    fn a_keychain_that_reads_but_cannot_write_is_reported_unavailable() {
        // The macOS ad-hoc-signed shape, and the reason this probe stopped being
        // a read. Every `tauri dev` build is in it: `get` returns a clean
        // errSecItemNotFound and `SecItemAdd` fails with errSecMissingEntitlement
        // (-34018). The read probe called such a device healthy, so the Privacy
        // row promised the picker would show names while each unlock silently
        // wrote nothing. Reported by furkan against the running app, and it is
        // exactly the looks-fine-does-nothing state this option exists to avoid.
        let fake = FakeKeychain::readable_but_unwritable();
        assert!(
            fake.get(KEYCHAIN_PROBE_ACCOUNT).is_ok(),
            "precondition: reads must work, or this proves nothing"
        );
        assert!(!keychain_available(&fake));
    }

    #[test]
    fn a_transient_backend_failure_is_not_reported_as_an_absent_keychain() {
        // One bad call against a facility that is there. The row's sentence
        // ("this device cannot store vault names") would be a lie about a
        // keychain that answered, so the probe retries and the second attempt
        // decides.
        //
        // This asserted over `failing_store()` until 2026-08-25, and that
        // fixture fails EVERY store, permanently. So a test named for a
        // transient failure was pinning the opposite: that a keychain which can
        // never write is reported available. It was green, and it held the
        // one-OSStatus gap below open.
        let fake = FakeKeychain::store_fails_once();
        assert!(keychain_available(&fake));
    }

    #[test]
    fn a_permanent_backend_refusal_is_reported_as_unavailable_whatever_its_code() {
        // The gap the retry closes. `AppleKeychain::store` maps only
        // `errSecMissingEntitlement` to `KeychainUnavailable` and sends every
        // other refusal to `Backend`; `errSecParam`, `errSecInteractionNotAllowed`
        // and `errSecAuthFailed` are all permanent and all arrive that way. A
        // probe that read `Backend` as available left each of them in exactly the
        // looks-fine-does-nothing state this whole function exists to prevent.
        let fake = FakeKeychain::failing_store();
        assert!(!keychain_available(&fake));
    }

    #[test]
    fn the_probe_account_can_never_name_a_vaults_key() {
        // Every real account is a canonical 36-char `VaultId` rendering, so the
        // probe cannot address, shadow or destroy one.
        assert!(VaultId::parse(KEYCHAIN_PROBE_ACCOUNT).is_err());
        assert_ne!(keychain_account(vault(VAULT_A)), KEYCHAIN_PROBE_ACCOUNT);
    }

    #[test]
    fn an_unavailable_keychain_reports_itself_on_every_operation() {
        // The Linux-with-no-secret-service shape. Note what is NOT here: no arm
        // that quietly succeeds by writing something in the clear.
        let none = UnavailableKeychain;
        assert_eq!(
            get_or_create_key(&none, vault(VAULT_A)),
            Err(VaultLabelError::KeychainUnavailable)
        );
        assert_eq!(
            existing_key(&none, vault(VAULT_A)),
            Err(VaultLabelError::KeychainUnavailable)
        );
        assert_eq!(
            destroy_key(&none, vault(VAULT_A)),
            Err(VaultLabelError::KeychainUnavailable)
        );
    }
}
