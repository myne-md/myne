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
//!    and cloud sync: IMPLEMENTED for Apple (Keychain, macOS + iOS);
//! 2. on Linux, the Secret Service (GNOME Keyring / KWallet) through the session bus:
//!    IMPLEMENTED (see `imp` below), with the `secret-service` crate's DH session;
//! 3. failing that, a `0600` file sealed by a user PIN, reusing the `MYQ1`
//!    attempt-and-wipe machinery: the CODEC is implemented in
//!    [`super::device_key_pin`], and **the ceremony that asks for the PIN is not**.
//!    No command, no Settings surface and no unlock-time prompt calls it in this
//!    release, so nothing in the product reaches this rung today and
//!    [`load`] cannot: a PIN has to be asked for, so a rung-3 key can only be
//!    installed by a user action ([`install_session_key`]) and no caller performs
//!    one. Said plainly here because the paragraph above used to read as a shipped
//!    rung, and a reader who believed it would look for the prompt and not find it
//!    (myne-md/myne#938 review). What the codec does buy today is the part that is
//!    hard to get right and unreviewable later: the salt domain, the attempt
//!    counter and the wipe;
//! 4. and if the user declines a PIN, **no device key is created on that machine**
//!    and it keeps the phrase path.
//!
//! A rung-3 unlock installs the key in this process's [`session`] slot, so the sync
//! cycle that runs afterwards reads it without a second PIN entry. That slot is
//! cleared by [`destroy`], by a vault lock (`vault_unlock::commands::lock` calls
//! [`clear_session_key`]), and by process exit, and it is never written anywhere:
//! it is the same lifetime as an unlocked vault, and shorter than the OS store's.
//!
//! Where no rung answers, the signer falls back to the person key (`0x02` heads,
//! which every peer already accepts) and **the product behaves exactly as it does
//! today**. That is rung 4. A silent plaintext fallback is not available and must not
//! be added: a device key in a plaintext file is a signing key any process on the
//! machine can use, which is worse than the phrase entry it would save.
//!
//! # Why the key is not biometric
//!
//! Unlike the quick-unlock provider (which gates a wrap key behind Touch ID), this
//! item is created with NO access-control flags. A head is authored on a background
//! sync cycle, so a biometric gate would either fail the cycle or prompt the user at
//! a moment they did not choose. `AccessibleWhenUnlockedThisDeviceOnly` is the
//! protection that matters here: never off-device, never in a backup. The Linux rung
//! inherits the same rule from the other side: a **locked** Secret Service item is
//! reported as unavailable rather than unlocked, because unlocking it prompts.
//!
//! # What the key is worth, repeated at the store
//!
//! A device key unwraps NOTHING. Losing it costs the device its ability to author
//! heads until it re-binds; stealing it costs attribution until the binding is
//! revoked. It is not a vault credential and must never be described as one.

use std::sync::{Mutex, OnceLock};

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

/// Whether this build can hold a device key at all.
///
/// Apple answers `true` (rung 1). Linux answers `true` (rungs 2 and 3: a Secret
/// Service, or a PIN-sealed file). Everywhere else the ladder has no rung yet and the
/// device keeps the phrase path, which is rung 4 and not a fault.
///
/// A `true` here is a **capability of the build**, not a promise that this machine has
/// a key: Linux with no session bus answers `true` and then [`load`] returns
/// [`DeviceKeyStoreError::Unsupported`] until a rung-3 PIN is set. Callers decide what
/// to offer from `supported()` + `load()`, never from `supported()` alone.
#[must_use]
pub fn supported() -> bool {
    cfg!(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "linux"
    )) || session_key().is_some()
        || host_provider().is_some()
}

/// The process-lifetime slot a rung-3 PIN unlock installs into, so the sync cycles
/// that follow do not ask for the PIN again.
///
/// In RAM only, never serialized, and cleared by [`destroy`]. Deliberately not a
/// preference and not a file: the whole point of rung 3 is that the key is at rest
/// only in sealed form.
fn session_slot() -> &'static Mutex<Option<DeviceKeyPair>> {
    static SLOT: OnceLock<Mutex<Option<DeviceKeyPair>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn session_key() -> Option<DeviceKeyPair> {
    session_slot().lock().ok().and_then(|guard| guard.clone())
}

