// SPDX-License-Identifier: AGPL-3.0-only
//! The two things every Secret Service caller in this crate must agree about.
//!
//! There are two callers: the device signing key's Linux rung
//! (`plugins/sync/device_identity`) and the label store's
//! (`vault_label::key_secret_service`). They keep their own read, write and delete
//! sequences, because each maps a failure onto its OWN error type and each has its own
//! zeroize obligations, and folding those together would put one family's failure
//! vocabulary on the other. What they must not each own is the part that is not a policy
//! at all:
//!
//! - **The item attributes.** One `service`/`username` pair, so a future migration
//!   between the two stores is a copy rather than a translation, and so the two families
//!   cannot drift into describing the same item two ways.
//! - **The failure classification.** `secret_service::Error` is `#[non_exhaustive]` and
//!   its `Display` is a `zbus` reply, which is a string no rule can bound: the diagnostic
//!   log's content claim only permits a closed token, and a hand-copied match is a second
//!   place for the next crate bump to be answered.

use std::collections::HashMap;

/// The attributes that address one item. Both callers pass a frozen `'static` service
/// string and an account that is either a canonical `VaultId` rendering or a reserved
/// name, so nothing here is a borrowed caller value that could outlive its use.
pub(crate) fn attributes<'a>(service: &'a str, account: &'a str) -> HashMap<&'a str, &'a str> {
    HashMap::from([("service", service), ("username", account)])
}

/// The closed classification of a Secret Service failure, as a `&'static str`.
///
/// The CLASS, never the error's `Display`. Every variant crate 5.2 names gets its own
/// label, and the wildcard keeps a minor bump from being a build break without letting an
/// unnamed variant's text reach the log.
pub(crate) fn error_class(e: &secret_service::Error) -> &'static str {
    use secret_service::Error;
    match e {
        Error::Crypto(_) => "crypto",
        Error::Zbus(_) => "zbus",
        Error::ZbusFdo(_) => "zbus_fdo",
        Error::Zvariant(_) => "zvariant",
        Error::Locked => "locked",
        _ => "other",
    }
}
