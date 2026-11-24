// SPDX-License-Identifier: AGPL-3.0-only
//! The consent gate: whether a remote request may be constructed at all
//! (ai-remote-providers task 9, SYNC-13/SYNC-18).
//!
//! **Host-side, and re-read at request time.** Not because the UI is expected
//! to lie, but because "the caller behaved" is not a property of a seam. The
//! shipped discipline in `AiPanel.tsx` already treats the panel as *discovery*
//! rather than enforcement, and this is the enforcement half.
//!
//! **Four independent preconditions**, and none implies another:
//!
//! | missing | cause | what the user does |
//! |---|---|---|
//! | `ai_enabled` | [`EngineError::FeatureOff`] | turn on the AI beta |
//! | a selected provider | [`EngineError::NotReady`] | pick one |
//! | a stored key | [`EngineError::NoCredential`] | paste a key |
//! | consent **for that provider** | [`EngineError::ConsentMissing`] | approve the screen |
//!
//! Missing-key and missing-consent are deliberately different causes: one means
//! "there is nothing to send", the other "you have not agreed to send it", and
//! the fixes are in different places.
//!
//! **It was five until myne-md/myne#456, and `developer_mode` is the one that
//! went.** SYNC-18 put the whole surface behind Developer mode, and that rule
//! is superseded rather than relaxed by accident. Two things forced the
//! question. Developer mode is defined as *where the user leaves the path Myne
//! vouches for* (`decisions/ai/0278`), and per-provider consent is a
//! sharper instrument for exactly that: it names the recipient, it is compared
//! for equality so a stale approval is unusable, and it cannot be satisfied by
//! a switch the user flipped for an unrelated reason, the same flag also
//! governs CLI access and the Vim keymap. And on mobile, where local inference
//! is out of scope by decision, a Developer-mode precondition would have meant
//! the AI surface was inert for anyone who had not found an unrelated toggle,
//! while the tab's own gate said otherwise.
//!
//! **What that costs, stated rather than glossed.** `ai_enabled` is now the
//! only device-local switch on this path. The compensating control is that
//! `ai_provider_consent` became `DeviceLocal` in the same change: the key still
//! syncs, so a phone can hold it, and it still sends nothing until somebody
//! approves the screen on that phone. One switch alone would have been a
//! narrowing; the pair is not.
//!
//! **Consent is per provider**, and that is a property of the DATA rather than
//! of a setter's diligence: `ai_provider_consent` stores the provider name it
//! was given for, so the check is an equality and a stale approval is unusable.
//! Rotating a key does not disturb it — the recipient has not changed.
//! Revoking clears both, so "turn this off" leaves exactly the state of "never
//! turned it on".
//!
//! Logging: nothing here logs. The key is never read into a log line, an error,
//! or a panic message (`src-tauri/AGENTS.md` DENY list) — this module answers
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
/// **It took a `developer_mode: bool` until myne-md/myne#456 and no longer
/// does.** That argument existed to make the call site state SYNC-18's rule
/// out loud, and the rule itself is what changed: per-provider consent, which
/// names the recipient and is compared for equality, is a stronger marker of
/// leaving the path Myne vouches for than a global switch that also governs
/// CLI access and Vim mode. The argument is removed rather than ignored so no
/// caller can pass a value that no longer decides anything.
pub fn authorize_remote(prefs: &PrefsView) -> Result<RemoteAuthorization, EngineError> {
    // 1. The AI beta itself. The only device-local switch left on this path,
    //    which is why the consent below is device-local too (myne-md/myne#456):
    //    one switch alone would mean a synced vault could turn a device into a
    //    sending device without anyone at that device agreeing.
    if !prefs.ai_enabled {
        return Err(EngineError::FeatureOff);
    }
    // 2. A provider this build can reach. An unrecognized stored name is
    //    treated as no provider — a newer client may have written one, and
    //    guessing at it is how a request goes somewhere nobody named.
    let selected = prefs.ai_provider.as_deref().unwrap_or_default();
    let Some(provider) = RemoteProvider::from_wire(selected) else {
        return Err(EngineError::NotReady);
    };
    // 3. Consent, FOR THIS PROVIDER. An equality, not a flag: an approval
    //    recorded for a different provider names a different recipient than
    //    the one about to receive the text.
    // The consent must be DEVICE-SCOPED, not merely present and matching. A
    // legacy bare-wire-name value is refused here for the reason
    // `CONSENT_DEVICE_SUFFIX` states: it is what both re-routed populations
    // hold, and accepting it leaves this gate where the review found it.
    if !protocol::prefs::consent_is_device_scoped(
        prefs.ai_provider_consent.as_deref(),
        provider.wire_name(),
    ) {
        // `ConsentMissing`, not `RemoteBarred` (myne-md/myne#456). The latter
        // is a rule about a request CLASS that no user choice can lift; this is
        // a permission nobody has given yet, and only one of the two has a fix
        // the user can act on. They were the same variant, so the surface told
        // someone who had never seen the consent screen that "this kind of
        // request never goes to a provider".
        return Err(EngineError::ConsentMissing);
    }
    // 4. A credential. Last, because "you have not agreed to send this" is a
    //    more fundamental refusal than "you have not pasted a key" — and
    //    ordering it this way means a user who declines consent is never asked
    //    for a key first.
    //
    //    SHAPE as well as presence, which is the fix for a co-member writing a
    //    header into every other member's request. `ai_provider_key` is
    //    `Shared(ScalarLww)` and the blob holding it is group-sealed on an NTV6
    //    vault, so on a shared vault the value can be authored by another roster
    //    member rather than by this device's own settings. No provider's
    //    credential format contains a CR or an LF, and those are the bytes that
    //    end an HTTP/1.1 header line, so `trim`-and-emptiness was never enough.
    //
    //    The refusal is `NoCredential`, not a new variant. A credential this
    //    build cannot use is the same situation as no credential and the user
    //    fixes both the same way, by pasting the key again. A distinguishable
    //    "your key contains a control character" would be a new IPC error variant
    //    and a new TS mirror, for a shape no legitimate key has.
    let key = prefs
        .ai_provider_key
        .as_deref()
        .map(|k| k.trim())
        .filter(|k| !k.is_empty() && !k.chars().any(|c| c.is_ascii_control()))
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
            ai_provider_consent: Some("openrouter@device".into()),
            ai_provider_key: Some(Zeroizing::new("sk-test".into())),
            ..PrefsView::default()
        }
    }

    #[test]
    fn the_happy_path_yields_the_provider_and_its_key() {
        let auth = authorize_remote(&ready()).expect("all four hold");
        assert_eq!(auth.provider(), RemoteProvider::OpenRouter);
        assert_eq!(auth.key(), "sk-test");
    }

    /// The fourth precondition checks shape as well as presence: an interior
    /// CR/LF is refused here, so the value never becomes an authorization. This
    /// is the chokepoint the whole chain closes at, and it matters most because
    /// the field is `Shared(ScalarLww)` with a group-sealed blob, so on a shared
    /// vault the value can arrive from a co-member rather than from this device's
    /// own settings. `trim` alone was not enough, because it touches only the
    /// ends. myne-md/myne#750, myne-md/myne#758.
    #[test]
    fn an_interior_crlf_in_the_credential_is_refused() {
        assert!(
            authorize_remote(&PrefsView {
                ai_provider_key: Some(Zeroizing::new("sk-real\r\nX: 1".into())),
                ..ready()
            })
            .is_err(),
            "a CR/LF in a synced credential must not become an authorization"
        );
    }

    /// Removing ANY ONE precondition refuses, and the refusals are
    /// distinguishable — table-driven, because a per-case test would pass even
    /// if two of them collapsed into the same message.
    #[test]
    fn each_missing_precondition_refuses_with_its_own_cause() {
        // The "developer mode off" row was here until myne-md/myne#456 and is
        // gone rather than converted: with the flag no longer read, it would
        // have been `ready()` asserting a refusal that no longer happens.
        let cases: Vec<(&str, PrefsView, EngineError)> = vec![
            (
                "AI beta off",
                PrefsView {
                    ai_enabled: false,
                    ..ready()
                },
                EngineError::FeatureOff,
            ),
            (
                "no provider selected",
                PrefsView {
                    ai_provider: None,
                    ..ready()
                },
                EngineError::NotReady,
            ),
            (
                "no consent",
                PrefsView {
                    ai_provider_consent: None,
                    ..ready()
                },
                // `ConsentMissing`, not `RemoteBarred` (myne-md/myne#456). The
                // two used to be one variant, and the surface therefore told a
                // user who had never seen the consent screen that "this kind of
                // request never goes to a provider", which is false about their
                // request and names no fix. `RemoteBarred` keeps its own
                // meaning: a rule about a request CLASS that no user choice can
                // lift.
                EngineError::ConsentMissing,
            ),
            (
                "no key",
                PrefsView {
                    ai_provider_key: None,
                    ..ready()
                },
                EngineError::NoCredential,
            ),
        ];

        for (what, prefs, expected) in &cases {
            let got = authorize_remote(prefs).err();
            assert_eq!(got, Some(*expected), "{what}");
        }

        // The distinction the whole task turns on: a missing KEY and a missing
        // CONSENT are different problems with different fixes, and must not
        // arrive at the UI as one message.
        let no_key = authorize_remote(&PrefsView {
            ai_provider_key: None,
            ..ready()
        })
        .err()
        .unwrap();
        let no_consent = authorize_remote(&PrefsView {
            ai_provider_consent: None,
            ..ready()
        })
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
            ai_provider_consent: Some("openrouter@device".into()),
            ..ready()
        };
        assert_eq!(
            authorize_remote(&switched).err(),
            Some(EngineError::ConsentMissing)
        );
        // Re-consenting to the new one lets it through.
        let reconsented = PrefsView {
            ai_provider_consent: Some("ollama-cloud@device".into()),
            ..switched
        };
        let auth = authorize_remote(&reconsented).expect("consented");
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
        let auth = authorize_remote(&rotated).expect("still consented");
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
            authorize_remote(&revoked).err(),
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
            authorize_remote(&blank).err(),
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
        assert_eq!(authorize_remote(&future).err(), Some(EngineError::NotReady));
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
    fn attempt_request(prefs: &PrefsView, port: u16) {
        if authorize_remote(prefs).is_ok() {
            let _ = TcpStream::connect(("127.0.0.1", port));
        }
    }

    fn configured() -> PrefsView {
        PrefsView {
            ai_enabled: true,
            ai_provider: Some("openrouter".into()),
            ai_provider_consent: Some("openrouter@device".into()),
            ai_provider_key: Some(Zeroizing::new("sk-test".into())),
            ..PrefsView::default()
        }
    }

    /// A LEGACY consent, the bare wire name, does NOT authorize a request.
    ///
    /// This is the Critical this token exists for (myne-md/myne#456, found by
    /// review). Two populations hold exactly this value and neither performed
    /// any act to reach it:
    ///
    /// * a desktop install that consented, then turned Developer mode OFF, and
    ///   was answered by the LOCAL arm for as long as `developer_mode` was a
    ///   request-time precondition. Dropping that precondition re-points the
    ///   same preferences at the remote provider, so note plaintext starts
    ///   crossing TB13 on upgrade with no user act and no notice;
    /// * a device enrolled before the reclassification, which inherited the
    ///   value under the old SHARED class and will never see a merge revise it.
    ///
    /// The refusal is `ConsentMissing`, which is the variant whose surface
    /// shows the consent screen, so the user is ASKED rather than blocked.
    ///
    /// Deleting the suffix check in `authorize_remote` makes this fail.
    #[test]
    fn a_legacy_bare_name_consent_does_not_authorize_a_request() {
        let mut legacy = configured();
        legacy.ai_provider_consent = Some("openrouter".into());
        // The exact shape of the re-routed desktop install: everything else is
        // configured, and on the previous build `developer_mode: false` is what
        // kept it on the local arm.
        legacy.developer_mode = false;
        assert!(
            matches!(authorize_remote(&legacy), Err(EngineError::ConsentMissing)),
            "a consent recorded before the reclassification must be re-asked, not honoured",
        );
        assert!(
            protocol::prefs::consent_is_legacy(legacy.ai_provider_consent.as_deref(), "openrouter"),
            "and it must be RECOGNISABLE as legacy, so a surface can say the user agreed once",
        );
    }

    /// The token is self-extinguishing: re-consenting on this device authorizes.
    ///
    /// Without this the fix would read as "the gate now refuses everything",
    /// which is the failure mode a fail-closed change has. The write side is
    /// `set_ai_provider_consent_from_host`, which adds the suffix so there is
    /// one writer of the stored spelling.
    #[test]
    fn re_consenting_on_this_device_authorizes_again() {
        let mut fresh = configured();
        fresh.ai_provider_consent = Some(protocol::prefs::device_scoped_consent("openrouter"));
        assert!(
            authorize_remote(&fresh).is_ok(),
            "a consent recorded on this device under the new classification authorizes",
        );
    }

    /// A scoped consent for ANOTHER provider still does not authorize.
    ///
    /// The suffix must not become a bypass of the equality the gate already
    /// had: `ollama-cloud@device` names a different recipient than the one
    /// about to receive the text.
    #[test]
    fn a_scoped_consent_for_another_provider_does_not_authorize() {
        let mut crossed = configured();
        crossed.ai_provider_consent = Some(protocol::prefs::device_scoped_consent("ollama-cloud"));
        assert!(
            matches!(authorize_remote(&crossed), Err(EngineError::ConsentMissing)),
            "the recipient equality survives the scoping",
        );
    }

    #[test]
    fn every_not_yet_named_state_opens_zero_sockets_and_the_configured_one_opens_a_socket() {
        let (port, accepts) = counting_listener();

        // Every state in which the user has NOT finished naming a provider.
        // The shipped state of every install that predates this feature is the
        // first row, and it is the one that matters most.
        //
        // SIX rows since myne-md/myne#456, not seven: the "developer mode off"
        // row went with the precondition. It is removed rather than converted
        // because, with the flag unread, it would have been `configured()`
        // asserting zero sockets, the exact opposite of what the control arm
        // below proves, and a row that would have turned this proof into a
        // contradiction rather than a weaker claim.
        let states: Vec<(&str, PrefsView)> = vec![
            ("nothing configured at all", PrefsView::default()),
            (
                "AI beta off",
                PrefsView {
                    ai_enabled: false,
                    ..configured()
                },
            ),
            (
                "no provider selected",
                PrefsView {
                    ai_provider: None,
                    ..configured()
                },
            ),
            (
                "provider selected, no key",
                PrefsView {
                    ai_provider_key: None,
                    ..configured()
                },
            ),
            (
                "key present, no consent",
                PrefsView {
                    ai_provider_consent: None,
                    ..configured()
                },
            ),
            (
                "consent for a DIFFERENT provider",
                PrefsView {
                    ai_provider: Some("ollama-cloud".into()),
                    ..configured()
                },
            ),
        ];

        for (what, prefs) in &states {
            attempt_request(prefs, port);
            assert_eq!(
                accepts.load(Ordering::SeqCst),
                0,
                "{what}: a socket was opened before the user named a provider"
            );
        }

        // ── THE CONTROL ARM ──
        // Fully configured, one request, one accept. Without this the six zeros
        // above are compatible with a probe that could never have seen
        // anything.
        attempt_request(&configured(), port);
        assert!(
            wait_for_accept(&accepts),
            "the probe must be able to see a connection, or the zeros above prove nothing"
        );
    }

    /// The absences that would each be a byte leaving on their own. Asserted
    /// over the whole AI tree's production source, because "we did not add one"
    /// is not something a behavioural test can show: a startup probe fires
    /// before any test's listener exists.
    ///
    /// **The tree is two directories since myne-md/myne#456**, and scanning only
    /// one would have been the quiet way to lose half this assertion. The
    /// portable half moved here; the local half (the Candle engine, the Ollama
    /// loopback arm, retrieval, the vector store, the model store, whisper, the
    /// Tauri surface) stayed in the desktop crate. Both are scanned, and a
    /// directory that is missing FAILS rather than shrinking the scan: the move
    /// itself made this test panic on a `read_dir` of a path that no longer
    /// existed, which is the behaviour to keep rather than paper over.
    #[test]
    fn there_is_no_startup_probe_reachability_check_or_telemetry() {
        use std::fs;
        // `file!()` is workspace-relative while the test's CWD is the crate
        // dir, so resolve from `CARGO_MANIFEST_DIR` instead — the one path
        // that is stable regardless of where cargo was invoked. The desktop
        // half is a sibling crate, reached by the one hop out of `core/`; that
        // is a path this test already deals in, and the alternative (a second
        // copy of the banned-word list in the desktop crate) is a list that
        // drifts.
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let dirs = [
            manifest.join("src/inference"),
            manifest.join("../src-tauri/src/plugins/local_inference"),
        ];
        let mut scanned = 0usize;
        let mut entries = Vec::new();
        for dir in &dirs {
            let read = fs::read_dir(dir).unwrap_or_else(|e| {
                panic!(
                    "{}: {e}. Both halves of the AI tree must be scanned; a half \
                     that cannot be read is a coverage hole, not a smaller scan",
                    dir.display()
                )
            });
            for entry in read {
                entries.push(entry.expect("entry").path());
            }
        }
        for path in entries {
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
        // loop above vacuously true. The floor is measured across BOTH halves
        // (8 here, 18 desktop-side at the time of the split), and it stays a
        // floor rather than an equality so ordinary additions do not trip it.
        assert!(
            scanned >= 20,
            "scanned only {scanned} files across both halves of the AI tree, \
             too few to be real"
        );
    }
}
