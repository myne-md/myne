// SPDX-License-Identifier: AGPL-3.0
//
// Byte-level integration tests against the `myne-test-vectors/` companion
// repository (expected at `../myne-test-vectors/` per `workspace/setup.sh`).
// Each runner reads a category's `cases.json`, drives the matching public
// API, and asserts byte-equality. When the companion repo is not checked
// out the runners skip with an explanatory message rather than fail.
//
// # Two execution targets, one set of runners (phase3-web-client task 15)
//
// The same 34 runners execute natively and **inside a browser**. Cross-
// implementation agreement is a property of compiled code on its execution
// target, and the web client's target is a browser's wasm engine — so a suite
// that only ever ran on aarch64/x86_64 was evidence about a different machine
// than the one those users run.
//
//   cargo test -p protocol --test vectors                 # native
//   scripts/browser-vectors.sh                            # headless Chrome
//
// Only two things differ between them, and both live here rather than sprinkled
// through the runners: where `cases.json` comes from ([`cases_json`]) and which
// attribute registers a test (the `cfg_attr` pair on each `fn`). Everything that
// asserts anything is shared source, which is the point — a browser lane running
// a *copy* of these assertions would drift from them silently.

#[cfg(not(target_arch = "wasm32"))]
use std::fs;
#[cfg(not(target_arch = "wasm32"))]
use std::path::PathBuf;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::{wasm_bindgen_test, wasm_bindgen_test_configure};

// **In the browser, not in node.** Without this, `wasm-bindgen-test` runs the
// module under node, which is a different wasm engine than any user has.
#[cfg(target_arch = "wasm32")]
wasm_bindgen_test_configure!(run_in_browser);

// `protocol` selects getrandom's `custom` backend on wasm32 and deliberately
// leaves the hook unregistered (see `protocol/Cargo.toml`), so a wasm test
// binary has to supply one: a test binary is a root artifact, and an
// unregistered hook is a link error rather than a fallback.
//
// It refuses. That is not a shortcut — **a vector run is deterministic by
// definition**: every nonce, salt and key comes from the fixture. A runner that
// reaches for entropy is testing something other than the vector, and the
// loudest available answer is the right one. Natively that property holds
// implicitly; here it is enforced.
#[cfg(target_arch = "wasm32")]
fn vectors_need_no_entropy(_dest: &mut [u8]) -> Result<(), getrandom::Error> {
    Err(getrandom::Error::UNSUPPORTED)
}
#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(vectors_need_no_entropy);

#[cfg(not(target_arch = "wasm32"))]
fn companion_vectors_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("myne-test-vectors")
        .join("vectors")
}

/// Whether a missing fixture is a **failure** rather than a skip.
///
/// The native lane's skip-on-absent-companion contract (`protocol/CLAUDE.md`)
/// is right for a contributor with no companion checked out and wrong for the
/// one CI step whose entire job is to assert: there, `[skip]` on every runner
/// reports green having verified nothing, which is the state the
/// `vector-verification` step in `.woodpecker.yml` is commented out over.
///
/// `MYNE_VECTORS_REQUIRED` inverts the default for that step alone. Unset —
/// `pre-push`, a fresh clone, a contributor's laptop — keeps today's skip. Set
/// to anything but `0` or the empty string, a missing fixture panics with the
/// path it looked for, so an expired token or a moved ref fails loudly instead
/// of silently returning the step to green-and-empty.
#[cfg(not(target_arch = "wasm32"))]
fn vectors_required() -> bool {
    match std::env::var("MYNE_VECTORS_REQUIRED") {
        Ok(v) => !v.is_empty() && v != "0",
        Err(_) => false,
    }
}

/// The `[skip]`-or-panic decision both loaders share, so the two cannot drift:
/// a fixture that is optional in one version directory and mandatory in the
/// other would be a hole exactly the size of whichever loader was forgotten.
#[cfg(not(target_arch = "wasm32"))]
fn missing_fixture(category: &str, path: &std::path::Path) -> Option<String> {
    if vectors_required() {
        panic!(
            "[{category}] MYNE_VECTORS_REQUIRED is set and the fixture is absent: {}\n\
             This lane exists to assert; skipping here would report green having \
             verified nothing. Check out `myne-test-vectors` beside this repo (or \
             unset MYNE_VECTORS_REQUIRED to restore the contributor-side skip).",
            path.display()
        );
    }
    eprintln!(
        "[skip] {category}: companion repo fixture not present at {}",
        path.display()
    );
    None
}

/// The raw `cases.json` for one category's fixtures at one protocol version, or
/// `None` when this build has none — in which case the caller returns without
/// asserting, exactly as the per-runner `path.exists()` check used to.
///
/// The two arms differ in *when* the bytes are read, and that difference is
/// forced rather than chosen:
///
/// * **native** — read from `../myne-test-vectors/vectors/<category>/<version>/cases.json`
///   at run time. A missing companion prints `[skip]` and returns `None`, which
///   is the long-standing contract (`protocol/CLAUDE.md`): the companion is
///   optional for a contributor and required for the gate.
/// * **wasm32** — a browser has no filesystem to read at run time, so the
///   fixtures are baked in at COMPILE time behind the `browser-vectors` feature.
///   Without that feature the browser build still compiles and every runner
///   skips.
///
/// A (category, version) pair the embedded table does not carry **panics**
/// instead of skipping. Natively a missing file means "no companion checked
/// out"; in the browser lane it can only mean the table fell behind the runners,
/// and a lane that silently skips the family somebody just added is worse than
/// no lane at all.
///
/// **The version is part of the key, and that is load-bearing.** The table was
/// keyed by category name alone while `crdt-note-blob` was the only next-major
/// family — one version directory per category made the name unambiguous. It
/// stopped being true the moment `vault-meta` and `vault-themes` landed a `v0.2/`
/// beside their `v0.1/`: a name-keyed lookup handed the v0.2 runners their v0.1
/// bytes, and no name-keyed table could have held both rows anyway (the
/// duplicate check below forbids it). Native and browser therefore key alike.
fn cases_json_for(category: &str, version: &str) -> Option<String> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let path = companion_vectors_root()
            .join(category)
            .join(version)
            .join("cases.json");
        if !path.exists() {
            return missing_fixture(category, &path);
        }
        Some(fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display())))
    }

    #[cfg(all(target_arch = "wasm32", feature = "browser-vectors"))]
    {
        Some(
            embedded::CASES
                .iter()
                .find(|(name, ver, _)| *name == category && *ver == version)
                .map(|(_, _, body)| (*body).to_owned())
                .unwrap_or_else(|| {
                    panic!(
                        "[{category}/{version}] no embedded fixture. The browser lane's \
                         table in `mod embedded` has fallen behind the runners — add the \
                         (category, version) row there rather than letting it skip."
                    )
                }),
        )
    }

    #[cfg(all(target_arch = "wasm32", not(feature = "browser-vectors")))]
    {
        let _ = (category, version);
        None
    }
}

/// The `v0.1/` fixtures for a category — the shape almost every runner wants.
fn cases_json(category: &str) -> Option<String> {
    cases_json_for(category, "v0.1")
}

/// The `v0.2/` fixtures for a category — the next-major families (`crdt-note-blob`
/// §10.7, plus the `vault-meta` / `vault-themes` sides of the §10.4.1 md.6
/// protocol_version split).
#[allow(dead_code)]
fn cases_json_v0_2(category: &str) -> Option<String> {
    cases_json_for(category, "v0.2")
}

/// The fixtures, baked in (phase3-web-client task 15).
///
/// A browser cannot read `../myne-test-vectors/` at run time, so the bytes have
/// to be in the module. `include_str!` resolves relative to THIS file, so these
/// paths are the same ones [`companion_vectors_root`] builds — the native and
/// browser lanes read the identical files, never a copy checked in beside the
/// runners.
///
/// The whole module is gated on `browser-vectors` because `include_str!` of an
/// absent file is a compile error: without the gate, every contributor who has
/// not cloned the companion would lose the ability to build this crate's tests.
///
/// Keeping this list complete is enforced rather than remembered —
/// [`cases_json`] panics on a category that is missing here, and
/// `the_browser_lane_carries_every_category` asserts the table and the runners
/// name the same set.
#[cfg(all(target_arch = "wasm32", feature = "browser-vectors"))]
mod embedded {
    pub const CASES: &[(&str, &str, &str)] = &[
        (
            "aad-construction",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/aad-construction/v0.1/cases.json"),
        ),
        (
            "aad-construction",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/aad-construction/v0.2/cases.json"),
        ),
        (
            "account-number",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/account-number/v0.1/cases.json"),
        ),
        (
            "argon2id",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/argon2id/v0.1/cases.json"),
        ),
        (
            "attachment-blob",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/attachment-blob/v0.1/cases.json"),
        ),
        (
            "attachment-text",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/attachment-text/v0.1/cases.json"),
        ),
        (
            "attachments-catalog",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/attachments-catalog/v0.1/cases.json"),
        ),
        (
            "bip39-recovery",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/bip39-recovery/v0.1/cases.json"),
        ),
        (
            "color-group",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/color-group/v0.1/cases.json"),
        ),
        (
            // The first next-major vector family, and the one category that has
            // NO v0.1 row: `NC05` is a v0.2-only note type.
            "crdt-note-blob",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/crdt-note-blob/v0.2/cases.json"),
        ),
        (
            "ctx-aead",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/ctx-aead/v0.1/cases.json"),
        ),
        (
            "damm32-table",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/damm32-table/v0.1/cases.json"),
        ),
        (
            "embeddings",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/embeddings/v0.1/cases.json"),
        ),
        (
            "graph-layout",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/graph-layout/v0.1/cases.json"),
        ),
        (
            "head-fingerprint",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/head-fingerprint/v0.1/cases.json"),
        ),
        (
            "hkdf-sha256",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/hkdf-sha256/v0.1/cases.json"),
        ),
        (
            "manifest",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/manifest/v0.1/cases.json"),
        ),
        (
            "myn-blob",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/myn-blob/v0.1/cases.json"),
        ),
        (
            "note-template",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/note-template/v0.1/cases.json"),
        ),
        (
            "paired-extension",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/paired-extension/v0.1/cases.json"),
        ),
        (
            "password-policy",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/password-policy/v0.1/cases.json"),
        ),
        (
            "pending-capture",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/pending-capture/v0.1/cases.json"),
        ),
        (
            "phrase_normalize",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/phrase_normalize/v0.1/cases.json"),
        ),
        (
            "saved-view",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/saved-view/v0.1/cases.json"),
        ),
        (
            "scram-auth",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/scram-auth/v0.1/cases.json"),
        ),
        (
            "share-import",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/share-import/v0.1/cases.json"),
        ),
        (
            "vault-dictionary",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-dictionary/v0.1/cases.json"),
        ),
        (
            "vault-head",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-head/v0.1/cases.json"),
        ),
        (
            "vault-head-state",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-head-state/v0.1/cases.json"),
        ),
        (
            "vault-indices",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-indices/v0.1/cases.json"),
        ),
        (
            "vault-meta",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-meta/v0.1/cases.json"),
        ),
        (
            "vault-meta",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/vault-meta/v0.2/cases.json"),
        ),
        (
            "vault-prefs",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-prefs/v0.1/cases.json"),
        ),
        (
            "vault-quickunlock",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-quickunlock/v0.1/cases.json"),
        ),
        (
            "vault-search",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-search/v0.1/cases.json"),
        ),
        (
            "vault-themes",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-themes/v0.1/cases.json"),
        ),
        (
            "vault-themes",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/vault-themes/v0.2/cases.json"),
        ),
        (
            "vault-workspace",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-workspace/v0.1/cases.json"),
        ),
        (
            "vault_meta_rewrite",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault_meta_rewrite/v0.1/cases.json"),
        ),
    ];
}

/// The browser lane is really running the vectors, not skipping every one.
///
/// Every runner returns quietly when its fixtures are unavailable — correct for
/// a contributor without the companion, and catastrophic for a CI lane that
/// forgot `--features browser-vectors`: the lane would report a full sheet of
/// passing tests having asserted nothing at all. This is the assertion that
/// distinguishes the two, and it is why the browser script passes the feature
/// explicitly rather than relying on a default.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen_test]
fn the_browser_lane_actually_has_fixtures() {
    assert!(
        cfg!(feature = "browser-vectors"),
        "browser vector run without `--features browser-vectors`: every runner \
         would skip and the lane would pass having verified nothing"
    );
}

/// The embedded table and the runners name the same (category, version) pairs.
///
/// One direction is covered by [`cases_json_for`], which panics on a pair the
/// table lacks. The **other** direction — a row left behind after a runner was
/// renamed or removed, sitting there looking like coverage — is covered by the
/// last assertion here, and it is worth saying how, because the obvious way does
/// not work. A row count cannot do it: the count this test used to carry had
/// drifted two rows behind reality (34 vs 36) without anyone noticing, since
/// nothing runs this lane in CI, and a hand-maintained number that nobody
/// executes is not a guard. Recording lookups at run time cannot do it either —
/// `wasm_bindgen_test` gives no ordering guarantee, so a test that inspected
/// which pairs had been requested might run first. What does work is reading
/// **this file's own source**, compiled in beside the fixtures, and requiring a
/// literal `cases_json…("<category>")` call for every row. That is checkable at
/// the only moment both facts exist together, and it cannot go stale.
///
/// The key/body assertion is the other one that earns its keep. A row's KEY is
/// written by hand while its BODY comes from an `include_str!` path written by
/// hand beside it, so the two can disagree — and the failure that
/// disagreement produces is the worst kind: the runner gets real, well-formed,
/// schema-valid vectors for the wrong version and asserts against them. Reading
/// `schema` + `protocol_version` back out of the bytes and comparing them to the
/// key closes that gap structurally, and unlike a row count it cannot go stale.
#[cfg(all(target_arch = "wasm32", feature = "browser-vectors"))]
#[wasm_bindgen_test]
fn the_browser_lane_carries_every_category() {
    let mut keys: Vec<(&str, &str)> = embedded::CASES.iter().map(|(n, v, _)| (*n, *v)).collect();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(
        keys.len(),
        embedded::CASES.len(),
        "duplicate (category, version) row in the embedded table"
    );

    for (name, version, body) in embedded::CASES {
        assert!(
            !body.trim().is_empty(),
            "[{name}/{version}] embedded fixture is empty — `include_str!` found a \
             file, but not one with vectors in it"
        );

        let doc: serde_json::Value = serde_json::from_str(body)
            .unwrap_or_else(|e| panic!("[{name}/{version}] embedded fixture is not JSON: {e}"));
        assert_eq!(
            doc["schema"].as_str(),
            Some(*name),
            "[{name}/{version}] the embedded row's key and its `include_str!` path \
             disagree: the bytes declare schema {:?}. The runner would assert against \
             another category's vectors.",
            doc["schema"].as_str()
        );
        assert_eq!(
            doc["protocol_version"].as_str(),
            Some(*version),
            "[{name}/{version}] the embedded row's key and its `include_str!` path \
             disagree: the bytes declare protocol_version {:?}. This is exactly the \
             shape that handed the v0.2 runners their v0.1 fixtures.",
            doc["protocol_version"].as_str()
        );

        // Every row must have a runner that asks for it. `THIS_FILE` is this
        // source compiled in beside the fixtures; the needles are BUILT at run
        // time rather than written as literals, so this loop cannot match
        // itself. A row nothing calls is dead weight that reads as coverage.
        //
        // Both spellings count, because both are legitimate: the per-version
        // wrappers are what runners normally use, and the general loader is what
        // a runner would reach for if a third version ever landed. Accepting
        // only the wrapper would fail a correct runner, and a guard that cries
        // wolf gets deleted.
        let wrapper = match *version {
            "v0.1" => concat_str(&["cases_json(\"", name, "\")"]),
            "v0.2" => concat_str(&["cases_json_v0_2(\"", name, "\")"]),
            other => panic!(
                "[{name}/{other}] unknown version in the embedded table — add a \
                 loader for it and a needle here in the same change"
            ),
        };
        let general = concat_str(&["cases_json_for(\"", name, "\", \"", version, "\")"]);
        assert!(
            THIS_FILE.contains(&wrapper) || THIS_FILE.contains(&general),
            "[{name}/{version}] the embedded table carries this row but no runner \
             in this file calls `{wrapper}` or `{general}` — either the runner was \
             renamed or removed and the row was left behind, or the row was added \
             ahead of its runner. A row nothing reads is not coverage."
        );
    }
}

/// This test file's own source, for the "is there a runner for this row?"
/// direction of [`the_browser_lane_carries_every_category`].
#[cfg(all(target_arch = "wasm32", feature = "browser-vectors"))]
const THIS_FILE: &str = include_str!("vectors.rs");

/// Build a needle by concatenation rather than `format!`.
///
/// Not a style preference: a `format!("cases_json(\"{name}\")")` would put the
/// literal `cases_json("` into THIS file's source, and this file's source is
/// what the search runs over — the guard would match itself and pass for every
/// row. Concatenation keeps the literal out of the haystack.
#[cfg(all(target_arch = "wasm32", feature = "browser-vectors"))]
fn concat_str(parts: &[&str]) -> String {
    parts.concat()
}

fn hex_decode(s: &str) -> Vec<u8> {
    assert!(
        s.bytes().all(|b| b.is_ascii_hexdigit()),
        "hex string must contain only ASCII hex digits, got {s:?}"
    );
    assert!(s.len().is_multiple_of(2), "hex string length must be even");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("ASCII-hex pre-validated"))
        .collect()
}

fn hex_decode_array<const N: usize>(s: &str) -> [u8; N] {
    let v = hex_decode(s);
    assert_eq!(
        v.len(),
        N,
        "hex string decodes to {} bytes, expected exactly {N}",
        v.len()
    );
    let mut arr = [0u8; N];
    arr.copy_from_slice(&v);
    arr
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Panics if any `vector_id` repeats in `cases` — duplicates would silently
/// pass byte-equality and break downstream tools that reference vector_ids
/// by string. Schema enforces the `vector_id` shape but not its uniqueness
/// across the array.
fn assert_unique_vector_ids(category: &str, cases: &[serde_json::Value]) {
    let mut seen = std::collections::HashSet::with_capacity(cases.len());
    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        assert!(
            seen.insert(id),
            "[{category}] duplicate vector_id '{id}' in cases array"
        );
    }
}

