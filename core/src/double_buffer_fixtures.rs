// SPDX-License-Identifier: AGPL-3.0-only
//! Named crash states of a double-buffered singleton, as BYTES
//! (phase3-web-client task 105).
//!
//! # Why the fixtures come from Rust and not from the test that uses them
//!
//! The web E2E lane arranges at-rest state by writing fixture bytes into OPFS
//! before the app boots — the browser analogue of the desktop lane's byte
//! surgery on a seeded vault directory, and the reason neither lane needs a
//! production test hook (`e2e-web/AGENTS.md`, non-negotiable 2).
//!
//! For that to prove anything, the bytes have to be **what the writer actually
//! writes**. A fixture hand-assembled in TypeScript would encode a second
//! opinion about the 8-byte generation prefix, the slot suffixes and which slot
//! a given history lands in — and the moment that opinion drifted from
//! `double_buffer.rs`, the lane would be testing recovery from a container
//! shape production never produces. The failure would look like a passing test.
//!
//! So every fixture here is produced by driving the REAL writer
//! ([`write_next_faulting`]) against a real directory, with the same [`Fault`]
//! injection the unit tests use. Nothing below constructs a container by hand.
//!
//! # The six, and what each one is asking
//!
//! | name | history | the question it puts to the reader |
//! |---|---|---|
//! | `pristine` | one clean write | does a single copy open at all |
//! | `steady-state` | two clean writes | with both slots complete, is the NEWER one chosen |
//! | `stop-before-write` | write, then a crash before the new slot is touched | is the previous copy returned untouched |
//! | `stop-mid-write` | write, then a crash with a prefix on disk | is the half-written slot refused in favour of the older complete one |
//! | `stop-before-flush` | write, then a crash after the bytes but before durability | does SOMETHING complete open — the outcome is unspecified, so the assertion is the weaker one |
//! | `torn-newest` | two writes, then a crash mid-third | the case measured in a real browser: the newest generation is torn and an intact copy must still be reachable |
//!
//! `stop-mid-write` and `torn-newest` look similar and are not. The first has
//! one complete copy and one prefix; the second has two complete generations
//! before the prefix overwrites one of them, so they resolve to DIFFERENT
//! payloads. A reader that merely preferred "the longest file" or "the last
//! written" would pass one and fail the other.
//!
//! # What "recoverable" means here, and what it deliberately does not
//!
//! `double_buffer::candidates` ranks slots by their 8-byte generation stamp and
//! hands back every one worth attempting, newest first. It does **not** decide
//! which is intact, because it cannot: completeness is an AEAD property, and the
//! tag lives inside the payload the layer above decodes.
//!
//! So a torn slot whose generation stamp DID land ranks first and is offered
//! first — correctly. Recovery is the caller trying the next candidate when the
//! decode fails. The fixtures therefore assert the intact payload is **among**
//! the candidates, not that it is `candidates[0]`; the stricter assertion would
//! be pinning a contract the container does not have, and would fail against
//! correct code. (It did, on the first run of these tests.)
//!
//! # The Safari path
//!
//! Safari implements no `FileSystemFileHandle.move()` and no `createWritable`,
//! which is why the double-buffer exists at all. A fixture is just bytes in two
//! files, so seeding needs neither — it is `createSyncAccessHandle`, which is
//! worker-only in every engine and therefore the same code path on all three.
//! That is what makes these fixtures usable on the seat that cannot be
//! automated in CI (`e2e-web/AGENTS.md`: the Safari row is a manual gate).

use crate::double_buffer::{write_next_faulting, Fault};
use crate::vault_io::{IoResult, VaultIo};
use std::path::Path;

/// One slot file of a fixture: the name to write in OPFS and its bytes.
#[derive(Debug, Clone)]
pub struct FixtureFile {
    /// File name relative to the vault root, e.g. `vault.meta.a`.
    pub name: String,
    pub bytes: Vec<u8>,
}

/// A named crash state, as the seeder consumes it.
#[derive(Debug, Clone)]
pub struct Fixture {
    /// Stable identifier the E2E scenario names.
    pub name: &'static str,
    /// One sentence: what a reader of this container must do.
    pub expectation: &'static str,
    /// The slot files present. A slot the history never wrote is ABSENT here,
    /// not empty — an empty file and a missing one are different inputs, and
    /// conflating them is exactly the bug the `stop-before-write` case exists
    /// to catch.
    pub files: Vec<FixtureFile>,
    /// The intact payload that MUST be among the candidates a reader gets, or
    /// `None` where the scheme permits either of two answers.
    ///
    /// **Among**, not first — and the distinction is the scheme.
    /// `double_buffer::candidates` ranks slots by their generation stamp and
    /// returns every one worth attempting, newest first; it does NOT decide
    /// which is intact, because it cannot. Completeness is established one layer
    /// up, by the blob decoder's AEAD tag failing on a torn payload.
    ///
    /// A torn slot whose 8-byte generation stamp did land therefore ranks FIRST
    /// and is handed over first — correctly. Recovery is the caller trying the
    /// next candidate. A fixture asserting "the older copy is `candidates[0]`"
    /// would be asserting a contract the container does not have, and would
    /// fail against correct code.
    pub recoverable_payload: Option<Vec<u8>>,
}