/// A **host-registered OS store**, for a platform whose keychain is reachable only
/// from the host layer.
///
/// This exists because of Android: the Keystore is behind a Kotlin plugin the mobile
/// host owns, and this crate is also compiled by the desktop and web clients, so it
/// must not take a JNI dependency to reach it. The host implements this trait over
/// its own bridge and installs it at startup with [`install_host_provider`].
///
/// It is **not** an escape hatch for a plaintext store: an implementation must keep
/// the key in the platform's own protected store, and `core` cannot verify that. The
/// same trust the Apple arm places in `security-framework` and the Linux arm in the
/// Secret Service. What the trait does buy is that the *policy* (when a key is read,
/// what a refusal means, when the fallback is silent) stays in one place for every
/// platform instead of being re-decided by each host.
pub trait DeviceKeyProvider: Send + Sync + 'static {
    /// Read the key, `Ok(None)` when the store holds none.
    fn load(&self) -> Result<Option<DeviceKeyPair>, DeviceKeyStoreError>;
    /// Write the key, replacing any previous one.
    fn store(&self, pair: &DeviceKeyPair) -> Result<(), DeviceKeyStoreError>;
    /// Delete the key. Best-effort, like every other erase on this ladder.
    fn destroy(&self);
}

/// The installed host provider, if the host registered one. One static, shared by
/// [`host_provider`] and [`install_host_provider`]: two locals would be two slots, so
/// an install would succeed and every read would still see `None`.
static HOST_PROVIDER: OnceLock<Box<dyn DeviceKeyProvider>> = OnceLock::new();

/// The installed host provider, if the host registered one.
fn host_provider() -> Option<&'static dyn DeviceKeyProvider> {
    HOST_PROVIDER.get().map(|boxed| &**boxed)
}

/// Install the host's OS store. **First call wins**, and a second is refused with a
/// warning rather than silently replacing the first.
///
/// Two providers would be two stores holding two different device keys, and the
/// device's identity is bound to one key: whichever lost the race would un-bind the
/// device on every cycle. A host calls this once, from its startup path.
pub fn install_host_provider(provider: Box<dyn DeviceKeyProvider>) {
    if HOST_PROVIDER.set(provider).is_err() {
        tracing::warn!(
            stage = "device_identity",
            event = "host_provider_already_installed",
            "a second device-key provider was refused; two stores would hold two \
             different device keys and un-bind this device on every cycle"
        );
    }
}

/// Install a key that a rung-3 PIN unlock recovered, for the rest of this process.
///
/// Idempotent and last-writer-wins: a second unlock with the same PIN simply replaces
/// an identical value, and a re-seal after a wipe replaces the stale one.
pub fn install_session_key(pair: DeviceKeyPair) {
    if let Ok(mut guard) = session_slot().lock() {
        *guard = Some(pair);
    }
}

/// Drop the process-lifetime key. Called by [`destroy`] and by a lock/forget path that
/// is wiping the device identity.
pub fn clear_session_key() {
    if let Ok(mut guard) = session_slot().lock() {
        *guard = None;
    }
}

/// Read the device key, without creating one. `Ok(None)` when the item is absent,
/// which is the ordinary first-run state.
///
/// A rung-3 unlock that already happened in this process answers first: the key is
/// then in RAM and no store is consulted.
pub fn load() -> Result<Option<DeviceKeyPair>, DeviceKeyStoreError> {
    if let Some(pair) = session_key() {
        return Ok(Some(pair));
    }
    // A host-registered store wins over this crate's own cfg arm: the host knows
    // whether its platform has one (Android's Keystore lives behind a Kotlin plugin),
    // and no host installs a provider where `imp` already works.
    if let Some(provider) = host_provider() {
        return provider.load();
    }
    imp::load()
}