/// Parse a case's `input_kdf_params` object (`{ m_kib, t, p, argon2_version_hex }`)
/// into a `KdfParams`. Shared by the argon2id / bip39-recovery / aad-construction
/// runners, all of which bind the canonical Argon2id param block.
fn parse_kdf_params(case: &serde_json::Value, id: &str) -> protocol::KdfParams {
    let obj = case
        .get("input_kdf_params")
        .unwrap_or_else(|| panic!("[{id}] missing input_kdf_params"));
    let argon2_version_bytes = hex_decode(
        obj["argon2_version_hex"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.argon2_version_hex")),
    );
    protocol::KdfParams {
        m_kib: obj["m_kib"]
            .as_u64()
            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.m_kib")) as u32,
        t: obj["t"]
            .as_u64()
            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.t")) as u32,
        p: obj["p"]
            .as_u64()
            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.p")) as u8,
        argon2_version: argon2_version_bytes[0],
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn phrase_normalize_vectors() {
    let Some(raw) = cases_json("phrase_normalize") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[phrase_normalize] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "phrase_normalize");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "phrase_normalize must have at least one case"
    );
    assert_unique_vector_ids("phrase_normalize", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let input_hex = case["input_utf8_hex"]
            .as_str()
            .expect("input_utf8_hex must be a string");
        let expected_hex = case["expected_output_utf8_hex"]
            .as_str()
            .expect("expected_output_utf8_hex must be a string");

        let input_bytes = hex_decode(input_hex);
        let input_str = core::str::from_utf8(&input_bytes)
            .unwrap_or_else(|e| panic!("[{id}] input not valid UTF-8: {e}"));
        let expected_bytes = hex_decode(expected_hex);

        let actual = protocol::normalize_user_phrase(input_str);
        let actual_bytes = actual.as_bytes();

        assert_eq!(
            actual_bytes,
            expected_bytes.as_slice(),
            "[{id}] phrase_normalize output mismatch\n  input_hex:    {input_hex}\n  expected_hex: {expected_hex}\n  actual_hex:   {}",
            hex_encode(actual_bytes),
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_prefs_vectors() {
    use protocol::{
        aad_prefs_blob, aead_seal_ctx, decode_prefs_blob, derive_subkey, encode_prefs_blob_raw,
        PrefsBlobError, PrefsView, SubkeyRole, PREFS_BLOB_HEADER_LEN, PREFS_BLOB_MAGIC,
        PREFS_BLOB_PROTOCOL_VERSION, PREFS_BLOB_RESERVED,
    };

    /// Assemble a MYP1 blob over caller-supplied raw plaintext bytes —
    /// the byte layout `encode_prefs_blob_raw` produces, but without the
    /// typed `PrefsView` → canonical-JSON step, so the §9.5.2 tolerance
    /// case (sealed plaintext carrying an unknown future field) can be
    /// reconstructed from pub exports only (mirrors
    /// `build_catalog_blob_from_plaintext`).
    fn build_prefs_blob_from_plaintext(
        prefs_key: &[u8; 32],
        account_hash: &[u8; 16],
        plaintext: &[u8],
        nonce: &[u8; 24],
    ) -> Vec<u8> {
        let aad = aad_prefs_blob(account_hash);
        let sealed = aead_seal_ctx(prefs_key, nonce, plaintext, &aad).expect("seal plaintext");
        let mut blob = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + sealed.len());
        blob.extend_from_slice(&PREFS_BLOB_MAGIC);
        blob.push(PREFS_BLOB_PROTOCOL_VERSION);
        blob.push(PREFS_BLOB_RESERVED);
        blob.extend_from_slice(nonce);
        blob.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
        blob.extend_from_slice(&sealed);
        blob
    }

    let Some(raw) = cases_json("vault-prefs") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-prefs] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-prefs");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty(), "vault-prefs must have at least one case");
    assert_unique_vector_ids("vault-prefs", cases);

    let mut seen_kinds: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    let mut seen_parse_errors: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    let mut saw_labeled_encrypt = false;
    let mut saw_labeled_decrypt = false;
    let mut saw_tolerance = false;

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind);

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext_bytes = hex_decode(
                    case["input_plaintext_canonical_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing input_plaintext_canonical_utf8_hex")
                        }),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_prefs_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_prefs_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_prefs_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_prefs_blob_hex")),
                );

                let prefs: PrefsView = serde_json::from_slice(&plaintext_bytes)
                    .unwrap_or_else(|e| panic!("[{id}] plaintext not parseable as PrefsView: {e}"));

                let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);

                // Defensive cross-check: if the case carries the
                // optional `informational_prefs_key_hex` field, verify
                // it matches the helper's own derivation. The schema's
                // "verified implicitly via expected_prefs_blob_hex"
                // claim is true only when the field is correct; this
                // check catches typos in the informational field that
                // would otherwise mislead cross-implementation reviewers.
                if let Some(info_hex) = case
                    .get("informational_prefs_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        prefs_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_prefs_key_hex disagrees with derive_subkey(root_key, PrefsKey)",
                    );
                }

                let actual = encode_prefs_blob_raw(&prefs_key, &account_hash, &prefs, &nonce)
                    .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-prefs encrypt mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );

                if prefs.label.is_some() {
                    saw_labeled_encrypt = true;
                }
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_view_value = case
                    .get("expected_prefs_view")
                    .unwrap_or_else(|| panic!("[{id}] missing expected_prefs_view"));
                let expected_view: PrefsView = serde_json::from_value(expected_view_value.clone())
                    .unwrap_or_else(|e| {
                        panic!("[{id}] expected_prefs_view not parseable as PrefsView: {e}")
                    });

                let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
                let actual = decode_prefs_blob(&prefs_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    actual, expected_view,
                    "[{id}] vault-prefs decrypt_ok mismatch"
                );

                // Make `expected_plaintext_canonical_utf8_hex` load-bearing:
                // re-encode the decoded view under the blob's own nonce and
                // compare against a blob sealed over the pinned canonical
                // plaintext. Equal iff the canonical re-encode of the view
                // matches the pinned bytes. For the §9.5.2 tolerance case
                // the re-encoded blob then DIFFERS from input_blob_hex
                // (the sealed plaintext carried an unknown future field).
                let expected_pt = hex_decode(
                    case["expected_plaintext_canonical_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing expected_plaintext_canonical_utf8_hex")
                        }),
                );
                let nonce: [u8; 24] = blob[6..30].try_into().expect("blob header nonce");
                let reencoded = encode_prefs_blob_raw(&prefs_key, &account_hash, &actual, &nonce)
                    .unwrap_or_else(|e| panic!("[{id}] re-encode failed: {e:?}"));
                let from_pinned_pt = build_prefs_blob_from_plaintext(
                    &prefs_key,
                    &account_hash,
                    &expected_pt,
                    &nonce,
                );
                assert_eq!(
                    reencoded, from_pinned_pt,
                    "[{id}] canonical re-encode of the decoded view disagrees with expected_plaintext_canonical_utf8_hex",
                );

                if actual.label.is_some() {
                    saw_labeled_decrypt = true;
                }
                if reencoded != blob {
                    saw_tolerance = true;
                }
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
                let result = decode_prefs_blob(&prefs_key, &account_hash, &blob);

                match result {
                    Err(PrefsBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected PrefsBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4 + §9.5.5), got {other:?}"
                    ),
                    Ok(view) => {
                        panic!("[{id}] expected AEAD failure, decoder returned Ok({view:?})")
                    }
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "header_too_short" => PrefsBlobError::HeaderTooShort,
                    "magic_mismatch" => PrefsBlobError::MagicMismatch,
                    "protocol_version_mismatch" => PrefsBlobError::ProtocolVersionMismatch,
                    "reserved_byte_nonzero" => PrefsBlobError::ReservedByteNonZero,
                    "ciphertext_len_overflow" => PrefsBlobError::CiphertextLenOverflow,
                    "ciphertext_truncated" => PrefsBlobError::CiphertextTruncated,
                    "plaintext_parse_failed" => PrefsBlobError::PlaintextParseFailed,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with PrefsBlobError"
                    ),
                };

                // The REAL prefs_key is load-bearing: header bytes are not
                // AAD-bound, so an implementation that skips a structural
                // check decrypts the tampered blob successfully and returns
                // Ok — caught here. (The plaintext_parse_failed case also
                // needs the key to get past AEAD at all.)
                let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
                match decode_prefs_blob(&prefs_key, &account_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(view) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_prefs_blob returned Ok({view:?})"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    // Structural coverage pins (mirror the vault_search seen_kinds pattern):
    // all four case kinds present, the MYND-205 label exercised on both the
    // encode and decode paths, at least one §9.5.2 forward-compat tolerance
    // case (sealed plaintext ≠ canonical re-encode) in the set, and every
    // distinguishable PrefsBlobError decode reject pinned by a parse_fail
    // case (MYND-227 — a regeneration that drops one fails here).
    for required in ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"] {
        assert!(
            seen_kinds.contains(required),
            "vault-prefs vectors must cover case_kind '{required}'",
        );
    }
    for required in [
        "header_too_short",
        "magic_mismatch",
        "protocol_version_mismatch",
        "reserved_byte_nonzero",
        "ciphertext_len_overflow",
        "ciphertext_truncated",
        "plaintext_parse_failed",
    ] {
        assert!(
            seen_parse_errors.contains(required),
            "vault-prefs vectors must include a parse_fail case for '{required}'",
        );
    }
    assert!(
        saw_labeled_encrypt,
        "vault-prefs vectors must include an encrypt case with a set MYND-205 label",
    );
    assert!(
        saw_labeled_decrypt,
        "vault-prefs vectors must include a decrypt_ok case surfacing a set MYND-205 label",
    );
    assert!(
        saw_tolerance,
        "vault-prefs vectors must include a §9.5.2 unknown-field tolerance decrypt_ok case",
    );
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_meta_rewrite_vectors() {
    use protocol::{parse_vault_meta, rewrite_vault_meta_password_side};

    let Some(raw) = cases_json("vault_meta_rewrite") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault_meta_rewrite] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault_meta_rewrite");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "vault_meta_rewrite must have at least one case"
    );
    assert_unique_vector_ids("vault_meta_rewrite", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");

        let existing_bytes = hex_decode(
            case["input_existing_vault_meta_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_existing_vault_meta_hex")),
        );
        let root_key: [u8; 32] = hex_decode_array(
            case["input_root_key_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
        );
        let new_password_bytes = hex_decode(
            case["input_new_password_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_new_password_utf8_hex")),
        );
        let new_password = core::str::from_utf8(&new_password_bytes)
            .unwrap_or_else(|e| panic!("[{id}] new_password not valid UTF-8: {e}"));
        let fresh_salt: [u8; 16] = hex_decode_array(
            case["input_fresh_salt_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_fresh_salt_hex")),
        );
        let fresh_nonce: [u8; 24] = hex_decode_array(
            case["input_fresh_nonce_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_fresh_nonce_hex")),
        );
        let expected = hex_decode(
            case["expected_vault_meta_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_vault_meta_hex")),
        );

        let existing = parse_vault_meta(&existing_bytes)
            .unwrap_or_else(|e| panic!("[{id}] parse_vault_meta failed: {e:?}"));

        let actual = rewrite_vault_meta_password_side(
            &existing,
            &root_key,
            new_password,
            &fresh_salt,
            &fresh_nonce,
        )
        .unwrap_or_else(|e| panic!("[{id}] rewrite failed: {e:?}"));

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] vault_meta_rewrite byte mismatch\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&actual),
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn hkdf_sha256_vectors() {
    use protocol::{derive_subkey, SubkeyRole};

    let Some(raw) = cases_json("hkdf-sha256") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[hkdf-sha256] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "hkdf-sha256");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 10,
        "hkdf-sha256 must carry at least 10 vectors (per PRD); found {}",
        cases.len()
    );
    assert_unique_vector_ids("hkdf-sha256", cases);

    let mut seen_roles: Vec<SubkeyRole> = Vec::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");

        let root_key: [u8; 32] = hex_decode_array(
            case["input_root_key_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
        );
        let role_str = case["input_role"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_role"));
        let expected = hex_decode(
            case["expected_subkey_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_subkey_hex")),
        );

        let role = match role_str {
            "itemsKey-wrap" => SubkeyRole::ItemsKeyWrap,
            "prefs-key" => SubkeyRole::PrefsKey,
            "search-index-key" => SubkeyRole::SearchIndexKey,
            "attachments-catalog-key" => SubkeyRole::AttachmentsCatalogKey,
            "attachments-id-hmac" => SubkeyRole::AttachmentsIdHmac,
            "session-state-key" => SubkeyRole::SessionStateKey,
            "personal-dictionary-key" => SubkeyRole::PersonalDictKey,
            "vault-indices-key" => SubkeyRole::VaultIndicesKey,
            "attachment-text-key" => SubkeyRole::AttachmentTextKey,
            "ai-embeddings-key" => SubkeyRole::AiEmbeddingsKey,
            "catalog-sync-id" => SubkeyRole::CatalogSyncId,
            "prefs-sync-id" => SubkeyRole::PrefsSyncId,
            "custom-themes-key" => SubkeyRole::CustomThemesKey,
            "themes-sync-id" => SubkeyRole::ThemesSyncId,
            "vault-head-mac" => SubkeyRole::VaultHeadMac,
            "server-auth" => SubkeyRole::ServerAuth,
            "graph-layout-key" => SubkeyRole::GraphLayoutKey,
            other => panic!(
                "[{id}] unknown input_role '{other}' — schema enforces enum; if a new variant landed in SubkeyRole, update this match arm in lockstep"
            ),
        };
        if !seen_roles.contains(&role) {
            seen_roles.push(role);
        }

        // Defensive cross-check: if the case carries the optional
        // `informational_info_utf8_hex` field, verify it matches the
        // canonical `"myne.v0.1 " || role_str` assembly. The schema's
        // "verified implicitly via expected_subkey_hex" claim is true
        // only when this field is correct; the check catches typos in
        // the informational field that would mislead cross-implementation
        // reviewers verifying their info-parameter assembly.
        if let Some(info_hex) = case
            .get("informational_info_utf8_hex")
            .and_then(|v| v.as_str())
        {
            let info_bytes = hex_decode(info_hex);
            let mut expected_info = b"myne.v0.1 ".to_vec();
            expected_info.extend_from_slice(role_str.as_bytes());
            assert_eq!(
                info_bytes, expected_info,
                "[{id}] informational_info_utf8_hex disagrees with the canonical \"myne.v0.1 \" || role assembly",
            );
        }

        let actual = derive_subkey(&root_key, role);

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] hkdf-sha256 subkey mismatch (role={role_str})\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&*actual),
        );
    }

    // Structural coverage pin: every registered SubkeyRole must appear in the
    // vector set directly. This enumerates `SubkeyRole::ALL` rather than
    // restating the registry as a literal list — the earlier hand-maintained
    // list silently fell four roles behind the enum (vault-head-mac,
    // server-auth, custom-themes-key, themes-sync-id shipped without a single
    // cross-implementation vector while this assertion still read as
    // exhaustive). Adding a variant now fails to compile in subkey.rs until it
    // lands in ALL, and fails here until it has a companion-repo case.
    for required in SubkeyRole::ALL {
        assert!(
            seen_roles.contains(&required),
            "hkdf-sha256 vectors must cover every registered SubkeyRole; missing {required:?}",
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_meta_vectors() {
    use protocol::{
        parse_kdf_params, parse_vault_meta, serialize_vault_meta, KdfParams, ProtocolError,
        VaultMeta,
    };

    let Some(raw) = cases_json("vault-meta") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[vault-meta] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-meta");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty(), "vault-meta must have at least one case");
    assert_unique_vector_ids("vault-meta", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        match case_kind {
            "roundtrip" => {
                let account_number_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let kdf_params_obj = case
                    .get("input_kdf_params")
                    .unwrap_or_else(|| panic!("[{id}] missing input_kdf_params"));
                let m_kib = kdf_params_obj["m_kib"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing kdf_params.m_kib"))
                    as u32;
                let t = kdf_params_obj["t"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing kdf_params.t"))
                    as u32;
                let p = kdf_params_obj["p"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing kdf_params.p"))
                    as u8;
                let argon2_version_bytes = hex_decode(
                    kdf_params_obj["argon2_version_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing kdf_params.argon2_version_hex")),
                );
                assert_eq!(argon2_version_bytes.len(), 1);
                let kdf_params = KdfParams {
                    m_kib,
                    t,
                    p,
                    argon2_version: argon2_version_bytes[0],
                };
                let random_salt_password: [u8; 16] = hex_decode_array(
                    case["input_random_salt_password_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_random_salt_password_hex")),
                );
                let random_salt_recovery: [u8; 16] = hex_decode_array(
                    case["input_random_salt_recovery_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_random_salt_recovery_hex")),
                );
                let nonce_password_wrap: [u8; 24] = hex_decode_array(
                    case["input_nonce_password_wrap_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_password_wrap_hex")),
                );
                let enc_root_key_password: [u8; 64] = hex_decode_array(
                    case["input_enc_root_key_password_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing input_enc_root_key_password_hex")
                        }),
                );
                let nonce_recovery_wrap: [u8; 24] = hex_decode_array(
                    case["input_nonce_recovery_wrap_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_recovery_wrap_hex")),
                );
                let enc_root_key_recovery: [u8; 64] = hex_decode_array(
                    case["input_enc_root_key_recovery_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing input_enc_root_key_recovery_hex")
                        }),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );
                let items_key_nonce: [u8; 24] = hex_decode_array(
                    case["input_items_key_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_nonce_hex")),
                );
                let enc_items_key: [u8; 64] = hex_decode_array(
                    case["input_enc_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_enc_items_key_hex")),
                );
                let expected = hex_decode(
                    case["expected_vault_meta_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_vault_meta_hex")),
                );

                let meta = VaultMeta {
                    account_number_hash,
                    kdf_params,
                    random_salt_password,
                    random_salt_recovery,
                    nonce_password_wrap,
                    enc_root_key_password,
                    nonce_recovery_wrap,
                    enc_root_key_recovery,
                    items_key_id,
                    items_key_nonce,
                    enc_items_key,
                };

                let actual = serialize_vault_meta(&meta);
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-meta serialize mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );

                // Round-trip: parse the expected bytes back and re-serialize;
                // both must equal the original expected bytes.
                let reparsed = parse_vault_meta(&expected)
                    .unwrap_or_else(|e| panic!("[{id}] parse_vault_meta round-trip failed: {e:?}"));
                let reserialized = serialize_vault_meta(&reparsed);
                assert_eq!(
                    reserialized.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-meta parse → re-serialize round-trip diverges from expected"
                );

                // Defensive: also exercise the canonical KDF params helper
                // — drift between serialize/parse_kdf_params would surface
                // here without affecting the parent assertion.
                let params_bytes = &expected[22..33];
                let _ = parse_kdf_params(params_bytes.try_into().unwrap()).unwrap_or_else(|e| {
                    panic!("[{id}] parse_kdf_params on offset 22..33 failed: {e:?}")
                });
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let result = parse_vault_meta(&blob);
                match result {
                    Err(ProtocolError::InvalidVaultMeta) => {}
                    Err(other) => panic!(
                        "[{id}] expected ProtocolError::InvalidVaultMeta (non-distinguishing parse-fail per spec §6.4), got {other:?}"
                    ),
                    Ok(meta) => panic!(
                        "[{id}] expected parse-fail, parse_vault_meta returned Ok with account_hash={}",
                        hex_encode(&meta.account_number_hash)
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    // Coverage floor: 2 original tampers (magic / reserved) + the 4 MYND-227
    // additions (wrong-length / protocol-version / kdf-id / argon2-version).
    // A regeneration that silently drops parse_fail cases fails here.
    let parse_fail_count = cases
        .iter()
        .filter(|c| c["case_kind"] == "parse_fail")
        .count();
    assert!(
        parse_fail_count >= 6,
        "vault-meta vectors must keep at least 6 parse_fail cases, found {parse_fail_count}"
    );
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn account_number_vectors() {
    use protocol::{parse_account_number, ProtocolError};

    let Some(raw) = cases_json("account-number") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[account-number] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "account-number");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 10,
        "account-number must carry at least 10 vectors (per PRD); found {}",
        cases.len()
    );
    assert_unique_vector_ids("account-number", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        let input_bytes = hex_decode(
            case["input_candidate_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_candidate_utf8_hex")),
        );
        let input_str = core::str::from_utf8(&input_bytes)
            .unwrap_or_else(|e| panic!("[{id}] input_candidate not valid UTF-8: {e}"));

        match case_kind {
            "parse_ok" => {
                let expected_canonical = hex_decode(
                    case["expected_canonical_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_canonical_utf8_hex")),
                );
                let expected_display_bytes = hex_decode(
                    case["expected_display_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_display_utf8_hex")),
                );
                let expected_display_str = core::str::from_utf8(&expected_display_bytes)
                    .unwrap_or_else(|e| panic!("[{id}] expected_display not valid UTF-8: {e}"));
                let expected_hash: [u8; 16] = hex_decode_array(
                    case["expected_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_hash_hex")),
                );

                let actual = parse_account_number(input_str).unwrap_or_else(|e| {
                    panic!("[{id}] parse_account_number returned Err({e:?}); expected Ok")
                });

                assert_eq!(
                    actual.canonical.as_slice(),
                    expected_canonical.as_slice(),
                    "[{id}] account-number canonical mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected_canonical),
                    hex_encode(&actual.canonical),
                );
                assert_eq!(
                    actual.display, expected_display_str,
                    "[{id}] account-number display mismatch"
                );
                assert_eq!(
                    actual.hash.as_slice(),
                    expected_hash.as_slice(),
                    "[{id}] account-number hash mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected_hash),
                    hex_encode(&actual.hash),
                );
            }
            "parse_fail" => {
                let result = parse_account_number(input_str);
                match result {
                    Err(ProtocolError::AccountNumberInvalid) => {}
                    Err(other) => panic!(
                        "[{id}] expected ProtocolError::AccountNumberInvalid (non-distinguishing parse-fail per spec §5), got {other:?}"
                    ),
                    Ok(acct) => panic!(
                        "[{id}] expected parse-fail, parse_account_number returned Ok with canonical={}",
                        core::str::from_utf8(&acct.canonical).unwrap_or("<non-ASCII?>")
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn myn_blob_vectors() {
    use protocol::{decode_note, encode_new_note_blob_raw, encode_update_blob_raw, DecryptError};

    let Some(raw) = cases_json("myn-blob") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[myn-blob] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "myn-blob");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty(), "myn-blob must have at least one case");
    assert_unique_vector_ids("myn-blob", cases);

    let mut seen_kinds = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let items_key: [u8; 32] = hex_decode_array(
                    case["input_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );
                let note_uuid: [u8; 16] = hex_decode_array(
                    case["input_note_uuid_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                );
                let item_key: [u8; 32] = hex_decode_array(
                    case["input_item_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_item_key_hex")),
                );
                let item_key_nonce: [u8; 24] = hex_decode_array(
                    case["input_item_key_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_item_key_nonce_hex")),
                );
                let content_nonce: [u8; 24] = hex_decode_array(
                    case["input_content_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_content_nonce_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let expected = hex_decode(
                    case["expected_myn_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_myn_blob_hex")),
                );

                let actual = encode_new_note_blob_raw(
                    &items_key,
                    &items_key_id,
                    &note_uuid,
                    &item_key,
                    &item_key_nonce,
                    &content_nonce,
                    &plaintext,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode_new_note_blob_raw failed: {e:?}"));

                assert_eq!(
                    actual.len(),
                    expected.len(),
                    "[{id}] myn-blob length mismatch: expected {} bytes, got {} bytes",
                    expected.len(),
                    actual.len(),
                );
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] myn-blob encrypt mismatch ({} bytes)",
                    expected.len(),
                );
            }
            "encrypt_update" => {
                // §6.3 note-update path: decode the source blob, then
                // re-encode its content under a new content_nonce. The
                // 112-byte header_prefix MUST be spliced verbatim (§3.3).
                let source_blob = hex_decode(
                    case["input_source_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_source_blob_hex")),
                );
                let note_uuid: [u8; 16] = hex_decode_array(
                    case["input_note_uuid_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                );
                let items_key: [u8; 32] = hex_decode_array(
                    case["input_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );
                let new_content_nonce: [u8; 24] = hex_decode_array(
                    case["input_new_content_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_new_content_nonce_hex")),
                );
                let new_plaintext = hex_decode(
                    case["input_new_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_new_plaintext_hex")),
                );
                let expected = hex_decode(
                    case["expected_myn_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_myn_blob_hex")),
                );

                let handle = decode_note(&source_blob, &note_uuid, &items_key, &items_key_id)
                    .unwrap_or_else(|e| panic!("[{id}] decode_note (source) failed: {e:?}"));
                let actual = encode_update_blob_raw(&handle, &new_content_nonce, &new_plaintext)
                    .unwrap_or_else(|e| panic!("[{id}] encode_update_blob_raw failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] myn-blob update mismatch ({} bytes)",
                    expected.len(),
                );
                // §3.3 invariant: header_prefix (first 112 bytes) is spliced
                // verbatim from the source — enc_item_key never re-wraps.
                assert_eq!(
                    &actual[..protocol::blob::HEADER_PREFIX_LEN],
                    &source_blob[..protocol::blob::HEADER_PREFIX_LEN],
                    "[{id}] update must preserve header_prefix byte-for-byte",
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let note_uuid: [u8; 16] = hex_decode_array(
                    case["input_note_uuid_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                );
                let items_key: [u8; 32] = hex_decode_array(
                    case["input_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let decrypted = decode_note(&blob, &note_uuid, &items_key, &items_key_id)
                    .unwrap_or_else(|e| panic!("[{id}] decode_note failed: {e:?}"));

                assert_eq!(
                    decrypted.plaintext(),
                    expected_plaintext.as_slice(),
                    "[{id}] myn-blob decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
                assert_eq!(
                    decrypted.note_uuid(),
                    &note_uuid,
                    "[{id}] myn-blob decrypt note_uuid mismatch",
                );
                assert_eq!(
                    decrypted.items_key_id(),
                    &items_key_id,
                    "[{id}] myn-blob decrypt items_key_id mismatch",
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let note_uuid: [u8; 16] = hex_decode_array(
                    case["input_note_uuid_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                );
                let items_key: [u8; 32] = hex_decode_array(
                    case["input_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );

                let result = decode_note(&blob, &note_uuid, &items_key, &items_key_id);
                match result {
                    Err(DecryptError::CannotDecrypt) => {}
                    Ok(decrypted) => panic!(
                        "[{id}] expected aead_fail, decode_note returned Ok ({} byte plaintext)",
                        decrypted.plaintext().len()
                    ),
                }
            }
            "parse_fail" => {
                // Structural rejects (bad magic / version / reserved /
                // enc_item_key_len / ciphertext_len bounds / §10.1
                // strict-trailing). All collapse to the same
                // non-distinguishing CannotDecrypt as the AEAD failures —
                // the separate case_kind documents WHICH checks a port must
                // perform, not a distinguishable error surface. The REAL
                // items_key is load-bearing: header bytes are not AAD-bound,
                // so a port that skips a structural check decodes the
                // tampered blob successfully and returns Ok — caught here.
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let note_uuid: [u8; 16] = hex_decode_array(
                    case["input_note_uuid_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                );
                let items_key: [u8; 32] = hex_decode_array(
                    case["input_items_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );

                match decode_note(&blob, &note_uuid, &items_key, &items_key_id) {
                    Err(DecryptError::CannotDecrypt) => {}
                    Ok(decrypted) => panic!(
                        "[{id}] expected parse_fail, decode_note returned Ok ({} byte plaintext) — a structural check was skipped",
                        decrypted.plaintext().len()
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    for kind in [
        "encrypt",
        "encrypt_update",
        "decrypt_ok",
        "decrypt_aead_fail",
        "parse_fail",
    ] {
        assert!(
            seen_kinds.contains(kind),
            "myn-blob missing every case of case_kind '{kind}' — coverage regression"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn password_policy_vectors() {
    use protocol::{validate_min_length, ProtocolError};

    let Some(raw) = cases_json("password-policy") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[password-policy] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "password-policy");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "password-policy must have at least one case"
    );
    assert_unique_vector_ids("password-policy", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let expected_kind = case["expected_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing expected_kind"));
        let password_bytes = hex_decode(
            case["input_password_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_password_utf8_hex")),
        );
        let password = std::str::from_utf8(&password_bytes)
            .unwrap_or_else(|e| panic!("[{id}] input_password_utf8_hex is not valid UTF-8: {e}"));

        // Cross-check the pinned informational counts against the canonical
        // impl — guards the USV-not-bytes contract: a port computing
        // chars().count() must agree with the vector's recorded USV count,
        // and the byte length must agree with the hex byte count.
        let usv = password.chars().count() as u64;
        let byte_len = password_bytes.len() as u64;
        if let Some(expected_usv) = case["informational_usv_count"].as_u64() {
            assert_eq!(usv, expected_usv, "[{id}] informational_usv_count mismatch");
        }
        if let Some(expected_byte) = case["informational_byte_len"].as_u64() {
            assert_eq!(
                byte_len, expected_byte,
                "[{id}] informational_byte_len mismatch"
            );
        }

        let result = validate_min_length(password);
        match expected_kind {
            "accept" => assert!(
                result.is_ok(),
                "[{id}] expected accept, validate_min_length returned {result:?}"
            ),
            "reject_too_short" => assert_eq!(
                result,
                Err(ProtocolError::PasswordTooShort),
                "[{id}] expected reject_too_short"
            ),
            other => panic!("[{id}] unknown expected_kind '{other}' — schema enforces enum"),
        }
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn ctx_aead_vectors() {
    use protocol::{
        aad_ai_embeddings_blob, aad_graph_layout_blob, aad_note_content_encrypt,
        aad_note_item_key_wrap, aad_password_wrap, aad_personal_dictionary_blob, aad_prefs_blob,
        aad_quick_unlock_blob, aad_recovery_wrap, aad_search_index_blob, aad_vault_indices_blob,
        aad_vault_items_key_wrap, aad_workspace_blob, aead_open_ctx, aead_seal_ctx, KdfParams,
        ProtocolError,
    };

    let Some(raw) = cases_json("ctx-aead") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[ctx-aead] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "ctx-aead");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 10,
        "ctx-aead must carry at least 10 vectors (per PRD); found {}",
        cases.len()
    );
    assert_unique_vector_ids("ctx-aead", cases);

    // Track which pub aad_* builders have been pinned via
    // aad_canonical_bytes cases. After the loop, assert every builder
    // got at least one pin — the structural guarantee per PRD that the
    // 6 pub builders are all under the byte-level audit-substitute leg.
    let mut pinned_builders = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        match case_kind {
            "encrypt" => {
                let key: [u8; 32] = hex_decode_array(
                    case["input_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_key_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let aad = hex_decode(
                    case["input_aad_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_aad_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let expected = hex_decode(
                    case["expected_sealed_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_sealed_hex")),
                );

                let actual = aead_seal_ctx(&key, &nonce, &plaintext, &aad)
                    .unwrap_or_else(|e| panic!("[{id}] aead_seal_ctx failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] ctx-aead encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let key: [u8; 32] = hex_decode_array(
                    case["input_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_key_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let aad = hex_decode(
                    case["input_aad_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_aad_hex")),
                );
                let sealed = hex_decode(
                    case["input_sealed_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_sealed_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let recovered = aead_open_ctx(&key, &nonce, &sealed, &aad)
                    .unwrap_or_else(|e| panic!("[{id}] aead_open_ctx failed: {e:?}"));

                assert_eq!(
                    recovered.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] ctx-aead decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let key: [u8; 32] = hex_decode_array(
                    case["input_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_key_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let aad = hex_decode(
                    case["input_aad_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_aad_hex")),
                );
                let sealed = hex_decode(
                    case["input_sealed_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_sealed_hex")),
                );

                let result = aead_open_ctx(&key, &nonce, &sealed, &aad);
                match result {
                    Err(ProtocolError::AeadFailure) => {}
                    Err(other) => panic!(
                        "[{id}] expected ProtocolError::AeadFailure (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, aead_open_ctx returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "aad_canonical_bytes" => {
                let builder_name = case["input_builder_name"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_builder_name"));
                let expected = hex_decode(
                    case["expected_aad_bytes_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_aad_bytes_hex")),
                );

                let actual: Vec<u8> = match builder_name {
                    "aad_password_wrap" | "aad_recovery_wrap" => {
                        let kdf_params_obj = case
                            .get("input_kdf_params")
                            .unwrap_or_else(|| panic!("[{id}] missing input_kdf_params"));
                        let m_kib = kdf_params_obj["m_kib"]
                            .as_u64()
                            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.m_kib"))
                            as u32;
                        let t = kdf_params_obj["t"]
                            .as_u64()
                            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.t"))
                            as u32;
                        let p = kdf_params_obj["p"]
                            .as_u64()
                            .unwrap_or_else(|| panic!("[{id}] missing kdf_params.p"))
                            as u8;
                        let argon2_version_bytes = hex_decode(
                            kdf_params_obj["argon2_version_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing kdf_params.argon2_version_hex"),
                            ),
                        );
                        let kdf_params = KdfParams {
                            m_kib,
                            t,
                            p,
                            argon2_version: argon2_version_bytes[0],
                        };
                        if builder_name == "aad_password_wrap" {
                            aad_password_wrap(&kdf_params)
                        } else {
                            aad_recovery_wrap(&kdf_params)
                        }
                    }
                    "aad_vault_items_key_wrap" => {
                        let items_key_id: [u8; 16] = hex_decode_array(
                            case["input_items_key_id_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                        );
                        aad_vault_items_key_wrap(&items_key_id)
                    }
                    "aad_note_item_key_wrap" => {
                        let items_key_id: [u8; 16] = hex_decode_array(
                            case["input_items_key_id_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                        );
                        let note_uuid: [u8; 16] = hex_decode_array(
                            case["input_note_uuid_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                        );
                        aad_note_item_key_wrap(&items_key_id, &note_uuid)
                    }
                    "aad_note_content_encrypt" => {
                        let items_key_id: [u8; 16] = hex_decode_array(
                            case["input_items_key_id_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                        );
                        let note_uuid: [u8; 16] = hex_decode_array(
                            case["input_note_uuid_hex"]
                                .as_str()
                                .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
                        );
                        aad_note_content_encrypt(&items_key_id, &note_uuid)
                    }
                    "aad_prefs_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        aad_prefs_blob(&account_number_hash)
                    }
                    "aad_search_index_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        aad_search_index_blob(&account_number_hash)
                    }
                    "aad_workspace_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        aad_workspace_blob(&account_number_hash)
                    }
                    "aad_graph_layout_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        aad_graph_layout_blob(&account_number_hash)
                    }
                    "aad_vault_indices_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        aad_vault_indices_blob(&account_number_hash)
                    }
                    "aad_ai_embeddings_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        aad_ai_embeddings_blob(&account_number_hash)
                    }
                    "aad_personal_dictionary_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        aad_personal_dictionary_blob(&account_number_hash)
                    }
                    "aad_quick_unlock_blob" => {
                        let account_number_hash: [u8; 16] = hex_decode_array(
                            case["input_account_number_hash_hex"].as_str().unwrap_or_else(
                                || panic!("[{id}] missing input_account_number_hash_hex"),
                            ),
                        );
                        let provider_kind = case["input_provider_kind"]
                            .as_u64()
                            .unwrap_or_else(|| panic!("[{id}] missing input_provider_kind"))
                            as u8;
                        aad_quick_unlock_blob(&account_number_hash, provider_kind)
                    }
                    other => panic!(
                        "[{id}] unknown input_builder_name '{other}' — schema enforces enum; update this match arm in lockstep with the schema"
                    ),
                };

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] {builder_name} canonical AAD mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );

                pinned_builders.insert(builder_name.to_string());
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    // Structural guarantee: the builders listed below must each have at least
    // one aad_canonical_bytes pin in the cases array. Drift in either the
    // schema's input_builder_name enum or the cases.json coverage surfaces
    // here. This list is NARROWER than the full `pub aad_*` surface by design —
    // builders whose own blob family runs a full encode/decode pipeline against
    // real vectors (aad_attachment_text_blob, aad_custom_themes_blob) get their
    // bytes exercised there, and the two device-local, vault-agnostic builders
    // (aad_capture_blob / aad_share_import_blob) sit outside the vault-scoped
    // enumeration entirely. The exhaustive decomposition family is
    // aad-construction; this one pins the AEAD round-trip.
    let required: [&str; 13] = [
        "aad_password_wrap",
        "aad_recovery_wrap",
        "aad_vault_items_key_wrap",
        "aad_note_item_key_wrap",
        "aad_note_content_encrypt",
        "aad_prefs_blob",
        "aad_search_index_blob",
        "aad_workspace_blob",
        "aad_graph_layout_blob",
        "aad_vault_indices_blob",
        "aad_ai_embeddings_blob",
        "aad_personal_dictionary_blob",
        "aad_quick_unlock_blob",
    ];
    for builder in required {
        assert!(
            pinned_builders.contains(builder),
            "ctx-aead missing aad_canonical_bytes pin for {builder} — every pub aad_* builder must have at least one case"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn argon2id_wrap_vectors() {
    use protocol::{derive_password_wrap_key, derive_recovery_wrap_key_from_normalized};

    let Some(raw) = cases_json("argon2id") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[argon2id] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "argon2id");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 7,
        "argon2id must carry at least 7 vectors (3 password + 3 recovery + 1 quickunlock-pin); found {}",
        cases.len()
    );
    assert_unique_vector_ids("argon2id", cases);

    let mut seen_paths = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let path = case["input_path"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_path"));
        seen_paths.insert(path.to_string());

        let password_bytes = hex_decode(
            case["input_password_or_phrase_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_password_or_phrase_utf8_hex")),
        );
        let password_str = core::str::from_utf8(&password_bytes)
            .unwrap_or_else(|e| panic!("[{id}] password/phrase not valid UTF-8: {e}"));
        let salt_random: [u8; 16] = hex_decode_array(
            case["input_salt_random_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_salt_random_hex")),
        );
        let account_number_hash: [u8; 16] = hex_decode_array(
            case["input_account_number_hash_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
        );

        let kdf_params = parse_kdf_params(case, id);
        let expected: [u8; 32] = hex_decode_array(
            case["expected_wrap_key_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_wrap_key_hex")),
        );

        let actual = match path {
            "password" => derive_password_wrap_key(
                password_str,
                &salt_random,
                &account_number_hash,
                &kdf_params,
            )
            .unwrap_or_else(|e| panic!("[{id}] derive_password_wrap_key failed: {e:?}")),
            "recovery" => derive_recovery_wrap_key_from_normalized(
                password_str,
                &salt_random,
                &account_number_hash,
                &kdf_params,
            )
            .unwrap_or_else(|e| {
                panic!("[{id}] derive_recovery_wrap_key_from_normalized failed: {e:?}")
            }),
            // NB: derive_quick_unlock_pin_wrap_key is NOT re-exported at the
            // crate root — reach it via the full module path. For this path the
            // shared input_salt_random_hex field carries the 16-byte pin_salt.
            "quickunlock-pin" => protocol::kdf::derive_quick_unlock_pin_wrap_key(
                password_str,
                &salt_random,
                &account_number_hash,
                &kdf_params,
            )
            .unwrap_or_else(|e| panic!("[{id}] derive_quick_unlock_pin_wrap_key failed: {e:?}")),
            other => panic!("[{id}] unknown input_path '{other}' — schema enforces enum"),
        };

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] argon2id wrap-key mismatch (path={path})\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&*actual),
        );
    }

    // Coverage pin: every Argon2id derivation path must appear in the vector
    // set — a new path (e.g. quickunlock-pin, MYND-329) added without a
    // companion case fails here rather than going silently unvectored.
    for required in ["password", "recovery", "quickunlock-pin"] {
        assert!(
            seen_paths.contains(required),
            "argon2id vectors must cover the '{required}' derivation path"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn bip39_recovery_vectors() {
    use protocol::{derive_recovery_wrap_key_from_normalized, normalize_user_phrase};

    let Some(raw) = cases_json("bip39-recovery") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[bip39-recovery] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "bip39-recovery");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "bip39-recovery must have at least one case"
    );
    assert_unique_vector_ids("bip39-recovery", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");

        let raw_phrase_bytes = hex_decode(
            case["input_raw_phrase_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_raw_phrase_utf8_hex")),
        );
        let raw_phrase = core::str::from_utf8(&raw_phrase_bytes)
            .unwrap_or_else(|e| panic!("[{id}] raw phrase not valid UTF-8: {e}"));
        let salt_random: [u8; 16] = hex_decode_array(
            case["input_salt_random_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_salt_random_hex")),
        );
        let account_number_hash: [u8; 16] = hex_decode_array(
            case["input_account_number_hash_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
        );

        let kdf_params = parse_kdf_params(case, id);
        let expected: [u8; 32] = hex_decode_array(
            case["expected_recovery_wrap_key_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_recovery_wrap_key_hex")),
        );

        // §7.4 normalization, then §3.1 derivation — the composition.
        let normalized = normalize_user_phrase(raw_phrase);

        // Cross-check the pinned normalized form (catches a normalize bug
        // before it silently changes the derived key).
        if let Some(expected_norm_hex) = case["informational_normalized_phrase_utf8_hex"].as_str() {
            let expected_norm = hex_decode(expected_norm_hex);
            assert_eq!(
                normalized.as_bytes(),
                expected_norm.as_slice(),
                "[{id}] normalized phrase mismatch — normalize_user_phrase drift",
            );
        }

        let actual = derive_recovery_wrap_key_from_normalized(
            normalized.as_str(),
            &salt_random,
            &account_number_hash,
            &kdf_params,
        )
        .unwrap_or_else(|e| {
            panic!("[{id}] derive_recovery_wrap_key_from_normalized failed: {e:?}")
        });

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] bip39-recovery wrap-key mismatch\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&*actual),
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn aad_construction_vectors() {
    use protocol::{
        aad_ai_embeddings_blob, aad_attachment_text_blob, aad_custom_themes_blob,
        aad_graph_layout_blob, aad_note_content_encrypt, aad_note_item_key_wrap, aad_password_wrap,
        aad_personal_dictionary_blob, aad_prefs_blob, aad_quick_unlock_blob, aad_recovery_wrap,
        aad_search_index_blob, aad_vault_indices_blob, aad_vault_items_key_wrap,
        aad_workspace_blob,
    };

    let Some(raw) = cases_json("aad-construction") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[aad-construction] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "aad-construction");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "aad-construction must have at least one case"
    );
    assert_unique_vector_ids("aad-construction", cases);

    let mut pinned_builders = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let builder_name = case["input_builder_name"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_builder_name"));
        let expected = hex_decode(
            case["expected_aad_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_aad_hex")),
        );

        // Re-derive the AAD via the named builder with the case's inputs.
        let items_key_id = || -> [u8; 16] {
            hex_decode_array(
                case["input_items_key_id_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
            )
        };
        let note_uuid = || -> [u8; 16] {
            hex_decode_array(
                case["input_note_uuid_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_note_uuid_hex")),
            )
        };
        let account_number_hash = || -> [u8; 16] {
            hex_decode_array(
                case["input_account_number_hash_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
            )
        };
        let kdf_params = || parse_kdf_params(case, id);
        let provider_kind = || -> u8 {
            case["input_provider_kind"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] missing input_provider_kind")) as u8
        };
        let attachment_id = || -> [u8; 32] {
            hex_decode_array(
                case["input_attachment_id_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_attachment_id_hex")),
            )
        };
        let extractor_version = || -> u8 {
            case["input_extractor_version"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] missing input_extractor_version"))
                as u8
        };

        let actual = match builder_name {
            "aad_password_wrap" => aad_password_wrap(&kdf_params()),
            "aad_recovery_wrap" => aad_recovery_wrap(&kdf_params()),
            "aad_vault_items_key_wrap" => aad_vault_items_key_wrap(&items_key_id()),
            "aad_note_item_key_wrap" => aad_note_item_key_wrap(&items_key_id(), &note_uuid()),
            "aad_prefs_blob" => aad_prefs_blob(&account_number_hash()),
            "aad_search_index_blob" => aad_search_index_blob(&account_number_hash()),
            "aad_workspace_blob" => aad_workspace_blob(&account_number_hash()),
            "aad_graph_layout_blob" => aad_graph_layout_blob(&account_number_hash()),
            "aad_vault_indices_blob" => aad_vault_indices_blob(&account_number_hash()),
            "aad_ai_embeddings_blob" => aad_ai_embeddings_blob(&account_number_hash()),
            "aad_personal_dictionary_blob" => {
                aad_personal_dictionary_blob(&account_number_hash())
            }
            "aad_quick_unlock_blob" => {
                aad_quick_unlock_blob(&account_number_hash(), provider_kind())
            }
            "aad_note_content_encrypt" => aad_note_content_encrypt(&items_key_id(), &note_uuid()),
            "aad_attachment_text_blob" => {
                aad_attachment_text_blob(&account_number_hash(), &attachment_id(), extractor_version())
            }
            "aad_custom_themes_blob" => aad_custom_themes_blob(&account_number_hash()),
            other => panic!(
                "[{id}] unknown input_builder_name '{other}' — schema enforces enum; update this match arm in lockstep with the schema"
            ),
        };

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] {builder_name} AAD byte mismatch\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&actual),
        );

        // Validate the per-call-site segment decomposition: segments must
        // be contiguous from offset 0, each length must match its bytes,
        // and the concatenation must reproduce the full AAD byte-for-byte.
        let segments = case["informational_aad_segments"]
            .as_array()
            .unwrap_or_else(|| panic!("[{id}] missing informational_aad_segments"));
        let mut reassembled: Vec<u8> = Vec::with_capacity(expected.len());
        let mut next_offset = 0u64;
        for (i, seg) in segments.iter().enumerate() {
            let offset = seg["offset"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] segment {i} missing offset"));
            let length = seg["length"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] segment {i} missing length"));
            let bytes = hex_decode(
                seg["bytes_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] segment {i} missing bytes_hex")),
            );
            assert_eq!(offset, next_offset, "[{id}] segment {i} not contiguous");
            assert_eq!(
                length as usize,
                bytes.len(),
                "[{id}] segment {i} length != bytes_hex byte count"
            );
            reassembled.extend_from_slice(&bytes);
            next_offset += length;
        }
        assert_eq!(
            reassembled.as_slice(),
            expected.as_slice(),
            "[{id}] segment concatenation must reproduce the full AAD",
        );

        pinned_builders.insert(builder_name.to_string());
    }

    // Structural guarantee: every VAULT-SCOPED pub aad_* builder must have a
    // decomposition case — drift in either the schema enum or the cases.json
    // surfaces here. `aad_capture_blob` / `aad_share_import_blob` are absent by
    // design, not by omission: they are device-local and vault-agnostic (they
    // bind a per-entry capture_id / share_id under an OS-keychain wrap_key
    // instead of account_number_hash under a root_key-derived KEK), so they sit
    // outside this family's enumeration. Their canonical bytes are pinned by
    // the aad_*_default_matches_pinned_hex unit tests in aead.rs plus the
    // pending-capture / share-import encrypt cases.
    let required: [&str; 15] = [
        "aad_password_wrap",
        "aad_recovery_wrap",
        "aad_vault_items_key_wrap",
        "aad_note_item_key_wrap",
        "aad_prefs_blob",
        "aad_search_index_blob",
        "aad_workspace_blob",
        "aad_graph_layout_blob",
        "aad_vault_indices_blob",
        "aad_ai_embeddings_blob",
        "aad_personal_dictionary_blob",
        "aad_quick_unlock_blob",
        "aad_note_content_encrypt",
        "aad_attachment_text_blob",
        "aad_custom_themes_blob",
    ];
    for builder in required {
        assert!(
            pinned_builders.contains(builder),
            "aad-construction missing decomposition case for {builder} — every vault-scoped pub aad_* builder must have one"
        );
    }
}

/// `aad-construction` v0.2 — the next-major AAD builders.
///
/// These four stamp `"myne.v0.2|"` and the `0x02` version byte, both listed in
/// the repo-root identifier table as major-version-event constants, and all four
/// are on the §10.4.1 whole-vault migration's re-seal path (`singleton_migrate`,
/// `vault_meta_v0_2`, `blob_envelope`, `prefs`, `attachments_catalog`). They
/// shipped with no cross-implementation vector of any kind: a port that framed
/// them wrong would migrate a vault into bytes no other implementation opens,
/// and nothing here would have said so.
///
/// The two `aad_nc05_*` builders complete the v0.2 family and are pinned by
/// `crdt_note_blob_vectors` instead — one home per builder, so there is no
/// second place to forget.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn aad_construction_v0_2_vectors() {
    use protocol::{
        aad_password_wrap_v0_2, aad_recovery_wrap_v0_2, aad_singleton_blob_v0_2,
        aad_vault_items_key_wrap_v0_2,
    };

    let Some(raw) = cases_json_v0_2("aad-construction") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[aad-construction/v0.2] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "aad-construction");
    assert_eq!(doc["protocol_version"], "v0.2");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("aad-construction/v0.2", cases);

    let mut pinned_builders = std::collections::HashSet::new();
    let mut singleton_roles = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let builder_name = case["input_builder_name"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_builder_name"));
        let expected = hex_decode(
            case["expected_aad_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_aad_hex")),
        );

        let items_key_id = || -> [u8; 16] {
            hex_decode_array(
                case["input_items_key_id_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
            )
        };
        let account_number_hash = || -> [u8; 16] {
            hex_decode_array(
                case["input_account_number_hash_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
            )
        };
        let role_label = || -> String {
            case["input_role_label"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_role_label"))
                .to_string()
        };

        let actual = match builder_name {
            "aad_password_wrap_v0_2" => aad_password_wrap_v0_2(&parse_kdf_params(case, id)),
            "aad_recovery_wrap_v0_2" => aad_recovery_wrap_v0_2(&parse_kdf_params(case, id)),
            "aad_vault_items_key_wrap_v0_2" => aad_vault_items_key_wrap_v0_2(&items_key_id()),
            "aad_singleton_blob_v0_2" => {
                let role = role_label();
                singleton_roles.insert(role.clone());
                aad_singleton_blob_v0_2(role.as_bytes(), &account_number_hash())
            }
            other => panic!(
                "[{id}] unknown input_builder_name '{other}' — update this match arm in lockstep with the schema"
            ),
        };

        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] {builder_name} AAD byte mismatch\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&actual),
        );

        // The v0.2 prefix + version byte are the domain separation. Asserting
        // them here rather than trusting the pinned bytes means a regenerated
        // fixture that lost the prefix fails as a prefix bug, by name, instead
        // of as an opaque byte mismatch.
        assert!(
            actual.starts_with(b"myne.v0.2|"),
            "[{id}] v0.2 AAD must open with the v0.2 prefix"
        );
        assert_eq!(
            actual[10], 0x02,
            "[{id}] v0.2 AAD must carry protocol_version 0x02"
        );

        let segments = case["informational_aad_segments"]
            .as_array()
            .unwrap_or_else(|| panic!("[{id}] missing informational_aad_segments"));
        let mut reassembled: Vec<u8> = Vec::with_capacity(expected.len());
        let mut next_offset = 0u64;
        for (i, seg) in segments.iter().enumerate() {
            let offset = seg["offset"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] segment {i} missing offset"));
            let length = seg["length"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] segment {i} missing length"));
            let bytes = hex_decode(
                seg["bytes_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] segment {i} missing bytes_hex")),
            );
            assert_eq!(offset, next_offset, "[{id}] segment {i} not contiguous");
            assert_eq!(
                length as usize,
                bytes.len(),
                "[{id}] segment {i} length != bytes_hex byte count"
            );
            reassembled.extend_from_slice(&bytes);
            next_offset += length;
        }
        assert_eq!(
            reassembled.as_slice(),
            expected.as_slice(),
            "[{id}] segment concatenation must reproduce the full AAD",
        );

        pinned_builders.insert(builder_name.to_string());
    }

    let required: [&str; 4] = [
        "aad_password_wrap_v0_2",
        "aad_recovery_wrap_v0_2",
        "aad_vault_items_key_wrap_v0_2",
        "aad_singleton_blob_v0_2",
    ];
    for builder in required {
        assert!(
            pinned_builders.contains(builder),
            "aad-construction/v0.2 missing decomposition case for {builder} — every v0.2 vault-scoped pub aad_* builder must have one"
        );
    }

    // The generic singleton builder takes its role as an argument, so one case
    // proves only that one role works. Two roles of DIFFERENT lengths prove the
    // u16 length prefix is computed rather than copied — the failure a port with
    // a hardcoded role length would otherwise sail past.
    assert!(
        singleton_roles.len() >= 2,
        "aad_singleton_blob_v0_2 needs at least two roles pinned; got {singleton_roles:?}"
    );
    let mut lengths: Vec<usize> = singleton_roles.iter().map(|r| r.len()).collect();
    lengths.sort_unstable();
    lengths.dedup();
    assert!(
        lengths.len() >= 2,
        "the pinned aad_singleton_blob_v0_2 roles must differ in LENGTH, not just in value — \
         same-length roles cannot catch a hardcoded length prefix (got lengths {lengths:?})"
    );
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_search_vectors() {
    use protocol::{
        decode_search_index_blob, derive_subkey, encode_search_index_blob_raw, SearchBlobError,
        SubkeyRole,
    };

    let Some(raw) = cases_json("vault-search") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-search] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-search");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 12,
        "vault-search must carry at least 12 vectors (3 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-search", cases);

    // Coverage guards (mirrors ctx-aead's required-builders array): assert
    // the category actually pins every case_kind and every structural
    // reject, so a future regeneration that silently drops — e.g. all 6
    // parse_fail cases — fails loudly instead of passing on the survivors.
    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_search_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_search_blob_hex")),
                );

                let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);

                // Defensive cross-check: if the case carries the optional
                // `informational_search_index_key_hex` field, verify it
                // matches the helper's own derivation. The HKDF role string
                // "search-index-key" is DISTINCT from the AAD role string
                // "search-index-blob"; this catches a typo in the
                // informational field that would mislead porters.
                if let Some(info_hex) = case
                    .get("informational_search_index_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        search_index_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_search_index_key_hex disagrees with derive_subkey(root_key, SearchIndexKey)",
                    );
                }

                let actual = encode_search_index_blob_raw(
                    &search_index_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-search encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);
                let decoded = decode_search_index_blob(&search_index_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] vault-search decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);
                match decode_search_index_blob(&search_index_key, &account_hash, &blob) {
                    Err(SearchBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected SearchBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_search_index_blob returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => SearchBlobError::MagicMismatch,
                    "protocol_version_mismatch" => SearchBlobError::ProtocolVersionMismatch,
                    "index_format_unsupported" => SearchBlobError::IndexFormatUnsupported,
                    "header_too_short" => SearchBlobError::HeaderTooShort,
                    "ciphertext_truncated" => SearchBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => SearchBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with SearchBlobError"
                    ),
                };

                // Structural rejects run BEFORE decryption, so the key /
                // account hash are irrelevant — pass throwaway zeros.
                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_search_index_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_search_index_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "vault-search missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "index_format_unsupported",
        "header_too_short",
        "ciphertext_truncated",
        "ciphertext_len_overflow",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "vault-search missing parse_fail coverage for SearchBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_workspace_vectors() {
    use protocol::{
        decode_workspace_blob, derive_subkey, encode_workspace_blob_raw, SubkeyRole,
        WorkspaceBlobError,
    };

    let Some(raw) = cases_json("vault-workspace") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-workspace] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-workspace");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 12,
        "vault-workspace must carry at least 12 vectors (3 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-workspace", cases);

    // Coverage guards (vault-search parity): assert the category pins every
    // case_kind and every structural reject, so a regeneration that silently
    // drops cases fails loudly instead of passing on the survivors.
    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_workspace_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_workspace_blob_hex")),
                );

                let session_state_key = derive_subkey(&root_key, SubkeyRole::SessionStateKey);

                // Defensive cross-check: if the case carries the optional
                // `informational_session_state_key_hex` field, verify it
                // matches the helper's own derivation. The HKDF role string
                // "session-state-key" is DISTINCT from the AAD role string
                // "workspace-blob"; this catches a typo in the informational
                // field that would mislead porters.
                if let Some(info_hex) = case
                    .get("informational_session_state_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        session_state_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_session_state_key_hex disagrees with derive_subkey(root_key, SessionStateKey)",
                    );
                }

                let actual = encode_workspace_blob_raw(
                    &session_state_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-workspace encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let session_state_key = derive_subkey(&root_key, SubkeyRole::SessionStateKey);
                let decoded = decode_workspace_blob(&session_state_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] vault-workspace decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let session_state_key = derive_subkey(&root_key, SubkeyRole::SessionStateKey);
                match decode_workspace_blob(&session_state_key, &account_hash, &blob) {
                    Err(WorkspaceBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected WorkspaceBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_workspace_blob returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => WorkspaceBlobError::MagicMismatch,
                    "protocol_version_mismatch" => WorkspaceBlobError::ProtocolVersionMismatch,
                    "format_unsupported" => WorkspaceBlobError::FormatUnsupported,
                    "header_too_short" => WorkspaceBlobError::HeaderTooShort,
                    "ciphertext_truncated" => WorkspaceBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => WorkspaceBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with WorkspaceBlobError"
                    ),
                };

                // Structural rejects run BEFORE decryption, so the key /
                // account hash are irrelevant — pass throwaway zeros.
                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_workspace_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_workspace_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "vault-workspace missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "format_unsupported",
        "header_too_short",
        "ciphertext_truncated",
        "ciphertext_len_overflow",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "vault-workspace missing parse_fail coverage for WorkspaceBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn graph_layout_vectors() {
    use protocol::{
        decode_graph_layout_blob, derive_subkey, encode_graph_layout_blob_raw,
        GraphLayoutBlobError, SubkeyRole,
    };

    let Some(raw) = cases_json("graph-layout") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[graph-layout] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "graph-layout");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 12,
        "graph-layout must carry at least 12 vectors (3 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("graph-layout", cases);

    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_graph_layout_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_graph_layout_blob_hex")),
                );

                let graph_layout_key = derive_subkey(&root_key, SubkeyRole::GraphLayoutKey);

                // Defensive cross-check on the optional informational KEK hex.
                // The HKDF role string "graph-layout-key" is DISTINCT from the
                // AAD role string "graph-layout-blob".
                if let Some(info_hex) = case
                    .get("informational_graph_layout_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        graph_layout_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_graph_layout_key_hex disagrees with derive_subkey(root_key, GraphLayoutKey)",
                    );
                }

                let actual = encode_graph_layout_blob_raw(
                    &graph_layout_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] graph-layout encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let graph_layout_key = derive_subkey(&root_key, SubkeyRole::GraphLayoutKey);
                let decoded = decode_graph_layout_blob(&graph_layout_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] graph-layout decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let graph_layout_key = derive_subkey(&root_key, SubkeyRole::GraphLayoutKey);
                match decode_graph_layout_blob(&graph_layout_key, &account_hash, &blob) {
                    Err(GraphLayoutBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected GraphLayoutBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_graph_layout_blob returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => GraphLayoutBlobError::MagicMismatch,
                    "protocol_version_mismatch" => GraphLayoutBlobError::ProtocolVersionMismatch,
                    "format_unsupported" => GraphLayoutBlobError::FormatUnsupported,
                    "header_too_short" => GraphLayoutBlobError::HeaderTooShort,
                    "ciphertext_truncated" => GraphLayoutBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => GraphLayoutBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with GraphLayoutBlobError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_graph_layout_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_graph_layout_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "graph-layout missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "format_unsupported",
        "header_too_short",
        "ciphertext_truncated",
        "ciphertext_len_overflow",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "graph-layout missing parse_fail coverage for GraphLayoutBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_indices_vectors() {
    use protocol::{
        decode_vault_indices_blob, derive_subkey, encode_vault_indices_blob_raw, SubkeyRole,
        VaultIndicesBlobError,
    };

    let Some(raw) = cases_json("vault-indices") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-indices] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-indices");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 12,
        "vault-indices must carry at least 12 vectors (3 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-indices", cases);

    // Coverage guards (vault-search / vault-workspace parity).
    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_vault_indices_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing expected_vault_indices_blob_hex")
                        }),
                );

                let vault_indices_key = derive_subkey(&root_key, SubkeyRole::VaultIndicesKey);

                // Defensive cross-check: the optional
                // `informational_vault_indices_key_hex` must match the helper's
                // own derivation. The HKDF role "vault-indices-key" is DISTINCT
                // from the AAD role "vault-indices-blob".
                if let Some(info_hex) = case
                    .get("informational_vault_indices_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        vault_indices_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_vault_indices_key_hex disagrees with derive_subkey(root_key, VaultIndicesKey)",
                    );
                }

                let actual = encode_vault_indices_blob_raw(
                    &vault_indices_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-indices encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let vault_indices_key = derive_subkey(&root_key, SubkeyRole::VaultIndicesKey);
                let decoded = decode_vault_indices_blob(&vault_indices_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] vault-indices decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let vault_indices_key = derive_subkey(&root_key, SubkeyRole::VaultIndicesKey);
                match decode_vault_indices_blob(&vault_indices_key, &account_hash, &blob) {
                    Err(VaultIndicesBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected VaultIndicesBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_vault_indices_blob returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => VaultIndicesBlobError::MagicMismatch,
                    "protocol_version_mismatch" => VaultIndicesBlobError::ProtocolVersionMismatch,
                    "format_unsupported" => VaultIndicesBlobError::FormatUnsupported,
                    "header_too_short" => VaultIndicesBlobError::HeaderTooShort,
                    "ciphertext_truncated" => VaultIndicesBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => VaultIndicesBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with VaultIndicesBlobError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_vault_indices_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_vault_indices_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "vault-indices missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "format_unsupported",
        "header_too_short",
        "ciphertext_truncated",
        "ciphertext_len_overflow",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "vault-indices missing parse_fail coverage for VaultIndicesBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_dictionary_vectors() {
    use protocol::{
        decode_dictionary_blob, derive_subkey, encode_dictionary_blob_raw, DictionaryBlobError,
        SubkeyRole,
    };

    let Some(raw) = cases_json("vault-dictionary") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-dictionary] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-dictionary");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 12,
        "vault-dictionary must carry at least 12 vectors (3 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-dictionary", cases);

    // Coverage guards (vault-search / vault-workspace / vault-indices parity).
    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_vault_dictionary_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing expected_vault_dictionary_blob_hex")
                        }),
                );

                let personal_dictionary_key = derive_subkey(&root_key, SubkeyRole::PersonalDictKey);

                // Defensive cross-check: the optional
                // `informational_personal_dictionary_key_hex` must match the
                // helper's own derivation. The HKDF role "personal-dictionary-key"
                // is DISTINCT from the AAD role "personal-dictionary-blob".
                if let Some(info_hex) = case
                    .get("informational_personal_dictionary_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        personal_dictionary_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_personal_dictionary_key_hex disagrees with derive_subkey(root_key, PersonalDictKey)",
                    );
                }

                let actual = encode_dictionary_blob_raw(
                    &personal_dictionary_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-dictionary encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let personal_dictionary_key = derive_subkey(&root_key, SubkeyRole::PersonalDictKey);
                let decoded =
                    decode_dictionary_blob(&personal_dictionary_key, &account_hash, &blob)
                        .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] vault-dictionary decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let personal_dictionary_key = derive_subkey(&root_key, SubkeyRole::PersonalDictKey);
                match decode_dictionary_blob(&personal_dictionary_key, &account_hash, &blob) {
                    Err(DictionaryBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected DictionaryBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_dictionary_blob returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => DictionaryBlobError::MagicMismatch,
                    "protocol_version_mismatch" => DictionaryBlobError::ProtocolVersionMismatch,
                    // NB: the dictionary codec names this variant DictFormatUnsupported
                    // (not FormatUnsupported); the vector string stays cross-family
                    // consistent as "format_unsupported".
                    "format_unsupported" => DictionaryBlobError::DictFormatUnsupported,
                    "header_too_short" => DictionaryBlobError::HeaderTooShort,
                    "ciphertext_truncated" => DictionaryBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => DictionaryBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with DictionaryBlobError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_dictionary_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_dictionary_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "vault-dictionary missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "format_unsupported",
        "header_too_short",
        "ciphertext_truncated",
        "ciphertext_len_overflow",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "vault-dictionary missing parse_fail coverage for DictionaryBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn attachment_text_vectors() {
    use protocol::{
        decode_attachment_text_blob, derive_subkey, encode_attachment_text_blob_raw,
        AttachmentTextBlobError, SubkeyRole,
    };

    let Some(raw) = cases_json("attachment-text") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[attachment-text] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "attachment-text");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 12,
        "attachment-text must carry at least 12 vectors (3 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("attachment-text", cases);

    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let attachment_id: [u8; 32] = hex_decode_array(
                    case["input_attachment_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_attachment_id_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_attachment_text_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing expected_attachment_text_blob_hex")
                        }),
                );

                let key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);

                // The HKDF role "attachment-text-key" is DISTINCT from the AAD
                // role "attachment-text-blob".
                if let Some(info_hex) = case
                    .get("informational_attachment_text_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_attachment_text_key_hex disagrees with derive_subkey(root_key, AttachmentTextKey)",
                    );
                }

                let actual = encode_attachment_text_blob_raw(
                    &key,
                    &account_hash,
                    &attachment_id,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] attachment-text encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let attachment_id: [u8; 32] = hex_decode_array(
                    case["input_attachment_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_attachment_id_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);
                let decoded =
                    decode_attachment_text_blob(&key, &account_hash, &attachment_id, &blob)
                        .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] attachment-text decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let attachment_id: [u8; 32] = hex_decode_array(
                    case["input_attachment_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_attachment_id_hex")),
                );

                let key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);
                match decode_attachment_text_blob(&key, &account_hash, &attachment_id, &blob) {
                    Err(AttachmentTextBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected AttachmentTextBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_attachment_text_blob returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => AttachmentTextBlobError::MagicMismatch,
                    "protocol_version_mismatch" => {
                        AttachmentTextBlobError::ProtocolVersionMismatch
                    }
                    "extractor_version_unsupported" => {
                        AttachmentTextBlobError::ExtractorVersionUnsupported
                    }
                    "header_too_short" => AttachmentTextBlobError::HeaderTooShort,
                    "ciphertext_truncated" => AttachmentTextBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => AttachmentTextBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with AttachmentTextBlobError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                let dummy_id = [0u8; 32];
                match decode_attachment_text_blob(&dummy_key, &dummy_hash, &dummy_id, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_attachment_text_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "attachment-text missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "extractor_version_unsupported",
        "header_too_short",
        "ciphertext_truncated",
        "ciphertext_len_overflow",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "attachment-text missing parse_fail coverage for AttachmentTextBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_quickunlock_vectors() {
    // quick_unlock_blob is NOT re-exported at the crate root (it is a `pub mod`
    // with no flattened `pub use`), so the codec items are imported via the
    // full module path.
    use protocol::quick_unlock_blob::{
        decode_quick_unlock_blob, encode_quick_unlock_blob_raw, QuickUnlockBlobError,
    };

    let Some(raw) = cases_json("vault-quickunlock") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-quickunlock] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-quickunlock");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 12,
        "vault-quickunlock must carry at least 12 vectors (2 encrypt + 1 decrypt_ok + 3 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-quickunlock", cases);

    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let wrap_key: [u8; 32] = hex_decode_array(
                    case["input_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_wrap_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let provider_kind = case["input_provider_kind"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing input_provider_kind"))
                    as u8;
                let pin_salt: [u8; 16] = hex_decode_array(
                    case["input_pin_salt_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_pin_salt_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_vault_quickunlock_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing expected_vault_quickunlock_blob_hex")
                        }),
                );

                let actual = encode_quick_unlock_blob_raw(
                    &wrap_key,
                    &account_hash,
                    provider_kind,
                    &pin_salt,
                    &root_key,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-quickunlock encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let wrap_key: [u8; 32] = hex_decode_array(
                    case["input_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_wrap_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_root_key = hex_decode(
                    case["expected_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_root_key_hex")),
                );

                let decoded = decode_quick_unlock_blob(&wrap_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_root_key.as_slice(),
                    "[{id}] vault-quickunlock decrypt root_key mismatch",
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let wrap_key: [u8; 32] = hex_decode_array(
                    case["input_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_wrap_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                match decode_quick_unlock_blob(&wrap_key, &account_hash, &blob) {
                    Err(QuickUnlockBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected QuickUnlockBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected aead_fail, decode_quick_unlock_blob returned Ok"
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => QuickUnlockBlobError::MagicMismatch,
                    "protocol_version_mismatch" => QuickUnlockBlobError::ProtocolVersionMismatch,
                    "provider_kind_unsupported" => QuickUnlockBlobError::ProviderKindUnsupported,
                    "ciphertext_len_invalid" => QuickUnlockBlobError::CiphertextLenInvalid,
                    "header_too_short" => QuickUnlockBlobError::HeaderTooShort,
                    "ciphertext_truncated" => QuickUnlockBlobError::CiphertextTruncated,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with QuickUnlockBlobError"
                    ),
                };

                // Structural rejects run BEFORE the AEAD stage, so dummy
                // key/hash suffice — a port that skips a check surfaces a
                // (wrong) CannotDecrypt, which this assertion catches.
                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_quick_unlock_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_quick_unlock_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "vault-quickunlock missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "provider_kind_unsupported",
        "ciphertext_len_invalid",
        "header_too_short",
        "ciphertext_truncated",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "vault-quickunlock missing parse_fail coverage for QuickUnlockBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn pending_capture_vectors() {
    // capture_blob is NOT re-exported at the crate root (it is a `pub mod` with
    // no flattened `pub use`), so the codec items are imported via the full
    // module path.
    use protocol::capture_blob::{decode_capture_blob, encode_capture_blob_raw, CaptureBlobError};

    let Some(raw) = cases_json("pending-capture") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[pending-capture] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "pending-capture");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 11,
        "pending-capture must carry at least 11 vectors (2 encrypt + 1 decrypt_ok + 3 decrypt_aead_fail + 5 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("pending-capture", cases);

    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let wrap_key: [u8; 32] = hex_decode_array(
                    case["input_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_wrap_key_hex")),
                );
                let capture_id: [u8; 16] = hex_decode_array(
                    case["input_capture_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_capture_id_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_utf8_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_pending_capture_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing expected_pending_capture_blob_hex")
                        }),
                );

                let actual = encode_capture_blob_raw(&wrap_key, &capture_id, &plaintext, &nonce)
                    .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] pending-capture encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let wrap_key: [u8; 32] = hex_decode_array(
                    case["input_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_wrap_key_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_utf8_hex")),
                );

                let decoded = decode_capture_blob(&wrap_key, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] pending-capture decrypt plaintext mismatch",
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let wrap_key: [u8; 32] = hex_decode_array(
                    case["input_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_wrap_key_hex")),
                );

                match decode_capture_blob(&wrap_key, &blob) {
                    Err(CaptureBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected CaptureBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(_) => panic!("[{id}] expected aead_fail, decode_capture_blob returned Ok"),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => CaptureBlobError::MagicMismatch,
                    "protocol_version_mismatch" => CaptureBlobError::ProtocolVersionMismatch,
                    "ciphertext_len_overflow" => CaptureBlobError::CiphertextLenOverflow,
                    "header_too_short" => CaptureBlobError::HeaderTooShort,
                    "ciphertext_truncated" => CaptureBlobError::CiphertextTruncated,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with CaptureBlobError"
                    ),
                };

                // Structural rejects run BEFORE the AEAD stage, so a dummy key
                // suffices — a port that skips a check surfaces a (wrong)
                // CannotDecrypt, which this assertion catches.
                let dummy_key = [0u8; 32];
                match decode_capture_blob(&dummy_key, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_capture_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "pending-capture missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 5] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "ciphertext_len_overflow",
        "header_too_short",
        "ciphertext_truncated",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "pending-capture missing parse_fail coverage for CaptureBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn share_import_vectors() {
    // share_import_blob is NOT re-exported at the crate root (it is a `pub mod`
    // with no flattened `pub use`), so the codec items are imported via the full
    // module path — same convention as capture_blob / quick_unlock_blob.
    use protocol::share_import_blob::{
        decode_share_import_blob, encode_share_import_blob_raw, ShareImportBlobError,
    };

    let Some(raw) = cases_json("share-import") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[share-import] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "share-import");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 11,
        "share-import must carry at least 11 vectors (2 encrypt + 1 decrypt_ok + 3 decrypt_aead_fail + 5 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("share-import", cases);

    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let wrap_key: [u8; 32] = hex_decode_array(
                    case["input_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_wrap_key_hex")),
                );
                let share_id: [u8; 16] = hex_decode_array(
                    case["input_share_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_share_id_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_share_import_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_share_import_blob_hex")),
                );

                let actual = encode_share_import_blob_raw(&wrap_key, &share_id, &plaintext, &nonce)
                    .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] share-import encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let wrap_key: [u8; 32] = hex_decode_array(
                    case["input_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_wrap_key_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let decoded = decode_share_import_blob(&wrap_key, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] share-import decrypt plaintext mismatch",
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let wrap_key: [u8; 32] = hex_decode_array(
                    case["input_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_wrap_key_hex")),
                );

                match decode_share_import_blob(&wrap_key, &blob) {
                    Err(ShareImportBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected ShareImportBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(_) => {
                        panic!("[{id}] expected aead_fail, decode_share_import_blob returned Ok")
                    }
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => ShareImportBlobError::MagicMismatch,
                    "protocol_version_mismatch" => ShareImportBlobError::ProtocolVersionMismatch,
                    "ciphertext_len_overflow" => ShareImportBlobError::CiphertextLenOverflow,
                    "header_too_short" => ShareImportBlobError::HeaderTooShort,
                    "ciphertext_truncated" => ShareImportBlobError::CiphertextTruncated,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with ShareImportBlobError"
                    ),
                };

                // Structural rejects run BEFORE the AEAD stage, so a dummy key
                // suffices — a port that skips a check surfaces a (wrong)
                // CannotDecrypt, which this assertion catches.
                let dummy_key = [0u8; 32];
                match decode_share_import_blob(&dummy_key, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_share_import_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "share-import missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 5] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "ciphertext_len_overflow",
        "header_too_short",
        "ciphertext_truncated",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "share-import missing parse_fail coverage for ShareImportBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn attachment_blob_vectors() {
    use protocol::{
        aad_encrypt_attachment, aad_wrap_attachment_key, compute_attachment_id,
        decode_attachment_blob, encode_attachment_blob_raw, AttachmentBlobError,
    };

    let Some(raw) = cases_json("attachment-blob") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[attachment-blob] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "attachment-blob");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "attachment-blob must have at least one case"
    );
    assert_unique_vector_ids("attachment-blob", cases);

    let mut seen_kinds = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                let attachment_id: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_id_hex"));
                let content_type = hex_decode(field(case, id, "input_content_type_utf8_hex"));
                let attachment_key: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_key_hex"));
                let attachment_key_nonce: [u8; 24] =
                    hex_decode_array(field(case, id, "input_attachment_key_nonce_hex"));
                let content_nonce: [u8; 24] =
                    hex_decode_array(field(case, id, "input_content_nonce_hex"));
                let file = hex_decode(field(case, id, "input_file_plaintext_hex"));
                let expected = hex_decode(field(case, id, "expected_attachment_blob_hex"));

                let actual = encode_attachment_blob_raw(
                    &items_key,
                    &items_key_id,
                    &attachment_id,
                    &content_type,
                    &attachment_key,
                    &attachment_key_nonce,
                    &content_nonce,
                    &file,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode_attachment_blob_raw failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] attachment-blob encrypt mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(field(case, id, "input_attachment_blob_hex"));
                let attachment_id: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_id_hex"));
                let content_type = hex_decode(field(case, id, "input_content_type_utf8_hex"));
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                let expected = hex_decode(field(case, id, "expected_file_plaintext_hex"));

                let actual = decode_attachment_blob(
                    &blob,
                    &attachment_id,
                    &content_type,
                    &items_key,
                    &items_key_id,
                )
                .unwrap_or_else(|e| panic!("[{id}] decode_attachment_blob failed: {e:?}"));
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] attachment-blob decrypt_ok mismatch"
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(field(case, id, "input_attachment_blob_hex"));
                let attachment_id: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_id_hex"));
                let content_type = hex_decode(field(case, id, "input_content_type_utf8_hex"));
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));

                match decode_attachment_blob(&blob, &attachment_id, &content_type, &items_key, &items_key_id)
                {
                    Err(AttachmentBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected AttachmentBlobError::CannotDecrypt (non-distinguishing AEAD failure §6.4), got {other:?}"
                    ),
                    Ok(pt) => panic!(
                        "[{id}] expected AEAD failure, decode returned Ok ({} bytes)",
                        pt.len()
                    ),
                }
            }
            "parse_fail" => {
                // Structural rejects (§9.9 layout + strict-trailing). Same
                // non-distinguishing CannotDecrypt as the AEAD failures —
                // the case_kind documents WHICH checks a port must perform.
                // The REAL items_key is load-bearing: header bytes are not
                // AAD-bound, so a port that skips a structural check decodes
                // the tampered blob successfully and returns Ok — caught here.
                let blob = hex_decode(field(case, id, "input_attachment_blob_hex"));
                let attachment_id: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_id_hex"));
                let content_type = hex_decode(field(case, id, "input_content_type_utf8_hex"));
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));

                match decode_attachment_blob(&blob, &attachment_id, &content_type, &items_key, &items_key_id)
                {
                    Err(AttachmentBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected AttachmentBlobError::CannotDecrypt (structural rejects collapse to the non-distinguishing variant), got {other:?}"
                    ),
                    Ok(pt) => panic!(
                        "[{id}] expected parse_fail, decode returned Ok ({} bytes) — a structural check was skipped",
                        pt.len()
                    ),
                }
            }
            "aad_construction" => {
                let builder = field(case, id, "input_aad_builder");
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                let attachment_id: [u8; 32] =
                    hex_decode_array(field(case, id, "input_attachment_id_hex"));
                let expected = hex_decode(field(case, id, "expected_aad_hex"));

                let actual = match builder {
                    "aad_wrap_attachment_key" => {
                        aad_wrap_attachment_key(&items_key_id, &attachment_id)
                    }
                    "aad_encrypt_attachment" => {
                        let content_type =
                            hex_decode(field(case, id, "input_content_type_utf8_hex"));
                        aad_encrypt_attachment(&items_key_id, &attachment_id, &content_type)
                    }
                    other => panic!("[{id}] unknown aad builder '{other}'"),
                };
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] {builder} AAD mismatch"
                );
            }
            "id_determinism" => {
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let file = hex_decode(field(case, id, "input_file_plaintext_hex"));
                let expected: [u8; 32] =
                    hex_decode_array(field(case, id, "expected_attachment_id_hex"));

                let actual = compute_attachment_id(&root_key, &file);
                assert_eq!(actual, expected, "[{id}] compute_attachment_id mismatch");
                // Determinism: a second call must match.
                assert_eq!(
                    compute_attachment_id(&root_key, &file),
                    actual,
                    "[{id}] compute_attachment_id is not deterministic"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    for kind in [
        "encrypt",
        "decrypt_ok",
        "decrypt_aead_fail",
        "aad_construction",
        "id_determinism",
        "parse_fail",
    ] {
        assert!(
            seen_kinds.contains(kind),
            "attachment-blob missing every case of case_kind '{kind}' — coverage regression"
        );
    }
}

/// `vault-meta` v0.2 (`NTV5`) — the `0x02` side of the frozen §10.4.1 md.6
/// `protocol_version` split (myne-md/myne#441).
///
/// The two reject cases are the load-bearing ones. A round-trip alone would pass
/// for an implementation that ignored the magic entirely; §10.5's anti-downgrade
/// property is that a `MYV1` blob MUST NOT parse as v0.2 and an `NTV5` blob MUST
/// NOT parse as v0.1, and that is what a port has to get right for a mixed fleet
/// to be safe.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_meta_v0_2_vectors() {
    use protocol::{parse_vault_meta, parse_vault_meta_v0_2, serialize_vault_meta_v0_2};

    let Some(raw) = cases_json_v0_2("vault-meta") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[vault-meta/v0.2] parse: {e}"));
    assert_eq!(doc["schema"], "vault-meta");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("vault-meta/v0.2", cases);

    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] case_kind"));
        seen.insert(kind.to_string());
        match kind {
            "roundtrip" => {
                let meta = protocol::VaultMeta {
                    account_number_hash: hex_decode_array(field(
                        case,
                        id,
                        "input_account_number_hash_hex",
                    )),
                    kdf_params: protocol::KdfParams {
                        m_kib: case["input_kdf_params"]["m_kib"].as_u64().unwrap() as u32,
                        t: case["input_kdf_params"]["t"].as_u64().unwrap() as u32,
                        p: case["input_kdf_params"]["p"].as_u64().unwrap() as u8,
                        argon2_version: u8::from_str_radix(
                            case["input_kdf_params"]["argon2_version_hex"]
                                .as_str()
                                .unwrap(),
                            16,
                        )
                        .unwrap(),
                    },
                    random_salt_password: hex_decode_array(field(
                        case,
                        id,
                        "input_random_salt_password_hex",
                    )),
                    random_salt_recovery: hex_decode_array(field(
                        case,
                        id,
                        "input_random_salt_recovery_hex",
                    )),
                    nonce_password_wrap: hex_decode_array(field(
                        case,
                        id,
                        "input_nonce_password_wrap_hex",
                    )),
                    enc_root_key_password: hex_decode_array(field(
                        case,
                        id,
                        "input_enc_root_key_password_hex",
                    )),
                    nonce_recovery_wrap: hex_decode_array(field(
                        case,
                        id,
                        "input_nonce_recovery_wrap_hex",
                    )),
                    enc_root_key_recovery: hex_decode_array(field(
                        case,
                        id,
                        "input_enc_root_key_recovery_hex",
                    )),
                    items_key_id: hex_decode_array(field(case, id, "input_items_key_id_hex")),
                    items_key_nonce: hex_decode_array(field(case, id, "input_items_key_nonce_hex")),
                    enc_items_key: hex_decode_array(field(case, id, "input_enc_items_key_hex")),
                };
                let actual = serialize_vault_meta_v0_2(&meta);
                assert_eq!(
                    hex_encode(&actual),
                    field(case, id, "expected_blob_hex"),
                    "[{id}] NTV5 bytes"
                );
                parse_vault_meta_v0_2(&actual)
                    .unwrap_or_else(|e| panic!("[{id}] round-trip: {e:?}"));
            }
            "parse_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert!(
                    parse_vault_meta_v0_2(&blob).is_err(),
                    "[{id}] the v0.2 parser must reject a MYV1 blob"
                );
            }
            "parse_fail_v0_1" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert!(
                    parse_vault_meta(&blob).is_err(),
                    "[{id}] the v0.1 parser must reject an NTV5 blob"
                );
            }
            other => panic!("[{id}] unknown case_kind {other}"),
        }
    }
    // Coverage asserted rather than hoped for: a cases.json that lost its reject
    // cases would otherwise still pass, and the rejects are the whole point.
    for k in ["roundtrip", "parse_fail", "parse_fail_v0_1"] {
        assert!(seen.contains(k), "vault-meta/v0.2 must cover case_kind {k}");
    }
}