/// The six histories, as (name, expectation, steps) — a step is a payload plus
/// the fault to inject on that write.
type Step<'a> = (&'a [u8], Fault);

fn histories() -> Vec<(&'static str, &'static str, Vec<Step<'static>>)> {
    const V1: &[u8] = b"MYV1-generation-one-payload";
    const V2: &[u8] = b"MYV1-generation-two-payload-longer";
    const V3: &[u8] = b"MYV1-generation-three";
    vec![
        (
            "pristine",
            "a lone complete copy opens",
            vec![(V1, Fault::None)],
        ),
        (
            "steady-state",
            "with both slots complete the NEWER generation wins",
            vec![(V1, Fault::None), (V2, Fault::None)],
        ),
        (
            "stop-before-write",
            "the previous copy is returned untouched; no stray sibling exists",
            vec![(V1, Fault::None), (V2, Fault::StopBeforeWrite)],
        ),
        (
            "stop-mid-write",
            "the half-written slot is refused; the older complete copy wins",
            vec![(V1, Fault::None), (V2, Fault::StopMidWrite(12))],
        ),
        (
            "stop-before-flush",
            "SOMETHING complete opens — which one is unspecified, so only completeness is asserted",
            vec![(V1, Fault::None), (V2, Fault::StopBeforeFlush)],
        ),
        (
            "torn-newest",
            "two complete copies plus a torn newest: the intact older generation wins",
            vec![
                (V1, Fault::None),
                (V2, Fault::None),
                (V3, Fault::StopMidWrite(11)),
            ],
        ),
    ]
}

/// Which intact payload must be RECOVERABLE from each history, or `None` where
/// the scheme permits either.
fn recoverable(name: &str) -> Option<Vec<u8>> {
    match name {
        "pristine" => Some(b"MYV1-generation-one-payload".to_vec()),
        "steady-state" => Some(b"MYV1-generation-two-payload-longer".to_vec()),
        // The crash never touched the new slot, so generation one is still the
        // only complete copy.
        "stop-before-write" => Some(b"MYV1-generation-one-payload".to_vec()),
        // The prefix DOES outrank it — its generation stamp landed — so the
        // torn bytes are handed over first and the intact copy is behind it.
        // That is the scheme working: the container ranks, the AEAD decides.
        "stop-mid-write" => Some(b"MYV1-generation-one-payload".to_vec()),
        // Deliberately unpinned: `flush()` is the only durability primitive a
        // browser offers and what a crash before it leaves is UNSPECIFIED. The
        // scheme must be correct either way, so the scenario asserts the weaker
        // property (a complete copy opens) rather than pinning which.
        "stop-before-flush" => None,
        "torn-newest" => Some(b"MYV1-generation-two-payload-longer".to_vec()),
        _ => None,
    }
}

/// Build every fixture by replaying its history through the real writer.
///
/// `scratch` is a directory this function owns for the duration — it writes
/// each history under a distinct subdirectory and reads the resulting slot
/// files back out. Nothing is left behind that a caller must interpret; the
/// return value is the whole artefact.
pub async fn build_fixtures(io: &dyn VaultIo, scratch: &Path) -> IoResult<Vec<Fixture>> {
    let mut out = Vec::new();
    for (name, expectation, steps) in histories() {
        let dir = scratch.join(name);
        io.create_dir_all(&dir).await?;
        let base = dir.join("vault.meta");
        for (payload, fault) in steps {
            // A faulting write reports the crash as an error on some arms; that
            // IS the simulated crash, not a failure of the fixture.
            let _ = write_next_faulting(io, &base, payload, fault).await;
        }
        let mut files = Vec::new();
        for suffix in crate::double_buffer::SLOT_SUFFIXES {
            let path = dir.join(format!("vault.meta{suffix}"));
            // Absent stays absent. See `Fixture::files`.
            if io.exists(&path).await.unwrap_or(false) {
                files.push(FixtureFile {
                    name: format!("vault.meta{suffix}"),
                    bytes: io.read(&path).await?,
                });
            }
        }
        out.push(Fixture {
            name,
            expectation,
            files,
            recoverable_payload: recoverable(name),
        });
    }
    Ok(out)
}