/// Read the device key for a call site that has a phrase path to fall back on.
///
/// `None` here means "sign with the person key instead", which is a legitimate state
/// (rung 4) when the platform has no rung: `Unsupported` is therefore silent. The other
/// two arm silently as well, and that was wrong: a keychain refusal or a corrupted item
/// collapsed into the same `None` as an unsupported platform, so a device whose key had
/// gone missing signed `0x02` heads forever with nothing in the log saying why, and the
/// `Corrupt`/absent distinction this module deliberately draws was discarded at the very
/// call sites that should act on it. They now warn, naming the site, and still fall back:
/// refusing outright would strand a device whose keychain is merely locked.
pub fn load_for_fallback(site: &'static str) -> Option<DeviceKeyPair> {
    match load() {
        Ok(pair) => pair,
        Err(DeviceKeyStoreError::Unsupported) => None,
        Err(err) => {
            tracing::warn!(
                stage = "device_identity",
                event = "device_key_unavailable",
                site,
                reason = ?err,
                "a device key exists on this platform but could not be read, so this \
                 device signs with the person key (0x02) until it can be"
            );
            None
        }
    }
}

/// Read the device key, minting one on first use.
///
/// Minting writes the item before it returns, so a caller that receives `Ok` holds a
/// key that is already at rest: a crash between here and the binding-row write leaves
/// an unbound key (harmless, re-bound on the next unlock) rather than a binding whose
/// key was lost.
pub fn load_or_create() -> Result<DeviceKeyPair, DeviceKeyStoreError> {
    if let Some(pair) = session_key() {
        return Ok(pair);
    }
    if let Some(pair) = load()? {
        return Ok(pair);
    }
    let pair = DeviceKeyPair::generate().map_err(|_| DeviceKeyStoreError::Csprng)?;
    match host_provider() {
        Some(provider) => provider.store(&pair)?,
        None => imp::store(&pair)?,
    }
    Ok(pair)
}

