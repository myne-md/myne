// SPDX-License-Identifier: AGPL-3.0
//! Host-side personal-dictionary payload (MYND-266 tasks 4-5; myne-md/myne#640).
//!
//! The typed `vault.dictionary` inner payload and its §10.2.1 merge live in
//! `myne_core::plugins::sync::dictionary_payload`, not here, because the sync
//! engine in `myne-core` is the other consumer: it merges a peer's payload with
//! this device's, and a schema that lived only in the desktop crate would have
//! forced a second implementation of the merge there. This module is the
//! desktop's one-line view of that type, kept at the old path so the spell
//! plugin's imports read as they always did.
//!
//! The protocol codec (`protocol::dictionary_blob`) stays payload-agnostic: it
//! owns the `MYD1`/`MYD5` envelope and the `dict_format_version` byte (now
//! `0x02`), and treats these bytes as opaque. `PersonalDictionaryData` is the
//! `0x02` shape (two canonical word sets plus a per-word removal-clock map);
//! `PersonalDictionaryV1` is the `0x01` shape a pre-feature blob decodes to,
//! promoted with no clocks.
//!
//! Both sets are AS3-Sensitive user vocabulary: they live encrypted at rest, are
//! held in RAM only while unlocked, and are zeroized on lock (see `sync.rs`).

pub use myne_core::plugins::sync::dictionary_payload::PersonalDictionaryData;