/// `vault-themes` v0.2 (`MYT5`) — the `0x01` side of the same frozen split, and
/// the KEK-envelope archetype `vault.dictionary` shares byte-for-byte
/// (myne-md/myne#441).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_themes_v0_2_vectors() {
    use protocol::{decode_themes_blob_versioned, MetaVersion};

    let Some(raw) = cases_json_v0_2("vault-themes") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[vault-themes/v0.2] parse: {e}"));
    assert_eq!(doc["schema"], "vault-themes");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("vault-themes/v0.2", cases);

    let kek: [u8; 32] = [0x71; 32];
    let acct: [u8; 16] = [0x5A; 16];
    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] case_kind"));
        seen.insert(kind.to_string());
        match kind {
            "encrypt" => {
                let expected = hex_decode(field(case, id, "expected_blob_hex"));
                // Read the two conventions straight off the bytes rather than
                // inferring them from a successful decode — the decode would
                // succeed under a different version byte too, since the byte is
                // not AEAD-bound in this family.
                assert_eq!(&expected[0..4], b"MYT5", "[{id}] magic");
                assert_eq!(
                    format!("{:02x}", expected[4]),
                    field(case, id, "expected_version_byte_hex"),
                    "[{id}] KEK-singleton families keep 0x01 in v0.2"
                );
                let opened =
                    decode_themes_blob_versioned(MetaVersion::V0_2, &kek, &acct, &expected)
                        .unwrap_or_else(|e| panic!("[{id}] decode: {e:?}"));
                assert_eq!(
                    hex_encode(&opened),
                    field(case, id, "input_plaintext_hex"),
                    "[{id}] plaintext"
                );
            }
            "decode_fail_v0_1" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert!(
                    decode_themes_blob_versioned(MetaVersion::V0_1, &kek, &acct, &blob).is_err(),
                    "[{id}] a MYT5 blob must not open under the v0.1 expectation"
                );
            }
            other => panic!("[{id}] unknown case_kind {other}"),
        }
    }
    for k in ["encrypt", "decode_fail_v0_1"] {
        assert!(
            seen.contains(k),
            "vault-themes/v0.2 must cover case_kind {k}"
        );
    }
}

