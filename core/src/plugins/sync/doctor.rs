// SPDX-License-Identifier: AGPL-3.0-only
//! **One verdict over the five facts that decide whether this device can sync**
//! (myne-md/myne#1003).
//!
//! # The question, and why it has one answer
//!
//! "Sync is not working" has five causes that look identical from a log tail: the
//! vault's generation, the authority (`sync::authority`'s answer), the binding row
//! that publishes this device's key, the key at rest, and the session. Before this
//! module the same failure was visible as a status tag, a log event and a settings
//! line, and working out which of the five was missing meant reading all three. The
//! forensic trail behind myne-md/myne#983 is exactly that cost, and the sentence the
//! product could produce for it named one cause out of five.
//!
//! # Every fact here is READ, never asked
//!
//! [`read`] does not resolve any half of the authority question itself. It consumes
//! [`super::cycle::signed_head_ctx`], the same builder the sync cycle uses, and
//! PROJECTS that decision into five facts. So the report cannot disagree with the
//! cycle: if it says `device_key`, the cycle signs; if it says `missing`, the cycle
//! refuses for the cause it names.
//!
//! The one question it DOES answer for itself is "does this frame carry a signed head".
//! That is asked through [`super::meta_kind::carries_b2b_tail`], the same classifier
//! the cycle's own guard consults ([`super::cycle`]'s `needs_signed_head`), so the two
//! cannot reach different verdicts about the same four bytes. A hand-written magic list
//! here reported a missing credential for a frame the cycle treats as needing none.
//!
//! Two of the five are projections of the `AuthorityMissing` cause rather than reads
//! of their own, and that is deliberate. Asking the binding store a second time, or
//! the key store a second time, is how myne-md/myne#983 got a row that published a
//! key nothing could load: two readers of one question, agreeing on every state that
//! exists today.
//!
//! # Four facts this module refuses to state as a cause
//!
//! **A locked vault is `Locked`, not `NoHeadContext`.** Every cause the builder can
//! produce on a locked vault is a lie about the user's credentials, which is the
//! defect class this diagnosis exists to end.
//!
//! **A frame with no signed head is `NotApplicable`.** `MYV1` and `NTV5` sign their head
//! with an HMAC under `vault-head-mac`, an absent `vault.meta` is not a B2B vault at
//! all, and a magic nobody recognises classifies as no tail. The cycle takes the same
//! three cases the same way. Reporting a missing device key there would send the user
//! to find a credential their vault never had.
//!
//! **An unreadable frame is `Unknown`, not a cause.** An IO failure that is not "not
//! found" leaves the generation unclassifiable, and the cycle refuses to author
//! anything at all on it. The authority is then not askable, which is a different
//! statement from "nothing may sign".
//!
//! **`unknown` is a real answer for a single fact too.** When the resolution never
//! reached a read, the cause does not say whether a key is at rest or which row
//! exists, and guessing is what this module is for refusing. `unknown` means "this run
//! did not ask", and the diagnostics block prints it rather than dropping the line.

use crate::host::HostCtx;
use crate::io_failure_kind::IoFailureKind;
use crate::plugins::vault_unlock::state::{Slot, VaultAuthority, VaultRuntimeState};
use crate::vault_io::VaultIo;

use super::authority::{missing_for_cycle, AuthorityMissing, DeviceResolution};
use super::cycle::{signed_head_ctx, HeadAuthority};