/// Destroy the device key. Called by the device-local erase paths (forget-identity,
/// vault delete) so a device that is being wiped does not leave a signing key behind.
/// Best-effort: a failed delete is logged and does not fail the erase, because the
/// erase's own guarantee is about vault content.
///
/// The rung-3 sealed file is **not** removed here: this function has no path and no
/// [`crate::vault_io::VaultIo`], and the caller that erases the identity knows the
/// device config directory. It calls [`super::device_key_pin::wipe`] alongside this.
pub fn destroy() {
    clear_session_key();
    match host_provider() {
        Some(provider) => provider.destroy(),
        None => imp::destroy(),
    }
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

#[cfg(target_os = "linux")]
mod imp {
    //! Rung 2: the Secret Service, over the session bus.
    //!
    //! Reached through the crate's **blocking** API because this module's callers are
    //! synchronous (the Apple arm beside it is a plain keychain call, and making one
    //! platform async would have rippled an `async` signature through the sync cycle,
    //! the device binding and the roster verification for no gain). The calls are bus
    //! round-trips, and the one that could block indefinitely (a prompt for a locked
    //! collection) is never made: see [`load`].
    //!
    //! **Where that round-trip runs, stated because it is a real cost and not a free
    //! one** (myne-md/myne#938 review). The callers are `async fn`s on the Tauri
    //! command and sync-cycle paths, which run on the tokio runtime's WORKER threads
    //! rather than on the WebView's thread, so a blocking call here cannot freeze the
    //! UI. What it can do is hold one worker for the length of a session-bus
    //! round-trip, which is milliseconds against a running keyring and bounded when
    //! the collection is locked (the answer is "unavailable", not a prompt). No lock
    //! of this module's is held across it: [`super::session_key`] clones and drops its
    //! guard before the store is consulted, and [`super::host_provider`] reads a
    //! `OnceLock` without keeping a guard. If a future caller is on the main thread
    //! or inside a `spawn_blocking` pool of size one, it must wrap the call in
    //! `crate::task::run_blocking` first.

    use super::{
        from_item_bytes, to_item_bytes, DeviceKeyPair, DeviceKeyStoreError,
        DEVICE_KEYCHAIN_ACCOUNT, DEVICE_KEYCHAIN_SERVICE,
    };
    use secret_service::blocking::SecretService;
    use secret_service::EncryptionType;
    use std::collections::HashMap;

    /// The item's attributes. The same service/account pair the Apple arm uses, so the
    /// ladder's two OS stores describe the same item, and a future migration between
    /// them is a copy rather than a translation.
    ///
    /// Borrowed `&str` keys, not `String`: the crate's `search_items` / `create_item`
    /// take `HashMap<&str, &str>`, and both constants are `&'static str` anyway.
    fn attributes() -> HashMap<&'static str, &'static str> {
        HashMap::from([
            ("service", DEVICE_KEYCHAIN_SERVICE),
            ("username", DEVICE_KEYCHAIN_ACCOUNT),
        ])
    }

    /// A DH session, so the secret crosses the bus encrypted rather than in the clear.
    /// `Plain` would put the device key on the bus where any same-session peer that
    /// can read the socket could lift it.
    /// Generic over the proxy lifetime because every caller keeps the service in a
    /// local and borrows it for that scope; a concrete `'static` here would demand a
    /// `&'static self` at each call site and none of them has one.
    fn connect<'a>() -> Result<SecretService<'a>, DeviceKeyStoreError> {
        SecretService::connect(EncryptionType::Dh).map_err(|e| {
            tracing::warn!(
                stage = "device_key_secret_service",
                op = "connect",
                reason = error_label(&e),
                "no Secret Service on this session bus; the device key has no OS store \
                 (rung 4 unless a PIN-sealed key exists)"
            );
            DeviceKeyStoreError::Unsupported
        })
    }

    pub fn load() -> Result<Option<DeviceKeyPair>, DeviceKeyStoreError> {
        let ss = connect()?;
        let found = ss.search_items(attributes()).map_err(|e| {
            log_backend_err("search", &e);
            DeviceKeyStoreError::Backend
        })?;

        let Some(item) = found.unlocked.first() else {
            if found.locked.is_empty() {
                // No item at all: the ordinary first-run state.
                return Ok(None);
            }
            // An item exists but its collection is locked. Unlocking it raises a
            // user prompt, and this read happens on a background sync cycle at a
            // moment the user did not choose, so the honest answer is "not
            // available right now" and the caller signs `0x02` until the session is
            // unlocked. Never `item.unlock()` here.
            tracing::warn!(
                stage = "device_key_secret_service",
                event = "device_key_locked",
                "the Secret Service holds a device key but its collection is locked; \
                 this cycle signs with the person key"
            );
            return Err(DeviceKeyStoreError::Backend);
        };

        let secret = item.get_secret().map_err(|e| {
            log_backend_err("get_secret", &e);
            DeviceKeyStoreError::Backend
        })?;
        let bytes = zeroize::Zeroizing::new(secret);
        from_item_bytes(&bytes).map(Some)
    }

    pub fn store(pair: &DeviceKeyPair) -> Result<(), DeviceKeyStoreError> {
        let ss = connect()?;
        let collection = ss.get_default_collection().map_err(|e| {
            log_backend_err("default_collection", &e);
            DeviceKeyStoreError::Backend
        })?;
        let bytes = to_item_bytes(pair);
        // `replace = true`: one device key per device, so a second write replaces the
        // item rather than creating a sibling that `search_items().unlocked.first()`
        // would pick between arbitrarily.
        collection
            .create_item(
                "Myne device signing key",
                attributes(),
                bytes.as_slice(),
                true,
                "text/plain",
            )
            .map_err(|e| {
                log_backend_err("create_item", &e);
                DeviceKeyStoreError::Backend
            })?;
        Ok(())
    }

    pub fn destroy() {
        let Ok(ss) = connect() else { return };
        let Ok(found) = ss.search_items(attributes()) else {
            return;
        };
        // Locked items are deleted too: the point of the erase is that the key stops
        // existing, and a delete needs no unlock.
        for item in found.unlocked.iter().chain(found.locked.iter()) {
            if let Err(e) = item.delete() {
                log_backend_err("delete", &e);
            }
        }
    }

    /// A D-Bus error is not key material, so it may be logged; it is the diagnostic a
    /// Linux support report needs (a missing keyring daemon, a refused bus name).
    ///
    /// The CLASS, never the error's `Display`. A `Display` value is the shape the
    /// diagnostic log's content claim cannot hold (`check-tracing-discipline.mjs` R1):
    /// `secret_service::Error` formats a `zbus` error, whose text comes from the
    /// daemon's reply, so it is a string no rule can bound. Every variant the crate
    /// 5.2 upgrade names gets its own label, and the enum is `#[non_exhaustive]` so a
    /// minor bump may add one; the wildcard arm keeps that from being a build break
    /// without letting an unnamed variant's `Display` reach the log.
    fn log_backend_err(op: &'static str, e: &secret_service::Error) {
        tracing::warn!(
            stage = "device_key_secret_service",
            op,
            reason = error_label(e),
            "device-key Secret Service operation failed"
        );
    }

    /// The closed classification of a Secret Service failure, as a `&'static str`.
    fn error_label(e: &secret_service::Error) -> &'static str {
        use secret_service::Error;
        match e {
            Error::Crypto(_) => "crypto",
            Error::Zbus(_) => "zbus",
            Error::ZbusFdo(_) => "zbus_fdo",
            Error::Zvariant(_) => "zvariant",
            Error::Locked => "locked",
            Error::NoResult => "no_result",
            Error::Prompt => "prompt",
            Error::PromptDisconnected => "prompt_disconnected",
            Error::Unavailable => "unavailable",
            _ => "unclassified",
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "linux")))]
mod imp {
    use super::{DeviceKeyPair, DeviceKeyStoreError};

