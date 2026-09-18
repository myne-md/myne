// SPDX-License-Identifier: AGPL-3.0
//! The single value that crosses back out of wasm.
//!
//! # Why a tagged envelope and not `Result<JsValue, JsValue>`
//!
//! wasm-bindgen can return a `Result` and raise the `Err` arm as a JS
//! exception, which looks like the idiomatic choice. It is the wrong one here
//! for a specific reason: a thrown value and a **returned** error are
//! indistinguishable at the Worker boundary from a *wasm trap*. `wasm32` is
//! `panic = "abort"`, so a Rust panic also surfaces as a JS exception — and
//! after a trap the instance is permanently unusable, while after a returned
//! error it is perfectly fine. Collapsing those two into one `catch` would make
//! the Worker either discard a healthy instance or keep using a dead one.
//!
//! So this crate's exported entry point **never throws**. Every outcome —
//! including a command failure — comes back as a JSON string in this shape, and
//! an exception escaping to the Worker therefore means exactly one thing: the
//! instance is gone. `web/src/worker/protocol.ts` maps that to `fatal`, which
//! task 82 owns.
//!
//! # Why JSON and not a `JsValue` graph
//!
//! `src/` pattern-matches on Rust error enums as Tauri serialized them
//! (`src/types/`). Tauri's IPC payload is JSON. Serializing through
//! `serde_json` here reproduces that byte-for-byte with no second wire format
//! to keep in step — see `Cargo.toml`'s note on why `serde-wasm-bindgen` is not
//! admitted.

use serde::Serialize;

/// The result of one `invoke`, as it crosses the wasm boundary.
///
/// `#[serde(tag = "outcome")]` puts a discriminator on the wire so the Worker
/// dispatches on a field rather than on the *shape* of the payload — a command
/// whose success value happens to have an `error` key must not read as a
/// failure.
#[derive(Debug, Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum Outcome {
    /// The command ran. `value` is its return value, serialized exactly as the
    /// Tauri IPC would have serialized it.
    Ok { value: serde_json::Value },
    /// The command ran and failed. `error` is the backend's own error value,
    /// **verbatim** — every caller in `src/` matches on those enums, so
    /// reshaping here would break the shared tree on web only.
    Error { error: serde_json::Value },
    /// Decided absent on web ([`crate::capability::Class::Unsupported`]). One
    /// outcome for every such command, which is what lets
    /// `src/platform/unsupported.ts` raise one error type for all of them.
    Unsupported { operation: String },
    /// A command whose port or capability decision is still owed
    /// ([`crate::capability::Class::Pending`]), or a name this build has never
    /// heard of. Deliberately loud: see `capability.rs` for why this is not
    /// folded into `Unsupported`.
    NotPorted { command: String },
    /// The argument payload was not the shape the command expects.
    ///
    /// `detail` carries serde's own message, which names the failing **field
    /// path and expected type** and never the value — so a malformed note body
    /// yields "invalid type: string, expected u64 at .version", not the body.
    /// That bound is what makes this safe to return to the page at all;
    /// `src-tauri/AGENTS.md`'s secret-handling logging discipline governs the
    /// same boundary on desktop.
    BadArgs { command: String, detail: String },
}

impl Outcome {
    /// Serialize a command's success value.
    ///
    /// A serialization failure here is a bug in a `Serialize` impl, not user
    /// input, and it must not silently become `null` — a caller reading `null`
    /// as "no notes" instead of "the note list could not be encoded" is the
    /// kind of quiet wrong answer this whole envelope exists to prevent.
    pub fn ok<T: Serialize>(value: &T) -> Self {
        match serde_json::to_value(value) {
            Ok(value) => Outcome::Ok { value },
            Err(e) => Outcome::Error {
                error: serde_json::json!({
                    "kind": "SerializeFailed",
                    // serde_json's Display for a serialization error names the
                    // type and the reason, never the data.
                    "detail": e.to_string(),
                }),
            },
        }
    }

    /// Serialize a command's error value verbatim.
    pub fn error<T: Serialize>(error: &T) -> Self {
        match serde_json::to_value(error) {
            Ok(error) => Outcome::Error { error },
            Err(e) => Outcome::Error {
                error: serde_json::json!({
                    "kind": "SerializeFailed",
                    "detail": e.to_string(),
                }),
            },
        }
    }

    /// Render to the JSON string the Worker receives.
    ///
    /// Infallible by construction: every variant is built from
    /// already-validated `serde_json::Value`s and `String`s, so there is no
    /// input that can fail here. The fallback exists so the signature stays
    /// `-> String` rather than leaking a `Result` the caller cannot act on —
    /// and it is itself a valid `Outcome::Error`, so the Worker's parser never
    /// sees malformed JSON.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"outcome":"error","error":{"kind":"EnvelopeEncodeFailed"}}"#.to_string()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_discriminator_is_a_field_not_a_shape() {
        // A success value that itself contains an `error` key must still read
        // as `ok`. This is the reason for `tag = "outcome"`.
        let json = Outcome::ok(&serde_json::json!({ "error": "not really" })).to_json();
        assert!(json.contains(r#""outcome":"ok""#), "{json}");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["outcome"], "ok");
        assert_eq!(parsed["value"]["error"], "not really");
    }

    #[test]
    fn error_values_cross_verbatim() {
        // `src/` matches on the backend's enum shape; a re-wrap would break it.
        #[derive(Serialize)]
        #[serde(tag = "kind")]
        enum FakeBackendError {
            WrongPassword { attempts_left: u32 },
        }
        let json = Outcome::error(&FakeBackendError::WrongPassword { attempts_left: 2 }).to_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["outcome"], "error");
        assert_eq!(parsed["error"]["kind"], "WrongPassword");
        assert_eq!(parsed["error"]["attempts_left"], 2);
    }

    #[test]
    fn unsupported_and_not_ported_are_distinguishable_on_the_wire() {
        let unsupported = Outcome::Unsupported {
            operation: "plugin:backup|vault_export_backup".into(),
        }
        .to_json();
        let pending = Outcome::NotPorted {
            command: "plugin:notes|note_read".into(),
        }
        .to_json();
        assert!(
            unsupported.contains(r#""outcome":"unsupported""#),
            "{unsupported}"
        );
        assert!(pending.contains(r#""outcome":"notported""#), "{pending}");
        assert_ne!(unsupported, pending);
    }

    #[test]
    fn every_variant_serializes_to_parseable_json() {
        for outcome in [
            Outcome::ok(&42u32),
            Outcome::error(&"boom"),
            Outcome::Unsupported {
                operation: "x".into(),
            },
            Outcome::NotPorted {
                command: "y".into(),
            },
            Outcome::BadArgs {
                command: "z".into(),
                detail: "invalid type: string, expected u64 at .version".into(),
            },
        ] {
            let json = outcome.to_json();
            serde_json::from_str::<serde_json::Value>(&json)
                .unwrap_or_else(|e| panic!("unparseable envelope {json}: {e}"));
        }
    }
}