/// The `vault.meta` generation this vault is on, named by its magic.
///
/// The magic rather than [`protocol::VaultMetaGeneration`] on purpose: the enum is
/// about the B2B TAIL and folds `MYV1` and `NTV5` into one `Legacy` arm, while a bug
/// report wants the four bytes that are on disk (`vault.meta` is `NTV8`
/// (`4e545638 02 00`), in the words of myne-md/myne#983's own evidence).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum VaultGeneration {
    /// v0.2, personal: no B2B tail, so no group tier and no signed head.
    #[serde(rename = "NTV5")]
    Ntv5,
    /// The first B2B generation.
    #[serde(rename = "NTV6")]
    Ntv6,
    /// B2B with a person wrap (`decisions/protocol/0758` retired the wrap, not the reader).
    #[serde(rename = "NTV7")]
    Ntv7,
    /// The password-only B2B generation, and the birth format since `0758`.
    #[serde(rename = "NTV8")]
    Ntv8,
    /// v0.1.
    #[serde(rename = "MYV1")]
    Myv1,
    /// No `vault.meta` at the vault root.
    #[serde(rename = "absent")]
    Absent,
    /// A `vault.meta` this machine could not read.
    #[serde(rename = "unreadable")]
    Unreadable,
    /// Bytes that match none of the five magics. The bytes themselves are never
    /// echoed: this value reaches a block the user pastes into a public issue.
    #[serde(rename = "unknown")]
    Unknown,
}

/// One read of `vault.meta`, and the two facts that decide whether the authority
/// question applies at all.
///
/// Both facts come from that read and from [`super::meta_kind::carries_b2b_tail`], never
/// from [`VaultGeneration`]'s magic list. The generation is what the report NAMES; it is
/// not what anything decides on, which is the difference between a value and a verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Frame {
    pub(super) generation: VaultGeneration,
    /// `false` only for an IO failure that is not "not found": the frame could not be
    /// read at all, so even the generation is `unreadable`.
    pub(super) readable: bool,
    /// Whether the frame carries the B2B tail, asked through the sync plane's own
    /// classifier.
    pub(super) carries_tail: bool,
}

impl Frame {
    /// Read the frame at the vault root.
    pub(super) async fn read(io: &dyn VaultIo, vault_dir: &std::path::Path) -> Self {
        match io.read(&vault_dir.join("vault.meta")).await {
            // An ABSENT frame is a fact the cycle acts on rather than a fault: it reads the
            // same absence as "not a B2B vault" and takes the HMAC path.
            Err(IoFailureKind::NotFound) => Self {
                generation: VaultGeneration::Absent,
                readable: true,
                carries_tail: false,
            },
            Err(_) => Self {
                generation: VaultGeneration::Unreadable,
                readable: false,
                carries_tail: false,
            },
            Ok(bytes) => Self::of(&bytes),
        }
    }

    /// The same decision, without IO, so the eight generation values are testable.
    #[must_use]
    fn of(bytes: &[u8]) -> Self {
        Self {
            generation: VaultGeneration::of(bytes),
            readable: true,
            carries_tail: super::meta_kind::carries_b2b_tail(bytes),
        }
    }
}

impl VaultGeneration {
    /// Classify by magic. Only the five known magics are named.
    #[must_use]
    pub fn of(bytes: &[u8]) -> Self {
        match bytes.get(0..4) {
            Some(m) if m == protocol::VAULT_META_V0_2_MAGIC.as_slice() => Self::Ntv5,
            Some(m) if m == protocol::VAULT_META_NTV6_MAGIC.as_slice() => Self::Ntv6,
            Some(m) if m == protocol::VAULT_META_NTV7_MAGIC.as_slice() => Self::Ntv7,
            Some(m) if m == protocol::VAULT_META_NTV8_MAGIC.as_slice() => Self::Ntv8,
            Some(m) if m == protocol::VAULT_META_MAGIC.as_slice() => Self::Myv1,
            _ => Self::Unknown,
        }
    }
}

/// What may sign this vault's head right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AuthorityVerdict {
    /// The vault is not unlocked, so nothing was asked. Not a missing credential.
    Locked,
    /// The frame carries no signed head, so there is no authority to have.
    NotApplicable,
    /// `vault.meta` could not be read, so the question could not be asked. The
    /// `generation` field says why, and the cycle refuses to author anything on it.
    Unknown,
    /// The held person keypair signs a `0x02` head.
    PersonKey,
    /// A verified binding row publishes the key at rest, so this device signs a
    /// `0x03` head without the phrase (`decisions/protocol/0731` + `0733`).
    DeviceKey,
    /// Nothing can sign, for this cause.
    Missing { cause: AuthorityMissing },
}

