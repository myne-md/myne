// SPDX-License-Identifier: AGPL-3.0
//! The **device signing key** at rest, and the storage ladder it is allowed to use
//! (`decisions/protocol/0731`, `0733` decision 4).
//!
//! # The ladder, and what this module implements of it
//!
//! `0733` fixes four rungs, in order, and one rule that outranks all of them:
//! **never plaintext**.
//!
//! 1. the OS keychain with `thisDeviceOnly` semantics, excluded from platform backup
//!    and cloud sync: IMPLEMENTED here for Apple (Keychain, macOS + iOS);
//! 2. on Linux, the Secret Service (GNOME Keyring / KWallet) through the session bus
//!    NOT IMPLEMENTED. It needs a platform dependency the tree does not carry, and
//!    adding one to an audited, no-egress-clean graph is its own decision;
//! 3. failing that, a `0600` file sealed by a user PIN, reusing the `MYQ1`
//!    attempt-and-wipe machinery: NOT IMPLEMENTED yet, for the same kind of reason
//!    one step over: it is a user-facing ceremony (choose a PIN, enter it on every
//!    cold start, lose the key after N wrong tries) and it lands with its own UI;
//! 4. and if the user declines a PIN, **no device key is created on that machine**
//!    and it keeps the phrase path.
//!
//! So on any platform but Apple this module reports [`supported()`] `false`, the
//! signer falls back to the person key (`0x02` heads, which every peer already
//! accepts), and **the product behaves exactly as it does today**. That is rung 4,
//! reached by not having built rungs 2 and 3 yet. A silent plaintext fallback is not
//! available and must not be added: a device key in a plaintext file is a signing key
//! any process on the machine can use, which is worse than the phrase entry it would
//! save.
//!
//! # Why the key is not biometric
//!
//! Unlike the quick-unlock provider (which gates a wrap key behind Touch ID), this
//! item is created with NO access-control flags. A head is authored on a background
//! sync cycle, so a biometric gate would either fail the cycle or prompt the user at
//! a moment they did not choose. `AccessibleWhenUnlockedThisDeviceOnly` is the
//! protection that matters here: never off-device, never in a backup.
//!
//! # What the key is worth, repeated at the store
//!
//! A device key unwraps NOTHING. Losing it costs the device its ability to author
//! heads until it re-binds; stealing it costs attribution until the binding is
//! revoked. It is not a vault credential and must never be described as one.

use protocol::device_key::{DeviceKeyPair, DEVICE_KEY_PLAINTEXT_LEN};
use zeroize::Zeroizing;

/// Keychain service string for the device signing key. DELIBERATELY its own service:
/// `md.myne.captures`, `md.myne.shareimport`, `md.myne.quickunlock` and
/// `md.myne.vaultlabel` each hold an unrelated secret, and one shared item name would
/// let one family's wipe take another's key.
pub const DEVICE_KEYCHAIN_SERVICE: &str = "md.myne.devicekey";

/// Item name inside the service. One device signing key per device, so no account
/// component: the key is device-scoped by definition, and two vaults on one device
/// share it.
pub const DEVICE_KEYCHAIN_ACCOUNT: &str = "device-signing-key";

/// Why a device key could not be read or created.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceKeyStoreError {
    /// This platform has no rung of the ladder yet (see the module header). The
    /// caller falls back to the person key, which is a SUPPORTED state and not a
    /// fault: it is rung 4.
    Unsupported,
    /// The keychain refused the read or the write.
    Backend,
    /// The stored item is not a well-formed device-key plaintext, so it was
    /// corrupted or written by something else. The caller re-creates rather than
    /// signing under a key it cannot trust.
    Corrupt,
    /// The OS entropy source failed while minting.
    Csprng,
}

/// Whether this build can hold a device key at all. See the module header for why
/// only Apple answers `true` today.
#[must_use]
pub fn supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "ios"))
}

/// Read the device key, without creating one. `Ok(None)` when the item is absent,
/// which is the ordinary first-run state.
pub fn load() -> Result<Option<DeviceKeyPair>, DeviceKeyStoreError> {
    imp::load()
}

/// Read the device key, minting one on first use.
///
/// Minting writes the item before it returns, so a caller that receives `Ok` holds a
/// key that is already at rest: a crash between here and the binding-row write leaves
/// an unbound key (harmless, re-bound on the next unlock) rather than a binding whose
/// key was lost.
pub fn load_or_create() -> Result<DeviceKeyPair, DeviceKeyStoreError> {
    if let Some(pair) = imp::load()? {
        return Ok(pair);
    }
    let pair = DeviceKeyPair::generate().map_err(|_| DeviceKeyStoreError::Csprng)?;
    imp::store(&pair)?;
    Ok(pair)
}

/// Destroy the device key. Called by the device-local erase paths (forget-identity,
/// vault delete) so a device that is being wiped does not leave a signing key behind.
/// Best-effort: a failed delete is logged and does not fail the erase, because the
/// erase's own guarantee is about vault content.
pub fn destroy() {
    imp::destroy();
}

/// The plaintext this module stores, as bytes. Exposed so a test can prove the
/// round-trip through the same codec the keychain item carries.
#[must_use]
pub fn to_item_bytes(pair: &DeviceKeyPair) -> Zeroizing<Vec<u8>> {
    Zeroizing::new(pair.to_plaintext_bytes().to_vec())
}