    pub fn load() -> Result<Option<DeviceKeyPair>, DeviceKeyStoreError> {
        // Rung 4: no OS store on this platform, so the device keeps the phrase path
        // until rung 2 or 3 lands here. A plaintext fallback is not an option.
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

    /// Serializes the tests that touch the two PROCESS-GLOBAL key slots: the RAM
    /// slot rung 3 installs into, and the host-provider `OnceLock`. `cargo test`
    /// runs a suite in threads inside one process, so two tests mutating either
    /// slot interleave, and the failure reads as a logic bug in the code under
    /// test rather than as shared state. Taken by `a_rung_three_unlock_...` and
    /// `a_host_registered_store_...`, which are the only two.
    static SLOT_LOCK: Mutex<()> = Mutex::new(());

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
            // Apple hosts have a real keychain and Linux hosts have rungs 2 and 3;
            // this assertion is about the remaining platforms, and asserting it on a
            // host with a real store would prompt for keychain access.
            return;
        }
        assert!(matches!(load(), Err(DeviceKeyStoreError::Unsupported)));
        assert!(matches!(
            load_or_create().map(|_| ()),
            Err(DeviceKeyStoreError::Unsupported)
        ));
    }

    /// A host-registered store answers for this crate on a platform whose keychain
    /// lives in the host layer (Android's Keystore is behind a Kotlin plugin), and a
    /// second install is refused rather than replacing the first.
    ///
    /// **Two process-global slots, and this test is the only one that may hold
    /// either.** `HOST_PROVIDER` is a `OnceLock` and the RAM slot is a plain
    /// `OnceLock`, and the whole suite shares one process: a second test installing
    /// either would make this one's answers depend on the order cargo happened to
    /// schedule them. [`SLOT_LOCK`] serializes the two tests that touch them, and
    /// both start from an empty RAM slot, which is not ceremony: this test first
    /// shipped without it and failed only when the other test happened to run
    /// first, because `load()` consults the RAM slot before any provider.
    ///
    /// **Every absence is asserted on the provider, never on [`load`], and that is
    /// the second half of the same lesson.** `load()` falls through to this crate's
    /// own `imp` arm when a provider answers `Ok(None)`, and on a host with a real
    /// keychain (macOS, iOS, Linux) that arm reads the OS store: an earlier test in
    /// the same suite can leave a real key there, so `assert!(load()...is_none())`
    /// passes or fails on scheduling rather than on this module's behaviour. It was
    /// green in the full suite and red in a full run an hour later, which is the
    /// signature. So the provider's own answers are read from the provider, and the
    /// only claim made through `load()` is a claim a fall-through cannot fake: that
    /// the key it returns is the one this provider minted.
    #[test]
    fn a_host_registered_store_answers_for_the_crate() {
        let _serialized = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_session_key();
        struct FakeProvider {
            inner: Mutex<Option<DeviceKeyPair>>,
            destroyed: std::sync::atomic::AtomicBool,
        }
        impl DeviceKeyProvider for FakeProvider {
            fn load(&self) -> Result<Option<DeviceKeyPair>, DeviceKeyStoreError> {
                Ok(self.inner.lock().expect("lock").clone())
            }
            fn store(&self, pair: &DeviceKeyPair) -> Result<(), DeviceKeyStoreError> {
                *self.inner.lock().expect("lock") = Some(pair.clone());
                Ok(())
            }
            fn destroy(&self) {
                self.destroyed
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                *self.inner.lock().expect("lock") = None;
            }
        }

        let provider = Box::new(FakeProvider {
            inner: Mutex::new(None),
            destroyed: std::sync::atomic::AtomicBool::new(false),
        });
        install_host_provider(provider);

        // The fixture must reach the state the assertion is about.
        assert!(host_provider().is_some(), "the provider must be installed");
        assert!(
            supported(),
            "a host that installed a store can hold a device key"
        );

        // Absent before anything is written, read ON THE PROVIDER: the ordinary
        // first-run state is the provider's `Ok(None)`, and `load()`'s answer here
        // would be the OS keychain's, which this test does not own.
        assert!(host_provider()
            .expect("the provider must be installed")
            .load()
            .expect("absent is not a failure")
            .is_none());

        // Minting goes THROUGH the provider, and `load()` must answer with the key
        // the provider minted rather than with anything the OS store holds. A
        // fall-through cannot produce this value, so the claim is attributable.
        let minted = load_or_create().expect("mint through the provider");
        let stored = host_provider()
            .expect("the provider must be installed")
            .load()
            .expect("read the provider")
            .expect("the minted key is in the provider");
        assert_eq!(stored.public_half(), minted.public_half());
        assert_eq!(
            load()
                .expect("read through the provider")
                .expect("the minted key is there")
                .public_half(),
            minted.public_half(),
            "load() must prefer the host store over this crate's own arm"
        );

        // A second key must not be minted while one is stored: a replacement key
        // silently un-binds the device.
        let again = load_or_create().expect("reuse");
        assert_eq!(again.public_half(), minted.public_half());

        destroy();
        assert!(
            host_provider()
                .expect("the provider must be installed")
                .load()
                .expect("after destroy")
                .is_none(),
            "destroy must empty the store it was installed over"
        );

        // A second install is refused, so the store that answered above is still the
        // one answering: two stores would be two device keys. The refused provider
        // holds a distinguishable key, so this is a claim about WHICH store answers
        // and not about an absence `load()` could reach through the fall-through.
        let refused = DeviceKeyPair::generate_raw(&[0x21; 32], &[0x22; 32]);
        install_host_provider(Box::new(FakeProvider {
            inner: Mutex::new(Some(refused.clone())),
            destroyed: std::sync::atomic::AtomicBool::new(false),
        }));
        assert!(
            load()
                .expect("after a refused second install")
                .map(|pair| pair.public_half())
                != Some(refused.public_half()),
            "the refused provider's key must not be readable: the first install stands"
        );
    }

    /// Rung 3 hands its key over through the process slot, and that slot answers
    /// BEFORE the OS store is consulted, otherwise a PIN unlock on a platform with a
    /// locked Secret Service would be re-read from the (locked) store on the next
    /// cycle and lost.
    #[test]
    fn a_rung_three_unlock_answers_before_the_os_store() {
        let _serialized = SLOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let pair = DeviceKeyPair::generate_raw(&[0x41; 32], &[0x42; 32]);
        install_session_key(pair.clone());

        let read = load().expect("the session slot answers without touching a store");
        assert_eq!(
            read.expect("a key is installed").public_half(),
            pair.public_half()
        );
        assert!(supported(), "a process holding a key can hold a key");

        // `load_or_create` must not mint a second key while one is installed: a
        // replacement key would silently un-bind this device.
        let same = load_or_create().expect("the installed key is reused");
        assert_eq!(same.public_half(), pair.public_half());

        clear_session_key();
    }
}