/// The state of this device's `vault.device-bindings` row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BindingState {
    /// A live row for this device, verified against the signed roster, publishing the
    /// key at rest.
    Verified,
    /// A row naming this device and these halves that does not verify against the
    /// roster.
    Unverified,
    /// A row for this device publishing DIFFERENT halves than the key at rest.
    NamesOtherKey,
    /// No live row publishes halves for this device.
    Absent,
    /// A row publishes halves and the store holds no such key: the orphan
    /// myne-md/myne#983 measured.
    Orphaned,
    /// The question was not asked, or could not be.
    Unknown,
}

/// The storage ladder's answer about the device signing key, as a report value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyAtRestState {
    Present,
    /// Rung 4: no store on this platform, or a store with no item. The ordinary
    /// state, not a fault.
    Absent,
    /// The store refused, or the item would not decode. A fault.
    Unreadable,
    /// Not read.
    Unknown,
}

/// The session, as the resolver saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct SessionFacts {
    /// The person keypair this process holds. `None` on a locked vault, where the
    /// resolver is not run. This is deliberately not a second read of the session, which
    /// would be the two-readers defect one section over.
    pub person_held: Option<bool>,
    /// Whether a durable device id was adopted, so a row CAN name this device. `None`
    /// when the resolution never reached that read.
    pub device_id_adopted: Option<bool>,
}

impl SessionFacts {
    const NOT_ASKED: Self = Self {
        person_held: None,
        device_id_adopted: None,
    };
}

/// The five facts, in one value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct VaultDoctor {
    pub generation: VaultGeneration,
    pub authority: AuthorityVerdict,
    pub binding: BindingState,
    pub key_at_rest: KeyAtRestState,
    pub session: SessionFacts,
}

impl VaultDoctor {
    /// The verdict for a vault nobody is inside.
    #[must_use]
    fn locked(generation: VaultGeneration) -> Self {
        Self {
            generation,
            authority: AuthorityVerdict::Locked,
            binding: BindingState::Unknown,
            key_at_rest: KeyAtRestState::Unknown,
            session: SessionFacts::NOT_ASKED,
        }
    }

    /// The verdict for a frame with no signed head.
    ///
    /// `key_at_rest` stays `unknown` because nothing asked the store. `binding` splits on
    /// the generation, and the split is not cosmetic: on a frame that IS one of the five
    /// magics, the binding family needs the group tier this frame does not have, so no row
    /// can exist to be found. On a frame whose magic nobody recognises, nobody looked, and
    /// asserting `absent` would tell a bug report that this device is unpublished when a
    /// damaged first four bytes may sit in front of a perfectly good row.
    #[must_use]
    fn not_applicable(generation: VaultGeneration) -> Self {
        Self {
            generation,
            authority: AuthorityVerdict::NotApplicable,
            binding: if matches!(generation, VaultGeneration::Unknown) {
                BindingState::Unknown
            } else {
                BindingState::Absent
            },
            key_at_rest: KeyAtRestState::Unknown,
            session: SessionFacts::NOT_ASKED,
        }
    }

    /// The verdict for a frame this machine could not read.
    #[must_use]
    fn unreadable(generation: VaultGeneration) -> Self {
        Self {
            generation,
            authority: AuthorityVerdict::Unknown,
            binding: BindingState::Unknown,
            key_at_rest: KeyAtRestState::Unknown,
            session: SessionFacts::NOT_ASKED,
        }
    }
}