/// `NC05` next-major (v0.2) CRDT note-type codec vectors (§10.7, #418 t4). The
/// first vector family for a next-major format — it reads the `v0.2/` fixture
/// dir. Mirrors the attachment/myn-blob runners: `encrypt` (byte output),
/// `decrypt_ok`, `decrypt_aead_fail` (incl. the v0.1-AAD domain-sep), `parse_fail`
/// (structural rejects incl. strict-trailing), `aad_construction`.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn crdt_note_blob_vectors() {
    use protocol::aead::{aad_nc05_content_encrypt, aad_nc05_item_key_wrap};
    use protocol::{decode_crdt_note_blob, encode_crdt_note_blob_raw, CannotDecryptCrdtNote};

    let Some(raw) = cases_json_v0_2("crdt-note-blob") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[crdt-note-blob] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "crdt-note-blob");
    assert_eq!(doc["protocol_version"], "v0.2");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "crdt-note-blob must have at least one case"
    );
    assert_unique_vector_ids("crdt-note-blob", cases);

    let mut seen_kinds = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                let note_uuid: [u8; 16] = hex_decode_array(field(case, id, "input_note_uuid_hex"));
                let item_key: [u8; 32] = hex_decode_array(field(case, id, "input_item_key_hex"));
                let item_key_nonce: [u8; 24] =
                    hex_decode_array(field(case, id, "input_item_key_nonce_hex"));
                let content_nonce: [u8; 24] =
                    hex_decode_array(field(case, id, "input_content_nonce_hex"));
                let plaintext = hex_decode(field(case, id, "input_plaintext_hex"));
                let expected = hex_decode(field(case, id, "expected_blob_hex"));

                let actual = encode_crdt_note_blob_raw(
                    &items_key,
                    &items_key_id,
                    &note_uuid,
                    &item_key,
                    &item_key_nonce,
                    &content_nonce,
                    &plaintext,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode_crdt_note_blob_raw failed: {e:?}"));
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] crdt-note-blob encrypt mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let note_uuid: [u8; 16] = hex_decode_array(field(case, id, "input_note_uuid_hex"));
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                let expected = hex_decode(field(case, id, "expected_plaintext_hex"));

                let actual = decode_crdt_note_blob(&blob, &note_uuid, &items_key, &items_key_id)
                    .unwrap_or_else(|e| panic!("[{id}] decode_crdt_note_blob failed: {e:?}"));
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] crdt-note-blob decrypt_ok mismatch"
                );
            }
            "decrypt_aead_fail" | "parse_fail" => {
                // Both collapse to the single non-distinguishing CannotDecryptCrdtNote
                // (§6.4). The REAL items_key is load-bearing for parse_fail: header
                // bytes are not AAD-bound, so a port skipping a structural check
                // decodes Ok and is caught here.
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let note_uuid: [u8; 16] = hex_decode_array(field(case, id, "input_note_uuid_hex"));
                let items_key: [u8; 32] = hex_decode_array(field(case, id, "input_items_key_hex"));
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                match decode_crdt_note_blob(&blob, &note_uuid, &items_key, &items_key_id) {
                    Err(CannotDecryptCrdtNote) => {}
                    Ok(pt) => panic!(
                        "[{id}] expected {case_kind}, decode returned Ok ({} bytes) — a check was skipped",
                        pt.len()
                    ),
                }
            }
            "aad_construction" => {
                let builder = field(case, id, "input_aad_builder");
                let items_key_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_items_key_id_hex"));
                let note_uuid: [u8; 16] = hex_decode_array(field(case, id, "input_note_uuid_hex"));
                let expected = hex_decode(field(case, id, "expected_aad_hex"));
                let actual = match builder {
                    "aad_nc05_item_key_wrap" => aad_nc05_item_key_wrap(&items_key_id, &note_uuid),
                    "aad_nc05_content_encrypt" => {
                        aad_nc05_content_encrypt(&items_key_id, &note_uuid)
                    }
                    other => panic!("[{id}] unknown aad builder '{other}'"),
                };
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] {builder} AAD mismatch"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}'"),
        }
    }

    for kind in [
        "encrypt",
        "decrypt_ok",
        "decrypt_aead_fail",
        "parse_fail",
        "aad_construction",
    ] {
        assert!(
            seen_kinds.contains(kind),
            "crdt-note-blob missing every case of case_kind '{kind}' — coverage regression"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn attachments_catalog_vectors() {
    use protocol::{
        aad_attachments_catalog, decode_attachments_catalog, derive_subkey,
        encode_attachments_catalog_raw, CatalogBlobError, SubkeyRole,
    };

    let Some(raw) = cases_json("attachments-catalog") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[attachments-catalog] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "attachments-catalog");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "attachments-catalog must have at least one case"
    );
    assert_unique_vector_ids("attachments-catalog", cases);

    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();
    let mut saw_tolerance = false;

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let plaintext = hex_decode(field(case, id, "input_plaintext_canonical_utf8_hex"));
                let nonce: [u8; 24] = hex_decode_array(field(case, id, "input_catalog_nonce_hex"));
                let expected = hex_decode(field(case, id, "expected_catalog_blob_hex"));

                // The encoder takes a structured catalog, not raw plaintext;
                // round-trip the canonical bytes through decode to obtain the
                // catalog, then re-encode and assert byte equality (this also
                // pins that decode(plaintext) is the inverse of the encoder's
                // canonical_json_encode).
                let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
                // Build a throwaway blob from the pinned plaintext to recover
                // the structured catalog via the public decode path.
                let probe_blob = build_catalog_blob_from_plaintext(
                    &catalog_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                );
                let catalog = decode_attachments_catalog(&catalog_key, &account_hash, &probe_blob)
                    .unwrap_or_else(|e| panic!("[{id}] probe decode failed: {e:?}"));

                let actual =
                    encode_attachments_catalog_raw(&catalog_key, &account_hash, &catalog, &nonce)
                        .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] attachments-catalog encrypt mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let expected_pt =
                    hex_decode(field(case, id, "expected_plaintext_canonical_utf8_hex"));

                let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
                let catalog = decode_attachments_catalog(&catalog_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));
                // Verify the decoded catalog equals the catalog the pinned
                // canonical plaintext parses to: build a blob from the
                // expected plaintext bytes and decode it through the same
                // public path, then compare the two structured catalogs.
                let nonce = [0u8; 24];
                let pt_blob = build_catalog_blob_from_plaintext(
                    &catalog_key,
                    &account_hash,
                    &expected_pt,
                    &nonce,
                );
                let catalog_from_pt =
                    decode_attachments_catalog(&catalog_key, &account_hash, &pt_blob)
                        .unwrap_or_else(|e| {
                            panic!("[{id}] expected_plaintext did not decode: {e:?}")
                        });
                assert_eq!(
                    catalog, catalog_from_pt,
                    "[{id}] decoded catalog disagrees with expected canonical plaintext"
                );

                // §9.10.2 tolerance detection: re-encode the decoded catalog
                // under the blob's own nonce; a byte difference from the
                // input blob means the sealed plaintext carried unknown
                // additive fields the decoder dropped.
                let blob_nonce: [u8; 24] = blob[6..30].try_into().expect("blob header nonce");
                let reencoded = encode_attachments_catalog_raw(
                    &catalog_key,
                    &account_hash,
                    &catalog,
                    &blob_nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] re-encode failed: {e:?}"));
                if reencoded != blob {
                    saw_tolerance = true;
                }
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));

                let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
                match decode_attachments_catalog(&catalog_key, &account_hash, &blob) {
                    Err(CatalogBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected CatalogBlobError::CannotDecrypt (non-distinguishing AEAD failure §6.4), got {other:?}"
                    ),
                    Ok(view) => panic!("[{id}] expected AEAD failure, decode returned Ok({view:?})"),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let expected_error = field(case, id, "expected_error");
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "header_too_short" => CatalogBlobError::HeaderTooShort,
                    "magic_mismatch" => CatalogBlobError::MagicMismatch,
                    "protocol_version_mismatch" => CatalogBlobError::ProtocolVersionMismatch,
                    "reserved_byte_nonzero" => CatalogBlobError::ReservedByteNonZero,
                    "ciphertext_len_overflow" => CatalogBlobError::CiphertextLenOverflow,
                    "ciphertext_truncated" => CatalogBlobError::CiphertextTruncated,
                    "plaintext_parse_failed" => CatalogBlobError::PlaintextParseFailed,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with CatalogBlobError"
                    ),
                };

                // The REAL catalog_key is load-bearing: header bytes are not
                // AAD-bound, so an implementation that skips a structural
                // check decrypts the tampered blob successfully and returns
                // Ok — caught here. (The plaintext_parse_failed case also
                // needs the key to get past AEAD at all.)
                let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
                match decode_attachments_catalog(&catalog_key, &account_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(view) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode returned Ok({view:?})"
                    ),
                }
            }
            "aad_construction" => {
                let account_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let expected = hex_decode(field(case, id, "expected_aad_hex"));
                let actual = aad_attachments_catalog(&account_hash);
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] aad_attachments_catalog mismatch"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    for kind in [
        "encrypt",
        "decrypt_ok",
        "decrypt_aead_fail",
        "aad_construction",
        "parse_fail",
    ] {
        assert!(
            seen_kinds.contains(kind),
            "attachments-catalog missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    for required in [
        "header_too_short",
        "magic_mismatch",
        "protocol_version_mismatch",
        "reserved_byte_nonzero",
        "ciphertext_len_overflow",
        "ciphertext_truncated",
        "plaintext_parse_failed",
    ] {
        assert!(
            seen_parse_errors.contains(required),
            "attachments-catalog vectors must include a parse_fail case for '{required}'",
        );
    }
    assert!(
        saw_tolerance,
        "attachments-catalog vectors must include a §9.10.2 unknown-field tolerance decrypt_ok case",
    );
}

