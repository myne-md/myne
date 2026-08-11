//! The consent gate: whether a remote request may be constructed at all
//! (ai-remote-providers task 9, SYNC-13/SYNC-18).
//!
//! **Host-side, and re-read at request time.** Not because the UI is expected
//! to lie, but because "the caller behaved" is not a property of a seam. The
//! shipped discipline in `AiPanel.tsx` already treats the panel as *discovery*
//! rather than enforcement, and this is the enforcement half.
//!
//! **Five independent preconditions**, and none implies another:
//!
//! | missing | cause | what the user does |
//! |---|---|---|
//! | `developer_mode` | [`EngineError::FeatureOff`] | turn on Developer mode |
//! | `ai_enabled` | [`EngineError::FeatureOff`] | turn on the AI beta |
//! | a selected provider | [`EngineError::NotReady`] | pick one |
//! | a stored key | [`EngineError::NoCredential`] | paste a key |
//! | consent **for that provider** | [`EngineError::RemoteBarred`] | approve the screen |
//!
//! Missing-key and missing-consent are deliberately different causes: one means
//! "there is nothing to send", the other "you have not agreed to send it", and
//! the fixes are in different places.
//!
//! **Consent is per provider**, and that is a property of the DATA rather than
//! of a setter's diligence: `ai_provider_consent` stores the provider name it
//! was given for, so the check is an equality and a stale approval is unusable.
//! Rotating a key does not disturb it — the recipient has not changed.
//! Revoking clears both, so "turn this off" leaves exactly the state of "never
//! turned it on".
//!
//! Logging: nothing here logs. The key is never read into a log line, an error,
//! or a panic message (`src-tauri/CLAUDE.md` DENY list) — this module answers
//! with a decision, and the key travels only inside the `Ok` arm.

// Consumed by the remote request path, which lands with the engine wiring.
// Named rather than left as a bare allow.
#![allow(dead_code)]

use protocol::PrefsView;
use zeroize::Zeroizing;

use super::error::EngineError;
use super::provider_registry::RemoteProvider;

/// Everything a remote request needs, and proof it is allowed to exist. The
/// only way to obtain one is [`authorize_remote`], so a caller cannot assemble
/// the pieces itself and skip the check — the same type-shape argument
/// `ProviderHost` makes about the destination.
pub struct RemoteAuthorization {
    provider: RemoteProvider,
    key: Zeroizing<String>,
}

impl RemoteAuthorization {
    pub fn provider(&self) -> RemoteProvider {
        self.provider
    }
    /// The bearer credential. Borrowed, never cloned into a longer-lived place
    /// by this type, and never `Debug`-printed — the struct deliberately does
    /// not derive `Debug`, so it cannot reach a log line through `{:?}`.
    pub fn key(&self) -> &str {
        &self.key
    }
}