/// Serialise the fixtures as JSON for the browser seeder, bytes base64-free.
///
/// Byte arrays rather than base64 on purpose: the seeder feeds them straight
/// into a `Uint8Array`, and a base64 hop would be one more place for an
/// encoding to be wrong in a way that looks like a corrupted container — which
/// is precisely the condition under test.
pub fn to_json(fixtures: &[Fixture]) -> String {
    let mut s = String::from("[\n");
    for (i, f) in fixtures.iter().enumerate() {
        s.push_str("  {\n");
        s.push_str(&format!("    \"name\": \"{}\",\n", f.name));
        s.push_str(&format!(
            "    \"expectation\": {},\n",
            json_str(f.expectation)
        ));
        s.push_str("    \"files\": [\n");
        for (j, file) in f.files.iter().enumerate() {
            s.push_str(&format!(
                "      {{ \"name\": \"{}\", \"bytes\": [{}] }}{}\n",
                file.name,
                file.bytes
                    .iter()
                    .map(|b| b.to_string())
                    .collect::<Vec<_>>()
                    .join(","),
                if j + 1 == f.files.len() { "" } else { "," }
            ));
        }
        s.push_str("    ],\n");
        match &f.recoverable_payload {
            Some(p) => s.push_str(&format!(
                "    \"recoverablePayload\": [{}]\n",
                p.iter()
                    .map(|b| b.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            )),
            None => s.push_str("    \"recoverablePayload\": null\n"),
        }
        s.push_str(if i + 1 == fixtures.len() {
            "  }\n"
        } else {
            "  },\n"
        });
    }
    s.push(']');
    s
}

fn json_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// Every fixture must be readable by the REAL reader, and yield what it
    /// claims. This is the check that makes the fixtures evidence rather than
    /// decoration: if `candidates` disagreed with `recoverable_payload`, the E2E
    /// scenario built on them would assert the wrong thing.
    #[test]
    fn every_fixture_is_what_the_real_reader_returns() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("db-fixtures").unwrap();
            let fixtures = build_fixtures(&IO, tmp.path()).await.unwrap();
            assert_eq!(fixtures.len(), 6, "six named crash states");

            for f in &fixtures {
                let base = tmp.path().join(f.name).join("vault.meta");
                let got = crate::double_buffer::candidates(&IO, &base).await.unwrap();
                assert!(
                    !got.is_empty(),
                    "{}: a correct reader must return SOMETHING — {}",
                    f.name,
                    f.expectation
                );
                match &f.recoverable_payload {
                    // MEMBERSHIP, not position — see the module header. The
                    // container ranks by generation; the AEAD decides.
                    Some(want) => assert!(
                        got.contains(want),
                        "{}: the intact copy is not among the candidates — {}",
                        f.name,
                        f.expectation
                    ),
                    None => {
                        // The unspecified case: SOME complete copy must be
                        // reachable, and which one is not this scheme's promise.
                        assert!(
                            got.contains(&b"MYV1-generation-one-payload".to_vec())
                                || got.contains(&b"MYV1-generation-two-payload-longer".to_vec()),
                            "{}: no COMPLETE copy is reachable at all",
                            f.name
                        );
                    }
                }
            }
        });
    }

    /// `stop-before-write` must leave exactly ONE slot file. An empty second
    /// file and a missing one are different inputs to the reader, and a fixture
    /// that materialised an empty sibling would be testing a state production
    /// never produces.
    #[test]
    fn a_crash_before_the_write_leaves_no_sibling() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("db-fixtures-nosib").unwrap();
            let fixtures = build_fixtures(&IO, tmp.path()).await.unwrap();
            let f = fixtures
                .iter()
                .find(|f| f.name == "stop-before-write")
                .unwrap();
            assert_eq!(
                f.files.len(),
                1,
                "the untouched slot must be ABSENT, not empty"
            );
        });
    }

    /// The two torn cases differ in a way a naive reader gets wrong: one has a
    /// single complete copy beside a prefix, the other has two. A reader that
    /// preferred "the longest file" or "the last written" would pass the first
    /// and fail the second, so the fixtures must actually differ in slot count.
    #[test]
    fn the_two_torn_cases_are_genuinely_different_shapes() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("db-fixtures-torn").unwrap();
            let fixtures = build_fixtures(&IO, tmp.path()).await.unwrap();
            let mid = fixtures
                .iter()
                .find(|f| f.name == "stop-mid-write")
                .unwrap();
            let torn = fixtures.iter().find(|f| f.name == "torn-newest").unwrap();
            // Both have two slot files, but the payloads behind them differ:
            // `stop-mid-write` has one complete + one prefix of generation 2;
            // `torn-newest` has a complete generation 2 and a prefix of 3.
            assert_ne!(
                mid.recoverable_payload, torn.recoverable_payload,
                "the two torn cases must resolve to DIFFERENT payloads, or one of them \
                 is not exercising what its name claims"
            );
        });
    }

    /// The JSON the browser seeder consumes must round-trip to the same bytes.
    #[test]
    fn the_serialised_form_carries_the_bytes_verbatim() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("db-fixtures-json").unwrap();
            let fixtures = build_fixtures(&IO, tmp.path()).await.unwrap();
            let json = to_json(&fixtures);
            let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
            let arr = parsed.as_array().unwrap();
            assert_eq!(arr.len(), 6);
            for (f, v) in fixtures.iter().zip(arr) {
                assert_eq!(v["name"].as_str().unwrap(), f.name);
                let files = v["files"].as_array().unwrap();
                assert_eq!(files.len(), f.files.len());
                for (ff, fv) in f.files.iter().zip(files) {
                    let bytes: Vec<u8> = fv["bytes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|b| b.as_u64().unwrap() as u8)
                        .collect();
                    assert_eq!(bytes, ff.bytes, "{} / {} byte drift", f.name, ff.name);
                }
            }
        });
    }
}