/// Diagnose the ACTIVE vault, or `None` when the host cannot name one.
///
/// `None` is narrow and it is not "the vault is missing": it means the host could not
/// resolve an active vault ROOT at all (no active vault id, or no app data directory), and
/// both callers render it as nothing rather than as a verdict. A root that resolves and
/// holds no `vault.meta` is a full report with `generation: absent`, because that is a fact
/// about a vault that exists on this machine.
pub async fn read(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Option<VaultDoctor> {
    let dir =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await).ok()?;
    let frame = Frame::read(io, &dir).await;
    // The unlocked slot, read exactly as the cycle reads it. `None` is a locked vault, and
    // the builder is then NOT run: on a locked vault every cause it can produce is about the
    // slot rather than about the user's credentials, which is the lie this verdict exists to
    // stop ([`diagnose`] makes the same call, and is where the branch is tested).
    let session_keys = {
        let slot = state.slot_read_active().await;
        match &*slot {
            Slot::Unlocked(unlocked) => Some((
                unlocked.shared_singleton_key(),
                unlocked.authority() == VaultAuthority::Owner,
            )),
            _ => None,
        }
    };
    let head = match (&session_keys, frame.readable && frame.carries_tail) {
        (Some((shared, is_owner)), true) => {
            Some(signed_head_ctx(host, io, &dir, state, shared, *is_owner).await)
        }
        // Locked, an unreadable frame, or no signed head to resolve: the builder is not run.
        _ => None,
    };
    Some(diagnose(frame, head.as_ref()))
}

/// The five facts, from what [`read`] gathered.
///
/// Split out so the branch ORDER is testable without a vault: the frame's own state
/// outranks the credential question, and the credential question outranks nothing. A caller
/// that has a `Frame` and no vault can assert every arm of it.
#[must_use]
fn diagnose(frame: Frame, head: Option<&HeadAuthority>) -> VaultDoctor {
    // The frame outranks the credentials, in the order the cycle consults the same facts: an
    // unreadable frame stops it outright, and a frame with no tail takes the HMAC path.
    if !frame.readable {
        return VaultDoctor::unreadable(frame.generation);
    }
    if !frame.carries_tail {
        return VaultDoctor::not_applicable(frame.generation);
    }
    let Some(head) = head else {
        // Unlocked, a tail, and no resolution: `read` always builds one in that state, so this
        // arm is a locked vault that reached here through a caller other than `read`.
        return VaultDoctor::locked(frame.generation);
    };
    let device = &head.device;
    VaultDoctor {
        generation: frame.generation,
        authority: verdict(head.ctx.is_some(), head.person_held, device),
        binding: binding_state(device),
        key_at_rest: key_at_rest_state(device),
        session: SessionFacts {
            person_held: Some(head.person_held),
            device_id_adopted: device_id_adopted(device),
        },
    }
}

/// Which half may author, in the precedence the cycle uses: a bound device key signs a
/// `0x03` head, a held person keypair signs a `0x02` one, and only when neither can is
/// there a cause to report.
///
/// The `missing_for_cycle` call is not a private guess: it is the same function the
/// cycle's failure class derives from, so the sentence the panel renders and the
/// class the indicator renders cannot name different causes.
#[must_use]
fn verdict(context_built: bool, person_held: bool, device: &DeviceResolution) -> AuthorityVerdict {
    match device {
        DeviceResolution::Bound(_) => AuthorityVerdict::DeviceKey,
        DeviceResolution::Unbound { .. } if person_held && context_built => {
            AuthorityVerdict::PersonKey
        }
        _ => AuthorityVerdict::Missing {
            cause: missing_for_cycle(context_built, person_held, device),
        },
    }
}