/// Decode what a keychain item carries. A wrong length is [`DeviceKeyStoreError::Corrupt`]
/// rather than "absent": an item that is present and wrong is a different failure from
/// no item, and the difference decides whether the caller may re-mint.
pub fn from_item_bytes(bytes: &[u8]) -> Result<DeviceKeyPair, DeviceKeyStoreError> {
    let fixed: [u8; DEVICE_KEY_PLAINTEXT_LEN] =
        bytes.try_into().map_err(|_| DeviceKeyStoreError::Corrupt)?;
    DeviceKeyPair::from_plaintext_bytes(&fixed).map_err(|_| DeviceKeyStoreError::Corrupt)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::{
        from_item_bytes, to_item_bytes, DeviceKeyPair, DeviceKeyStoreError,
        DEVICE_KEYCHAIN_ACCOUNT, DEVICE_KEYCHAIN_SERVICE,
    };
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password_options,
    };
    use security_framework::passwords_options::PasswordOptions;
    use zeroize::Zeroizing;

    /// `errSecItemNotFound`: the item is absent (never created, or wiped).
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    pub fn load() -> Result<Option<DeviceKeyPair>, DeviceKeyStoreError> {
        // `Zeroizing` on the returned Vec ITSELF, before any arm inspects it: the
        // buffer holds both private seeds, and the corrupt-length arm would otherwise
        // leave the allocation intact.
        match get_generic_password(DEVICE_KEYCHAIN_SERVICE, DEVICE_KEYCHAIN_ACCOUNT)
            .map(Zeroizing::new)
        {
            Ok(bytes) => from_item_bytes(&bytes).map(Some),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => {
                log_keychain_err("get", &e);
                Err(DeviceKeyStoreError::Backend)
            }
        }
    }

    pub fn store(pair: &DeviceKeyPair) -> Result<(), DeviceKeyStoreError> {
        // No access-control flags (0): no biometric / user-presence gate, because a
        // head is authored on a background cycle. `WhenUnlockedThisDeviceOnly`: the
        // item is never exported, never synced, never in a backup, and reachable only
        // while the device is unlocked.
        let access_control = SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
            0,
        )
        .map_err(|e| {
            log_keychain_err("access_control_create", &e);
            DeviceKeyStoreError::Backend
        })?;
        let mut options =
            PasswordOptions::new_generic_password(DEVICE_KEYCHAIN_SERVICE, DEVICE_KEYCHAIN_ACCOUNT);
        options.set_access_control(access_control);
        let bytes = to_item_bytes(pair);
        set_generic_password_options(bytes.as_slice(), options).map_err(|e| {
            log_keychain_err("store", &e);
            DeviceKeyStoreError::Backend
        })
    }

    pub fn destroy() {
        if let Err(e) = delete_generic_password(DEVICE_KEYCHAIN_SERVICE, DEVICE_KEYCHAIN_ACCOUNT) {
            if e.code() != ERR_SEC_ITEM_NOT_FOUND {
                log_keychain_err("delete", &e);
            }
        }
    }

    /// An OSStatus code is not key material, so it may be logged; it is the
    /// diagnostic a hardware review needs (e.g. `-34018` missing entitlement).
    fn log_keychain_err(op: &'static str, e: &security_framework::base::Error) {
        tracing::warn!(
            stage = "device_key_keychain",
            op,
            errsec_code = e.code(),
            "device-key keychain operation failed"
        );
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    use super::{DeviceKeyPair, DeviceKeyStoreError};

    pub fn load() -> Result<Option<DeviceKeyPair>, DeviceKeyStoreError> {
        // Rung 4: no device key on this machine, so it keeps the phrase path. See the
        // module header; rungs 2 and 3 are not built yet and a plaintext fallback is
        // not an option.
        Err(DeviceKeyStoreError::Unsupported)
    }

    pub fn store(_pair: &DeviceKeyPair) -> Result<(), DeviceKeyStoreError> {
        Err(DeviceKeyStoreError::Unsupported)
    }

    pub fn destroy() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_item_codec_round_trips_and_refuses_a_foreign_length() {
        let pair = DeviceKeyPair::generate_raw(&[0x31; 32], &[0x32; 32]);
        let bytes = to_item_bytes(&pair);
        let back = from_item_bytes(&bytes).expect("round trip");
        assert_eq!(back.public_half(), pair.public_half());

        // An item of the wrong length is CORRUPT rather than absent: the difference
        // decides whether the caller may mint a replacement.
        assert!(matches!(
            from_item_bytes(&bytes[..bytes.len() - 1]),
            Err(DeviceKeyStoreError::Corrupt)
        ));
    }

    #[test]
    fn a_platform_without_a_rung_reports_unsupported_rather_than_minting() {
        if supported() {
            // Apple hosts have a real keychain; this assertion is about the other
            // platforms, and asserting it here would prompt for keychain access.
            return;
        }
        assert!(matches!(load(), Err(DeviceKeyStoreError::Unsupported)));
        assert!(matches!(
            load_or_create().map(|_| ()),
            Err(DeviceKeyStoreError::Unsupported)
        ));
    }
}