/// Decide whether a remote request may be built from these preferences.
///
/// Takes a `PrefsView` rather than reading one itself so the decision is a pure
/// function of state — testable without a vault, and impossible to satisfy with
/// a cached answer, because the caller must hand it freshly-read prefs.
///
/// `developer_mode` is a separate argument rather than a `PrefsView` field read
/// here only to make the call site state it: SYNC-18 puts the whole surface
/// behind Developer mode, and a gate that reads it silently is one refactor
/// away from not reading it at all.
pub fn authorize_remote(
    prefs: &PrefsView,
    developer_mode: bool,
) -> Result<RemoteAuthorization, EngineError> {
    // 1. Developer mode. Checked first because it is the outermost gate: with
    //    it off, none of the controls that set the rest are even reachable.
    if !developer_mode {
        return Err(EngineError::FeatureOff);
    }
    // 2. The AI beta itself.
    if !prefs.ai_enabled {
        return Err(EngineError::FeatureOff);
    }
    // 3. A provider this build can reach. An unrecognized stored name is
    //    treated as no provider — a newer client may have written one, and
    //    guessing at it is how a request goes somewhere nobody named.
    let selected = prefs.ai_provider.as_deref().unwrap_or_default();
    let Some(provider) = RemoteProvider::from_wire(selected) else {
        return Err(EngineError::NotReady);
    };
    // 4. Consent, FOR THIS PROVIDER. An equality, not a flag: an approval
    //    recorded for a different provider names a different recipient than
    //    the one about to receive the text.
    if prefs.ai_provider_consent.as_deref() != Some(provider.wire_name()) {
        return Err(EngineError::RemoteBarred);
    }
    // 5. A credential. Last, because "you have not agreed to send this" is a
    //    more fundamental refusal than "you have not pasted a key" — and
    //    ordering it this way means a user who declines consent is never asked
    //    for a key first.
    let key = prefs
        .ai_provider_key
        .as_deref()
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .ok_or(EngineError::NoCredential)?;

    Ok(RemoteAuthorization {
        provider,
        // Wrapped, because this is a fresh allocation holding the credential and
        // it outlives the borrow it came from (myne-md/myne#444). The prefs
        // field being `Zeroizing` would mean little if the authorization the
        // request is actually built from kept a plain copy.
        key: Zeroizing::new(key.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fully-configured, consented, keyed vault.
    fn ready() -> PrefsView {
        PrefsView {
            ai_enabled: true,
            ai_provider: Some("openrouter".into()),
            ai_provider_consent: Some("openrouter".into()),
            ai_provider_key: Some(Zeroizing::new("sk-test".into())),
            ..PrefsView::default()
        }
    }

    #[test]
    fn the_happy_path_yields_the_provider_and_its_key() {
        let auth = authorize_remote(&ready(), true).expect("all five hold");
        assert_eq!(auth.provider(), RemoteProvider::OpenRouter);
        assert_eq!(auth.key(), "sk-test");
    }

    /// Removing ANY ONE precondition refuses, and the refusals are
    /// distinguishable — table-driven, because a per-case test would pass even
    /// if two of them collapsed into the same message.
    #[test]
    fn each_missing_precondition_refuses_with_its_own_cause() {
        let cases: Vec<(&str, PrefsView, bool, EngineError)> = vec![
            (
                "developer mode off",
                ready(),
                false,
                EngineError::FeatureOff,
            ),
            (
                "AI beta off",
                PrefsView {
                    ai_enabled: false,
                    ..ready()
                },
                true,
                EngineError::FeatureOff,
            ),
            (
                "no provider selected",
                PrefsView {
                    ai_provider: None,
                    ..ready()
                },
                true,
                EngineError::NotReady,
            ),
            (
                "no consent",
                PrefsView {
                    ai_provider_consent: None,
                    ..ready()
                },
                true,
                EngineError::RemoteBarred,
            ),
            (
                "no key",
                PrefsView {
                    ai_provider_key: None,
                    ..ready()
                },
                true,
                EngineError::NoCredential,
            ),
        ];

        for (what, prefs, dev, expected) in &cases {
            let got = authorize_remote(prefs, *dev).err();
            assert_eq!(got, Some(*expected), "{what}");
        }

        // The distinction the whole task turns on: a missing KEY and a missing
        // CONSENT are different problems with different fixes, and must not
        // arrive at the UI as one message.
        let no_key = authorize_remote(
            &PrefsView {
                ai_provider_key: None,
                ..ready()
            },
            true,
        )
        .err()
        .unwrap();
        let no_consent = authorize_remote(
            &PrefsView {
                ai_provider_consent: None,
                ..ready()
            },
            true,
        )
        .err()
        .unwrap();
        assert_ne!(no_key.kind(), no_consent.kind());
    }

    /// Consent is per provider. An approval for A does not satisfy a request to
    /// B — which is the reason the field stores a name.
    #[test]
    fn consent_for_one_provider_does_not_satisfy_a_request_to_another() {
        let switched = PrefsView {
            ai_provider: Some("ollama-cloud".into()),
            // …still carrying yesterday's approval for OpenRouter.
            ai_provider_consent: Some("openrouter".into()),
            ..ready()
        };
        assert_eq!(
            authorize_remote(&switched, true).err(),
            Some(EngineError::RemoteBarred)
        );
        // Re-consenting to the new one lets it through.
        let reconsented = PrefsView {
            ai_provider_consent: Some("ollama-cloud".into()),
            ..switched
        };
        let auth = authorize_remote(&reconsented, true).expect("consented");
        assert_eq!(auth.provider(), RemoteProvider::OllamaCloud);
    }

    /// Rotating the key must NOT re-ask for consent: the recipient has not
    /// changed, and re-asking would train people to click through the screen.
    #[test]
    fn rotating_the_key_leaves_consent_intact() {
        let rotated = PrefsView {
            ai_provider_key: Some(Zeroizing::new("sk-rotated".into())),
            ..ready()
        };
        let auth = authorize_remote(&rotated, true).expect("still consented");
        assert_eq!(auth.key(), "sk-rotated");
    }

    /// Revoking leaves exactly the never-configured state — asserted by
    /// **byte-equality of the encoded blob**, not by field comparison. A
    /// field-by-field check would pass while some other residue stayed behind.
    #[test]
    fn revoking_returns_the_blob_to_its_never_configured_bytes() {
        // Compared through the real ENCODER with a fixed key and nonce, so the
        // claim is about the bytes that reach disk rather than about the struct
        // — a field-by-field check would pass while some other residue stayed
        // behind in the canonical JSON.
        const KEY: [u8; protocol::AEAD_KEY_LEN] = [0x42; protocol::AEAD_KEY_LEN];
        const HASH: [u8; protocol::PREFS_BLOB_ACCOUNT_HASH_LEN] =
            [0x33; protocol::PREFS_BLOB_ACCOUNT_HASH_LEN];
        const NONCE: [u8; protocol::AEAD_NONCE_LEN] = [0x77; protocol::AEAD_NONCE_LEN];
        let encode = |p: &PrefsView| {
            protocol::encode_prefs_blob_raw(&KEY, &HASH, p, &NONCE).expect("encode")
        };

        let never = encode(&PrefsView::default());

        // Configure fully, then revoke the way the setters do: clear the
        // provider, which clears the key and the consent with it.
        let mut revoked = ready();
        revoked.ai_provider = None;
        revoked.ai_provider_key = None;
        revoked.ai_provider_consent = None;
        revoked.ai_enabled = false;
        let after = encode(&revoked);

        assert_eq!(
            after, never,
            "after a revoke the blob must be byte-identical to a vault that never configured a provider"
        );
        assert_eq!(
            authorize_remote(&revoked, true).err(),
            Some(EngineError::FeatureOff)
        );
    }

    /// An all-whitespace key is not a key. Without this, a user who selected
    /// the field and pressed delete would pass the gate and fail at the
    /// provider with an auth error they cannot connect to anything.
    #[test]
    fn a_blank_key_is_no_key() {
        let blank = PrefsView {
            ai_provider_key: Some(Zeroizing::new("   ".into())),
            ..ready()
        };
        assert_eq!(
            authorize_remote(&blank, true).err(),
            Some(EngineError::NoCredential)
        );
    }

    /// A stored provider this build does not know is "no provider", not a
    /// guess. A newer client may have written one.
    #[test]
    fn an_unknown_stored_provider_is_treated_as_none() {
        let future = PrefsView {
            ai_provider: Some("some-future-provider".into()),
            ai_provider_consent: Some("some-future-provider".into()),
            ..ready()
        };
        assert_eq!(
            authorize_remote(&future, true).err(),
            Some(EngineError::NotReady)
        );
    }

    /// The authorization cannot be `Debug`-printed, so the key cannot reach a
    /// log line through `{:?}` on a whim. Asserted structurally because the
    /// tempting regression is a `#[derive(Debug)]` added for convenience.
    #[test]
    fn the_authorization_cannot_be_debug_printed() {
        let src = include_str!("provider_gate.rs");
        let production = &src[..src.find("#[cfg(test)]").expect("test block")];
        let idx = production
            .find("pub struct RemoteAuthorization")
            .expect("the struct exists");
        let before = &production[idx.saturating_sub(200)..idx];
        assert!(
            !before.contains("derive"),
            "RemoteAuthorization must derive nothing — a Debug impl puts the key one {{:?}} away from a log line"
        );
    }
}

#[cfg(test)]
mod default_off_proof {
    //! **No byte leaves the device unless the user has named a provider**
    //! (ai-remote-providers task 10) — proved with an accept-counting probe,
    //! not asserted.
    //!
    //! Modelled on `rustls_transport.rs::proxy_down_fails_closed_with_no_direct_connection_attempt`,
    //! including the part that makes it mean anything: **the control arm**. Its
    //! own comment is the reason — *"the probe must be able to see a direct
    //! connection, or the zero above proves nothing."* A zero without a control
    //! is a vacuous pass, which is the exact class of defect this repo has been
    //! burned by three times.

    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// Bind a real listener and count accepts. Returns the port and the counter.
    fn counting_listener() -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let accepts = Arc::new(AtomicUsize::new(0));
        let a2 = Arc::clone(&accepts);
        std::thread::spawn(move || {
            for _ in listener.incoming() {
                a2.fetch_add(1, Ordering::SeqCst);
            }
        });
        (port, accepts)
    }

    fn wait_for_accept(accepts: &Arc<AtomicUsize>) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if accepts.load(Ordering::SeqCst) > 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    /// What a request would do IF the gate let it through: open a socket. The
    /// probe measures whether that ever happens, which is a stronger question
    /// than "what did the gate return".
    fn attempt_request(prefs: &PrefsView, developer_mode: bool, port: u16) {
        if authorize_remote(prefs, developer_mode).is_ok() {
            let _ = TcpStream::connect(("127.0.0.1", port));
        }
    }

    fn configured() -> PrefsView {
        PrefsView {
            ai_enabled: true,
            ai_provider: Some("openrouter".into()),
            ai_provider_consent: Some("openrouter".into()),
            ai_provider_key: Some(Zeroizing::new("sk-test".into())),
            ..PrefsView::default()
        }
    }

    #[test]
    fn every_not_yet_named_state_opens_zero_sockets_and_the_configured_one_opens_a_socket() {
        let (port, accepts) = counting_listener();

        // Every state in which the user has NOT finished naming a provider.
        // The shipped state of every install that predates this feature is the
        // first row, and it is the one that matters most.
        let states: Vec<(&str, PrefsView, bool)> = vec![
            ("nothing configured at all", PrefsView::default(), true),
            ("developer mode off", configured(), false),
            (
                "AI beta off",
                PrefsView {
                    ai_enabled: false,
                    ..configured()
                },
                true,
            ),
            (
                "no provider selected",
                PrefsView {
                    ai_provider: None,
                    ..configured()
                },
                true,
            ),
            (
                "provider selected, no key",
                PrefsView {
                    ai_provider_key: None,
                    ..configured()
                },
                true,
            ),
            (
                "key present, no consent",
                PrefsView {
                    ai_provider_consent: None,
                    ..configured()
                },
                true,
            ),
            (
                "consent for a DIFFERENT provider",
                PrefsView {
                    ai_provider: Some("ollama-cloud".into()),
                    ..configured()
                },
                true,
            ),
        ];

        for (what, prefs, dev) in &states {
            attempt_request(prefs, *dev, port);
            assert_eq!(
                accepts.load(Ordering::SeqCst),
                0,
                "{what}: a socket was opened before the user named a provider"
            );
        }

        // ── THE CONTROL ARM ──
        // Fully configured, one request, one accept. Without this the seven
        // zeros above are compatible with a probe that could never have seen
        // anything.
        attempt_request(&configured(), true, port);
        assert!(
            wait_for_accept(&accepts),
            "the probe must be able to see a connection, or the zeros above prove nothing"
        );
    }

    /// The absences that would each be a byte leaving on their own. Asserted
    /// over the whole plugin tree's production source, because "we did not add
    /// one" is not something a behavioural test can show — a startup probe
    /// fires before any test's listener exists.
    #[test]
    fn there_is_no_startup_probe_reachability_check_or_telemetry() {
        use std::fs;
        // `file!()` is workspace-relative while the test's CWD is the crate
        // dir, so resolve from `CARGO_MANIFEST_DIR` instead — the one path
        // that is stable regardless of where cargo was invoked.
        let dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/plugins/local_inference");
        let mut scanned = 0usize;
        for entry in fs::read_dir(&dir).expect("read the plugin dir") {
            let path = entry.expect("entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let src = fs::read_to_string(&path).expect("read source");
            // Production half only: a test fixture may legitimately connect,
            // and this probe's own control arm does.
            let production = match src.find("#[cfg(test)]") {
                Some(i) => &src[..i],
                None => &src[..],
            };
            let code: String = production
                .lines()
                .filter(|l| {
                    let t = l.trim_start();
                    !t.starts_with("//") && !t.starts_with("//!")
                })
                .collect::<Vec<_>>()
                .join("\n");
            scanned += 1;
            for banned in [
                "telemetry",
                "analytics",
                "phone_home",
                "check_for_update",
                "validate_key",
                "ping(",
                "healthcheck",
                "reachability",
            ] {
                assert!(
                    !code.contains(banned),
                    "{}: {banned:?} — nothing on the AI path may reach out unasked",
                    path.display()
                );
            }
        }
        // Self-guard: a directory read that returned nothing would make the
        // loop above vacuously true.
        assert!(
            scanned >= 10,
            "scanned only {scanned} files — too few to be real"
        );
    }
}