/// The row's state, read off the resolution's cause rather than asked again.
///
/// Every arm is a fact `resolve_device` established on the way to that cause. The two
/// `Unknown` arms are the causes it returns BEFORE the row is looked at or after the
/// store refused to answer.
#[must_use]
fn binding_state(device: &DeviceResolution) -> BindingState {
    use AuthorityMissing as M;
    match device {
        DeviceResolution::Bound(_) => BindingState::Verified,
        DeviceResolution::Unbound { cause, .. } => match cause {
            M::NoBindingRow => BindingState::Absent,
            // The store was read and no row publishes halves for this device: either no
            // row at all, or one from the `0x01` generation that claims nothing.
            M::NoKeyAtRest => BindingState::Absent,
            M::RowUnverified => BindingState::Unverified,
            M::RowNamesDifferentKey => BindingState::NamesOtherKey,
            M::KeyMissingWhileBound => BindingState::Orphaned,
            // Returned before the row lookup (no device id to look up by), or after the
            // store refused. Neither says anything about this device's row.
            M::NoHeadContext | M::NoDeviceId | M::KeyUnreadable => BindingState::Unknown,
            // Produced by `missing_for_cycle`, never by `resolve_device`.
            M::NoPersonSession => BindingState::Unknown,
        },
    }
}

/// The ladder's answer, read off the same cause. See [`binding_state`] for why this is
/// a projection and not a second read.
#[must_use]
fn key_at_rest_state(device: &DeviceResolution) -> KeyAtRestState {
    use AuthorityMissing as M;
    match device {
        DeviceResolution::Bound(_) => KeyAtRestState::Present,
        DeviceResolution::Unbound { cause, .. } => match cause {
            M::NoKeyAtRest | M::KeyMissingWhileBound => KeyAtRestState::Absent,
            M::KeyUnreadable => KeyAtRestState::Unreadable,
            // Before the key read, or the store never got that far.
            M::NoHeadContext | M::NoDeviceId => KeyAtRestState::Unknown,
            // Past the key match, so a key decodes in this process.
            M::NoBindingRow | M::RowNamesDifferentKey | M::RowUnverified | M::NoPersonSession => {
                KeyAtRestState::Present
            }
        },
    }
}