/// Helper: build a MYC1 blob directly from a canonical-JSON plaintext,
/// so the runner can recover the structured catalog from a pinned
/// plaintext via the public decode path. Mirrors the encoder's
/// envelope assembly (34-byte header + AEAD-sealed plaintext).
fn build_catalog_blob_from_plaintext(
    catalog_key: &[u8; 32],
    account_hash: &[u8; 16],
    plaintext: &[u8],
    nonce: &[u8; 24],
) -> Vec<u8> {
    use protocol::{aad_attachments_catalog, aead_seal_ctx, CATALOG_BLOB_MAGIC};
    let aad = aad_attachments_catalog(account_hash);
    let sealed = aead_seal_ctx(catalog_key, nonce, plaintext, &aad).expect("seal");
    let mut blob = Vec::with_capacity(34 + sealed.len());
    blob.extend_from_slice(&CATALOG_BLOB_MAGIC);
    blob.push(0x01);
    blob.push(0x00);
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
    blob.extend_from_slice(&sealed);
    blob
}

/// Helper: fetch a required string field, panicking with the vector id
/// on absence. Trims the repetitive `unwrap_or_else` boilerplate the
/// older runners spell out inline.
fn field<'a>(case: &'a serde_json::Value, id: &str, key: &str) -> &'a str {
    case[key]
        .as_str()
        .unwrap_or_else(|| panic!("[{id}] missing {key}"))
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn damm32_table_vectors() {
    use protocol::damm32_table;

    let Some(raw) = cases_json("damm32-table") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[damm32-table] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "damm32-table");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "damm32-table must have at least one case"
    );
    assert_unique_vector_ids("damm32-table", cases);

    // The reference table (frozen const, exposed via the public accessor).
    let table = damm32_table();

    let mut saw_table = false;
    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        match case_kind {
            "table" => {
                saw_table = true;
                let expected = hex_decode(
                    case["expected_table_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_table_hex")),
                );
                assert_eq!(
                    expected.len(),
                    1024,
                    "[{id}] expected_table_hex must decode to 1024 bytes, got {}",
                    expected.len()
                );
                // Row-major flatten of the reference table.
                let mut actual = Vec::with_capacity(1024);
                for row in table.iter() {
                    actual.extend_from_slice(row);
                }
                assert_eq!(
                    actual,
                    expected,
                    "[{id}] damm32 table mismatch (row-major)\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "checksum" => {
                let indices: Vec<u8> = case["input_entropy_indices"]
                    .as_array()
                    .unwrap_or_else(|| panic!("[{id}] missing input_entropy_indices"))
                    .iter()
                    .map(|v| {
                        let n = v
                            .as_u64()
                            .unwrap_or_else(|| panic!("[{id}] index not an integer"));
                        assert!(n < 32, "[{id}] index {n} out of range 0..32");
                        n as u8
                    })
                    .collect();
                let expected = case["expected_check_index"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_check_index"));
                assert!(expected < 32, "[{id}] expected_check_index out of range");

                // Fold left from interim 0 through the reference table — the
                // same operation a port runs against its derived table.
                let mut interim = 0usize;
                for &d in &indices {
                    interim = table[interim][d as usize] as usize;
                }
                assert_eq!(
                    interim as u64, expected,
                    "[{id}] checksum mismatch: folded {interim}, expected {expected}"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}'"),
        }
    }

    assert!(
        saw_table,
        "damm32-table must include the full 'table' case (the cross-impl ground truth)"
    );
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn note_template_vectors() {
    use protocol::{render, supported_tokens, RenderContext};

    let Some(raw) = cases_json("note-template") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[note-template] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "note-template");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "note-template must have at least one case"
    );
    assert_unique_vector_ids("note-template", cases);

    // Decode a `*_utf8_hex` field into an owned String, failing loudly on
    // invalid UTF-8 (the hex pins exact bytes; the engine API is &str).
    let utf8_field = |case: &serde_json::Value, id: &str, key: &str| -> String {
        let bytes = hex_decode(field(case, id, key));
        String::from_utf8(bytes).unwrap_or_else(|e| panic!("[{id}] {key} is not valid UTF-8: {e}"))
    };

    let mut seen_kinds = std::collections::HashSet::new();
    let mut saw_single_pass_pin = false;

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));

        match case_kind {
            "render" => {
                seen_kinds.insert("render");
                let template = utf8_field(case, id, "input_template_utf8_hex");
                // RenderContext carries no serde derives (deliberate — the
                // engine is `#![no_std]` and host-injected); construct it
                // field-by-field from the five pinned hex fields.
                let ctx = RenderContext {
                    title: utf8_field(case, id, "input_ctx_title_utf8_hex"),
                    date: utf8_field(case, id, "input_ctx_date_utf8_hex"),
                    time: utf8_field(case, id, "input_ctx_time_utf8_hex"),
                    datetime: utf8_field(case, id, "input_ctx_datetime_utf8_hex"),
                    weekday: utf8_field(case, id, "input_ctx_weekday_utf8_hex"),
                };
                let expected = hex_decode(field(case, id, "expected_output_utf8_hex"));

                // A ctx value carrying a `{{token}}` shape marks the
                // single-pass pin (substituted values are never re-scanned)
                // — the one render case any re-scanning port fails.
                if ctx.title.contains("{{")
                    || ctx.date.contains("{{")
                    || ctx.time.contains("{{")
                    || ctx.datetime.contains("{{")
                    || ctx.weekday.contains("{{")
                {
                    saw_single_pass_pin = true;
                }

                // Defensive cross-check: the informational UTF-8 mirrors (when
                // present) must agree with the load-bearing hex — a stale
                // mirror would mislead cross-implementation reviewers. The
                // NFD-unicode case is exempt from a byte-level template check
                // by construction: JSON tooling may NFC-normalize the mirror,
                // which is exactly why the hex is the contract; mismatches
                // there fail here and force regenerating the mirror honestly.
                if let Some(info) = case
                    .get("informational_template_utf8")
                    .and_then(|v| v.as_str())
                {
                    assert_eq!(
                        info.as_bytes(),
                        template.as_bytes(),
                        "[{id}] informational_template_utf8 disagrees with input_template_utf8_hex"
                    );
                }
                if let Some(info) = case
                    .get("informational_output_utf8")
                    .and_then(|v| v.as_str())
                {
                    assert_eq!(
                        info.as_bytes(),
                        expected.as_slice(),
                        "[{id}] informational_output_utf8 disagrees with expected_output_utf8_hex"
                    );
                }

                let actual = render(&template, &ctx);
                assert_eq!(
                    actual.as_bytes(),
                    expected.as_slice(),
                    "[{id}] note-template render mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(actual.as_bytes()),
                );
            }
            "token_registry" => {
                seen_kinds.insert("token_registry");
                let expected: Vec<&str> = case["expected_tokens"]
                    .as_array()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_tokens"))
                    .iter()
                    .map(|v| v.as_str().expect("expected_tokens entries must be strings"))
                    .collect();
                let actual = supported_tokens();
                assert_eq!(
                    actual, expected,
                    "[{id}] supported_tokens() order/set mismatch — the registry and the vector must move in lockstep"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    for kind in ["render", "token_registry"] {
        assert!(
            seen_kinds.contains(kind),
            "note-template missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    assert!(
        saw_single_pass_pin,
        "note-template vectors must include the single-pass pin (a render case whose ctx value contains a {{{{token}}}} shape that stays literal)"
    );
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_head_vectors() {
    use protocol::{
        compute_head_id, compute_vault_head_mac, derive_subkey, vv_dominance, Dominance,
        SubkeyRole, VaultHead, VvEntry, DEVICE_ID_LEN, HEAD_ID_LEN, HEAD_MAC_LEN,
        VAULT_HEAD_FORMAT_V1,
    };

    let Some(raw) = cases_json("vault-head") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[vault-head] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-head");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 8,
        "vault-head must carry at least 8 vectors (4 encode + 4 verify); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-head", cases);

    fn parse_vv(val: &serde_json::Value, id: &str) -> Vec<VvEntry> {
        val.as_array()
            .unwrap_or_else(|| panic!("[{id}] version vector must be an array"))
            .iter()
            .map(|e| VvEntry {
                device_id: hex_decode_array::<DEVICE_ID_LEN>(
                    e["input_device_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] vv entry missing input_device_id_hex")),
                ),
                counter: e["counter"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] vv entry missing counter")),
            })
            .collect()
    }

    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_decisions = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encode" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_number_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let manifest_hash: [u8; 32] = hex_decode_array(
                    case["input_manifest_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_manifest_hash_hex")),
                );
                let seq = case["input_seq"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing input_seq"));
                let prev_head_hash: Vec<[u8; HEAD_ID_LEN]> = case["input_prev_head_hash_hex"]
                    .as_array()
                    .unwrap_or_else(|| panic!("[{id}] missing input_prev_head_hash_hex"))
                    .iter()
                    .map(|h| {
                        hex_decode_array::<HEAD_ID_LEN>(
                            h.as_str().unwrap_or_else(|| panic!("[{id}] bad prev hash")),
                        )
                    })
                    .collect();
                let version_vector = parse_vv(&case["input_version_vector"], id);

                let head = VaultHead {
                    head_format_version: VAULT_HEAD_FORMAT_V1,
                    account_number_hash,
                    manifest_hash,
                    seq,
                    prev_head_hash,
                    version_vector,
                };

                // informational head_mac_key cross-check (HKDF role "vault-head-mac").
                if let Some(info_hex) = case
                    .get("informational_head_mac_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info: [u8; 32] = hex_decode_array(info_hex);
                    let derived = derive_subkey(&root_key, SubkeyRole::VaultHeadMac);
                    assert_eq!(
                        derived.as_slice(),
                        info.as_slice(),
                        "[{id}] informational_head_mac_key_hex disagrees with derive_subkey(root_key, VaultHeadMac)",
                    );
                }

                let mac_input = head
                    .encode_mac_input()
                    .unwrap_or_else(|e| panic!("[{id}] encode_mac_input failed: {e:?}"));
                let expected_input = hex_decode(
                    case["expected_head_mac_input_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_head_mac_input_hex")),
                );
                assert_eq!(
                    mac_input.as_slice(),
                    expected_input.as_slice(),
                    "[{id}] head_mac_input mismatch\n  expected: {}\n  actual:   {}",
                    hex_encode(&expected_input),
                    hex_encode(&mac_input),
                );

                let mac = compute_vault_head_mac(&root_key, &mac_input);
                let expected_mac: [u8; HEAD_MAC_LEN] = hex_decode_array(
                    case["expected_head_mac_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_head_mac_hex")),
                );
                assert_eq!(mac, expected_mac, "[{id}] head_mac mismatch");

                let sealed = head
                    .seal(&root_key)
                    .unwrap_or_else(|e| panic!("[{id}] seal failed: {e:?}"));
                let expected_id: [u8; HEAD_ID_LEN] = hex_decode_array(
                    case["expected_head_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_head_id_hex")),
                );
                assert_eq!(sealed.head_id, expected_id, "[{id}] head_id mismatch");
                // head_id is SHA-256 over the full record.
                assert_eq!(
                    compute_head_id(&sealed.record),
                    expected_id,
                    "[{id}] head_id != SHA-256(record)"
                );
            }
            "verify" => {
                let baseline = parse_vv(&case["input_baseline_version_vector"], id);
                let candidate = parse_vv(&case["input_candidate_version_vector"], id);
                let want = case["expected_decision"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_decision"));
                seen_decisions.insert(want.to_string());
                let got = vv_dominance(&baseline, &candidate);
                let want_enum = match want {
                    "extension" => Dominance::Extension,
                    "rollback" => Dominance::Rollback,
                    "incomparable_merge" => Dominance::Incomparable,
                    "bootstrap_tofu" => Dominance::BootstrapTofu,
                    other => panic!("[{id}] unknown expected_decision {other:?}"),
                };
                assert_eq!(got, want_enum, "[{id}] vv_dominance decision mismatch");
            }
            other => panic!("[{id}] unknown case_kind {other:?}"),
        }
    }

    assert!(
        seen_kinds.contains("encode") && seen_kinds.contains("verify"),
        "vault-head must cover both case_kinds (encode + verify); saw {seen_kinds:?}"
    );
    for d in [
        "extension",
        "rollback",
        "incomparable_merge",
        "bootstrap_tofu",
    ] {
        assert!(
            seen_decisions.contains(d),
            "vault-head verify cases must cover the §5.3 decision {d:?}; saw {seen_decisions:?}"
        );
    }
}