/// Whether a row can name this device at all.
///
/// `Some(true)` past the device-id read, `Some(false)` when there is no durable id, and
/// `None` for the cause returned before that read.
#[must_use]
fn device_id_adopted(device: &DeviceResolution) -> Option<bool> {
    match device {
        DeviceResolution::Bound(_) => Some(true),
        DeviceResolution::Unbound { cause, .. } => match cause {
            AuthorityMissing::NoDeviceId => Some(false),
            AuthorityMissing::NoHeadContext => None,
            _ => Some(true),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::vault_head::DeviceHeadSigner;

    fn unbound(cause: AuthorityMissing) -> DeviceResolution {
        DeviceResolution::Unbound {
            cause,
            signers: Vec::<DeviceHeadSigner>::new(),
        }
    }

    /// Every cause `resolve_device` can return, so a new one fails this test list
    /// rather than silently reporting `Unknown` for a state the doctor could name.
    const FROM_THE_RESOLVER: [AuthorityMissing; 8] = [
        AuthorityMissing::NoHeadContext,
        AuthorityMissing::NoDeviceId,
        AuthorityMissing::NoKeyAtRest,
        AuthorityMissing::KeyUnreadable,
        AuthorityMissing::NoBindingRow,
        AuthorityMissing::RowNamesDifferentKey,
        AuthorityMissing::RowUnverified,
        AuthorityMissing::KeyMissingWhileBound,
    ];

    /// The row and the key are projections of ONE read, and the pairs below are that
    /// read's actual answers. Getting one wrong here would put a fact in a bug report
    /// that the resolver never established.
    #[test]
    fn the_row_and_the_key_are_read_off_the_resolution() {
        use AuthorityMissing as M;
        let cases = [
            // No readable head context, or a store that refused: nothing is known.
            (
                M::NoHeadContext,
                BindingState::Unknown,
                KeyAtRestState::Unknown,
            ),
            // Returned before the row lookup, and before the key match.
            (
                M::NoDeviceId,
                BindingState::Unknown,
                KeyAtRestState::Unknown,
            ),
            // The store was read; no row publishes halves for this device.
            (M::NoKeyAtRest, BindingState::Absent, KeyAtRestState::Absent),
            (
                M::KeyUnreadable,
                BindingState::Unknown,
                KeyAtRestState::Unreadable,
            ),
            (
                M::NoBindingRow,
                BindingState::Absent,
                KeyAtRestState::Present,
            ),
            (
                M::RowNamesDifferentKey,
                BindingState::NamesOtherKey,
                KeyAtRestState::Present,
            ),
            (
                M::RowUnverified,
                BindingState::Unverified,
                KeyAtRestState::Present,
            ),
            (
                M::KeyMissingWhileBound,
                BindingState::Orphaned,
                KeyAtRestState::Absent,
            ),
        ];
        for (cause, binding, key) in cases {
            let device = unbound(cause);
            assert_eq!(binding_state(&device), binding, "binding for {cause:?}");
            assert_eq!(key_at_rest_state(&device), key, "key at rest for {cause:?}");
        }
    }

    /// The orphan is the one state myne-md/myne#983 was measured in, and it has to be
    /// visible as its own fact: `orphaned` plus `absent` is the sentence a support
    /// reader acts on, while either alone reads as an ordinary unbound device.
    #[test]
    fn the_orphan_reports_the_row_and_the_missing_key_together() {
        let device = unbound(AuthorityMissing::KeyMissingWhileBound);
        assert_eq!(binding_state(&device), BindingState::Orphaned);
        assert_eq!(key_at_rest_state(&device), KeyAtRestState::Absent);
        assert_eq!(device_id_adopted(&device), Some(true));
    }

    /// A `HeadAuthority` with no context and one device cause, for the branch tests below.
    fn head(person_held: bool, cause: AuthorityMissing) -> HeadAuthority {
        HeadAuthority {
            ctx: None,
            device: unbound(cause),
            person_held,
        }
    }

    /// The same, with a context that BUILT. The distinction is load-bearing in `verdict`:
    /// an unbuilt context outranks every credential cause, so a test that wants the device
    /// cause has to have one.
    fn head_with_context(person_held: bool, cause: AuthorityMissing) -> HeadAuthority {
        HeadAuthority {
            ctx: Some(super::super::head_authority::SignedHeadCtx::new(
                None,
                [0x11; 16],
                Vec::new(),
            )),
            device: unbound(cause),
            person_held,
        }
    }

    /// A locked vault is not a credential problem. This is the defect class the whole
    /// issue exists for: one sentence for five causes, and the wrong one.
    #[test]
    fn a_locked_vault_never_reports_a_missing_cause() {
        let report = VaultDoctor::locked(VaultGeneration::Ntv8);
        assert_eq!(report.authority, AuthorityVerdict::Locked);
        assert_eq!(report.session, SessionFacts::NOT_ASKED);
        assert_eq!(report.generation, VaultGeneration::Ntv8);
    }

    /// The branch ORDER, which is what a support reader actually reads: a frame's own state
    /// outranks the credential question, and a tail-carrying frame with no resolution is a
    /// locked vault. Getting the order wrong is how `NTV5` would be told its authority is
    /// missing, or a locked vault blamed on its own files.
    #[test]
    fn a_missing_resolution_means_locked_only_for_a_tail_carrying_frame() {
        let tail = Frame::of(b"NTV8\x02\x00");
        let locked = diagnose(tail, None);
        assert_eq!(locked.authority, AuthorityVerdict::Locked);
        assert_eq!(locked.binding, BindingState::Unknown);
        assert_eq!(locked.session, SessionFacts::NOT_ASKED);
    }

    /// An unlocked vault takes its facts from the resolution, and every one of the five is
    /// filled from that single answer.
    #[test]
    fn an_unlocked_vault_reports_all_five_facts_from_one_resolution() {
        let report = diagnose(
            Frame::of(b"NTV8\x02\x00"),
            Some(&head_with_context(
                false,
                AuthorityMissing::KeyMissingWhileBound,
            )),
        );
        assert_eq!(report.generation, VaultGeneration::Ntv8);
        assert_eq!(
            report.authority,
            AuthorityVerdict::Missing {
                cause: AuthorityMissing::KeyMissingWhileBound
            }
        );
        assert_eq!(report.binding, BindingState::Orphaned);
        assert_eq!(report.key_at_rest, KeyAtRestState::Absent);
        assert_eq!(
            report.session,
            SessionFacts {
                person_held: Some(false),
                device_id_adopted: Some(true),
            }
        );
    }

    /// A frame with no signed head has no authority to be missing, and the answer comes from
    /// the sync plane's classifier rather than from a magic list here.
    #[test]
    fn a_frame_with_no_signed_head_is_not_a_missing_authority() {
        // The two personal generations, and an unrecognised magic, all classify as no tail.
        for bytes in [b"NTV5\x02\x00".as_slice(), b"MYV1\x01\x00", b"hunt"] {
            let frame = Frame::of(bytes);
            assert!(!frame.carries_tail, "{:?}", frame.generation);
            assert_eq!(
                diagnose(frame, None).authority,
                AuthorityVerdict::NotApplicable,
                "{:?}",
                frame.generation
            );
        }
        // A magic nobody recognises is not the same fact as a frame with no tail: nobody
        // looked at the binding store, so the report says `unknown` rather than claiming this
        // device is unpublished.
        assert_eq!(
            diagnose(Frame::of(b"hunt"), None).binding,
            BindingState::Unknown
        );
        // The three tail generations carry it.
        for bytes in [b"NTV6\x02\x00".as_slice(), b"NTV7\x02\x00", b"NTV8\x02\x00"] {
            assert!(
                Frame::of(bytes).carries_tail,
                "{:?}",
                Frame::of(bytes).generation
            );
        }
    }

    /// An absent `vault.meta` is a FACT the cycle acts on, not a fault: it reads the same
    /// absence as "not a B2B vault" and authors an HMAC head. Reporting a missing credential
    /// on it would contradict the cycle on the same bytes.
    #[test]
    fn an_absent_frame_follows_the_cycle_to_the_hmac_path() {
        let absent = Frame {
            generation: VaultGeneration::Absent,
            readable: true,
            carries_tail: false,
        };
        let report = diagnose(absent, None);
        assert_eq!(report.authority, AuthorityVerdict::NotApplicable);
        assert_eq!(report.generation, VaultGeneration::Absent);
    }

    /// An unreadable frame is `unknown`, never a cause: the cycle refuses to author anything
    /// on it, so naming a credential state would blame the user for a file problem.
    #[test]
    fn an_unreadable_frame_is_not_a_credential_cause() {
        let unreadable = Frame {
            generation: VaultGeneration::Unreadable,
            readable: false,
            carries_tail: false,
        };
        let report = diagnose(unreadable, None);
        assert_eq!(report.authority, AuthorityVerdict::Unknown);
        assert_eq!(report.binding, BindingState::Unknown);
        assert_eq!(report.key_at_rest, KeyAtRestState::Unknown);
        assert_eq!(report.session, SessionFacts::NOT_ASKED);
    }

    /// A bound device authors without the phrase, so a closed identity is not a cause.
    #[test]
    fn a_bound_device_key_outranks_the_closed_identity() {
        let bound = DeviceResolution::Bound(Box::new(super::super::authority::BoundDevice {
            device_id: [0x11; 16],
            key: protocol::device_key::DeviceKeyPair::generate_raw(&[0x21; 32], &[0x22; 32]),
            signers: Vec::new(),
        }));
        assert_eq!(verdict(true, false, &bound), AuthorityVerdict::DeviceKey);
        assert_eq!(binding_state(&bound), BindingState::Verified);
        assert_eq!(key_at_rest_state(&bound), KeyAtRestState::Present);
        assert_eq!(device_id_adopted(&bound), Some(true));
    }

    /// With the identity held and no device key, the person keypair authors a `0x02`
    /// head. Reporting a missing authority here would tell a syncing device it cannot
    /// sync. That is the same shape of lie as the locked arm.
    #[test]
    fn a_held_identity_authors_without_a_device_key() {
        let device = unbound(AuthorityMissing::NoKeyAtRest);
        assert_eq!(verdict(true, true, &device), AuthorityVerdict::PersonKey);
    }

    /// The cause the panel will render is the cycle's own, not a second opinion.
    #[test]
    fn the_missing_cause_is_the_one_the_cycle_reports() {
        let device = unbound(AuthorityMissing::RowUnverified);
        assert_eq!(
            verdict(true, false, &device),
            AuthorityVerdict::Missing {
                cause: AuthorityMissing::RowUnverified
            }
        );
        // No head context outranks every credential question, exactly as the cycle's
        // failure class decides it.
        assert_eq!(
            verdict(false, true, &unbound(AuthorityMissing::NoBindingRow)),
            AuthorityVerdict::Missing {
                cause: AuthorityMissing::NoHeadContext
            }
        );
    }

    /// Five magics are named and no other bytes are echoed.
    #[test]
    fn the_generation_is_named_by_magic_and_nothing_else_is() {
        assert_eq!(VaultGeneration::of(b"NTV5\x02\x00"), VaultGeneration::Ntv5);
        assert_eq!(VaultGeneration::of(b"NTV6\x02\x00"), VaultGeneration::Ntv6);
        assert_eq!(VaultGeneration::of(b"NTV7\x02\x00"), VaultGeneration::Ntv7);
        assert_eq!(VaultGeneration::of(b"NTV8\x02\x00"), VaultGeneration::Ntv8);
        assert_eq!(VaultGeneration::of(b"MYV1\x01\x00"), VaultGeneration::Myv1);
        // A secret that happened to be in the first four bytes is not a generation, and
        // the report says nothing about it.
        assert_eq!(VaultGeneration::of(b"hunt"), VaultGeneration::Unknown);
        assert_eq!(VaultGeneration::of(b"NT"), VaultGeneration::Unknown);
        assert_eq!(
            serde_json::to_string(&VaultGeneration::Unknown).unwrap(),
            "\"unknown\""
        );
    }

    /// The report is a closed shape the client mirrors, so the wire names are pinned
    /// here rather than discovered by a TypeScript reader.
    #[test]
    fn the_report_serializes_as_closed_tokens() {
        let report = VaultDoctor {
            generation: VaultGeneration::Ntv8,
            authority: AuthorityVerdict::Missing {
                cause: AuthorityMissing::KeyMissingWhileBound,
            },
            binding: BindingState::Orphaned,
            key_at_rest: KeyAtRestState::Absent,
            session: SessionFacts {
                person_held: Some(false),
                device_id_adopted: Some(true),
            },
        };
        assert_eq!(
            serde_json::to_string(&report).unwrap(),
            "{\"generation\":\"NTV8\",\"authority\":{\"state\":\"missing\",\"cause\":\"key_missing_while_bound\"},\"binding\":\"orphaned\",\"key_at_rest\":\"absent\",\"session\":{\"person_held\":false,\"device_id_adopted\":true}}"
        );
    }

    /// Exactly three causes leave the row unstated, and they are the three returned
    /// before the row was read or after the store refused. A fourth appearing here is
    /// a cause the projection forgot, and it would show up as `unknown` in a bug report
    /// instead of as a fact.
    #[test]
    fn only_the_unread_causes_leave_the_row_unknown() {
        let unknown: Vec<_> = FROM_THE_RESOLVER
            .iter()
            .copied()
            .filter(|cause| binding_state(&unbound(*cause)) == BindingState::Unknown)
            .collect();
        assert_eq!(
            unknown,
            vec![
                AuthorityMissing::NoHeadContext,
                AuthorityMissing::NoDeviceId,
                AuthorityMissing::KeyUnreadable,
            ]
        );
    }
}