/// `manifest` (MYND-414 / SYNC-13): the canonical vault-head manifest byte
/// encoding (`uuid → content_nonce`) + its `manifest_hash`, and the structural
/// decode rejects. Validates `protocol::manifest` bit-for-bit against the
/// committed golden vectors (`sync-protocol.md` §4.2).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn manifest_vectors() {
    use protocol::{
        compute_manifest_hash, decode_manifest, encode_manifest, ManifestEntry, ManifestError,
        MANIFEST_ID_LEN,
    };

    let Some(raw) = cases_json("manifest") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[manifest] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "manifest");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 5,
        "manifest must carry at least 5 vectors; found {}",
        cases.len()
    );
    assert_unique_vector_ids("manifest", cases);

    fn parse_entries(case: &serde_json::Value, id: &str) -> Vec<ManifestEntry> {
        case["input_entries"]
            .as_array()
            .unwrap_or_else(|| panic!("[{id}] input_entries must be an array"))
            .iter()
            .map(|e| ManifestEntry {
                id: hex_decode_array::<MANIFEST_ID_LEN>(
                    e["input_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] entry missing input_id_hex")),
                ),
                content_nonce: hex_decode_array::<24>(
                    e["input_content_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] entry missing input_content_nonce_hex")),
                ),
            })
            .collect()
    }

    fn err_str(e: &ManifestError) -> &'static str {
        match e {
            ManifestError::DuplicateId => "duplicate_id",
            ManifestError::TooShort => "too_short",
            ManifestError::TrailingBytes => "trailing_bytes",
            ManifestError::DomainPrefixMismatch => "domain_prefix_mismatch",
            ManifestError::ProtocolVersionMismatch => "protocol_version_mismatch",
            ManifestError::FormatUnsupported => "format_unsupported",
            ManifestError::NotCanonical => "not_canonical",
            _ => "unknown",
        }
    }

    let mut seen_kinds = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encode" => {
                let entries = parse_entries(case, id);
                let expected_bytes = hex_decode(
                    case["expected_manifest_bytes_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_manifest_bytes_hex")),
                );
                let expected_hash: [u8; 32] = hex_decode_array(
                    case["expected_manifest_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_manifest_hash_hex")),
                );
                let got_bytes = encode_manifest(&entries)
                    .unwrap_or_else(|e| panic!("[{id}] encode_manifest failed: {e}"));
                assert_eq!(
                    hex_encode(&got_bytes),
                    hex_encode(&expected_bytes),
                    "[{id}] manifest bytes mismatch"
                );
                let got_hash = compute_manifest_hash(&entries)
                    .unwrap_or_else(|e| panic!("[{id}] compute_manifest_hash failed: {e}"));
                assert_eq!(got_hash, expected_hash, "[{id}] manifest_hash mismatch");
                // Round-trip the canonical bytes back to entries.
                assert!(
                    decode_manifest(&got_bytes).is_ok(),
                    "[{id}] canonical bytes must round-trip"
                );
            }
            "parse_fail" => {
                let bytes = hex_decode(
                    case["input_manifest_bytes_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_manifest_bytes_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                match decode_manifest(&bytes) {
                    Ok(_) => panic!("[{id}] expected parse_fail '{expected_error}', got Ok"),
                    Err(e) => {
                        assert_eq!(err_str(&e), expected_error, "[{id}] wrong reject variant")
                    }
                }
            }
            other => panic!("[{id}] unknown case_kind {other:?}"),
        }
    }

    for k in ["encode", "parse_fail"] {
        assert!(
            seen_kinds.contains(k),
            "manifest must cover case_kind {k:?}; saw {seen_kinds:?}"
        );
    }
}

/// `head-fingerprint` (SYNC-17): the deterministic `head_id → SAS` fingerprint
/// (`protocol::head_fingerprint`) both devices eye-compare at enrollment
/// (MYND-425) + fork-audit (MYND-427). Validates byte-for-byte against the
/// committed golden vectors (`sync-protocol.md` §6.3).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn head_fingerprint_vectors() {
    use protocol::head_fingerprint;

    let Some(raw) = cases_json("head-fingerprint") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[head-fingerprint] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "head-fingerprint");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 3,
        "head-fingerprint must carry at least 3 vectors; found {}",
        cases.len()
    );
    assert_unique_vector_ids("head-fingerprint", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let head_id: [u8; 32] = hex_decode_array(
            case["input_head_id_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_head_id_hex")),
        );
        let expected = case["expected_fingerprint"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing expected_fingerprint"));
        assert_eq!(
            head_fingerprint(&head_id),
            expected,
            "[{id}] fingerprint mismatch"
        );
    }
}

/// `scram-auth` (MYND-420/425): the SCRAM-SHA-256-PLUS client proof + server
/// signature. Validates `protocol::scram_client_proof` byte-for-byte against the
/// shared golden vectors — the cross-impl bar with the Go server's
/// `internal/auth/scram` (`server-protocol.md` auth; RFC 5802/7677/9266).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn scram_auth_vectors() {
    use protocol::scram_client_proof;

    let Some(raw) = cases_json("scram-auth") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[scram-auth] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "scram-auth");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty(), "scram-auth must carry vectors");
    assert_unique_vector_ids("scram-auth", cases);

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let secret = hex_decode(
            case["input_secret_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_secret_hex")),
        );
        let salt = hex_decode(
            case["input_salt_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_salt_hex")),
        );
        let iterations = case["input_iterations"]
            .as_u64()
            .unwrap_or_else(|| panic!("[{id}] missing input_iterations"))
            as u32;
        let username = case["input_username"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_username"));
        let client_nonce = case["input_client_nonce"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_client_nonce"));
        let combined_nonce = case["input_combined_nonce"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing input_combined_nonce"));
        let cbind = hex_decode(
            case["input_cbind_data_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_cbind_data_hex")),
        );

        let out = scram_client_proof(
            &secret,
            &salt,
            iterations,
            username,
            client_nonce,
            combined_nonce,
            &cbind,
        );

        let expect = |k: &str| -> String {
            case[k]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing {k}"))
                .to_string()
        };
        assert_eq!(
            hex_encode(&out.stored_key),
            expect("expected_stored_key_hex"),
            "[{id}] stored_key"
        );
        assert_eq!(
            hex_encode(&out.server_key),
            expect("expected_server_key_hex"),
            "[{id}] server_key"
        );
        assert_eq!(
            hex_encode(&out.client_proof),
            expect("expected_client_proof_hex"),
            "[{id}] client_proof"
        );
        assert_eq!(
            hex_encode(&out.server_signature),
            expect("expected_server_signature_hex"),
            "[{id}] server_signature"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn saved_view_vectors() {
    use protocol::{canonical_encode_saved_views, parse_saved_views_array, SavedViewParseError};

    let Some(raw) = cases_json("saved-view") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[saved-view] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "saved-view");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty(), "saved-view must have at least one case");
    assert_unique_vector_ids("saved-view", cases);

    // Mirror of `saved_view::tests::vector_error_str`. `SavedViewParseError` is
    // `#[non_exhaustive]`, so across the crate boundary this match needs a
    // catch-all — a new variant lands a vector string here and in the generator.
    fn err_str(e: &SavedViewParseError) -> &'static str {
        match e {
            SavedViewParseError::Malformed => "malformed",
            SavedViewParseError::MissingField => "missing_field",
            SavedViewParseError::WrongType => "wrong_type",
            SavedViewParseError::Unrepresentable => "unrepresentable",
            other => panic!("unmapped SavedViewParseError variant {other:?} — extend err_str"),
        }
    }

    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        let input = hex_decode(field(case, id, "input_bytes_utf8_hex"));
        match kind {
            "parse_ok" => {
                seen.insert("parse_ok");
                let (views, consumed) = parse_saved_views_array(&input)
                    .unwrap_or_else(|e| panic!("[{id}] parse_ok input did not parse: {e:?}"));
                let want_consumed = case["expected_consumed_len"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_consumed_len"))
                    as usize;
                assert_eq!(consumed, want_consumed, "[{id}] consumed-len mismatch");
                assert_eq!(
                    hex_encode(&canonical_encode_saved_views(&views)),
                    field(case, id, "expected_canonical_utf8_hex"),
                    "[{id}] canonical re-encoding mismatch"
                );
            }
            "parse_fail" => {
                seen.insert("parse_fail");
                let got = parse_saved_views_array(&input)
                    .expect_err(&format!("[{id}] parse_fail input parsed Ok"));
                assert_eq!(
                    err_str(&got),
                    field(case, id, "expected_error"),
                    "[{id}] error variant mismatch"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }
    for kind in ["parse_ok", "parse_fail"] {
        assert!(
            seen.contains(kind),
            "saved-view missing every case of case_kind '{kind}' — coverage regression"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn color_group_vectors() {
    use protocol::{canonical_encode_color_groups, parse_color_groups_array, ColorGroupParseError};

    let Some(raw) = cases_json("color-group") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[color-group] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "color-group");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty(), "color-group must have at least one case");
    assert_unique_vector_ids("color-group", cases);

    // Mirror of `color_group::tests::vector_error_str`. `ColorGroupParseError`
    // is `#[non_exhaustive]`, so across the crate boundary this match needs a
    // catch-all — a new variant lands a vector string here and in the generator.
    fn err_str(e: &ColorGroupParseError) -> &'static str {
        match e {
            ColorGroupParseError::Malformed => "malformed",
            ColorGroupParseError::MissingField => "missing_field",
            ColorGroupParseError::WrongType => "wrong_type",
            ColorGroupParseError::Unrepresentable => "unrepresentable",
            other => panic!("unmapped ColorGroupParseError variant {other:?} — extend err_str"),
        }
    }

    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        let input = hex_decode(field(case, id, "input_bytes_utf8_hex"));
        match kind {
            "parse_ok" => {
                seen.insert("parse_ok");
                let (groups, consumed) = parse_color_groups_array(&input)
                    .unwrap_or_else(|e| panic!("[{id}] parse_ok input did not parse: {e:?}"));
                let want_consumed = case["expected_consumed_len"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_consumed_len"))
                    as usize;
                assert_eq!(consumed, want_consumed, "[{id}] consumed-len mismatch");
                assert_eq!(
                    hex_encode(&canonical_encode_color_groups(&groups)),
                    field(case, id, "expected_canonical_utf8_hex"),
                    "[{id}] canonical re-encoding mismatch"
                );
            }
            "parse_fail" => {
                seen.insert("parse_fail");
                let got = parse_color_groups_array(&input)
                    .expect_err(&format!("[{id}] parse_fail input parsed Ok"));
                assert_eq!(
                    err_str(&got),
                    field(case, id, "expected_error"),
                    "[{id}] error variant mismatch"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }
    for kind in ["parse_ok", "parse_fail"] {
        assert!(
            seen.contains(kind),
            "color-group missing every case of case_kind '{kind}' — coverage regression"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn paired_extension_vectors() {
    use protocol::{
        canonical_encode_paired_extensions, parse_paired_extensions_array,
        PairedExtensionParseError,
    };

    let Some(raw) = cases_json("paired-extension") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[paired-extension] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "paired-extension");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        !cases.is_empty(),
        "paired-extension must have at least one case"
    );
    assert_unique_vector_ids("paired-extension", cases);

    fn err_str(e: &PairedExtensionParseError) -> &'static str {
        match e {
            PairedExtensionParseError::Malformed => "malformed",
            PairedExtensionParseError::MissingField => "missing_field",
            PairedExtensionParseError::WrongType => "wrong_type",
            other => {
                panic!("unmapped PairedExtensionParseError variant {other:?} — extend err_str")
            }
        }
    }

    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        let input = hex_decode(field(case, id, "input_bytes_utf8_hex"));
        match kind {
            "parse_ok" => {
                seen.insert("parse_ok");
                let (records, consumed) = parse_paired_extensions_array(&input)
                    .unwrap_or_else(|e| panic!("[{id}] parse_ok input did not parse: {e:?}"));
                let want_consumed = case["expected_consumed_len"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_consumed_len"))
                    as usize;
                assert_eq!(consumed, want_consumed, "[{id}] consumed-len mismatch");
                assert_eq!(
                    hex_encode(&canonical_encode_paired_extensions(&records)),
                    field(case, id, "expected_canonical_utf8_hex"),
                    "[{id}] canonical re-encoding mismatch"
                );
            }
            "parse_fail" => {
                seen.insert("parse_fail");
                let got = parse_paired_extensions_array(&input)
                    .expect_err(&format!("[{id}] parse_fail input parsed Ok"));
                assert_eq!(
                    err_str(&got),
                    field(case, id, "expected_error"),
                    "[{id}] error variant mismatch"
                );
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }
    for kind in ["parse_ok", "parse_fail"] {
        assert!(
            seen.contains(kind),
            "paired-extension missing every case of case_kind '{kind}' — coverage regression"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_themes_vectors() {
    use protocol::{
        decode_themes_blob, derive_subkey, encode_themes_blob_raw, SubkeyRole, ThemesBlobError,
    };

    let Some(raw) = cases_json("vault-themes") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-themes] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-themes");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 12,
        "vault-themes must carry at least 12 vectors (3 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-themes", cases);

    // Coverage guards (vault-dictionary / graph-layout parity).
    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_vault_themes_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_vault_themes_blob_hex")),
                );

                let custom_themes_key = derive_subkey(&root_key, SubkeyRole::CustomThemesKey);

                // Defensive cross-check: the optional
                // `informational_custom_themes_key_hex` must match the helper's
                // own derivation. The HKDF role "custom-themes-key" is DISTINCT
                // from the AAD role "custom-themes-blob".
                if let Some(info_hex) = case
                    .get("informational_custom_themes_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        custom_themes_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_custom_themes_key_hex disagrees with derive_subkey(root_key, CustomThemesKey)",
                    );
                }

                let actual =
                    encode_themes_blob_raw(&custom_themes_key, &account_hash, &plaintext, &nonce)
                        .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-themes encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let custom_themes_key = derive_subkey(&root_key, SubkeyRole::CustomThemesKey);
                let decoded = decode_themes_blob(&custom_themes_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] vault-themes decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let custom_themes_key = derive_subkey(&root_key, SubkeyRole::CustomThemesKey);
                match decode_themes_blob(&custom_themes_key, &account_hash, &blob) {
                    Err(ThemesBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected ThemesBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_themes_blob returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => ThemesBlobError::MagicMismatch,
                    "protocol_version_mismatch" => ThemesBlobError::ProtocolVersionMismatch,
                    // NB: the themes codec names this variant ThemesFormatUnsupported
                    // (not FormatUnsupported); the vector string stays cross-family
                    // consistent as "format_unsupported".
                    "format_unsupported" => ThemesBlobError::ThemesFormatUnsupported,
                    "header_too_short" => ThemesBlobError::HeaderTooShort,
                    "ciphertext_truncated" => ThemesBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => ThemesBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with ThemesBlobError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_themes_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_themes_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "vault-themes missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "format_unsupported",
        "header_too_short",
        "ciphertext_truncated",
        "ciphertext_len_overflow",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "vault-themes missing parse_fail coverage for ThemesBlobError '{err}' — every structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_head_state_vectors() {
    use protocol::{
        decode_head_state, derive_subkey, encode_head_state, SubkeyRole, VaultHead, VaultHeadError,
        VvEntry, DEVICE_ID_LEN, HEAD_ID_LEN,
    };

    let Some(raw) = cases_json("vault-head-state") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-head-state] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-head-state");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 9,
        "vault-head-state must carry at least 9 vectors (3 encode + 1 decode_ok + 1 mac_fail + 4 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-head-state", cases);

    fn parse_vv(val: &serde_json::Value, id: &str) -> Vec<VvEntry> {
        val.as_array()
            .unwrap_or_else(|| panic!("[{id}] version vector must be an array"))
            .iter()
            .map(|e| VvEntry {
                device_id: hex_decode_array::<DEVICE_ID_LEN>(
                    e["input_device_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] vv entry missing input_device_id_hex")),
                ),
                counter: e["counter"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] vv entry missing counter")),
            })
            .collect()
    }

    fn parse_parents(val: &serde_json::Value, id: &str) -> Vec<[u8; HEAD_ID_LEN]> {
        val.as_array()
            .unwrap_or_else(|| panic!("[{id}] prev_head_hash must be an array"))
            .iter()
            .map(|h| {
                hex_decode_array::<HEAD_ID_LEN>(
                    h.as_str()
                        .unwrap_or_else(|| panic!("[{id}] prev_head_hash entry must be a string")),
                )
            })
            .collect()
    }

    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encode" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let head = VaultHead {
                    head_format_version: case["input_head_format_version"]
                        .as_u64()
                        .unwrap_or_else(|| panic!("[{id}] missing input_head_format_version"))
                        as u8,
                    account_number_hash: hex_decode_array(
                        case["input_account_number_hash_hex"]
                            .as_str()
                            .unwrap_or_else(|| {
                                panic!("[{id}] missing input_account_number_hash_hex")
                            }),
                    ),
                    manifest_hash: hex_decode_array(
                        case["input_manifest_hash_hex"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] missing input_manifest_hash_hex")),
                    ),
                    seq: case["input_seq"]
                        .as_u64()
                        .unwrap_or_else(|| panic!("[{id}] missing input_seq")),
                    prev_head_hash: parse_parents(&case["input_prev_head_hash_hex"], id),
                    version_vector: parse_vv(&case["input_version_vector"], id),
                };

                // The declared parent_count must agree with the array it
                // describes — a port reading one and ignoring the other would
                // otherwise pass on an inconsistent fixture.
                assert_eq!(
                    case["input_parent_count"]
                        .as_u64()
                        .unwrap_or_else(|| panic!("[{id}] missing input_parent_count"))
                        as usize,
                    head.prev_head_hash.len(),
                    "[{id}] input_parent_count disagrees with input_prev_head_hash_hex length",
                );

                let sealed = head
                    .seal(&root_key)
                    .unwrap_or_else(|e| panic!("[{id}] seal failed: {e:?}"));

                // Defensive cross-checks on the informational fields.
                if let Some(info_hex) = case
                    .get("informational_head_mac_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let expected_key: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        derive_subkey(&root_key, SubkeyRole::VaultHeadMac).as_slice(),
                        expected_key.as_slice(),
                        "[{id}] informational_head_mac_key_hex disagrees with derive_subkey(root_key, VaultHeadMac)",
                    );
                }
                if let Some(info_hex) = case
                    .get("informational_head_id_hex")
                    .and_then(|v| v.as_str())
                {
                    let expected_id: [u8; HEAD_ID_LEN] = hex_decode_array(info_hex);
                    assert_eq!(
                        sealed.head_id.as_slice(),
                        expected_id.as_slice(),
                        "[{id}] informational_head_id_hex disagrees with the sealed record's head_id",
                    );
                }

                let head_format_version = case["input_head_format_version"].as_u64().unwrap() as u8;
                let actual = encode_head_state(&sealed, head_format_version);
                let expected = hex_decode(
                    case["expected_head_state_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_head_state_blob_hex")),
                );

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-head-state encode mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );

                // The MYH1 header is a pure 6-byte prefix: the remainder must
                // be the wire record verbatim, which is what lets the sibling
                // `vault-head` vectors and these agree byte-for-byte.
                assert_eq!(
                    &actual[6..],
                    sealed.record.as_slice(),
                    "[{id}] bytes after the 6-byte MYH1 header are not the sealed record verbatim",
                );
            }
            "decode_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );

                let decoded = decode_head_state(&root_key, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.head_format_version as u64,
                    case["expected_head_format_version"]
                        .as_u64()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_head_format_version")),
                    "[{id}] head_format_version mismatch",
                );
                assert_eq!(
                    hex_encode(&decoded.account_number_hash),
                    case["expected_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing expected_account_number_hash_hex")
                        }),
                    "[{id}] account_number_hash mismatch",
                );
                assert_eq!(
                    hex_encode(&decoded.manifest_hash),
                    case["expected_manifest_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_manifest_hash_hex")),
                    "[{id}] manifest_hash mismatch",
                );
                assert_eq!(
                    decoded.seq,
                    case["expected_seq"]
                        .as_u64()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_seq")),
                    "[{id}] seq mismatch",
                );
                assert_eq!(
                    decoded.prev_head_hash,
                    parse_parents(&case["expected_prev_head_hash_hex"], id),
                    "[{id}] prev_head_hash mismatch (canonical byte-sorted order expected)",
                );
                assert_eq!(
                    decoded.version_vector,
                    parse_vv(&case["expected_version_vector"], id),
                    "[{id}] version_vector mismatch (canonical device_id-sorted order expected)",
                );
            }
            "mac_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );

                match decode_head_state(&root_key, &blob) {
                    Err(VaultHeadError::MacMismatch) => {}
                    Err(other) => panic!(
                        "[{id}] expected VaultHeadError::MacMismatch, got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected mac_fail, decode_head_state returned Ok — the port is not verifying the head MAC"
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "state_magic_mismatch" => VaultHeadError::StateMagicMismatch,
                    "protocol_version_mismatch" => VaultHeadError::ProtocolVersionMismatch,
                    "format_unsupported" => VaultHeadError::FormatUnsupported,
                    "record_too_short" => VaultHeadError::RecordTooShort,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with VaultHeadError"
                    ),
                };

                // Real root_key: a port that skips a structural check reaches
                // the MAC stage and surfaces MacMismatch instead, which this
                // assertion catches. A dummy key would mask that as a
                // coincidental failure.
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                match decode_head_state(&root_key, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_head_state returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encode", "decode_ok", "mac_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "vault-head-state missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 4] = [
        "state_magic_mismatch",
        "protocol_version_mismatch",
        "format_unsupported",
        "record_too_short",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "vault-head-state missing parse_fail coverage for VaultHeadError '{err}' — every pre-MAC structural reject must be pinned"
        );
    }
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn embeddings_vectors() {
    use protocol::{
        decode_embeddings_blob, derive_subkey, encode_embeddings_blob_raw, EmbeddingsBlobError,
        SubkeyRole,
    };

    let Some(raw) = cases_json("embeddings") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[embeddings] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "embeddings");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 13,
        "embeddings must carry at least 13 vectors (3 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 7 parse_fail — the 7th being the superseded-0x01 reject added with the model-identity tagged union); found {}",
        cases.len()
    );
    assert_unique_vector_ids("embeddings", cases);

    // Coverage guards (vault-search / vault-indices parity — MYR1 is their
    // structural twin: opaque inner plaintext, model identity rides inside the
    // payload rather than the AAD).
    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "encrypt" => {
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_embeddings_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_embeddings_blob_hex")),
                );

                let ai_embeddings_key = derive_subkey(&root_key, SubkeyRole::AiEmbeddingsKey);

                // Defensive cross-check: the optional
                // `informational_ai_embeddings_key_hex` must match the helper's
                // own derivation. The HKDF role "ai-embeddings-key" is DISTINCT
                // from the AAD role "ai-embeddings-blob".
                if let Some(info_hex) = case
                    .get("informational_ai_embeddings_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        ai_embeddings_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_ai_embeddings_key_hex disagrees with derive_subkey(root_key, AiEmbeddingsKey)",
                    );
                }

                let actual = encode_embeddings_blob_raw(
                    &ai_embeddings_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] embeddings encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let ai_embeddings_key = derive_subkey(&root_key, SubkeyRole::AiEmbeddingsKey);
                let decoded = decode_embeddings_blob(&ai_embeddings_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] embeddings decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let root_key: [u8; 32] = hex_decode_array(
                    case["input_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_account_number_hash_hex")),
                );

                let ai_embeddings_key = derive_subkey(&root_key, SubkeyRole::AiEmbeddingsKey);
                match decode_embeddings_blob(&ai_embeddings_key, &account_hash, &blob) {
                    Err(EmbeddingsBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected EmbeddingsBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_embeddings_blob returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_error = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_error"));
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => EmbeddingsBlobError::MagicMismatch,
                    "protocol_version_mismatch" => EmbeddingsBlobError::ProtocolVersionMismatch,
                    "format_unsupported" => EmbeddingsBlobError::FormatUnsupported,
                    "header_too_short" => EmbeddingsBlobError::HeaderTooShort,
                    "ciphertext_truncated" => EmbeddingsBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => EmbeddingsBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}' — schema enforces enum; update this match arm in lockstep with EmbeddingsBlobError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_embeddings_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_embeddings_blob returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' — schema enforces enum"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "embeddings missing every case of case_kind '{kind}' — coverage regression"
        );
    }
    let required_parse_errors: [&str; 6] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "format_unsupported",
        "header_too_short",
        "ciphertext_truncated",
        "ciphertext_len_overflow",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "embeddings missing parse_fail coverage for EmbeddingsBlobError '{err}' — every structural reject must be pinned"
        );
    }
}
