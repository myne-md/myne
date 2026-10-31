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
// Every runner in this file executes natively and **inside a browser** (the
// count used to be written out here and had drifted six runners behind before
// anyone noticed. A hand-maintained number nothing executes is not a fact
// about anything, the same reason `the_browser_lane_carries_every_category`
// stopped carrying a row count). Cross-
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
/// The native lane's skip-on-absent-companion contract (`protocol/AGENTS.md`)
/// is right for a contributor with no companion checked out and wrong for the
/// one CI step whose entire job is to assert: there, `[skip]` on every runner
/// reports green having verified nothing. That step is live
/// (`.woodpecker/main.yml` `vector-verification`), and `MYNE_VECTORS_REQUIRED`
/// turns a missing fixture into a loud panic rather than a green skip, so an
/// expired token or a moved ref cannot return the step to green-and-empty.
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
///   is the long-standing contract (`protocol/AGENTS.md`): the companion is
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
/// Keeping this list complete is enforced rather than remembered :
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
            "group-roster",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/group-roster/v0.2/cases.json"),
        ),
        (
            "awareness-frame",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/awareness-frame/v0.2/cases.json"),
        ),
        (
            "agent-memory-blob",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/agent-memory-blob/v0.1/cases.json"),
        ),
        (
            "agent-memory-blob",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/agent-memory-blob/v0.2/cases.json"),
        ),
        (
            "agent-memory-catalog",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/agent-memory-catalog/v0.1/cases.json"),
        ),
        (
            "agent-memory-catalog",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/agent-memory-catalog/v0.2/cases.json"),
        ),
        (
            "agent-personality",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/agent-personality/v0.1/cases.json"),
        ),
        (
            "agent-personality",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/agent-personality/v0.2/cases.json"),
        ),
        (
            "account-number",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/account-number/v0.1/cases.json"),
        ),
        (
            "person-account-number",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/person-account-number/v0.2/cases.json"),
        ),
        (
            "argon2id",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/argon2id/v0.1/cases.json"),
        ),
        (
            "person-keypair",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/person-keypair/v0.2/cases.json"),
        ),
        (
            "person-identity",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/person-identity/v0.2/cases.json"),
        ),
        (
            "person-member-unlock-store",
            "v0.2",
            include_str!(
                "../../myne-test-vectors/vectors/person-member-unlock-store/v0.2/cases.json"
            ),
        ),
        (
            "person-vault-carrier",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/person-vault-carrier/v0.2/cases.json"),
        ),
        (
            "person-profile",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/person-profile/v0.2/cases.json"),
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
            "chats-blob",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/chats-blob/v0.1/cases.json"),
        ),
        (
            "chats-blob",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/chats-blob/v0.2/cases.json"),
        ),
        (
            "chats-catalog",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/chats-catalog/v0.1/cases.json"),
        ),
        (
            "chats-catalog",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/chats-catalog/v0.2/cases.json"),
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
            "device-binding",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/device-binding/v0.2/cases.json"),
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
            "hkdf-sha256",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/hkdf-sha256/v0.2/cases.json"),
        ),
        (
            "manifest",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/manifest/v0.1/cases.json"),
        ),
        (
            "member-names",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/member-names/v0.2/cases.json"),
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
            "vault-label",
            "v0.1",
            include_str!("../../myne-test-vectors/vectors/vault-label/v0.1/cases.json"),
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
            "vault-meta-ntv7",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/vault-meta-ntv7/v0.2/cases.json"),
        ),
        (
            "vault-meta-ntv8",
            "v0.2",
            include_str!("../../myne-test-vectors/vectors/vault-meta-ntv8/v0.2/cases.json"),
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

/// Two `encrypt` cases sharing `(root_key, account_number_hash, prefs_nonce)`
/// seal different plaintexts under the same key and nonce, so their ciphertexts
/// share XChaCha20 keystream. Nothing is exposed here (the key is a fixed public
/// test value), but these are the bytes an independent implementation copies
/// from, and the family's nonce "registry" was prose that nothing checked.
///
/// A RATCHET, not a gate on the whole family. Three pairs already collided
/// before anyone looked; re-minting a published case changes bytes other ports
/// pin against, which belongs in its own change. So those three are named below
/// and the list may shrink and never grow. A fourth collision fails here.
fn assert_distinct_prefs_nonces(cases: &[serde_json::Value]) {
    /// The three pairs that already collided, keyed by the LATER case's id. Each
    /// entry is debt: remove it when that case is re-minted onto a free nonce.
    ///
    /// **Removing an entry is a PAIRED change across two repositories, and
    /// nothing enforces the ordering.** The re-mint happens in
    /// `myne-test-vectors` (a new nonce, a new blob, a new `expected_*_hex`) and
    /// the deletion happens here, so doing either alone turns this test red:
    /// delete first and the collision is still in the companion's cases; re-mint
    /// first and this list names a collision that no longer exists, which the
    /// stale-entry half of this check refuses. Stated because the whole point of
    /// the ratchet is that whoever pays the debt down is a later reader, and a
    /// later reader has no other way to learn that the two edits belong
    /// together.
    const KNOWN_COLLISIONS: &[(&str, &str)] = &[
        (
            "vault-prefs/v0.1/encrypt-ai-provider",
            "collides with encrypt-last-backup-at (nonce f1..)",
        ),
        (
            "vault-prefs/v0.1/encrypt-keymap",
            "collides with encrypt-editor-line-numbers (nonce f4..)",
        ),
        (
            "vault-prefs/v0.1/encrypt-device-names",
            "collides with encrypt-right-panel-tabs (nonce f6..)",
        ),
    ];

    let mut seen: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let mut excused: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for case in cases {
        if case["case_kind"].as_str() != Some("encrypt") {
            continue;
        }
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let (Some(root), Some(hash), Some(nonce)) = (
            case["input_root_key_hex"].as_str(),
            case["input_account_number_hash_hex"].as_str(),
            case["input_prefs_nonce_hex"].as_str(),
        ) else {
            continue;
        };
        let key = format!("{root}|{hash}|{nonce}");
        if let Some(first) = seen.get(&key) {
            let excuse = KNOWN_COLLISIONS.iter().find(|(name, _)| *name == id);
            match excuse {
                Some((_, reason)) => {
                    excused.insert(id);
                    eprintln!(
                        "[vault-prefs] known nonce collision, not yet re-minted: {id} ({reason})"
                    );
                }
                None => panic!(
                    "[vault-prefs] {id} reuses (root_key, account_number_hash, prefs_nonce) \
                     already used by {first}. Two plaintexts sealed under one key and nonce \
                     share keystream. Mint this case on a free nonce."
                ),
            }
        } else {
            seen.insert(key, id.to_string());
        }
    }
    // The other direction: an entry whose case has been re-minted (or removed)
    // is stale, and a stale exemption is how a ratchet stops ratcheting.
    for (name, _) in KNOWN_COLLISIONS {
        assert!(
            excused.contains(name),
            "[vault-prefs] KNOWN_COLLISIONS still lists {name}, which no longer collides. \
             Remove the entry: the list may shrink, never grow."
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
    assert_distinct_prefs_nonces(cases);

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
    use protocol::{derive_subkey, derive_subkey_v0_2, SubkeyRole};

    let mut seen_roles: Vec<SubkeyRole> = Vec::new();

    // Skip contract (`missing_fixture`): with no companion at all there is
    // nothing to verify. The ALL pin below runs only when at least one file
    // loaded; a present-but-old companion (v0.1 without the v0.2 category)
    // fails the pin on MembershipKey by design, which is the stale-companion
    // signal, not a skip.
    let v01 = cases_json("hkdf-sha256");
    let v02 = cases_json_for("hkdf-sha256", "v0.2");
    if v01.is_none() && v02.is_none() {
        return;
    }

    // v0.1 file: every role except MembershipKey, derived under the v0.1
    // prefix. MembershipKey lives in the v0.2 file below: pinning it here
    // would bless a KEK no shipped path derives (myne-md/myne#684 review).
    if let Some(raw) = v01 {
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
                "personal-dictionary-sync-id" => SubkeyRole::PersonalDictSyncId,
                "vault-indices-key" => SubkeyRole::VaultIndicesKey,
                "attachment-text-key" => SubkeyRole::AttachmentTextKey,
                "catalog-sync-id" => SubkeyRole::CatalogSyncId,
                "prefs-sync-id" => SubkeyRole::PrefsSyncId,
                "custom-themes-key" => SubkeyRole::CustomThemesKey,
                "themes-sync-id" => SubkeyRole::ThemesSyncId,
                "chats-catalog-key" => SubkeyRole::ChatsCatalogKey,
                "chats-catalog-sync-id" => SubkeyRole::ChatsCatalogSyncId,
                "chats-key" => SubkeyRole::ChatsKey,
                "agent-memory-catalog-key" => SubkeyRole::AgentMemoryCatalogKey,
                "agent-memory-catalog-sync-id" => SubkeyRole::AgentMemoryCatalogSyncId,
                "agent-memory-key" => SubkeyRole::AgentMemoryKey,
                "agent-personality-key" => SubkeyRole::AgentPersonalityKey,
                "agent-personality-sync-id" => SubkeyRole::AgentPersonalitySyncId,
                "vault-head-mac" => SubkeyRole::VaultHeadMac,
                "server-auth" => SubkeyRole::ServerAuth,
                "graph-layout-key" => SubkeyRole::GraphLayoutKey,
                "membership-key" => panic!(
                    "[{id}] membership-key MUST NOT appear in the v0.1 file: it derives under the v0.2 prefix (see the v0.2 file below)"
                ),
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
    }

    // v0.2 file: exactly the membership KEK, derived under the v0.2 prefix.
    // The envelope (vector_id, protocol_version, info assembly) must all say
    // v0.2; a v0.1 info here would re-bless the wrong KEK.
    if let Some(raw) = v02 {
        let doc: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("[hkdf-sha256/v0.2] parse cases.json: {e}"));

        assert_eq!(doc["schema"], "hkdf-sha256");
        assert_eq!(doc["protocol_version"], "v0.2");

        let cases = doc["cases"].as_array().expect("cases must be a JSON array");
        assert_unique_vector_ids("hkdf-sha256/v0.2", cases);

        for case in cases {
            let id = case["vector_id"]
                .as_str()
                .expect("vector_id must be a string");
            assert!(
                id.starts_with("hkdf-sha256/v0.2/"),
                "[{id}] v0.2 file must carry v0.2 vector ids"
            );

            let root_key: [u8; 32] = hex_decode_array(
                case["input_root_key_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_root_key_hex")),
            );
            let role_str = case["input_role"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_role"));
            let role = match role_str {
                "membership-key" => SubkeyRole::MembershipKey,
                "person-vault-carrier" => SubkeyRole::PersonVaultCarrier,
                "awareness-room-id" => SubkeyRole::AwarenessRoomId,
                "awareness-key" => SubkeyRole::AwarenessKey,
                other => panic!("[{id}] unexpected v0.2 role {other:?}"),
            };
            let expected = hex_decode(
                case["expected_subkey_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_subkey_hex")),
            );

            if !seen_roles.contains(&role) {
                seen_roles.push(role);
            }

            if let Some(info_hex) = case
                .get("informational_info_utf8_hex")
                .and_then(|v| v.as_str())
            {
                let info_bytes = hex_decode(info_hex);
                let mut expected_info = b"myne.v0.2 ".to_vec();
                expected_info.extend_from_slice(role_str.as_bytes());
                assert_eq!(
                    info_bytes, expected_info,
                    "[{id}] informational_info_utf8_hex disagrees with the canonical \"myne.v0.2 \" || role assembly",
                );
            }

            let actual = derive_subkey_v0_2(&root_key, role);

            assert_eq!(
                actual.as_slice(),
                expected.as_slice(),
                "[{id}] hkdf-sha256/v0.2 subkey mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                hex_encode(&expected),
                hex_encode(&*actual),
            );
        }
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
                    membership: None,
                    person_binding: None,
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
        aad_graph_layout_blob, aad_note_content_encrypt, aad_note_item_key_wrap, aad_password_wrap,
        aad_personal_dictionary_blob, aad_prefs_blob, aad_quick_unlock_blob, aad_recovery_wrap,
        aad_search_index_blob, aad_vault_indices_blob, aad_vault_items_key_wrap,
        aad_workspace_blob, aead_open_ctx, aead_seal_ctx, KdfParams, ProtocolError,
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
    let required: [&str; 12] = [
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

/// `person-account-number` (myne-md/myne#911): the number a person identity
/// derives, pinned from the phrase all the way to the display form.
///
/// The family exists because the number is load-bearing through IDENTITY rather
/// than through cryptography: two ports that read a different 95-bit window of
/// the person id print different numbers for the same phrase, and the number is
/// what two people read to each other during a support handoff or a self-host
/// setup. Nothing here is secret.
#[test]
fn person_account_number_vectors() {
    use protocol::{account_number_from_person_id, person_id_hash};

    let Some(raw) = cases_json_v0_2("person-account-number") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[person-account-number/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "person-account-number");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 5,
        "person-account-number must carry at least 5 vectors; found {}",
        cases.len()
    );
    assert_unique_vector_ids("person-account-number/v0.2", cases);

    // The two cases whose EXPECTED value is hand-computable. Asserting they are
    // present is what keeps the family from degrading into "whatever our
    // implementation printed": a swapped window cannot pass these two.
    let mut saw_zero_id = false;
    let mut saw_top_bit = false;

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let person_id: [u8; 16] = hex_decode_array(
            case["input_person_id_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_person_id_hex")),
        );
        let expected_canonical = case["expected_canonical_ascii"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing expected_canonical_ascii"));
        let expected_display = case["expected_display_ascii"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing expected_display_ascii"));
        let expected_hash: [u8; 16] = hex_decode_array(
            case["expected_account_number_hash_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_account_number_hash_hex")),
        );

        // Hop 1, where a phrase is carried: the id is a pure function of the
        // normalized phrase, so a port that games hop 2 still has to agree here.
        if let Some(phrase_hex) = case["input_phrase_utf8_hex"].as_str() {
            let phrase = hex_decode(phrase_hex);
            let phrase = core::str::from_utf8(&phrase)
                .unwrap_or_else(|e| panic!("[{id}] phrase is not UTF-8: {e}"));
            assert_eq!(
                person_id_hash(phrase),
                person_id,
                "[{id}] person id does not match SHA-256('myne.person-id|' || phrase)[:16]"
            );
        }

        let acct = account_number_from_person_id(&person_id);
        assert_eq!(
            &acct.canonical,
            expected_canonical.as_bytes(),
            "[{id}] canonical mismatch (expected {expected_canonical})"
        );
        assert_eq!(acct.display, expected_display, "[{id}] display mismatch");
        assert_eq!(
            &acct.hash, &expected_hash,
            "[{id}] account_number_hash mismatch"
        );

        // The derived number is an ordinary account number: the one parser must
        // accept it, or a number read out loud cannot be typed back.
        let reparsed = protocol::parse_account_number(expected_display)
            .unwrap_or_else(|e| panic!("[{id}] derived display must parse: {e:?}"));
        assert_eq!(reparsed, acct, "[{id}] parse round-trip mismatch");

        if person_id == [0u8; 16] {
            saw_zero_id = true;
            assert_eq!(
                expected_canonical, "00000000000000000000",
                "[{id}] an all-zero id must encode as the all-zero body"
            );
        }
        let mut top_bit = [0u8; 16];
        top_bit[0] = 0x80;
        if person_id == top_bit {
            saw_top_bit = true;
            assert_eq!(
                expected_canonical, "G000000000000000000F",
                "[{id}] bit 127 must land in the FIRST five-bit group"
            );
        }
    }

    assert!(
        saw_zero_id && saw_top_bit,
        "person-account-number must keep the two hand-computable orientation \
         cases (all-zero id, bit 127 only); without them a swapped 95-bit window \
         passes every other case in the family"
    );
}

/// `vault-meta-ntv7` (myne-md/myne#911): the person-wrapped generation.
///
/// Three things are pinned and none of them is the seal's randomness: the FRAME
/// (parse then re-serialize is byte-identical), its STRUCTURAL rejections (the
/// three retired phrase-wrap fields included), and that a given envelope opens
/// to one root key or fails closed.
#[test]
fn vault_meta_ntv7_vectors() {
    use protocol::vault_meta_ntv7::{
        open_person_wrapped_root_key, parse_vault_meta_ntv7, serialize_vault_meta_ntv7, PersonWrap,
    };

    let Some(raw) = cases_json_v0_2("vault-meta-ntv7") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-meta-ntv7/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "vault-meta-ntv7");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 13,
        "vault-meta-ntv7 must carry at least 13 vectors; found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-meta-ntv7/v0.2", cases);

    let mut kinds = std::collections::HashSet::new();
    let mut phrase_wrap_rejects = 0usize;

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        kinds.insert(kind.to_string());

        match kind {
            "roundtrip" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_blob = hex_decode(
                    case["expected_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_blob_hex")),
                );
                let meta = parse_vault_meta_ntv7(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] NTV7 frame must parse: {e:?}"));

                assert_eq!(
                    meta.group_key_epoch as u64,
                    case["expected_group_key_epoch"]
                        .as_u64()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_group_key_epoch")),
                    "[{id}] group_key_epoch"
                );
                assert_eq!(
                    meta.signed_roster_envelope.len(),
                    case["expected_signed_roster_len"]
                        .as_u64()
                        .expect("[{id}] missing expected_signed_roster_len")
                        as usize,
                    "[{id}] signed_roster_len"
                );
                assert_eq!(
                    hex_encode(&meta.base.account_number_hash),
                    case["expected_base_account_number_hash_hex"]
                        .as_str()
                        .expect("[{id}] missing expected_base_account_number_hash_hex"),
                    "[{id}] base account_number_hash"
                );
                assert_eq!(
                    hex_encode(&meta.base.items_key_id),
                    case["expected_base_items_key_id_hex"]
                        .as_str()
                        .expect("[{id}] missing expected_base_items_key_id_hex"),
                    "[{id}] base items_key_id"
                );
                assert_eq!(
                    hex_encode(&meta.person_wrap.ml_kem_ct),
                    case["expected_person_wrap_ml_kem_ct_hex"]
                        .as_str()
                        .expect("[{id}] missing expected_person_wrap_ml_kem_ct_hex")
                );
                assert_eq!(
                    hex_encode(&meta.person_wrap.ed_ephemeral_pk),
                    case["expected_person_wrap_ed_ephemeral_pk_hex"]
                        .as_str()
                        .expect("[{id}] missing expected_person_wrap_ed_ephemeral_pk_hex")
                );
                assert_eq!(
                    hex_encode(&meta.person_wrap.nonce),
                    case["expected_person_wrap_nonce_hex"]
                        .as_str()
                        .expect("[{id}] missing expected_person_wrap_nonce_hex")
                );
                assert_eq!(
                    hex_encode(&meta.person_wrap.wrapped_root_key),
                    case["expected_person_wrap_wrapped_root_key_hex"]
                        .as_str()
                        .expect("[{id}] missing expected_person_wrap_wrapped_root_key_hex")
                );

                // Re-serialization is the half a parse-only case cannot see: a
                // port that reads every field and writes a different frame is
                // caught here and nowhere else.
                let re = serialize_vault_meta_ntv7(&meta)
                    .unwrap_or_else(|e| panic!("[{id}] re-serialize failed: {e:?}"));
                assert_eq!(
                    hex_encode(&re),
                    hex_encode(&expected_blob),
                    "[{id}] parse then re-serialize is not byte-identical"
                );

                // The generation boundary, checked from the OLD reader's side: a
                // client that predates NTV7 must refuse the magic rather than
                // read the tail as an NTV6 one and stop at the roster.
                assert!(
                    protocol::parse_vault_meta_ntv6(&blob).is_err(),
                    "[{id}] an NTV6 reader must refuse an NTV7 frame"
                );
                assert!(
                    protocol::parse_vault_meta_v0_2(&blob).is_err(),
                    "[{id}] the NTV5 reader must refuse an NTV7 frame"
                );
                assert_eq!(
                    protocol::meta_version_of(&blob),
                    Some(protocol::MetaVersion::V0_2),
                    "[{id}] NTV7 is a v0.2 generation, not a fifth client generation"
                );
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                assert_eq!(
                    case["expected_kind"].as_str(),
                    Some("invalid_meta"),
                    "[{id}] the family pins ONE non-distinguishing rejection"
                );
                assert!(
                    parse_vault_meta_ntv7(&blob).is_err(),
                    "[{id}] must be rejected: {}",
                    case["informational_reason"].as_str().unwrap_or("")
                );
                // The phrase-wrap trio is the load-bearing subset of this kind:
                // those three cases are what make "the generation retired the
                // phrase wrap" a checked claim rather than a comment.
                if id.contains("live-recovery") {
                    phrase_wrap_rejects += 1;
                }
            }
            "person_wrap_open" | "person_wrap_open_fail" => {
                let kem_seed: [u8; 64] = hex_decode_array(
                    case["input_kem_seed_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_kem_seed_hex")),
                );
                let ed_seed: [u8; 32] = hex_decode_array(
                    case["input_ed25519_seed_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_ed25519_seed_hex")),
                );
                let mldsa_seed: [u8; 32] = hex_decode_array(
                    case["input_mldsa_seed_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_mldsa_seed_hex")),
                );
                let items_key_id: [u8; 16] = hex_decode_array(
                    case["input_items_key_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_items_key_id_hex")),
                );
                let wrap = PersonWrap {
                    ml_kem_ct: hex_decode_array(
                        case["input_person_wrap_ml_kem_ct_hex"]
                            .as_str()
                            .expect("[{id}] missing input_person_wrap_ml_kem_ct_hex"),
                    ),
                    ed_ephemeral_pk: hex_decode_array(
                        case["input_person_wrap_ed_ephemeral_pk_hex"]
                            .as_str()
                            .expect("[{id}] missing input_person_wrap_ed_ephemeral_pk_hex"),
                    ),
                    nonce: hex_decode_array(
                        case["input_person_wrap_nonce_hex"]
                            .as_str()
                            .expect("[{id}] missing input_person_wrap_nonce_hex"),
                    ),
                    wrapped_root_key: hex_decode_array(
                        case["input_person_wrap_wrapped_root_key_hex"]
                            .as_str()
                            .expect("[{id}] missing input_person_wrap_wrapped_root_key_hex"),
                    ),
                };
                let owner = protocol::PersonKeyPair::generate_raw(&kem_seed, &ed_seed, &mldsa_seed);
                let opened = open_person_wrapped_root_key(&owner, &wrap, &items_key_id);
                if kind == "person_wrap_open" {
                    let expected: [u8; 32] = hex_decode_array(
                        case["expected_root_key_hex"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] missing expected_root_key_hex")),
                    );
                    let opened =
                        opened.unwrap_or_else(|e| panic!("[{id}] person wrap must open: {e:?}"));
                    assert_eq!(&*opened, &expected, "[{id}] root_key mismatch");
                } else {
                    assert_eq!(
                        case["expected_kind"].as_str(),
                        Some("aead_fail"),
                        "[{id}] a refused open is one non-distinguishing result"
                    );
                    assert!(
                        opened.is_err(),
                        "[{id}] must fail closed: {}",
                        case["informational_reason"].as_str().unwrap_or("")
                    );
                }
            }
            other => panic!("[{id}] unknown case_kind {other:?}"),
        }
    }

    for required in [
        "roundtrip",
        "parse_fail",
        "person_wrap_open",
        "person_wrap_open_fail",
    ] {
        assert!(
            kinds.contains(required),
            "vault-meta-ntv7 lost its {required} case kind"
        );
    }
    assert_eq!(
        phrase_wrap_rejects, 3,
        "all three retired phrase-wrap fields (salt, nonce, ciphertext) must keep \
         their own rejection case"
    );
}

/// `vault-meta-ntv8` (myne-md/myne#938): the password-only generation.
///
/// Four things are pinned. The FRAME (parse then re-serialize is byte-identical,
/// with the tail fields read back at their offsets). The CREDENTIAL (the same
/// password opens it to one root key, which is the half no parse-side case can
/// see: a drifted salt domain, AAD role or KDF block parses every field
/// correctly and then fails here). The UPGRADE (an `NTV7` frame becomes this one
/// by truncation, so the password still opens it). And the STRUCTURAL rejections,
/// of which the length rule is the load-bearing one: `NTV7` and `NTV8` share
/// every byte of the tail, so only the magic and 1208 bytes of length separate
/// them, and a lenient reader would accept an `NTV7` file and then wait for a
/// credential the user no longer has.
#[test]
fn vault_meta_ntv8_vectors() {
    use protocol::vault_meta_ntv8::{
        parse_vault_meta_ntv8, serialize_vault_meta_ntv8, NTV8_FIXED_LEN,
    };
    use protocol::vault_meta_v0_2::unlock_root_key_v0_2_password;

    let Some(raw) = cases_json_v0_2("vault-meta-ntv8") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-meta-ntv8/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "vault-meta-ntv8");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 14,
        "vault-meta-ntv8 must carry at least 14 vectors; found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-meta-ntv8/v0.2", cases);

    let mut kinds = std::collections::HashSet::new();
    let mut phrase_wrap_rejects = 0usize;
    let mut length_reject = false;

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        kinds.insert(kind.to_string());

        match kind {
            "roundtrip" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let expected_blob = hex_decode(
                    case["expected_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_blob_hex")),
                );
                let meta = parse_vault_meta_ntv8(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] NTV8 frame must parse: {e:?}"));

                assert_eq!(
                    blob.len(),
                    NTV8_FIXED_LEN + meta.signed_roster_envelope.len(),
                    "[{id}] the frame is 445 + roster_len and nothing else"
                );
                assert_eq!(
                    meta.group_key_epoch,
                    case["expected_group_key_epoch"]
                        .as_u64()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_group_key_epoch")),
                    "[{id}] group_key_epoch"
                );
                assert_eq!(
                    meta.signed_roster_envelope.len(),
                    case["expected_signed_roster_len"]
                        .as_u64()
                        .expect("[{id}] missing expected_signed_roster_len")
                        as usize,
                    "[{id}] signed_roster_len"
                );
                assert_eq!(
                    hex_encode(&meta.base.account_number_hash),
                    case["expected_base_account_number_hash_hex"]
                        .as_str()
                        .expect("[{id}] missing expected_base_account_number_hash_hex"),
                    "[{id}] base account_number_hash"
                );
                assert_eq!(
                    hex_encode(&meta.base.items_key_id),
                    case["expected_base_items_key_id_hex"]
                        .as_str()
                        .expect("[{id}] missing expected_base_items_key_id_hex"),
                    "[{id}] base items_key_id"
                );
                // The frame's OWN KDF parameters. A port that ignores them and
                // applies its own defaults derives a different wrap key while
                // parsing every byte correctly, and the `password_opens` case is
                // where that surfaces; pinning them here names which field moved.
                assert_eq!(
                    meta.base.kdf_params.m_kib as u64,
                    case["expected_kdf_m_kib"]
                        .as_u64()
                        .expect("[{id}] missing expected_kdf_m_kib"),
                    "[{id}] kdf m_kib"
                );
                assert_eq!(
                    meta.base.kdf_params.t as u64,
                    case["expected_kdf_t"]
                        .as_u64()
                        .expect("[{id}] missing expected_kdf_t"),
                    "[{id}] kdf t"
                );
                assert_eq!(
                    meta.base.kdf_params.p as u64,
                    case["expected_kdf_p"]
                        .as_u64()
                        .expect("[{id}] missing expected_kdf_p"),
                    "[{id}] kdf p"
                );
                assert_eq!(
                    meta.base.kdf_params.argon2_version as u64,
                    case["expected_kdf_argon2_version"]
                        .as_u64()
                        .expect("[{id}] missing expected_kdf_argon2_version"),
                    "[{id}] argon2_version"
                );
                assert_eq!(
                    case["expected_phrase_wrap_zeroed"].as_bool(),
                    Some(true),
                    "[{id}] the retired phrase wrap is structural, not optional"
                );
                // Checked field by field rather than through a helper, because
                // the helper is crate-private and this runner is the OUTSIDE view
                // a port author has: three explicit zero assertions say what the
                // rule is without borrowing the implementation's own predicate.
                assert_eq!(
                    meta.base.random_salt_recovery,
                    [0u8; protocol::vault_meta::VAULT_META_SALT_RANDOM_LEN],
                    "[{id}] the retired recovery salt must be all zero"
                );
                assert_eq!(
                    meta.base.nonce_recovery_wrap,
                    [0u8; protocol::aead::AEAD_NONCE_LEN],
                    "[{id}] the retired recovery nonce must be all zero"
                );
                assert_eq!(
                    meta.base.enc_root_key_recovery,
                    [0u8; protocol::vault_meta::VAULT_META_WRAPPED_ROOT_KEY_LEN],
                    "[{id}] the retired recovery-wrapped root_key must be all zero"
                );
                assert_eq!(
                    case["expected_person_wrap_absent"].as_bool(),
                    Some(true),
                    "[{id}] this generation has no person envelope"
                );

                // Re-serialization is the half a parse-only case cannot see.
                let re = serialize_vault_meta_ntv8(&meta)
                    .unwrap_or_else(|e| panic!("[{id}] re-serialize failed: {e:?}"));
                assert_eq!(
                    hex_encode(&re),
                    hex_encode(&expected_blob),
                    "[{id}] parse then re-serialize is not byte-identical"
                );

                // The generation boundary, from the OLD readers' side. An NTV7
                // reader must refuse the magic rather than read the tail and then
                // demand 1208 bytes that are not there.
                assert!(
                    protocol::vault_meta_ntv7::parse_vault_meta_ntv7(&blob).is_err(),
                    "[{id}] an NTV7 reader must refuse an NTV8 frame"
                );
                assert!(
                    protocol::parse_vault_meta_ntv6(&blob).is_err(),
                    "[{id}] an NTV6 reader must refuse an NTV8 frame"
                );
                assert!(
                    protocol::parse_vault_meta_v0_2(&blob).is_err(),
                    "[{id}] the NTV5 reader must refuse an NTV8 frame"
                );
                assert_eq!(
                    protocol::meta_version_of(&blob),
                    Some(protocol::MetaVersion::V0_2),
                    "[{id}] NTV8 is a v0.2 generation, not a sixth client generation"
                );
            }
            "password_opens" | "password_open_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                let password = String::from_utf8(hex_decode(
                    case["input_password_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_password_utf8_hex")),
                ))
                .unwrap_or_else(|e| panic!("[{id}] password is not UTF-8: {e}"));
                let meta = parse_vault_meta_ntv8(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] NTV8 frame must parse: {e:?}"));
                let opened = unlock_root_key_v0_2_password(
                    &meta.base,
                    &password,
                    &meta.base.account_number_hash,
                );
                if kind == "password_opens" {
                    let expected: [u8; 32] = hex_decode_array(
                        case["expected_root_key_hex"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] missing expected_root_key_hex")),
                    );
                    let opened = opened.unwrap_or_else(|e| {
                        panic!(
                            "[{id}] the master password must open the frame: {e:?}. A \
                             parse-side mismatch would have failed above, so a failure \
                             here means the salt domain, the AAD role or the KDF block \
                             diverged."
                        )
                    });
                    assert_eq!(&*opened, &expected, "[{id}] root_key mismatch");
                } else {
                    assert_eq!(
                        case["expected_kind"].as_str(),
                        Some("aead_fail"),
                        "[{id}] a refused open is one non-distinguishing result"
                    );
                    assert_eq!(
                        opened.err(),
                        Some(protocol::ProtocolError::AeadFailure),
                        "[{id}] must fail closed: {}",
                        case["informational_reason"].as_str().unwrap_or("")
                    );
                }
            }
            "upgrade" => {
                let before = hex_decode(
                    case["input_ntv7_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_ntv7_blob_hex")),
                );
                let expected = hex_decode(
                    case["expected_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_blob_hex")),
                );
                let dropped = case["expected_dropped_person_wrap_len"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_dropped_person_wrap_len"))
                    as usize;
                assert_eq!(
                    dropped,
                    protocol::vault_meta_ntv7::PERSON_WRAP_LEN,
                    "[{id}] the envelope this generation drops is a fixed length"
                );
                assert_eq!(
                    before.len(),
                    expected.len() + dropped,
                    "[{id}] the upgrade removes exactly the person envelope"
                );

                // The step, expressed the way a port implements it: parse the old
                // generation, move its five tail fields across, serialize.
                let old = protocol::vault_meta_ntv7::parse_vault_meta_ntv7(&before)
                    .unwrap_or_else(|e| panic!("[{id}] the NTV7 input must parse: {e:?}"));
                let upgraded = protocol::vault_meta_ntv8::PasswordOnlyVaultMeta {
                    base: old.base,
                    group_key_nonce: old.group_key_nonce,
                    enc_group_key: old.enc_group_key,
                    group_key_epoch: old.group_key_epoch,
                    signed_roster_envelope: old.signed_roster_envelope,
                };
                let bytes = serialize_vault_meta_ntv8(&upgraded)
                    .unwrap_or_else(|e| panic!("[{id}] upgrade serialize failed: {e:?}"));
                assert_eq!(
                    hex_encode(&bytes),
                    hex_encode(&expected),
                    "[{id}] the upgrade must reproduce these bytes exactly. A port that \
                     re-derives or re-wraps anything lands elsewhere here."
                );

                // Truncation, not a re-wrap: every surviving byte after the magic
                // is identical to the input's. This is the assertion that makes
                // "the password the user already has still opens the file" a fact
                // about the bytes rather than a hope.
                assert_eq!(
                    &before[4..expected.len()],
                    &expected[4..],
                    "[{id}] the upgrade must truncate: every surviving byte after the \
                     magic identical, so no key was re-wrapped"
                );

                let password = String::from_utf8(hex_decode(
                    case["input_password_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_password_utf8_hex")),
                ))
                .unwrap_or_else(|e| panic!("[{id}] password is not UTF-8: {e}"));
                let expected_root: [u8; 32] = hex_decode_array(
                    case["expected_root_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_root_key_hex")),
                );
                for (label, blob) in [("NTV7", &before), ("NTV8", &expected)] {
                    let meta = if label == "NTV7" {
                        let m = protocol::vault_meta_ntv7::parse_vault_meta_ntv7(blob)
                            .expect("NTV7 parses");
                        protocol::vault_meta_ntv8::PasswordOnlyVaultMeta {
                            base: m.base,
                            group_key_nonce: m.group_key_nonce,
                            enc_group_key: m.enc_group_key,
                            group_key_epoch: m.group_key_epoch,
                            signed_roster_envelope: m.signed_roster_envelope,
                        }
                    } else {
                        parse_vault_meta_ntv8(blob).expect("NTV8 parses")
                    };
                    let opened = unlock_root_key_v0_2_password(
                        &meta.base,
                        &password,
                        &meta.base.account_number_hash,
                    )
                    .unwrap_or_else(|e| {
                        panic!("[{id}] the same password must open the {label} frame: {e:?}")
                    });
                    assert_eq!(
                        &*opened, &expected_root,
                        "[{id}] the upgrade must not move the credential: the {label} \
                         frame opens to the same root_key"
                    );
                }
            }
            "parse_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );
                assert_eq!(
                    case["expected_kind"].as_str(),
                    Some("invalid_meta"),
                    "[{id}] the family pins ONE non-distinguishing rejection"
                );
                assert!(
                    parse_vault_meta_ntv8(&blob).is_err(),
                    "[{id}] must be rejected: {}",
                    case["informational_reason"].as_str().unwrap_or("")
                );
                // The phrase-wrap trio is the load-bearing subset of this kind:
                // those three cases are what make "the generation retired the
                // phrase wrap" a checked claim rather than a comment.
                if id.contains("live-recovery") {
                    phrase_wrap_rejects += 1;
                }
                // ...and the length rule is what separates this generation from
                // the one it upgrades from, since every other byte matches.
                if id.contains("person-wrap-present") {
                    length_reject = true;
                    // The premise, and the reason this case exists at all: the
                    // fixture has to be a frame the NTV7 parser ACCEPTS. A frame
                    // assembled by gluing 1208 bytes onto an NTV8 one is rejected
                    // on its magic instead, so it would pass while proving nothing
                    // about the length rule.
                    assert!(
                        protocol::vault_meta_ntv7::parse_vault_meta_ntv7(&blob).is_ok(),
                        "[{id}] the fixture must be a VALID NTV7 frame, or the length \
                         rule is not what rejected it"
                    );
                    let roster_len =
                        u32::from_be_bytes([blob[441], blob[442], blob[443], blob[444]]) as usize;
                    assert_eq!(
                        blob.len(),
                        NTV8_FIXED_LEN + roster_len + protocol::vault_meta_ntv7::PERSON_WRAP_LEN,
                        "[{id}] the fixture is one person envelope longer than a valid NTV8 \
                         frame, and nothing else"
                    );
                }
            }
            other => panic!("[{id}] unknown case_kind {other:?}"),
        }
    }

    for required in [
        "roundtrip",
        "password_opens",
        "password_open_fail",
        "upgrade",
        "parse_fail",
    ] {
        assert!(
            kinds.contains(required),
            "vault-meta-ntv8 lost its {required} case kind"
        );
    }
    assert_eq!(
        phrase_wrap_rejects, 3,
        "all three retired phrase-wrap fields (salt, nonce, ciphertext) must keep \
         their own rejection case"
    );
    assert!(
        length_reject,
        "the family must keep the case where a whole valid NTV7 frame is rejected on \
         length. Every other byte is identical across the two generations, so that \
         case is the only thing standing between a lenient reader and a vault whose \
         credential the user no longer has."
    );
}

/// `person-keypair` v0.2: the B2B person-keypair wrap-key derivation under the
/// `"myne.v0.2 argon2id-person-keypair|"` salt domain (`decisions/protocol/0592`).
///
/// A protocol-touching KDF domain with no case is a port that derives the wrap
/// key differently and is caught by nothing; the two cases pin the bytes AND the
/// person-level domain separation (same phrase + salt, different `person_id_hash`
/// must derive different keys).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn person_keypair_vectors() {
    use protocol::derive_person_keypair_wrap_key_from_normalized;

    let Some(raw) = cases_json_v0_2("person-keypair") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[person-keypair/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "person-keypair");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 2,
        "person-keypair must carry at least 2 vectors; found {}",
        cases.len()
    );
    assert_unique_vector_ids("person-keypair/v0.2", cases);

    let mut seen_keys = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let phrase = hex_decode(
            case["input_phrase_utf8_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_phrase_utf8_hex")),
        );
        let phrase = core::str::from_utf8(&phrase)
            .unwrap_or_else(|e| panic!("[{id}] phrase not valid UTF-8: {e}"));
        let salt: [u8; 16] = hex_decode_array(
            case["input_salt_random_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_salt_random_hex")),
        );
        let person_id: [u8; 16] = hex_decode_array(
            case["input_person_id_hash_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_person_id_hash_hex")),
        );
        let params = parse_kdf_params(case, id);
        let expected: [u8; 32] = hex_decode_array(
            case["expected_wrap_key_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing expected_wrap_key_hex")),
        );
        let actual =
            derive_person_keypair_wrap_key_from_normalized(phrase, &salt, &person_id, &params)
                .unwrap_or_else(|e| {
                    panic!("[{id}] derive_person_keypair_wrap_key_from_normalized failed: {e:?}")
                });
        assert_eq!(
            actual.as_slice(),
            expected.as_slice(),
            "[{id}] person-keypair wrap-key mismatch\n  expected_hex: {}\n  actual_hex:   {}",
            hex_encode(&expected),
            hex_encode(&*actual),
        );
        seen_keys.insert(hex_encode(&*actual));
    }
    // Domain separation: the cases differ only in person id, so their keys MUST
    // differ, a runner that pinned two identical keys would be asserting
    // nothing about the person-level binding.
    assert_eq!(
        seen_keys.len(),
        cases.len(),
        "person-keypair cases must derive distinct keys per person id"
    );
}

/// `person-identity` v0.2: the canonical fingerprint and the hybrid-wrap
/// combiner, the two deterministic byte surfaces a second implementation must
/// reproduce byte-for-byte (myne-md/myne#698).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn person_identity_vectors() {
    use protocol::{compute_fingerprint, hybrid_wrap_key};

    let Some(raw) = cases_json_v0_2("person-identity") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[person-identity/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "person-identity");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty());

    let mut seen_kinds = std::collections::HashSet::new();
    for case in cases {
        let kind = case["case_kind"]
            .as_str()
            .expect("case_kind must be a string");
        seen_kinds.insert(kind.to_string());
        match kind {
            "fingerprint" => {
                let kem_ek: [u8; protocol::PERSON_EK_LEN] = hex_decode_array(
                    case["input_kem_ek_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing input_kem_ek_hex")),
                );
                let ed_pk: [u8; protocol::PERSON_ED25519_PK_LEN] = hex_decode_array(
                    case["input_ed_pk_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing input_ed_pk_hex")),
                );
                let mldsa_vk: [u8; protocol::PERSON_MLDSA_VK_LEN] = hex_decode_array(
                    case["input_mldsa_vk_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing input_mldsa_vk_hex")),
                );
                let expected: [u8; protocol::PERSON_FINGERPRINT_LEN] = hex_decode_array(
                    case["expected_fingerprint_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing expected_fingerprint_hex")),
                );
                let actual = compute_fingerprint(&kem_ek, &ed_pk, &mldsa_vk);
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[fingerprint] mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
                // The domain prefix is load-bearing: the bare SHA-256 of the
                // concatenation must NOT equal the expected fingerprint.
                use sha2::{Digest, Sha256};
                let mut bare = Sha256::new();
                bare.update(kem_ek);
                bare.update(ed_pk);
                bare.update(mldsa_vk);
                assert_ne!(
                    bare.finalize().as_slice(),
                    expected.as_slice(),
                    "[fingerprint] the domain prefix must change the digest"
                );
            }
            "hybrid-wrap-key" => {
                let classical: [u8; 32] = hex_decode_array(
                    case["input_classical_ss_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing input_classical_ss_hex")),
                );
                let pq: [u8; 32] = hex_decode_array(
                    case["input_pq_ss_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing input_pq_ss_hex")),
                );
                let expected: [u8; 32] = hex_decode_array(
                    case["expected_hybrid_wrap_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing expected_hybrid_wrap_key_hex")),
                );
                let actual = hybrid_wrap_key(&classical, &pq);
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[hybrid-wrap-key] mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&*actual),
                );
            }
            other => panic!("[{other}] unknown case_kind for person-identity"),
        }
    }
    for required in ["fingerprint", "hybrid-wrap-key"] {
        assert!(
            seen_kinds.contains(required),
            "person-identity must cover the '{required}' case kind"
        );
    }
}

/// `person-member-unlock-store` v0.2: the B2B member vault-unlock password KEK
/// derivation and the device-local `vault.member-unlock` AAD
/// (`decisions/protocol/0653`).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn person_member_unlock_store_vectors() {
    use protocol::{
        aad_person_member_unlock_store, derive_person_vault_member_unlock_key,
        DEFAULT_V0_1_KDF_PARAMS,
    };

    let Some(raw) = cases_json_v0_2("person-member-unlock-store") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[person-member-unlock-store/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "person-member-unlock-store");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty());

    let mut seen_kinds = std::collections::HashSet::new();
    for case in cases {
        let kind = case["case_kind"]
            .as_str()
            .expect("case_kind must be a string");
        seen_kinds.insert(kind.to_string());
        match kind {
            "member-unlock-derivation" => {
                let password = case["input_password"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{kind}] missing input_password"));
                let salt: [u8; 16] = hex_decode_array(
                    case["input_salt_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing input_salt_hex")),
                );
                let acct: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{kind}] missing input_account_number_hash_hex")
                        }),
                );
                let expected: [u8; 32] = hex_decode_array(
                    case["expected_member_unlock_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{kind}] missing expected_member_unlock_key_hex")
                        }),
                );
                let actual = derive_person_vault_member_unlock_key(
                    password,
                    &salt,
                    &acct,
                    &DEFAULT_V0_1_KDF_PARAMS,
                )
                .expect("derive member unlock key");
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[member-unlock-derivation] mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&*actual),
                );
            }
            "member-unlock-store-aad" => {
                let vault: [u8; 16] = hex_decode_array(
                    case["input_vault_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing input_vault_id_hex")),
                );
                let acct: [u8; 16] = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{kind}] missing input_account_number_hash_hex")
                        }),
                );
                let expected: [u8; 71] = hex_decode_array(
                    case["expected_aad_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing expected_aad_hex")),
                );
                let actual = aad_person_member_unlock_store(&vault, &acct);
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[member-unlock-store-aad] mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            other => panic!("[{other}] unknown case_kind for person-member-unlock-store"),
        }
    }
    for required in ["member-unlock-derivation", "member-unlock-store-aad"] {
        assert!(
            seen_kinds.contains(required),
            "person-member-unlock-store must cover the '{required}' case kind"
        );
    }
}

/// Regenerate the `person-member-unlock-store/v0.2` cases (companion repo).
/// `cargo test -p protocol --test vectors emit_person_member_unlock -- --ignored --nocapture`
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
#[ignore]
fn emit_person_member_unlock_store_vectors_for_paste() {
    use protocol::{
        aad_person_member_unlock_store, derive_person_vault_member_unlock_key,
        DEFAULT_V0_1_KDF_PARAMS,
    };
    let password = "correct horse battery staple";
    let salt: [u8; 16] = [0xab; 16];
    let acct: [u8; 16] = [0x7c; 16];
    let vault: [u8; 16] = [0x11; 16];
    let key =
        derive_person_vault_member_unlock_key(password, &salt, &acct, &DEFAULT_V0_1_KDF_PARAMS)
            .expect("derive");
    let aad = aad_person_member_unlock_store(&vault, &acct);
    println!("MEMBER_UNLOCK_KEY_HEX {}", hex_encode(&*key));
    println!("MEMBER_UNLOCK_AAD_HEX {}", hex_encode(&aad));
}

/// `person-vault-carrier` v0.2: the device-local vault-bound person-identity
/// carrier AAD (myne-md/myne#792). The carrier's KEK is pinned by
/// `hkdf-sha256/v0.2`; this family pins the AAD framing (`aad_person_vault_carrier`).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn person_vault_carrier_vectors() {
    use protocol::aad_person_vault_carrier;

    let Some(raw) = cases_json_v0_2("person-vault-carrier") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[person-vault-carrier/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "person-vault-carrier");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty());

    for case in cases {
        let kind = case["case_kind"]
            .as_str()
            .expect("case_kind must be a string");
        match kind {
            "aad-construction" => {
                let vault: [u8; 16] = hex_decode_array(
                    case["input_vault_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing input_vault_id_hex")),
                );
                let person: [u8; 16] = hex_decode_array(
                    case["input_person_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing input_person_id_hex")),
                );
                let expected: [u8; 70] = hex_decode_array(
                    case["expected_aad_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{kind}] missing expected_aad_hex")),
                );
                let actual = aad_person_vault_carrier(&vault, &person);
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[aad-construction] mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            other => panic!("[{other}] unknown case_kind for person-vault-carrier"),
        }
    }
}

/// `person-profile` v0.2: the MYY5 person-private AI profile codec.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn person_profile_vectors() {
    use protocol::{decode_person_profile_blob, encode_person_profile_blob_raw};

    let Some(raw) = cases_json_v0_2("person-profile") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[person-profile/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "person-profile");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty());

    let mut seen_kinds = std::collections::HashSet::new();
    for case in cases {
        let kind = case["case_kind"]
            .as_str()
            .expect("case_kind must be a string");
        seen_kinds.insert(kind.to_string());
        let key: [u8; 32] = hex_decode_array(case["input_key_hex"].as_str().unwrap_or(""));
        let profile_id: [u8; 16] =
            hex_decode_array(case["input_profile_id_hex"].as_str().unwrap_or(""));
        let acct: [u8; 16] =
            hex_decode_array(case["input_account_number_hash_hex"].as_str().unwrap_or(""));
        let nonce: [u8; 24] = hex_decode_array(case["input_nonce_hex"].as_str().unwrap_or(""));
        let plaintext = case["input_plaintext_utf8"]
            .as_str()
            .unwrap_or_else(|| panic!("[{kind}] missing input_plaintext_utf8"))
            .as_bytes();
        let expected = hex_decode(
            case["expected_blob_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{kind}] missing expected_blob_hex")),
        );
        match kind {
            "seal" => {
                let actual =
                    encode_person_profile_blob_raw(&key, &profile_id, &acct, &nonce, plaintext)
                        .expect("seal profile");
                assert_eq!(actual, expected, "[seal] blob mismatch");
                let opened = decode_person_profile_blob(&key, &profile_id, &acct, &expected)
                    .expect("open profile");
                assert_eq!(&*opened, plaintext, "[seal] round-trip mismatch");
            }
            "cross_vault_fail" => {
                assert!(
                    decode_person_profile_blob(&key, &profile_id, &acct, &expected).is_err(),
                    "[cross_vault_fail] the account hash is AAD-bound; a moved blob must fail closed"
                );
            }
            other => panic!("[{other}] unknown case_kind for person-profile"),
        }
    }
    for required in ["seal", "cross_vault_fail"] {
        assert!(
            seen_kinds.contains(required),
            "person-profile must cover the '{required}' case kind"
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
        aad_agent_memory_blob, aad_agent_memory_catalog, aad_agent_personality_blob,
        aad_attachment_text_blob, aad_chats_blob, aad_chats_catalog, aad_custom_themes_blob,
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
        let conversation_id = || -> [u8; 16] {
            hex_decode_array(
                case["input_conversation_id_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_conversation_id_hex")),
            )
        };
        let memory_entry_id = || -> [u8; 16] {
            hex_decode_array(
                case["input_memory_entry_id_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_memory_entry_id_hex")),
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
            "aad_chats_catalog" => aad_chats_catalog(&account_number_hash()),
            "aad_chats_blob" => {
                aad_chats_blob(&account_number_hash(), &conversation_id())
            }
            "aad_agent_memory_catalog" => aad_agent_memory_catalog(&account_number_hash()),
            "aad_agent_memory_blob" => {
                aad_agent_memory_blob(&account_number_hash(), &memory_entry_id())
            }
            "aad_agent_personality_blob" => aad_agent_personality_blob(&account_number_hash()),
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
    let required: [&str; 19] = [
        "aad_password_wrap",
        "aad_recovery_wrap",
        "aad_vault_items_key_wrap",
        "aad_note_item_key_wrap",
        "aad_prefs_blob",
        "aad_search_index_blob",
        "aad_workspace_blob",
        "aad_graph_layout_blob",
        "aad_vault_indices_blob",
        "aad_personal_dictionary_blob",
        "aad_quick_unlock_blob",
        "aad_note_content_encrypt",
        "aad_attachment_text_blob",
        "aad_custom_themes_blob",
        "aad_chats_catalog",
        "aad_chats_blob",
        "aad_agent_memory_catalog",
        "aad_agent_memory_blob",
        "aad_agent_personality_blob",
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
        aad_agent_memory_blob_v0_2, aad_awareness_frame, aad_device_binding_blob,
        aad_member_names_blob, aad_membership_blob, aad_membership_roster_blob,
        aad_password_wrap_v0_2, aad_person_binding_blob, aad_recovery_wrap_v0_2,
        aad_singleton_blob_v0_2, aad_vault_items_key_wrap_v0_2,
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
        let memory_entry_id = || -> [u8; 16] {
            hex_decode_array(
                case["input_memory_entry_id_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] missing input_memory_entry_id_hex")),
            )
        };

        let actual = match builder_name {
            "aad_password_wrap_v0_2" => aad_password_wrap_v0_2(&parse_kdf_params(case, id)),
            "aad_recovery_wrap_v0_2" => aad_recovery_wrap_v0_2(&parse_kdf_params(case, id)),
            "aad_vault_items_key_wrap_v0_2" => aad_vault_items_key_wrap_v0_2(&items_key_id()),
            "aad_agent_memory_blob_v0_2" => {
                aad_agent_memory_blob_v0_2(&account_number_hash(), &memory_entry_id())
            }
            "aad_singleton_blob_v0_2" => {
                let role = role_label();
                singleton_roles.insert(role.clone());
                aad_singleton_blob_v0_2(role.as_bytes(), &account_number_hash())
            }
            "aad_membership_blob" => aad_membership_blob(&account_number_hash()),
            "aad_membership_roster_blob" => aad_membership_roster_blob(&account_number_hash()),
            "aad_person_binding_blob" => aad_person_binding_blob(&account_number_hash()),
            "aad_person_wrap" => {
                let fingerprint: [u8; 32] = hex_decode_array(
                    case["input_recipient_fingerprint_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_recipient_fingerprint_hex")),
                );
                protocol::person_key::aad_person_wrap(&fingerprint, &account_number_hash())
            }
            "aad_person_wrap_root_key" => {
                let fingerprint: [u8; 32] = hex_decode_array(
                    case["input_recipient_fingerprint_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_recipient_fingerprint_hex")),
                );
                protocol::person_key::aad_person_wrap_root_key(&fingerprint, &items_key_id())
            }
            "aad_person_keypair" => protocol::person_key::aad_person_keypair(),
            "aad_vault_invite" => protocol::person_invite::aad_vault_invite(),
            "aad_awareness_frame" => {
                let epoch = case.get("input_group_key_epoch").and_then(|v| v.as_u64());
                aad_awareness_frame(&account_number_hash(), epoch)
            }
            // The one builder in this family whose epoch is REQUIRED rather than
            // optional, so the case always carries it, and the runner takes it
            // without an `Option`, matching the signature rather than the
            // sibling's shape. A missing field is a panic here, not a silent
            // `None` that would pin an epochless AAD no writer produces.
            "aad_member_names_blob" => {
                let epoch = case["input_group_key_epoch"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing input_group_key_epoch"));
                aad_member_names_blob(&account_number_hash(), epoch)
            }
            // The second builder whose epoch is REQUIRED, same shape and same reason
            // as its `member-names` twin directly above: the group epoch is a segment
            // of this AAD, so an epochless variant is not a thing any writer produces.
            "aad_device_binding_blob" => {
                let epoch = case["input_group_key_epoch"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing input_group_key_epoch"));
                aad_device_binding_blob(&account_number_hash(), epoch)
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

    let required: [&str; 15] = [
        "aad_password_wrap_v0_2",
        "aad_recovery_wrap_v0_2",
        "aad_vault_items_key_wrap_v0_2",
        "aad_singleton_blob_v0_2",
        "aad_agent_memory_blob_v0_2",
        "aad_membership_blob",
        "aad_person_binding_blob",
        "aad_membership_roster_blob",
        "aad_person_wrap",
        "aad_person_wrap_root_key",
        "aad_person_keypair",
        "aad_vault_invite",
        "aad_awareness_frame",
        "aad_member_names_blob",
        "aad_device_binding_blob",
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
fn awareness_frame_vectors() {
    use protocol::{
        open_awareness_frame, seal_awareness_frame_raw, AwarenessPayload, FrameType,
        AWARENESS_FRAME_VERSION, AWARENESS_HEADER_LEN, AWARENESS_ROOM_ID_LEN,
        PRESENCE_ASSERTION_PREFIX,
    };

    let Some(raw) = cases_json_v0_2("awareness-frame") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[awareness-frame/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "awareness-frame");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("awareness-frame/v0.2", cases);

    fn parse_payload(v: &serde_json::Value, id: &str) -> AwarenessPayload {
        let frame_type = match v["frame_type"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] frame_type"))
        {
            "join" => FrameType::Join,
            "presence" => FrameType::Presence,
            o => panic!("[{id}] bad frame_type {o:?}"),
        };
        AwarenessPayload {
            frame_type,
            note_id: hex_decode_array(
                v["note_id_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] note_id")),
            ),
            actor_id: hex_decode_array(
                v["actor_id_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] actor_id")),
            ),
            seq: v["seq"].as_u64().unwrap_or_else(|| panic!("[{id}] seq")),
            cursor: v.get("cursor").and_then(|x| x.as_u64()).map(|x| x as u32),
            selection: v.get("selection").and_then(|x| x.as_array()).map(|a| {
                (
                    a[0].as_u64().expect("selection anchor") as u32,
                    a[1].as_u64().expect("selection head") as u32,
                )
            }),
            label: v.get("label").and_then(|x| x.as_str()).map(str::to_string),
            change: v.get("change_hex").and_then(|x| x.as_str()).map(hex_decode),
            ts: v.get("ts").and_then(|x| x.as_u64()),
        }
    }

    let mut saw_frame = false;
    let mut saw_assertion = false;

    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["kind"].as_str().expect("kind");
        match kind {
            "frame" => {
                saw_frame = true;
                let room_key: [u8; 32] = hex_decode_array(
                    case["room_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] room_key")),
                );
                let room_id: [u8; 16] = hex_decode_array(
                    case["room_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] room_id")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] nonce")),
                );
                let account_hash: [u8; 16] = hex_decode_array(
                    case["account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] account_number_hash")),
                );
                let epoch = case.get("group_key_epoch").and_then(|v| v.as_u64());
                let payload = parse_payload(&case["payload"], id);
                let expected = hex_decode(
                    case["expected_frame_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] expected_frame_hex")),
                );

                let frame = seal_awareness_frame_raw(
                    &room_key,
                    &room_id,
                    &nonce,
                    &account_hash,
                    epoch,
                    &payload,
                )
                .expect("seal");
                assert_eq!(frame, expected, "[{id}] awareness frame bytes mismatch");

                // Header shape: room_id || nonce || version, no magic.
                assert!(frame.len() >= AWARENESS_HEADER_LEN);
                assert_eq!(&frame[..AWARENESS_ROOM_ID_LEN], &room_id[..]);
                assert_eq!(frame[AWARENESS_HEADER_LEN - 1], AWARENESS_FRAME_VERSION);
                assert!(
                    !frame.starts_with(b"MY"),
                    "[{id}] awareness frame must carry no magic"
                );

                let open_room: [u8; 16] = hex_decode_array(
                    case["open_room_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] open_room_id_hex")),
                );
                let open_epoch = case.get("open_group_key_epoch").and_then(|v| v.as_u64());
                let expect_ok = case["expect_open_ok"]
                    .as_bool()
                    .unwrap_or_else(|| panic!("[{id}] expect_open_ok"));
                let mut to_open = expected.clone();
                if case["tamper_last_byte"].as_bool().unwrap_or(false) {
                    let last = to_open.len() - 1;
                    to_open[last] ^= 0x01;
                }
                let opened = open_awareness_frame(
                    &room_key,
                    &open_room,
                    &account_hash,
                    open_epoch,
                    &to_open,
                );
                assert_eq!(opened.is_ok(), expect_ok, "[{id}] open outcome mismatch");
                if expect_ok {
                    assert_eq!(
                        opened.expect("open"),
                        payload,
                        "[{id}] payload round-trip mismatch"
                    );
                }
            }
            "assertion_message" => {
                saw_assertion = true;
                let actor: [u8; 16] = hex_decode_array(
                    case["actor_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] actor_id")),
                );
                let person: [u8; 32] = hex_decode_array(
                    case["person_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] person_id")),
                );
                let expected = hex_decode(
                    case["expected_message_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] expected_message_hex")),
                );
                let mut msg = Vec::new();
                msg.extend_from_slice(PRESENCE_ASSERTION_PREFIX);
                msg.extend_from_slice(&actor);
                msg.extend_from_slice(&person);
                assert_eq!(msg, expected, "[{id}] presence message bytes mismatch");
                // The class prefix is the load-bearing identifier; pin it whole.
                assert_eq!(PRESENCE_ASSERTION_PREFIX, b"myne.awareness-presence v1|");
            }
            other => panic!("[{id}] unknown awareness-frame kind {other:?}"),
        }
    }
    assert!(
        saw_frame,
        "awareness-frame must carry at least one frame case"
    );
    assert!(
        saw_assertion,
        "awareness-frame must carry the assertion message-class case"
    );
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn member_names_vectors() {
    use protocol::{
        decode_member_names_blob, derive_group_subkey_v0_2, encode_member_names_blob_raw,
        member_name_signed_bytes, verify_member_name, verify_member_removal, GroupKey, GroupRole,
        MemberNameEntry, MemberNamesBlobError, MemberNamesMap, PersonPublicHalf, SubkeyRole,
        MAX_MEMBER_NAME_LEN, MEMBER_NAMES_BLOB_AAD_ROLE, MEMBER_NAMES_BLOB_FORMAT_V1,
        MEMBER_NAMES_BLOB_HEADER_LEN, MEMBER_NAMES_BLOB_MAGIC, MEMBER_NAME_PREFIX,
    };

    // The wire names the companion's `expected_error` vocabulary is drawn from, kept
    // exhaustive over the enum so a new variant cannot ship without deciding its name
    // here. This is a second copy of the mapping in the generator, and that is
    // deliberate rather than sloppy: the generator writes the JSON and this reads it,
    // so a rename on one side alone fails right here: the two copies cross-check each
    // other instead of one merely restating the other.
    fn err_name(e: &MemberNamesBlobError) -> &'static str {
        match e {
            MemberNamesBlobError::HeaderTooShort => "header_too_short",
            MemberNamesBlobError::MagicMismatch => "magic_mismatch",
            MemberNamesBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
            MemberNamesBlobError::MemberNamesFormatUnsupported => "format_unsupported",
            MemberNamesBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
            MemberNamesBlobError::CiphertextTruncated => "ciphertext_truncated",
            MemberNamesBlobError::CannotDecrypt => "cannot_decrypt",
            MemberNamesBlobError::RandomnessUnavailable => "randomness_unavailable",
            MemberNamesBlobError::MapMalformed => "plaintext_parse_failed",
            MemberNamesBlobError::MapNotCanonical => "not_canonical",
            MemberNamesBlobError::EpochZero => "epoch_zero",
            MemberNamesBlobError::SignatureUnavailable => "signature_unavailable",
        }
    }

    fn parse_entry(v: &serde_json::Value, id: &str) -> MemberNameEntry {
        MemberNameEntry {
            name: v["name"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] entry name"))
                .to_string(),
            version: v["version"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] entry version")),
            tombstone: v["tombstone"]
                .as_bool()
                .unwrap_or_else(|| panic!("[{id}] entry tombstone")),
            signature_hex: v["signature_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] entry signature_hex"))
                .to_string(),
        }
    }

    fn parse_map(v: &serde_json::Value, id: &str) -> MemberNamesMap {
        let obj = v
            .as_object()
            .unwrap_or_else(|| panic!("[{id}] input_map must be a JSON object"));
        let mut map = MemberNamesMap::new();
        for (k, entry) in obj {
            map.insert(k.clone(), parse_entry(entry, id));
        }
        map
    }

    let Some(raw) = cases_json_v0_2("member-names") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[member-names/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "member-names");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("member-names/v0.2", cases);

    // The family magic and the message-class prefix are major-version-event
    // constants (repo-root identifier table), so pin them whole rather than only
    // through the bytes a case happens to carry.
    assert_eq!(&MEMBER_NAMES_BLOB_MAGIC, b"MYO5");
    assert_eq!(MEMBER_NAME_PREFIX, b"myne.member-name v1|");
    assert_eq!(MEMBER_NAMES_BLOB_AAD_ROLE, b"member-names-blob");
    assert_eq!(MEMBER_NAMES_BLOB_HEADER_LEN, 34);
    assert_eq!(MAX_MEMBER_NAME_LEN, 64);

    let mut saw_encrypt = false;
    let mut saw_decrypt_fail = false;
    let mut saw_parse_fail = false;
    let mut saw_encode_fail = false;
    let mut saw_signed_bytes = false;
    let mut saw_verify = false;
    let mut saw_group_subkey = false;
    let mut pinned_errors: Vec<String> = Vec::new();
    let mut pinned_roles: Vec<String> = Vec::new();
    let mut derived: Vec<(String, [u8; 32])> = Vec::new();
    // The verify kind is only meaningful if it pins BOTH outcomes: a family of
    // refusals alone is passed by a `verify` that returns `false` unconditionally.
    let mut saw_accept = false;
    let mut saw_refuse = false;

    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["case_kind"].as_str().expect("case_kind");

        // Only the four blob kinds carry a key and an account hash: `signed_bytes`,
        // `verify` and `group_subkey` are keyless by construction (they pin a message
        // class, a verification outcome and a derivation, none of which touches the
        // seal), and demanding the fields there would be the schema's job, not this
        // runner's.
        let key = || -> [u8; protocol::AEAD_KEY_LEN] {
            hex_decode_array(
                case["input_member_names_key_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] input_member_names_key_hex")),
            )
        };
        let account_hash = || -> [u8; 16] {
            hex_decode_array(
                case["input_account_number_hash_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] input_account_number_hash_hex")),
            )
        };

        match kind {
            "encrypt" => {
                saw_encrypt = true;
                let epoch = case["input_group_key_epoch"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] input_group_key_epoch"));
                let nonce: [u8; protocol::AEAD_NONCE_LEN] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_nonce_hex")),
                );
                let map = parse_map(&case["input_map"], id);
                let expected = hex_decode(
                    case["expected_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] expected_blob_hex")),
                );

                let blob =
                    encode_member_names_blob_raw(&key(), &account_hash(), epoch, &map, &nonce)
                        .expect("seal member-names map");
                assert_eq!(blob, expected, "[{id}] member-names blob bytes mismatch");

                // The header facts the format fixes, asserted against the case's own
                // pins rather than only against the blob: a regenerated fixture that
                // lost its magic would otherwise still agree with the codec.
                assert_eq!(
                    case["expected_magic_ascii"].as_str(),
                    Some("MYO5"),
                    "[{id}] expected_magic_ascii"
                );
                assert_eq!(&blob[..4], &MEMBER_NAMES_BLOB_MAGIC[..], "[{id}] magic");
                assert_eq!(
                    hex_decode(
                        case["expected_protocol_version_byte_hex"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] expected_protocol_version_byte_hex"))
                    ),
                    vec![blob[4]],
                    "[{id}] protocol_version byte"
                );
                assert_eq!(
                    hex_decode(
                        case["expected_format_version_byte_hex"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] expected_format_version_byte_hex"))
                    ),
                    vec![MEMBER_NAMES_BLOB_FORMAT_V1],
                    "[{id}] format_version byte"
                );
                assert_eq!(
                    case["informational_header_len"].as_u64(),
                    Some(MEMBER_NAMES_BLOB_HEADER_LEN as u64),
                    "[{id}] header length"
                );
                let nonce_offset = case["informational_nonce_offset"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] informational_nonce_offset"))
                    as usize;
                assert_eq!(nonce_offset, 6, "[{id}] nonce offset");
                assert_eq!(
                    &blob[nonce_offset..nonce_offset + protocol::AEAD_NONCE_LEN],
                    &nonce[..],
                    "[{id}] nonce must sit at the pinned offset"
                );
                let declared =
                    u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
                assert_eq!(
                    blob.len(),
                    MEMBER_NAMES_BLOB_HEADER_LEN + declared,
                    "[{id}] the length field counts the ciphertext with its tag"
                );

                // The plaintext is the CANONICAL map, so a port must be able to hand
                // the codec the same map and read the same rows back. Round-tripping
                // is what makes `not_canonical` a contract rather than a codec quirk.
                let opened = decode_member_names_blob(&key(), &account_hash(), epoch, &expected)
                    .expect("open");
                assert_eq!(opened, map, "[{id}] map round-trip mismatch");
            }
            "decrypt_fail" | "parse_fail" => {
                if kind == "decrypt_fail" {
                    saw_decrypt_fail = true;
                } else {
                    saw_parse_fail = true;
                }
                let epoch = case["input_group_key_epoch"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] input_group_key_epoch"));
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_blob_hex")),
                );
                let want = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] expected_error"));
                let err = decode_member_names_blob(&key(), &account_hash(), epoch, &blob)
                    .err()
                    .unwrap_or_else(|| panic!("[{id}] expected {want}, got Ok"));
                assert_eq!(
                    err_name(&err),
                    want,
                    "[{id}] wrong failure variant: {err:?}"
                );
                pinned_errors.push(want.to_string());
            }
            "encode_fail" => {
                saw_encode_fail = true;
                let epoch = case["input_group_key_epoch"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] input_group_key_epoch"));
                let nonce: [u8; protocol::AEAD_NONCE_LEN] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_nonce_hex")),
                );
                let map = parse_map(&case["input_map"], id);
                let want = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] expected_error"));
                let err =
                    encode_member_names_blob_raw(&key(), &account_hash(), epoch, &map, &nonce)
                        .err()
                        .unwrap_or_else(|| {
                            panic!("[{id}] expected {want} on the write side, got Ok")
                        });
                assert_eq!(
                    err_name(&err),
                    want,
                    "[{id}] wrong failure variant: {err:?}"
                );
                pinned_errors.push(want.to_string());
            }
            "signed_bytes" => {
                saw_signed_bytes = true;
                let person_id: [u8; 16] = hex_decode_array(
                    case["input_person_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_person_id_hex")),
                );
                let version = case["input_version"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] input_version"));
                let tombstone = case["input_tombstone"]
                    .as_bool()
                    .unwrap_or_else(|| panic!("[{id}] input_tombstone"));
                let name = case["input_name_utf8"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] input_name_utf8"));
                assert_eq!(
                    case["expected_prefix_ascii"].as_str(),
                    Some("myne.member-name v1|"),
                    "[{id}] expected_prefix_ascii"
                );
                assert_eq!(
                    case["informational_name_len_bytes"].as_u64(),
                    Some(name.len() as u64),
                    "[{id}] the name length is BYTES, not characters"
                );
                let expected = hex_decode(
                    case["expected_message_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] expected_message_hex")),
                );
                let msg = member_name_signed_bytes(&person_id, version, tombstone, name);
                assert_eq!(msg, expected, "[{id}] signed-message bytes mismatch");
                assert!(
                    msg.starts_with(MEMBER_NAME_PREFIX),
                    "[{id}] the message must open with the class prefix"
                );
                // The prefix is what stops a name signature being replayed as a
                // roster, invite, transition or awareness assertion, so it is asserted
                // as a whole constant rather than only as the message's head.
                assert_eq!(MEMBER_NAME_PREFIX.len(), 20);
            }
            "verify" => {
                saw_verify = true;
                let verifier = case["verifier"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] verifier"));
                let person_id: [u8; 16] = hex_decode_array(
                    case["input_person_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_person_id_hex")),
                );
                let public = PersonPublicHalf::from_parts_hex(
                    case["input_signer_kem_ek_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_signer_kem_ek_hex")),
                    case["input_signer_ed_pk_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_signer_ed_pk_hex")),
                    case["input_signer_mldsa_vk_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_signer_mldsa_vk_hex")),
                )
                .unwrap_or_else(|e| panic!("[{id}] the published public half must parse: {e}"));
                let entry = parse_entry(&case["input_entry"], id);
                let expected = case["expected_verified"]
                    .as_bool()
                    .unwrap_or_else(|| panic!("[{id}] expected_verified"));

                // The message the signature covers, published beside the row so a port
                // can diff its own assembly against ours instead of reconstructing it.
                let signed = hex_decode(
                    case["informational_signed_bytes_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] informational_signed_bytes_hex")),
                );
                assert_eq!(
                    signed,
                    member_name_signed_bytes(
                        &person_id,
                        entry.version,
                        entry.tombstone,
                        &entry.name
                    ),
                    "[{id}] informational_signed_bytes_hex must be the message the row signs"
                );

                let got = match verifier {
                    "person" => verify_member_name(&public, &person_id, &entry),
                    "owner" => verify_member_removal(&public, &person_id, &entry),
                    other => panic!("[{id}] unknown verifier {other:?}"),
                };
                assert_eq!(got, expected, "[{id}] verification outcome mismatch");
                if expected {
                    saw_accept = true;
                } else {
                    saw_refuse = true;
                }
            }
            "group_subkey" => {
                saw_group_subkey = true;
                let group_key: [u8; 32] = hex_decode_array(
                    case["input_group_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_group_key_hex")),
                );
                let role_name = case["input_role"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] input_role"));
                let role = match role_name {
                    "member-names-key" => GroupRole::MemberNamesKey,
                    "member-names-sync-id" => GroupRole::MemberNamesSyncId,
                    other => panic!(
                        "[{id}] unknown GROUP role {other:?}: the §3.4 registry has no such role"
                    ),
                };
                let expected = hex_decode(
                    case["expected_subkey_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] expected_subkey_hex")),
                );
                let derived_key = derive_group_subkey_v0_2(&GroupKey::new(group_key), role);
                assert_eq!(
                    derived_key.as_slice(),
                    expected.as_slice(),
                    "[{id}] {role_name} subkey bytes mismatch"
                );
                // A derivation that returned the group key unchanged would satisfy a
                // byte comparison only if the fixture were regenerated to match, so
                // the separation is asserted directly.
                assert_ne!(
                    derived_key.as_slice(),
                    &group_key[..],
                    "[{id}] {role_name} must not be the raw group key"
                );
                pinned_roles.push(role_name.to_string());
                derived.push((role_name.to_string(), *derived_key));
            }
            other => panic!("[{id}] unknown member-names case_kind {other:?}"),
        }
    }

    for (flag, what) in [
        (saw_encrypt, "encrypt"),
        (saw_decrypt_fail, "decrypt_fail"),
        (saw_parse_fail, "parse_fail"),
        (saw_encode_fail, "encode_fail"),
        (saw_signed_bytes, "signed_bytes"),
        (saw_verify, "verify"),
        (saw_group_subkey, "group_subkey"),
    ] {
        assert!(
            flag,
            "member-names/v0.2 must carry at least one {what} case"
        );
    }
    assert!(
        saw_accept && saw_refuse,
        "the verify kind must pin BOTH outcomes: a sheet of refusals alone is passed by \
         a `verify` that always answers false"
    );

    let mut sorted_errors = pinned_errors.clone();
    sorted_errors.sort_unstable();
    sorted_errors.dedup();
    assert!(
        sorted_errors.len() >= 8,
        "member-names/v0.2 pins only {} distinct failure names ({sorted_errors:?}); the family's \
         decode surface is one variant at a time and must stay that way",
        sorted_errors.len()
    );

    // ---- the §3.4 registry-level claim the `group_subkey` kind exists for -------
    //
    // Both roles are GROUP-tier, and the registry statement that matters is that
    // NEITHER has a root-tier twin: if one ever grew a `SubkeyRole`, this family could
    // be keyed from `root_key`, and a pre-B2B vault could carry a `MYO5` blob: the
    // exact thing the family's `NTV6`-only rule forbids. Iterating `SubkeyRole::ALL`
    // is what makes that fail when the registry changes rather than when somebody
    // remembers to look.
    let mut root_tier = Vec::new();
    for role in SubkeyRole::ALL {
        if let Some(group) = role.shared_group_role() {
            root_tier.push(group);
        }
    }
    for forbidden in [GroupRole::MemberNamesKey, GroupRole::MemberNamesSyncId] {
        assert!(
            !root_tier.contains(&forbidden),
            "{forbidden:?} has a SubkeyRole counterpart, so this family could be keyed from \
             root_key and a pre-B2B vault could carry it: the NTV6-only rule is broken"
        );
        assert!(
            GroupRole::ALL.contains(&forbidden),
            "{forbidden:?} must be registered in GroupRole::ALL (§3.4)"
        );
    }

    // Both roles pinned, and pinned as DISTINCT values: two names for one derivation
    // would pass a per-case byte check while making the sync-id role a second copy of
    // the key role.
    let mut sorted_roles = pinned_roles.clone();
    sorted_roles.sort_unstable();
    sorted_roles.dedup();
    assert_eq!(
        sorted_roles,
        vec![
            "member-names-key".to_string(),
            "member-names-sync-id".to_string()
        ],
        "both GROUP roles must be pinned by a case"
    );
    assert_ne!(
        derived[0].1, derived[1].1,
        "the two member-names GROUP roles must derive different subkeys"
    );
}

/// The `MYU5` device-binding family: the vault-scoped map from a device to the person
/// it belongs to, sealed under the group key so every member reads and writes it.
///
/// Four things here are not like its `MYO5` sibling beside it, and each is the reason
/// a rule below reads differently:
///
/// 1. the map KEY is the DEVICE, not the person, so the claimed person lives inside
///    the row and `verify_device_binding` has to check it against the signer's own
///    fingerprint;
/// 2. the inner map is merge-resolved, so this family pins a `merge` kind;
/// 3. that merge has a refusal, so the `merge` kind carries two mutually exclusive
///    outcomes and its sub-schema needs a nested `oneOf` no sibling family has;
/// 4. exactly one GROUP role is pinned, not two.
///
/// The `group-roster` category (`decisions/protocol/0731` stage 2 + `0733`;
/// `protocol.md` §9.3.3). Three case kinds and one invariant behind all of them: the
/// roster's canonical payload is the SAME in both signature classes, so a port that
/// reproduces the v1 message must reproduce the v2 one by changing the prefix alone.
///
/// What is pinned, in three parts. First `signed_bytes`, the exact message each class
/// signs: the class prefix is inside the signed bytes, which is what stops a person
/// signature satisfying a device verifier. Second `verify`, four verdicts over whole
/// frames so a port exercises its own decoder: v1 with the person key, v2 with the
/// vouched device, v2 with no attestation (refused), and v2 with a DIFFERENT device
/// (refused). A roster carries no key of its own, so a device is trusted only because
/// something else vouched for it. Third `package_payload`, the canonical package payload
/// that carries the attestation and the same payload from a build with no device key,
/// where the field is ABSENT rather than null; that absence is what makes the field
/// additive instead of a format break.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn group_roster_vectors() {
    use protocol::person_invite::{
        decode_signed_group_frame_public, verify_group_roster, RosterTrust, GROUP_ROSTER_PREFIX,
        GROUP_ROSTER_PREFIX_V2,
    };

    let Some(raw) = cases_json_v0_2("group-roster") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw).expect("group-roster cases.json");
    let cases = doc["cases"].as_array().expect("cases array");
    let mut kinds = std::collections::BTreeSet::new();

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .unwrap_or_else(|| panic!("vector_id"));
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] case_kind"));
        kinds.insert(kind.to_string());
        match kind {
            "signed_bytes" => {
                let payload = hex_decode(case["input_payload_hex"].as_str().unwrap_or_default());
                let class = case["input_class"].as_str().unwrap_or_default();
                let prefix = match class {
                    "v1" => GROUP_ROSTER_PREFIX,
                    "v2" => GROUP_ROSTER_PREFIX_V2,
                    other => panic!("[{id}] unknown input_class {other:?}"),
                };
                let mut expected = Vec::new();
                expected.extend_from_slice(prefix);
                expected.extend_from_slice(&payload);
                assert_eq!(
                    hex_decode(
                        case["expected_signed_bytes_hex"]
                            .as_str()
                            .unwrap_or_default()
                    ),
                    expected,
                    "[{id}] the signed message is prefix || payload"
                );
                // The payload must parse as a roster in BOTH classes, which is the
                // invariance the category exists to pin.
                assert!(
                    protocol::person_invite::parse_group_roster(&payload).is_some(),
                    "[{id}] the payload is a canonical roster"
                );
            }
            "verify" => {
                let frame = hex_decode(case["input_frame_hex"].as_str().unwrap_or_default());
                let account = hex_decode_array(
                    case["input_account_number_hash_hex"]
                        .as_str()
                        .unwrap_or_default(),
                );
                let expected = case["expected_verified"].as_bool().unwrap_or(false);
                let person = person_public_for_case(&doc, case, id);
                let device = match (
                    case["input_device_ed_pk_hex"].as_str(),
                    case["input_device_mldsa_vk_hex"].as_str(),
                ) {
                    (Some(ed), Some(vk)) => Some(
                        protocol::device_key::DevicePublicHalf::from_parts_hex(ed, vk)
                            .unwrap_or_else(|e| panic!("[{id}] device halves: {e}")),
                    ),
                    _ => None,
                };
                // The person half is always supplied, because a reader always has the
                // pinned one; which KEY actually verifies is decided by the class inside
                // the frame, and whether that key is trusted is decided by this list.
                let devices: Vec<protocol::device_key::DevicePublicHalf> =
                    device.into_iter().collect();
                let trust = RosterTrust {
                    owner_person: &person,
                    owner_devices: &devices,
                };
                let (payload, signature) = decode_signed_group_frame_public(&frame)
                    .unwrap_or_else(|| panic!("[{id}] frame"));
                let envelope = protocol::person_invite::SignedGroupRoster { payload, signature };
                let got = verify_group_roster(trust, &envelope, &account).is_ok();
                assert_eq!(got, expected, "[{id}] verification verdict");
            }
            "package_payload" => {
                let payload = hex_decode(case["input_payload_hex"].as_str().unwrap_or_default());
                // Canonical means the CODEC's own re-serialization reproduces the bytes,
                // which is the struct's declaration order. A `serde_json::Value`
                // round-trip would compare against alphabetical key order instead and
                // fail a correct payload (`preserve_order` is deliberately off in this
                // workspace), so the typed decode is the only honest comparator here.
                let parsed: protocol::person_invite::GroupPackagePayload =
                    serde_json::from_slice(&payload)
                        .unwrap_or_else(|e| panic!("[{id}] package payload is JSON: {e}"));
                assert_eq!(
                    serde_json::to_vec(&parsed).expect("re-serialize"),
                    payload,
                    "[{id}] the payload is canonical JSON"
                );
                let parsed = serde_json::to_value(&parsed).expect("to value");
                if let Some(field) = case["expects_no_field"].as_str() {
                    assert!(
                        parsed.get(field).is_none(),
                        "[{id}] {field} must be ABSENT, not null: an absent attestation is                          omitted so the bytes match the previous release"
                    );
                }
                if case["expected_person_fingerprint_hex"].as_str().is_some() {
                    assert!(
                        parsed["account_number_hash_hex"].is_string(),
                        "[{id}] a package payload carries its vault"
                    );
                }
                if let Some(device_id) = case["expected_device_id_hex"].as_str() {
                    assert_eq!(
                        parsed["owner_device"]["device_id_hex"].as_str(),
                        Some(device_id),
                        "[{id}] the attestation names its device"
                    );
                }
                if let Some(ed) = case["expected_device_ed_pk_hex"].as_str() {
                    assert_eq!(
                        parsed["owner_device"]["entry"]["device_ed_pk"].as_str(),
                        Some(ed),
                        "[{id}] the attested row carries the device halves"
                    );
                }
            }
            other => panic!("[{id}] unknown case_kind {other:?}"),
        }
    }

    assert_eq!(
        kinds.len(),
        3,
        "the category carries all three case kinds; a missing one is a lost half"
    );
}

/// The owner's person half a `verify` case is checked against. The frame does not carry
/// it (a roster is verified against a PINNED key, which is the whole trust model), so the
/// case names it by the payload's `owner_fingerprint_hex` and the runner needs the real
/// half: it is pinned in the category's fixture under `informational_owner_*` keys.
fn person_public_for_case(
    doc: &serde_json::Value,
    _case: &serde_json::Value,
    id: &str,
) -> protocol::person_key::PersonPublicHalf {
    let owner = doc
        .get("informational_owner")
        .unwrap_or_else(|| panic!("[{id}] the category pins the owner's public halves"));
    protocol::person_key::PersonPublicHalf::from_parts_hex(
        owner["kem_ek_hex"].as_str().unwrap_or_default(),
        owner["ed_pk_hex"].as_str().unwrap_or_default(),
        owner["mldsa_vk_hex"].as_str().unwrap_or_default(),
    )
    .unwrap_or_else(|e| panic!("[{id}] owner halves: {e}"))
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn device_binding_vectors() {
    use protocol::{
        binding_message_for_entry, decode_device_binding_blob, derive_group_subkey_v0_2,
        device_binding_signed_bytes, encode_device_binding_blob_raw_with_format,
        merge_device_bindings, verify_device_binding, verify_device_binding_removal,
        DeviceBindingBlobError, DeviceBindingEntry, DeviceBindingsMap, GroupKey, GroupRole,
        PersonPublicHalf, SubkeyRole, DEVICE_BINDING_BLOB_AAD_ROLE, DEVICE_BINDING_BLOB_HEADER_LEN,
        DEVICE_BINDING_BLOB_MAGIC, DEVICE_BINDING_PREFIX, DEVICE_BINDING_SIGNATURE_HEX_LEN,
        MAX_DEVICE_BINDINGS_PLAINTEXT_LEN,
    };

    // Same contract as the sibling above: the wire names the companion's
    // `expected_error` vocabulary is drawn from, exhaustive over the enum so a new
    // variant cannot ship without deciding its name here. The generator keeps a second
    // copy, and that is the point: the generator writes the JSON and this reads it, so
    // a rename on one side alone fails right here.
    fn err_name(e: &DeviceBindingBlobError) -> &'static str {
        match e {
            DeviceBindingBlobError::HeaderTooShort => "header_too_short",
            DeviceBindingBlobError::MagicMismatch => "magic_mismatch",
            DeviceBindingBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
            DeviceBindingBlobError::DeviceBindingFormatUnsupported => "format_unsupported",
            DeviceBindingBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
            DeviceBindingBlobError::CiphertextTruncated => "ciphertext_truncated",
            DeviceBindingBlobError::CannotDecrypt => "cannot_decrypt",
            DeviceBindingBlobError::RandomnessUnavailable => "randomness_unavailable",
            DeviceBindingBlobError::MapMalformed => "plaintext_parse_failed",
            DeviceBindingBlobError::MapNotCanonical => "not_canonical",
            DeviceBindingBlobError::EpochZero => "epoch_zero",
            DeviceBindingBlobError::SignatureUnavailable => "signature_unavailable",
            DeviceBindingBlobError::ConflictingBinding => "conflicting_binding",
        }
    }

    fn parse_entry(v: &serde_json::Value, id: &str) -> DeviceBindingEntry {
        DeviceBindingEntry {
            person_fingerprint: v["person_fingerprint"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] entry person_fingerprint"))
                .to_string(),
            version: v["version"]
                .as_u64()
                .unwrap_or_else(|| panic!("[{id}] entry version")),
            tombstone: v["tombstone"]
                .as_bool()
                .unwrap_or_else(|| panic!("[{id}] entry tombstone")),
            // The v2 schema's device public halves: OPTIONAL in a case, because the
            // v1 cases predate the schema and a v1 row re-encodes byte-identically
            // only while both stay absent.
            device_ed_pk: v["device_ed_pk"].as_str().map(ToString::to_string),
            device_mldsa_vk: v["device_mldsa_vk"].as_str().map(ToString::to_string),
            signature_hex: v["signature_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] entry signature_hex"))
                .to_string(),
        }
    }

    fn parse_map(v: &serde_json::Value, id: &str) -> DeviceBindingsMap {
        let obj = v
            .as_object()
            .unwrap_or_else(|| panic!("[{id}] a device-binding map must be a JSON object"));
        let mut map = DeviceBindingsMap::new();
        for (k, entry) in obj {
            map.insert(k.clone(), parse_entry(entry, id));
        }
        map
    }

    let Some(raw) = cases_json_v0_2("device-binding") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[device-binding/v0.2] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "device-binding");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("device-binding/v0.2", cases);

    // The family magic, the AAD role and the message-class prefix are
    // major-version-event constants (repo-root identifier table), so pin them whole
    // rather than only through the bytes some case happens to carry.
    assert_eq!(&DEVICE_BINDING_BLOB_MAGIC, b"MYU5");
    assert_eq!(DEVICE_BINDING_BLOB_AAD_ROLE, b"device-binding-blob");
    assert_eq!(DEVICE_BINDING_PREFIX, b"myne.device-binding v1|");
    assert_eq!(DEVICE_BINDING_BLOB_HEADER_LEN, 34);
    // The signature is a fixed-width hex column: 64 + 3309 bytes, doubled. A row's
    // `signature_hex` length is what the map's shape check tests, so the constant and
    // the schema's `^[0-9a-f]{6746}$` pattern are the same number said twice.
    assert_eq!(DEVICE_BINDING_SIGNATURE_HEX_LEN, 6746);
    assert_eq!(MAX_DEVICE_BINDINGS_PLAINTEXT_LEN, 4 * 1024 * 1024);

    let mut saw_encrypt = false;
    let mut saw_decrypt_fail = false;
    let mut saw_parse_fail = false;
    let mut saw_encode_fail = false;
    let mut saw_signed_bytes = false;
    let mut saw_verify = false;
    let mut saw_group_subkey = false;
    let mut saw_merge_ok = false;
    let mut saw_merge_refused = false;
    let mut pinned_errors: Vec<String> = Vec::new();
    let mut pinned_roles: Vec<String> = Vec::new();
    let mut derived: Vec<(String, [u8; 32])> = Vec::new();
    let mut cannot_decrypt_cases = 0usize;
    // The verify kind is only meaningful if it pins BOTH outcomes: a sheet of
    // refusals alone is passed by a `verify` that returns `false` unconditionally.
    let mut saw_accept = false;
    let mut saw_refuse = false;

    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["case_kind"].as_str().expect("case_kind");

        // Only the four blob kinds carry a key and an account hash: `merge`,
        // `signed_bytes`, `verify` and `group_subkey` are keyless by construction (a
        // merge of two maps, a message class, a verification outcome and a derivation,
        // none of which touches the seal), and demanding the fields there would be the
        // schema's job, not this runner's.
        let key = || -> [u8; protocol::AEAD_KEY_LEN] {
            hex_decode_array(
                case["input_device_binding_key_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] input_device_binding_key_hex")),
            )
        };
        let account_hash = || -> [u8; 16] {
            hex_decode_array(
                case["input_account_number_hash_hex"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] input_account_number_hash_hex")),
            )
        };

        match kind {
            "encrypt" => {
                saw_encrypt = true;
                let epoch = case["input_group_key_epoch"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] input_group_key_epoch"));
                let nonce: [u8; protocol::AEAD_NONCE_LEN] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_nonce_hex")),
                );
                let map = parse_map(&case["input_map"], id);
                let expected = hex_decode(
                    case["expected_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] expected_blob_hex")),
                );

                // The writer's format byte comes from the CASE. The family gained a
                // `0x02` schema (a row carrying the device public halves,
                // `decisions/protocol/0733`) without moving any magic, so the v1 cases
                // stay readable-and-pinned rather than being rewritten: a reader must
                // still accept a v1 blob, and the production writer emits v2.
                let declared_format = hex_decode(
                    case["expected_format_version_byte_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] expected_format_version_byte_hex")),
                );
                let format_version = *declared_format
                    .first()
                    .unwrap_or_else(|| panic!("[{id}] expected_format_version_byte_hex empty"));
                let blob = encode_device_binding_blob_raw_with_format(
                    &key(),
                    &account_hash(),
                    epoch,
                    &map,
                    format_version,
                    &nonce,
                )
                .expect("seal the device-binding map");
                assert_eq!(blob, expected, "[{id}] device-binding blob bytes mismatch");

                // The header facts the format fixes, asserted against the case's own
                // pins rather than only against the blob: a regenerated fixture that
                // lost its magic would otherwise still agree with the codec.
                assert_eq!(
                    case["expected_magic_ascii"].as_str(),
                    Some("MYU5"),
                    "[{id}] expected_magic_ascii"
                );
                assert_eq!(&blob[..4], &DEVICE_BINDING_BLOB_MAGIC[..], "[{id}] magic");
                assert_eq!(
                    hex_decode(
                        case["expected_protocol_version_byte_hex"]
                            .as_str()
                            .unwrap_or_else(|| panic!("[{id}] expected_protocol_version_byte_hex"))
                    ),
                    vec![blob[4]],
                    "[{id}] protocol_version byte"
                );
                assert_eq!(
                    declared_format,
                    vec![format_version],
                    "[{id}] format_version byte"
                );
                assert_eq!(
                    case["informational_header_len"].as_u64(),
                    Some(DEVICE_BINDING_BLOB_HEADER_LEN as u64),
                    "[{id}] header length"
                );
                let nonce_offset = case["informational_nonce_offset"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] informational_nonce_offset"))
                    as usize;
                assert_eq!(nonce_offset, 6, "[{id}] nonce offset");
                assert_eq!(
                    &blob[nonce_offset..nonce_offset + protocol::AEAD_NONCE_LEN],
                    &nonce[..],
                    "[{id}] nonce must sit at the pinned offset"
                );
                let declared =
                    u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;
                assert_eq!(
                    blob.len(),
                    DEVICE_BINDING_BLOB_HEADER_LEN + declared,
                    "[{id}] the length field counts the ciphertext with its tag"
                );

                // The plaintext is the CANONICAL map, so a port must be able to hand
                // the codec the same map and read the same rows back. Round-tripping is
                // what makes `not_canonical` a contract rather than a codec quirk, and
                // the EMPTY map case is here because that is the form a vault that has
                // never bound a device stores.
                let opened = decode_device_binding_blob(&key(), &account_hash(), epoch, &expected)
                    .expect("open");
                assert_eq!(opened, map, "[{id}] map round-trip mismatch");
            }
            "decrypt_fail" | "parse_fail" => {
                if kind == "decrypt_fail" {
                    saw_decrypt_fail = true;
                } else {
                    saw_parse_fail = true;
                }
                let epoch = case["input_group_key_epoch"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] input_group_key_epoch"));
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_blob_hex")),
                );
                let want = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] expected_error"));
                let err = decode_device_binding_blob(&key(), &account_hash(), epoch, &blob)
                    .err()
                    .unwrap_or_else(|| panic!("[{id}] expected {want}, got Ok"));
                assert_eq!(
                    err_name(&err),
                    want,
                    "[{id}] wrong failure variant: {err:?}"
                );
                if want == "cannot_decrypt" {
                    cannot_decrypt_cases += 1;
                }
                pinned_errors.push(want.to_string());
            }
            "encode_fail" => {
                saw_encode_fail = true;
                let epoch = case["input_group_key_epoch"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] input_group_key_epoch"));
                let nonce: [u8; protocol::AEAD_NONCE_LEN] = hex_decode_array(
                    case["input_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_nonce_hex")),
                );
                let map = parse_map(&case["input_map"], id);
                let want = case["expected_error"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] expected_error"));
                let err = encode_device_binding_blob_raw_with_format(
                    &key(),
                    &account_hash(),
                    epoch,
                    &map,
                    protocol::DEVICE_BINDING_BLOB_FORMAT_CURRENT,
                    &nonce,
                )
                .err()
                .unwrap_or_else(|| panic!("[{id}] expected {want} on the write side, got Ok"));
                assert_eq!(
                    err_name(&err),
                    want,
                    "[{id}] wrong failure variant: {err:?}"
                );
                pinned_errors.push(want.to_string());
            }
            "merge" => {
                let a = parse_map(&case["input_map_a"], id);
                let b = parse_map(&case["input_map_b"], id);
                // Order independence is the property the merge EXISTS for, so every
                // pair is merged both ways rather than one: a one-directional check
                // passes on an order-dependent implementation that happens to be tried
                // from the winning side.
                let a_then_b = merge_device_bindings(&a, &b);
                let b_then_a = merge_device_bindings(&b, &a);
                match case.get("expected_error").and_then(|v| v.as_str()) {
                    Some(want) => {
                        saw_merge_refused = true;
                        assert_eq!(
                            want, "conflicting_binding",
                            "[{id}] the merge kind pins one refusal; the sub-schema's \
                             nested oneOf admits no other"
                        );
                        let err = a_then_b
                            .err()
                            .unwrap_or_else(|| panic!("[{id}] expected {want}, got Ok"));
                        assert_eq!(
                            err_name(&err),
                            want,
                            "[{id}] wrong failure variant: {err:?}"
                        );
                        // The refusal must be SYMMETRIC: a pair that resolves one way
                        // and refuses the other is worse than one that always refuses,
                        // because the two peers would then hold different maps.
                        let err_rev = b_then_a.err().unwrap_or_else(|| {
                            panic!(
                                "[{id}] the refusal must be symmetric, but the reverse \
                                 argument order merged"
                            )
                        });
                        assert_eq!(
                            err_name(&err_rev),
                            want,
                            "[{id}] wrong failure variant in reverse order: {err_rev:?}"
                        );
                        pinned_errors.push(want.to_string());
                    }
                    None => {
                        saw_merge_ok = true;
                        let merged =
                            a_then_b.unwrap_or_else(|e| panic!("[{id}] merge a into b: {e:?}"));
                        let merged_rev =
                            b_then_a.unwrap_or_else(|e| panic!("[{id}] merge b into a: {e:?}"));
                        assert_eq!(
                            merged, merged_rev,
                            "[{id}] the merge must not depend on argument order"
                        );
                        let expected = parse_map(&case["expected_merged_map"], id);
                        assert_eq!(merged, expected, "[{id}] merged map mismatch");
                        // Merging the winner back in must be a no-op, which is what
                        // stops two peers re-sending the same row forever.
                        let idempotent = merge_device_bindings(&merged, &merged)
                            .unwrap_or_else(|e| panic!("[{id}] self-merge: {e:?}"));
                        assert_eq!(idempotent, merged, "[{id}] the merge must be idempotent");
                    }
                }
            }
            "signed_bytes" => {
                saw_signed_bytes = true;
                let device_id: [u8; 16] = hex_decode_array(
                    case["input_device_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_device_id_hex")),
                );
                let fingerprint: [u8; 32] = hex_decode_array(
                    case["input_person_fingerprint_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_person_fingerprint_hex")),
                );
                let version = case["input_version"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] input_version"));
                let tombstone = case["input_tombstone"]
                    .as_bool()
                    .unwrap_or_else(|| panic!("[{id}] input_tombstone"));
                assert_eq!(
                    case["expected_prefix_ascii"].as_str(),
                    Some("myne.device-binding v1|"),
                    "[{id}] expected_prefix_ascii"
                );
                // The message is FIXED width, so unlike the sibling here the length
                // does not vary with the tombstone flag: the fingerprint is present on
                // a tombstone too.
                assert_eq!(
                    case["informational_message_len_bytes"].as_u64(),
                    Some(80),
                    "[{id}] the signed message is fixed width"
                );
                let expected = hex_decode(
                    case["expected_message_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] expected_message_hex")),
                );
                let msg = device_binding_signed_bytes(&device_id, &fingerprint, version, tombstone);
                assert_eq!(msg, expected, "[{id}] signed-message bytes mismatch");
                assert!(
                    msg.starts_with(DEVICE_BINDING_PREFIX),
                    "[{id}] the message must open with the class prefix"
                );
                assert_eq!(
                    msg.len(),
                    DEVICE_BINDING_PREFIX.len() + 16 + 32 + 8 + 1,
                    "[{id}] prefix + device + fingerprint + version + tombstone"
                );
                // The prefix is what stops a device-binding signature being replayed as
                // a member name, a roster, an invite, a transition or an awareness
                // assertion, so it is asserted as a whole constant rather than only as
                // the message's head.
                assert_eq!(DEVICE_BINDING_PREFIX.len(), 23);
            }
            "verify" => {
                saw_verify = true;
                let verifier = case["verifier"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] verifier"));
                let device_id: [u8; 16] = hex_decode_array(
                    case["input_device_id_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_device_id_hex")),
                );
                let public = PersonPublicHalf::from_parts_hex(
                    case["input_signer_kem_ek_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_signer_kem_ek_hex")),
                    case["input_signer_ed_pk_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_signer_ed_pk_hex")),
                    case["input_signer_mldsa_vk_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_signer_mldsa_vk_hex")),
                )
                .unwrap_or_else(|e| panic!("[{id}] the published public half must parse: {e}"));
                let entry = parse_entry(&case["input_entry"], id);
                let expected = case["expected_verified"]
                    .as_bool()
                    .unwrap_or_else(|| panic!("[{id}] expected_verified"));

                // The message the signature covers, published beside the row so a port
                // can diff its own assembly against ours instead of reconstructing it.
                // It is rebuilt from the ROW's claimed fingerprint, which for an owner
                // removal is the removed member's, not the owner's.
                let claimed: [u8; 32] = hex_decode_array(&entry.person_fingerprint);
                let signed = hex_decode(
                    case["informational_signed_bytes_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] informational_signed_bytes_hex")),
                );
                // The message depends on the row's CLASS, so it is rebuilt through the
                // same helper the signer uses rather than by assuming v1: a v2 row
                // carries the device public halves inside the message.
                assert_eq!(
                    Some(signed),
                    binding_message_for_entry(&device_id, &claimed, &entry),
                    "[{id}] informational_signed_bytes_hex must be the message the row signs"
                );

                let got = match verifier {
                    "person" => verify_device_binding(&public, &device_id, &entry),
                    "owner" => verify_device_binding_removal(&public, &device_id, &entry),
                    other => panic!("[{id}] unknown verifier {other:?}"),
                };
                assert_eq!(got, expected, "[{id}] verification outcome mismatch");
                if expected {
                    saw_accept = true;
                } else {
                    saw_refuse = true;
                }
            }
            "group_subkey" => {
                saw_group_subkey = true;
                let group_key: [u8; 32] = hex_decode_array(
                    case["input_group_key_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] input_group_key_hex")),
                );
                let role_name = case["input_role"]
                    .as_str()
                    .unwrap_or_else(|| panic!("[{id}] input_role"));
                let role = match role_name {
                    "device-binding-key" => GroupRole::DeviceBindingKey,
                    "device-binding-sync-id" => GroupRole::DeviceBindingSyncId,
                    other => panic!(
                        "[{id}] unknown GROUP role {other:?}: the §3.4 registry has no such role"
                    ),
                };
                let expected = hex_decode(
                    case["expected_subkey_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] expected_subkey_hex")),
                );
                let derived_key = derive_group_subkey_v0_2(&GroupKey::new(group_key), role);
                assert_eq!(
                    derived_key.as_slice(),
                    expected.as_slice(),
                    "[{id}] {role_name} subkey bytes mismatch"
                );
                // A derivation that returned the group key unchanged would satisfy a
                // byte comparison only if the fixture were regenerated to match, so the
                // separation is asserted directly.
                assert_ne!(
                    derived_key.as_slice(),
                    &group_key[..],
                    "[{id}] {role_name} must not be the raw group key"
                );
                pinned_roles.push(role_name.to_string());
                derived.push((role_name.to_string(), *derived_key));
            }
            other => panic!("[{id}] unknown device-binding case_kind {other:?}"),
        }
    }

    for (flag, what) in [
        (saw_encrypt, "encrypt"),
        (saw_decrypt_fail, "decrypt_fail"),
        (saw_parse_fail, "parse_fail"),
        (saw_encode_fail, "encode_fail"),
        (saw_merge_ok, "merge (resolved)"),
        (saw_merge_refused, "merge (refused)"),
        (saw_signed_bytes, "signed_bytes"),
        (saw_verify, "verify"),
        (saw_group_subkey, "group_subkey"),
    ] {
        assert!(
            flag,
            "device-binding/v0.2 must carry at least one {what} case"
        );
    }
    assert!(
        saw_accept && saw_refuse,
        "the verify kind must pin BOTH outcomes: a sheet of refusals alone is passed by \
         a `verify` that always answers false"
    );
    // The refusal half of `merge` is not decoration: a family that pinned only the
    // resolved pairs would be satisfied by a merge that arbitrates every tie, which is
    // the implementation that leaves a device bound to two people forever.
    assert!(
        saw_merge_ok && saw_merge_refused,
        "the merge kind must pin BOTH outcomes: a resolved pair AND the refusal"
    );

    let mut sorted_errors = pinned_errors.clone();
    sorted_errors.sort_unstable();
    sorted_errors.dedup();
    assert!(
        sorted_errors.len() >= 9,
        "device-binding/v0.2 pins only {} distinct failure names ({sorted_errors:?}); the family's \
         decode surface is one variant at a time and must stay that way",
        sorted_errors.len()
    );
    // The non-distinguishing decrypt surface is the point of the four `cannot_decrypt`
    // cases: four DIFFERENT inputs (a tampered tag, a cross-vault account hash, a stale
    // epoch, a wrong key) must collapse to ONE name, so a port cannot report which
    // check fired. Counting them separately from the deduplicated set is what keeps
    // that a claim about four cases rather than about the one name dedup left behind.
    assert_eq!(
        cannot_decrypt_cases, 4,
        "the non-distinguishing decrypt surface must be pinned by four different inputs \
         that all collapse to `cannot_decrypt`; got {cannot_decrypt_cases}"
    );

    // ---- the §3.4 registry-level claim the `group_subkey` kind exists for -------
    //
    // Both roles are GROUP-tier, and the registry statement that matters is that neither
    // has a root-tier twin: if one ever grew a `SubkeyRole`, this family could be keyed
    // from `root_key`, an owner-only reader could open it, and a pre-B2B vault could
    // carry a `MYU5` blob: the exact thing the family's `NTV6`-only rule forbids.
    // Iterating `SubkeyRole::ALL` is what makes that fail when the registry changes
    // rather than when somebody remembers to look.
    let mut root_tier = Vec::new();
    for role in SubkeyRole::ALL {
        if let Some(group) = role.shared_group_role() {
            root_tier.push(group);
        }
    }
    for role in [GroupRole::DeviceBindingKey, GroupRole::DeviceBindingSyncId] {
        assert!(
            !root_tier.contains(&role),
            "GroupRole::{role:?} has a SubkeyRole counterpart, so this family could be \
             keyed from root_key and a pre-B2B vault could carry it: the NTV6-only rule is broken"
        );
        assert!(
            GroupRole::ALL.contains(&role),
            "GroupRole::{role:?} must be registered in GroupRole::ALL (§3.4)"
        );
    }

    // Both roles are pinned here, and that is stated as a SET rather than assumed: the
    // KEK role is the key the blob is sealed under and the sync-id role is the address
    // it is published at, so a change that registered a third GROUP role for this family
    // (or renamed one of these) has to come through this assertion. An unpinned role is
    // the shape that let `member-names-sync-id` ship with no vector while its KEK had
    // one, which is why the sibling category pins both and this one now does too.
    let mut sorted_roles = pinned_roles.clone();
    sorted_roles.sort_unstable();
    sorted_roles.dedup();
    assert_eq!(
        sorted_roles,
        vec![
            "device-binding-key".to_string(),
            "device-binding-sync-id".to_string()
        ],
        "both GROUP roles must be pinned by a case"
    );
    // The two are a KEK and an identifier, and a registry that pointed both at one
    // context string would satisfy the byte comparison only if the fixture were
    // regenerated to match, so the separation is asserted on the derived bytes.
    let mut by_role = derived.clone();
    by_role.sort_by(|a, b| a.0.cmp(&b.0));
    assert_ne!(
        by_role[0].1, by_role[1].1,
        "the two device-binding GROUP roles must derive different subkeys"
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

/// `vault-label` (`MYL1`, §9.22): the device-local sealed label store the
/// LOCKED vault picker reads a vault's name from (myne-md/myne#411).
///
/// Structurally the `share-import` / `pending-capture` runner above plus the two
/// things this family does that they cannot, and both are why the extra case
/// kinds exist:
///
/// * **The AAD binds the `VaultId` the READER expected**, not the one the blob
///   carries, which splits the cross-vault surface in two. An untouched blob
///   from another vault is `vault_id_mismatch`, refused by the structural
///   comparison before any key is touched; the *same* blob with its header
///   rewritten to claim the expected vault passes that comparison and is
///   refused by the AAD instead, collapsing to `CannotDecrypt`. The schema says
///   the two MUST surface different outcomes. A port that only compares passes
///   the first and fails the second, one that only binds reports the wrong error
///   for the first, so this runner asserts the split directly (below), rather
///   than leaving it implied by two independent cases.
/// * **Strict-trailing is enforced** (§10.3.1), so `trailing_bytes` is a named
///   reject rather than a tolerated tail, and `encode_fail` pins the write-side
///   cap refusal that pairs with the at-cap `encrypt` case to make the 4 KiB
///   boundary inclusive rather than off by one.
///
/// Every `parse_fail` fixture carries the **real** `wrap_key`. None of the
/// corrupted header fields is AAD-bound, so a port that skips one of these
/// checks decodes the fixture successfully, and this runner's exact-variant
/// assertion is what catches that. A dummy key would hide the same bug behind a
/// coincidental `CannotDecrypt`.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn vault_label_vectors() {
    // vault_label_blob is NOT re-exported at the crate root (it is a `pub mod`
    // with no flattened `pub use`), so the codec items are imported via the full
    // module path, the same convention as capture_blob / quick_unlock_blob /
    // share_import_blob. `aad_vault_label_blob` is likewise absent from the
    // crate-root `pub use aead::{…}` block, for the same device-local reason.
    use protocol::aead::aad_vault_label_blob;
    use protocol::vault_label_blob::{
        decode_vault_label_blob, encode_vault_label_blob_raw, VaultLabelBlobError,
        VAULT_LABEL_BLOB_HEADER_LEN,
    };

    let Some(raw) = cases_json("vault-label") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[vault-label] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "vault-label");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 18,
        "vault-label must carry at least 18 vectors (1 aad_construction + 3 encrypt + 1 encode_fail + 2 decrypt_ok + 3 decrypt_aead_fail + 8 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("vault-label", cases);

    let mut seen_kinds = std::collections::HashSet::new();
    let mut seen_parse_errors = std::collections::HashSet::new();
    // The untouched-blob half of the cross-vault pin, kept for the derived
    // relabelled-header check after the loop. The fixture's own wrap_key rides
    // along because the derived half claims an AAD refusal, and only the REAL
    // key can make that claim true: a dummy key fails the CTX check whatever
    // the AAD binds, so the assertion would not be able to tell "the AAD
    // refused" from "the key was wrong".
    struct CrossVaultPin {
        id: String,
        blob: Vec<u8>,
        expected_vault_id: [u8; 16],
        wrap_key: [u8; 32],
    }
    let mut cross_vault_pin: Option<CrossVaultPin> = None;

    for case in cases {
        let id = case["vector_id"]
            .as_str()
            .expect("vector_id must be a string");
        let case_kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] missing case_kind"));
        seen_kinds.insert(case_kind.to_string());

        match case_kind {
            "aad_construction" => {
                let builder = field(case, id, "input_aad_builder");
                let vault_id: [u8; 16] = hex_decode_array(field(case, id, "input_vault_id_hex"));
                let expected = hex_decode(field(case, id, "expected_aad_hex"));

                let actual = match builder {
                    "aad_vault_label_blob" => aad_vault_label_blob(&vault_id),
                    other => {
                        panic!("[{id}] unknown aad builder '{other}': this family has exactly one")
                    }
                };
                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] {builder} AAD mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "encrypt" => {
                let wrap_key: [u8; 32] = hex_decode_array(field(case, id, "input_wrap_key_hex"));
                let vault_id: [u8; 16] = hex_decode_array(field(case, id, "input_vault_id_hex"));
                let label = hex_decode(field(case, id, "input_label_utf8_hex"));
                let nonce: [u8; 24] = hex_decode_array(field(case, id, "input_nonce_hex"));
                let expected = hex_decode(field(case, id, "expected_vault_label_blob_hex"));

                let actual = encode_vault_label_blob_raw(&wrap_key, &vault_id, &label, &nonce)
                    .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] vault-label encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "encode_fail" => {
                // The write-side cap refusal. An over-cap label must be refused
                // OUTRIGHT rather than truncated: a truncating port emits a blob
                // that decodes cleanly forever after, carrying a wrong name.
                let wrap_key: [u8; 32] = hex_decode_array(field(case, id, "input_wrap_key_hex"));
                let vault_id: [u8; 16] = hex_decode_array(field(case, id, "input_vault_id_hex"));
                let label = hex_decode(field(case, id, "input_label_utf8_hex"));
                let nonce: [u8; 24] = hex_decode_array(field(case, id, "input_nonce_hex"));
                let expected_error = field(case, id, "expected_error");

                let expected_variant = match expected_error {
                    "ciphertext_len_overflow" => VaultLabelBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown encode-side expected_error '{other}': schema enforces enum; update this match arm in lockstep with VaultLabelBlobError"
                    ),
                };

                match encode_vault_label_blob_raw(&wrap_key, &vault_id, &label, &nonce) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected encode_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(blob) => panic!(
                        "[{id}] expected encode_fail '{expected_error}', encode returned Ok ({} bytes). An over-cap label was sealed (truncated?) instead of refused",
                        blob.len()
                    ),
                }
            }
            "decrypt_ok" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let wrap_key: [u8; 32] = hex_decode_array(field(case, id, "input_wrap_key_hex"));
                let vault_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_expected_vault_id_hex"));
                let expected_label = hex_decode(field(case, id, "expected_label_utf8_hex"));

                let decoded = decode_vault_label_blob(&wrap_key, &vault_id, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_label.as_slice(),
                    "[{id}] vault-label decrypt label mismatch\n  expected_hex: {}\n  actual_hex:   {}",
                    hex_encode(&expected_label),
                    hex_encode(&decoded),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let wrap_key: [u8; 32] = hex_decode_array(field(case, id, "input_wrap_key_hex"));
                let vault_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_expected_vault_id_hex"));
                assert_eq!(
                    field(case, id, "expected_kind"),
                    "aead_fail",
                    "[{id}] decrypt_aead_fail carries a non-aead expected_kind"
                );

                match decode_vault_label_blob(&wrap_key, &vault_id, &blob) {
                    Err(VaultLabelBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected VaultLabelBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(label) => panic!(
                        "[{id}] expected aead_fail, decode_vault_label_blob returned Ok ({} bytes)",
                        label.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                // The REAL wrap_key, deliberately (schema: "input_wrap_key_hex
                // … the REAL wrap_key"). A port that skips one of these checks
                // decodes the fixture SUCCESSFULLY; a dummy key would mask that
                // as a coincidental AEAD failure.
                let wrap_key: [u8; 32] = hex_decode_array(field(case, id, "input_wrap_key_hex"));
                let vault_id: [u8; 16] =
                    hex_decode_array(field(case, id, "input_expected_vault_id_hex"));
                let expected_error = field(case, id, "expected_error");
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => VaultLabelBlobError::MagicMismatch,
                    "protocol_version_mismatch" => VaultLabelBlobError::ProtocolVersionMismatch,
                    "vault_id_mismatch" => VaultLabelBlobError::VaultIdMismatch,
                    "ciphertext_len_overflow" => VaultLabelBlobError::CiphertextLenOverflow,
                    "header_too_short" => VaultLabelBlobError::HeaderTooShort,
                    "ciphertext_truncated" => VaultLabelBlobError::CiphertextTruncated,
                    "trailing_bytes" => VaultLabelBlobError::TrailingBytes,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}': schema enforces enum; update this match arm in lockstep with VaultLabelBlobError"
                    ),
                };

                match decode_vault_label_blob(&wrap_key, &vault_id, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(VaultLabelBlobError::CannotDecrypt) => panic!(
                        "[{id}] expected the DISTINGUISHABLE structural reject '{expected_error}' ({expected_variant:?}), got CannotDecrypt. The decoder collapsed a pre-decryption check into the AEAD stage, which is the ordering bug these fixtures (real wrap_key, one corrupted field) exist to name"
                    ),
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(label) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_vault_label_blob returned Ok ({} bytes). A structural check was skipped",
                        label.len()
                    ),
                }

                if expected_error == "vault_id_mismatch" {
                    cross_vault_pin = Some(CrossVaultPin {
                        id: id.to_string(),
                        blob,
                        expected_vault_id: vault_id,
                        wrap_key,
                    });
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}': schema enforces enum"),
        }
    }

    // ---- the cross-vault split, asserted rather than implied ----------
    //
    // The schema's MUST: an untouched blob from another vault and the same blob
    // with its header relabelled MUST surface DIFFERENT outcomes. Derived here
    // from the `vault_id_mismatch` fixture rather than matched by vector_id, so
    // the assertion holds even if the companion's relabelled case is renamed or
    // dropped. It is therefore a claim about the codec, not about two case files
    // agreeing with each other.
    //
    // Both halves run under the fixture's REAL wrap_key (every parse_fail case
    // carries it, by schema), which is what makes the relabelled half's message
    // true: with a dummy key CannotDecrypt would be the answer no matter what
    // the AAD binds, so the assertion would prove only that the structural
    // comparison had been passed.
    let CrossVaultPin {
        id: pin_id,
        blob: pin_blob,
        expected_vault_id,
        wrap_key,
    } = cross_vault_pin
        .expect("vault-label must carry the vault_id_mismatch fixture (required_parse_errors)");
    let untouched = decode_vault_label_blob(&wrap_key, &expected_vault_id, &pin_blob);
    assert_eq!(
        untouched,
        Err(VaultLabelBlobError::VaultIdMismatch),
        "[{pin_id}] the untouched cross-vault blob must be refused by the structural comparison"
    );

    assert!(
        pin_blob.len() >= VAULT_LABEL_BLOB_HEADER_LEN,
        "[{pin_id}] the vault_id_mismatch fixture must be a full-header blob for the relabelled half to be derivable"
    );

    // The positive control, and the reason the relabelled half below can be
    // ATTRIBUTED to the AAD at all. Read the same blob under the vault it was
    // sealed for (the one its own header names) and it opens: the key is the
    // right key and the ciphertext is intact. Everything that changes between
    // here and the next assertion is the 16 header bytes and, through them, the
    // AAD, so CannotDecrypt there has exactly one remaining cause.
    let own_vault_id: [u8; 16] = pin_blob[5..21].try_into().expect("header vault_id");
    assert!(
        decode_vault_label_blob(&wrap_key, &own_vault_id, &pin_blob).is_ok(),
        "[{pin_id}] the fixture's own wrap_key must OPEN its blob when read as the vault it was sealed for; without that the relabelled half below proves only that something refused"
    );

    let mut relabelled = pin_blob.clone();
    relabelled[5..21].copy_from_slice(&expected_vault_id);
    let relabelled_outcome = decode_vault_label_blob(&wrap_key, &expected_vault_id, &relabelled);
    assert_eq!(
        relabelled_outcome,
        Err(VaultLabelBlobError::CannotDecrypt),
        "[{pin_id}] relabelling the header to the expected vault must leave the AAD to refuse (CannotDecrypt), not the comparison"
    );
    assert_ne!(
        untouched, relabelled_outcome,
        "[{pin_id}] the two halves of the cross-vault pin collapsed to one outcome. A port that only compares, or only binds, would pass"
    );

    for kind in [
        "aad_construction",
        "encrypt",
        "encode_fail",
        "decrypt_ok",
        "decrypt_aead_fail",
        "parse_fail",
    ] {
        assert!(
            seen_kinds.contains(kind),
            "vault-label missing every case of case_kind '{kind}': coverage regression"
        );
    }
    // One per `VaultLabelBlobError` DECODE variant. `CannotDecrypt` is the
    // non-distinguishing AEAD surface (covered by decrypt_aead_fail) and
    // `RandomnessUnavailable` cannot be expressed as a fixture, so neither is
    // listed here.
    let required_parse_errors: [&str; 7] = [
        "magic_mismatch",
        "protocol_version_mismatch",
        "vault_id_mismatch",
        "ciphertext_len_overflow",
        "header_too_short",
        "ciphertext_truncated",
        "trailing_bytes",
    ];
    for err in required_parse_errors {
        assert!(
            seen_parse_errors.contains(err),
            "vault-label missing parse_fail coverage for VaultLabelBlobError '{err}': every structural reject must be pinned"
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
                    membership: None,
                    person_binding: None,
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
            "membership_absent" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let meta = parse_vault_meta_v0_2(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] absent membership must parse: {e:?}"));
                assert!(
                    meta.membership.is_none(),
                    "[{id}] absent membership must report None"
                );
            }
            "membership_present" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let meta = parse_vault_meta_v0_2(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] present membership must parse: {e:?}"));
                let membership = meta
                    .membership
                    .as_ref()
                    .unwrap_or_else(|| panic!("[{id}] membership must be present"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_number_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let account_id =
                    protocol::unseal_membership(&root_key, membership, &account_number_hash)
                        .unwrap_or_else(|e| panic!("[{id}] unseal: {e:?}"));
                assert_eq!(
                    hex_encode(&*account_id),
                    field(case, id, "expected_account_id_hex"),
                    "[{id}] account id"
                );
            }
            "membership_tampered" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let meta = parse_vault_meta_v0_2(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] tampered membership must parse: {e:?}"));
                let membership = meta
                    .membership
                    .as_ref()
                    .unwrap_or_else(|| panic!("[{id}] membership must be present"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_number_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                assert!(
                    protocol::unseal_membership(&root_key, membership, &account_number_hash)
                        .is_err(),
                    "[{id}] a tampered membership field must fail closed"
                );
            }
            "roster_present" | "roster_role" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let meta = parse_vault_meta_v0_2(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] roster meta must parse: {e:?}"));
                let membership = meta
                    .membership
                    .as_ref()
                    .unwrap_or_else(|| panic!("[{id}] membership must be present"));
                let roster = membership
                    .roster
                    .as_ref()
                    .unwrap_or_else(|| panic!("[{id}] roster must be present"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_number_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let plaintext =
                    protocol::unseal_membership_roster(&root_key, roster, &account_number_hash)
                        .unwrap_or_else(|e| panic!("[{id}] roster unseal: {e:?}"));
                assert_eq!(
                    String::from_utf8_lossy(&plaintext),
                    field(case, id, "expected_roster_plaintext_utf8"),
                    "[{id}] roster plaintext"
                );
                assert_eq!(
                    hex_encode(&roster.nonce),
                    field(case, id, "input_roster_nonce_hex"),
                    "[{id}] roster nonce"
                );
            }
            "roster_tampered" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let meta = parse_vault_meta_v0_2(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] tampered roster must parse: {e:?}"));
                let membership = meta
                    .membership
                    .as_ref()
                    .unwrap_or_else(|| panic!("[{id}] membership must be present"));
                let roster = membership
                    .roster
                    .as_ref()
                    .unwrap_or_else(|| panic!("[{id}] roster must be present"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_number_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                assert!(
                    protocol::unseal_membership_roster(&root_key, roster, &account_number_hash)
                        .is_err(),
                    "[{id}] a tampered roster envelope must fail closed"
                );
            }
            "roster_over_cap" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert!(
                    parse_vault_meta_v0_2(&blob).is_err(),
                    "[{id}] the length field past the 64 KiB cap must reject BEFORE any ciphertext read"
                );
            }
            "person_binding_present" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let meta = parse_vault_meta_v0_2(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] person-binding meta must parse: {e:?}"));
                let binding = meta
                    .person_binding
                    .as_ref()
                    .unwrap_or_else(|| panic!("[{id}] person binding must be present"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_number_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                let person_id =
                    protocol::unseal_person_binding(&root_key, binding, &account_number_hash)
                        .unwrap_or_else(|e| panic!("[{id}] person binding unseal: {e:?}"));
                assert_eq!(
                    hex_encode(&*person_id),
                    field(case, id, "expected_person_id_hex"),
                    "[{id}] person id hash"
                );
            }
            "person_binding_tampered" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let meta = parse_vault_meta_v0_2(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] tampered person binding must parse: {e:?}"));
                let binding = meta
                    .person_binding
                    .as_ref()
                    .unwrap_or_else(|| panic!("[{id}] person binding must be present"));
                let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
                let account_number_hash: [u8; 16] =
                    hex_decode_array(field(case, id, "input_account_number_hash_hex"));
                assert!(
                    protocol::unseal_person_binding(&root_key, binding, &account_number_hash)
                        .is_err(),
                    "[{id}] a tampered person binding must fail closed"
                );
            }
            "person_binding_absent" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let meta = parse_vault_meta_v0_2(&blob)
                    .unwrap_or_else(|e| panic!("[{id}] absent person binding must parse: {e:?}"));
                assert!(
                    meta.person_binding.is_none(),
                    "[{id}] absent person binding must report None"
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
    for k in [
        "membership_absent",
        "membership_present",
        "membership_tampered",
    ] {
        assert!(
            seen.contains(k),
            "vault-meta/v0.2 must cover membership case_kind {k}"
        );
    }
    for k in [
        "roster_present",
        "roster_tampered",
        "roster_over_cap",
        "roster_role",
    ] {
        assert!(
            seen.contains(k),
            "vault-meta/v0.2 must cover roster case_kind {k}"
        );
    }
    for k in [
        "person_binding_present",
        "person_binding_tampered",
        "person_binding_absent",
    ] {
        assert!(
            seen.contains(k),
            "vault-meta/v0.2 must cover person-binding case_kind {k}"
        );
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
                // succeed under a different magic too, since the magic selects
                // the generation before the AEAD stage.
                assert_eq!(
                    &expected[0..4],
                    field(case, id, "expected_magic_ascii").as_bytes(),
                    "[{id}] magic"
                );
                assert_eq!(
                    format!("{:02x}", expected[4]),
                    field(case, id, "expected_version_byte_hex"),
                    "[{id}] catalog singletons keep 0x01 in v0.2"
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

/// `MYM1` conversations-catalog codec vectors (§9.23, myne-md/myne#675).
/// Mirrors `vault_search_vectors`: the catalog plaintext is the client
/// layer's opaque roster bytes here (the canonical roster JSON is pinned by
/// the cases' byte content, not by a protocol-side canonicalizer).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn chats_catalog_vectors() {
    use protocol::{
        decode_chats_catalog_blob, derive_subkey, encode_chats_catalog_blob_raw, ChatsCatalogError,
        SubkeyRole,
    };

    let Some(raw) = cases_json("chats-catalog") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[chats-catalog] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "chats-catalog");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 13,
        "chats-catalog must carry at least 13 vectors (3 encrypt + 2 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("chats-catalog", cases);

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
                    case["input_plaintext_canonical_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing input_plaintext_canonical_utf8_hex")
                        }),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_catalog_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_catalog_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_catalog_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_catalog_blob_hex")),
                );

                let catalog_key = derive_subkey(&root_key, SubkeyRole::ChatsCatalogKey);
                if let Some(info_hex) = case
                    .get("informational_catalog_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        catalog_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_catalog_key_hex disagrees with derive_subkey(root_key, ChatsCatalogKey)",
                    );
                }

                let actual =
                    encode_chats_catalog_blob_raw(&catalog_key, &account_hash, &plaintext, &nonce)
                        .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] chats-catalog encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
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
                    case["expected_plaintext_canonical_utf8_hex"]
                        .as_str()
                        .unwrap_or_else(|| {
                            panic!("[{id}] missing expected_plaintext_canonical_utf8_hex")
                        }),
                );

                let catalog_key = derive_subkey(&root_key, SubkeyRole::ChatsCatalogKey);
                let decoded = decode_chats_catalog_blob(&catalog_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] chats-catalog decrypt plaintext mismatch ({} bytes)",
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

                let catalog_key = derive_subkey(&root_key, SubkeyRole::ChatsCatalogKey);
                match decode_chats_catalog_blob(&catalog_key, &account_hash, &blob) {
                    Err(ChatsCatalogError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected ChatsCatalogError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_chats_catalog_blob returned Ok ({} byte plaintext)",
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
                    "magic_mismatch" => ChatsCatalogError::MagicMismatch,
                    "protocol_version_mismatch" => ChatsCatalogError::ProtocolVersionMismatch,
                    "format_unsupported" => ChatsCatalogError::FormatUnsupported,
                    "header_too_short" => ChatsCatalogError::HeaderTooShort,
                    "ciphertext_truncated" => ChatsCatalogError::CiphertextTruncated,
                    "ciphertext_len_overflow" => ChatsCatalogError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}': schema enforces enum, so update this match arm in lockstep with ChatsCatalogError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_chats_catalog_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_chats_catalog_blob returned Ok"
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
            "chats-catalog missing every case of case_kind '{kind}': coverage regression"
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
            "chats-catalog missing parse_fail coverage for ChatsCatalogError '{err}': every structural reject must be pinned"
        );
    }
}

/// `MYM5` migrated-catalog envelope vectors (§10.4.1, myne-md/myne#675).
/// Mirrors `vault_themes_v0_2_vectors`, except the KEK is derived (v0.2
/// generation) rather than fixed, so the cases carry their root key and
/// account hash inputs.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn chats_catalog_v0_2_vectors() {
    use protocol::{decode_chats_catalog_blob_versioned, derive_subkey_versioned, MetaVersion};

    let Some(raw) = cases_json_v0_2("chats-catalog") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[chats-catalog/v0.2] parse: {e}"));
    assert_eq!(doc["schema"], "chats-catalog");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("chats-catalog/v0.2", cases);

    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] case_kind"));
        seen.insert(kind.to_string());
        let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
        let account_hash: [u8; 16] =
            hex_decode_array(field(case, id, "input_account_number_hash_hex"));
        let kek_v0_1 = derive_subkey_versioned(
            MetaVersion::V0_1,
            &root_key,
            protocol::SubkeyRole::ChatsCatalogKey,
        );
        let kek_v0_2 = derive_subkey_versioned(
            MetaVersion::V0_2,
            &root_key,
            protocol::SubkeyRole::ChatsCatalogKey,
        );
        match kind {
            "encrypt" => {
                let expected = hex_decode(field(case, id, "expected_blob_hex"));
                // Read the two conventions straight off the bytes rather than
                // inferring them from a successful decode.
                assert_eq!(&expected[0..4], b"MYM5", "[{id}] magic");
                assert_eq!(
                    format!("{:02x}", expected[4]),
                    field(case, id, "expected_version_byte_hex"),
                    "[{id}] catalog singletons keep 0x01 in v0.2"
                );
                let opened = decode_chats_catalog_blob_versioned(
                    MetaVersion::V0_2,
                    &kek_v0_2,
                    &account_hash,
                    &expected,
                )
                .unwrap_or_else(|e| panic!("[{id}] decode: {e:?}"));
                assert_eq!(
                    hex_encode(&opened),
                    field(case, id, "input_plaintext_hex"),
                    "[{id}] plaintext"
                );
            }
            "decode_fail_v0_1" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert_eq!(
                    field(case, id, "expected_error"),
                    "magic_mismatch",
                    "[{id}] the v0.1 expectation refuses a next-major blob at the magic check"
                );
                assert!(
                    decode_chats_catalog_blob_versioned(
                        MetaVersion::V0_1,
                        &kek_v0_1,
                        &account_hash,
                        &blob
                    )
                    .is_err(),
                    "[{id}] a MYM5 blob must not open under the v0.1 expectation"
                );
            }
            other => panic!("[{id}] unknown case_kind {other}"),
        }
    }
    for k in ["encrypt", "decode_fail_v0_1"] {
        assert!(
            seen.contains(k),
            "chats-catalog/v0.2 must cover case_kind {k}"
        );
    }
}

/// `MYJ1` conversation-file codec vectors (§9.24, myne-md/myne#675). The
/// per-conversation-file twin of `chats_catalog_vectors`, plus the
/// cross-conversation-id AEAD refusal the per-entry AAD binding owes.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn chats_blob_vectors() {
    use protocol::{
        decode_chats_blob, derive_subkey, encode_chats_blob_raw, ChatsBlobError, SubkeyRole,
    };

    let Some(raw) = cases_json("chats-blob") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[chats-blob] parse cases.json: {e}"));

    assert_eq!(doc["schema"], "chats-blob");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 13,
        "chats-blob must carry at least 13 vectors (3 encrypt + 1 decrypt_ok + 3 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("chats-blob", cases);

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

        // Every arm needs the same four inputs; read once.
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
        let conv_id: [u8; 16] = hex_decode_array(
            case["input_conversation_id_hex"]
                .as_str()
                .unwrap_or_else(|| panic!("[{id}] missing input_conversation_id_hex")),
        );
        let chats_key = derive_subkey(&root_key, SubkeyRole::ChatsKey);

        match case_kind {
            "encrypt" => {
                let plaintext = hex_decode(
                    case["input_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_plaintext_hex")),
                );
                let nonce: [u8; 24] = hex_decode_array(
                    case["input_blob_nonce_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_nonce_hex")),
                );
                let expected = hex_decode(
                    case["expected_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_blob_hex")),
                );

                if let Some(info_hex) = case
                    .get("informational_chats_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        chats_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_chats_key_hex disagrees with derive_subkey(root_key, ChatsKey)",
                    );
                }

                let actual =
                    encode_chats_blob_raw(&chats_key, &account_hash, &conv_id, &plaintext, &nonce)
                        .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] chats-blob encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
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
                let expected_plaintext = hex_decode(
                    case["expected_plaintext_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing expected_plaintext_hex")),
                );

                let decoded = decode_chats_blob(&chats_key, &account_hash, &conv_id, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] chats-blob decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(
                    case["input_blob_hex"]
                        .as_str()
                        .unwrap_or_else(|| panic!("[{id}] missing input_blob_hex")),
                );

                match decode_chats_blob(&chats_key, &account_hash, &conv_id, &blob) {
                    Err(ChatsBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected ChatsBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode_chats_blob returned Ok ({} byte plaintext)",
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
                    "magic_mismatch" => ChatsBlobError::MagicMismatch,
                    "protocol_version_mismatch" => ChatsBlobError::ProtocolVersionMismatch,
                    "format_unsupported" => ChatsBlobError::FormatUnsupported,
                    "header_too_short" => ChatsBlobError::HeaderTooShort,
                    "ciphertext_truncated" => ChatsBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => ChatsBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_error '{other}': schema enforces enum, so update this match arm in lockstep with ChatsBlobError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                let dummy_conv = [0u8; 16];
                match decode_chats_blob(&dummy_key, &dummy_hash, &dummy_conv, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode_chats_blob returned Ok"
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
            "chats-blob missing every case of case_kind '{kind}': coverage regression"
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
            "chats-blob missing parse_fail coverage for ChatsBlobError '{err}': every structural reject must be pinned"
        );
    }
}

/// `MYJ5` migrated conversation-file envelope vectors (§10.4.1,
/// myne-md/myne#675). Unlike the catalog/themes singletons, the
/// conversation-file header version byte IS the generation (`0x02` here).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn chats_blob_v0_2_vectors() {
    use protocol::{decode_chats_blob_versioned, derive_subkey_versioned, MetaVersion};

    let Some(raw) = cases_json_v0_2("chats-blob") else {
        return;
    };
    let doc: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("[chats-blob/v0.2] parse: {e}"));
    assert_eq!(doc["schema"], "chats-blob");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("chats-blob/v0.2", cases);

    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] case_kind"));
        seen.insert(kind.to_string());
        let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
        let account_hash: [u8; 16] =
            hex_decode_array(field(case, id, "input_account_number_hash_hex"));
        let conv_id: [u8; 16] = hex_decode_array(field(case, id, "input_conversation_id_hex"));
        let kek_v0_1 =
            derive_subkey_versioned(MetaVersion::V0_1, &root_key, protocol::SubkeyRole::ChatsKey);
        let kek_v0_2 =
            derive_subkey_versioned(MetaVersion::V0_2, &root_key, protocol::SubkeyRole::ChatsKey);
        match kind {
            "encrypt" => {
                let expected = hex_decode(field(case, id, "expected_blob_hex"));
                assert_eq!(
                    &expected[0..4],
                    field(case, id, "expected_magic_ascii").as_bytes(),
                    "[{id}] magic"
                );
                assert_eq!(
                    format!("{:02x}", expected[4]),
                    field(case, id, "expected_version_byte_hex"),
                    "[{id}] the conversation-file header version byte is the generation"
                );
                let opened = decode_chats_blob_versioned(
                    MetaVersion::V0_2,
                    &kek_v0_2,
                    &account_hash,
                    &conv_id,
                    &expected,
                )
                .unwrap_or_else(|e| panic!("[{id}] decode: {e:?}"));
                assert_eq!(
                    hex_encode(&opened),
                    field(case, id, "input_plaintext_hex"),
                    "[{id}] plaintext"
                );
            }
            "decode_fail_v0_1" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert_eq!(
                    field(case, id, "expected_error"),
                    "magic_mismatch",
                    "[{id}] the v0.1 expectation refuses a next-major blob at the magic check"
                );
                assert!(
                    decode_chats_blob_versioned(
                        MetaVersion::V0_1,
                        &kek_v0_1,
                        &account_hash,
                        &conv_id,
                        &blob
                    )
                    .is_err(),
                    "[{id}] a MYJ5 blob must not open under the v0.1 expectation"
                );
            }
            other => panic!("[{id}] unknown case_kind {other}"),
        }
    }
    for k in ["encrypt", "decode_fail_v0_1"] {
        assert!(seen.contains(k), "chats-blob/v0.2 must cover case_kind {k}");
    }
}

/// `MYN1` agent-memory catalog codec vectors (§9.25, myne-md/myne#697). The
/// `chats_catalog_vectors` shape: envelope golden bytes, decode round-trips,
/// the non-distinguishing AEAD failure, and every structural reject the
/// `AgentMemoryCatalogError` enum carries.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn agent_memory_catalog_vectors() {
    use protocol::{
        decode_agent_memory_catalog_blob, derive_subkey, encode_agent_memory_catalog_blob_raw,
        AgentMemoryCatalogError, SubkeyRole,
    };

    let Some(raw) = cases_json("agent-memory-catalog") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[agent-memory-catalog] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "agent-memory-catalog");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 13,
        "agent-memory-catalog must carry at least 13 vectors (3 encrypt + 2 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("agent-memory-catalog", cases);

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

        let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
        let account_hash: [u8; 16] =
            hex_decode_array(field(case, id, "input_account_number_hash_hex"));

        match case_kind {
            "encrypt" => {
                let plaintext = hex_decode(field(case, id, "input_plaintext_canonical_utf8_hex"));
                let nonce: [u8; 24] = hex_decode_array(field(case, id, "input_catalog_nonce_hex"));
                let expected = hex_decode(field(case, id, "expected_catalog_blob_hex"));

                let catalog_key = derive_subkey(&root_key, SubkeyRole::AgentMemoryCatalogKey);
                if let Some(info_hex) = case
                    .get("informational_catalog_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        catalog_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_catalog_key_hex disagrees with derive_subkey(root_key, AgentMemoryCatalogKey)",
                    );
                }

                let actual = encode_agent_memory_catalog_blob_raw(
                    &catalog_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] agent-memory-catalog encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let expected_plaintext =
                    hex_decode(field(case, id, "expected_plaintext_canonical_utf8_hex"));

                let catalog_key = derive_subkey(&root_key, SubkeyRole::AgentMemoryCatalogKey);
                let decoded = decode_agent_memory_catalog_blob(&catalog_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] agent-memory-catalog decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert_eq!(
                    field(case, id, "expected_kind"),
                    "aead_fail",
                    "[{id}] decrypt_aead_fail carries a non-aead expected_kind"
                );

                let catalog_key = derive_subkey(&root_key, SubkeyRole::AgentMemoryCatalogKey);
                match decode_agent_memory_catalog_blob(&catalog_key, &account_hash, &blob) {
                    Err(AgentMemoryCatalogError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected AgentMemoryCatalogError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let expected_error = field(case, id, "expected_error");
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => AgentMemoryCatalogError::MagicMismatch,
                    "protocol_version_mismatch" => AgentMemoryCatalogError::ProtocolVersionMismatch,
                    "format_unsupported" => AgentMemoryCatalogError::FormatUnsupported,
                    "header_too_short" => AgentMemoryCatalogError::HeaderTooShort,
                    "ciphertext_truncated" => AgentMemoryCatalogError::CiphertextTruncated,
                    "ciphertext_len_overflow" => AgentMemoryCatalogError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_kind '{other}': schema enforces enum, so update this match arm in lockstep with AgentMemoryCatalogError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_agent_memory_catalog_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' (schema enforces enum)"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "agent-memory-catalog missing every case of case_kind '{kind}': coverage regression"
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
            "agent-memory-catalog missing parse_fail coverage for AgentMemoryCatalogError '{err}': every structural reject must be pinned"
        );
    }
}

/// `MYN5` agent-memory catalog codec vectors (§9.25 + §10.4.1, myne-md/myne#697).
/// The `chats_catalog_v0_2_vectors` shape: golden `encrypt` (the bytes the
/// migration writes: v0.2 KEK + v0.2 AAD) + `decode_fail_v0_1` (the §10.5
/// anti-downgrade pin). Skips without the companion checkout, like every
/// other runner in this file.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn agent_memory_catalog_v0_2_vectors() {
    use protocol::{
        decode_agent_memory_catalog_blob_versioned, derive_subkey_versioned, MetaVersion,
    };

    let Some(raw) = cases_json_v0_2("agent-memory-catalog") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[agent-memory-catalog/v0.2] parse: {e}"));
    assert_eq!(doc["schema"], "agent-memory-catalog");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("agent-memory-catalog/v0.2", cases);

    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] case_kind"));
        seen.insert(kind.to_string());
        let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
        let account_hash: [u8; 16] =
            hex_decode_array(field(case, id, "input_account_number_hash_hex"));
        let kek_v0_1 = derive_subkey_versioned(
            MetaVersion::V0_1,
            &root_key,
            protocol::SubkeyRole::AgentMemoryCatalogKey,
        );
        let kek_v0_2 = derive_subkey_versioned(
            MetaVersion::V0_2,
            &root_key,
            protocol::SubkeyRole::AgentMemoryCatalogKey,
        );
        match kind {
            "encrypt" => {
                let expected = hex_decode(field(case, id, "expected_blob_hex"));
                assert_eq!(
                    &expected[0..4],
                    field(case, id, "expected_magic_ascii").as_bytes(),
                    "[{id}] magic"
                );
                assert_eq!(
                    format!("{:02x}", expected[4]),
                    field(case, id, "expected_version_byte_hex"),
                    "[{id}] catalog singletons keep 0x01 in v0.2"
                );
                let opened = decode_agent_memory_catalog_blob_versioned(
                    MetaVersion::V0_2,
                    &kek_v0_2,
                    &account_hash,
                    &expected,
                )
                .unwrap_or_else(|e| panic!("[{id}] decode: {e:?}"));
                assert_eq!(
                    hex_encode(&opened),
                    field(case, id, "input_plaintext_hex"),
                    "[{id}] plaintext"
                );
            }
            "decode_fail_v0_1" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert_eq!(
                    field(case, id, "expected_error"),
                    "magic_mismatch",
                    "[{id}] the v0.1 expectation refuses a next-major blob at the magic check"
                );
                assert!(
                    decode_agent_memory_catalog_blob_versioned(
                        MetaVersion::V0_1,
                        &kek_v0_1,
                        &account_hash,
                        &blob
                    )
                    .is_err(),
                    "[{id}] a MYN5 blob must not open under the v0.1 expectation"
                );
            }
            other => panic!("[{id}] unknown case_kind {other}"),
        }
    }
    for k in ["encrypt", "decode_fail_v0_1"] {
        assert!(
            seen.contains(k),
            "agent-memory-catalog/v0.2 must cover case_kind {k}"
        );
    }
}

/// `MYX1` per-entry agent-memory blob codec vectors (§9.26, myne-md/myne#697).
/// Same shape as the catalog runner one above; the cases carry the entry id
/// the AAD binds, which is what makes a cross-entry substitution fail.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn agent_memory_blob_vectors() {
    use protocol::{
        decode_agent_memory_blob, derive_subkey, encode_agent_memory_blob_raw,
        AgentMemoryBlobError, SubkeyRole,
    };

    let Some(raw) = cases_json("agent-memory-blob") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[agent-memory-blob] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "agent-memory-blob");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 13,
        "agent-memory-blob must carry at least 13 vectors (3 encrypt + 1 decrypt_ok + 3 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("agent-memory-blob", cases);

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

        let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
        let account_hash: [u8; 16] =
            hex_decode_array(field(case, id, "input_account_number_hash_hex"));
        let entry_id: [u8; 16] = hex_decode_array(field(case, id, "input_memory_entry_id_hex"));

        match case_kind {
            "encrypt" => {
                let plaintext = hex_decode(field(case, id, "input_plaintext_canonical_utf8_hex"));
                let nonce: [u8; 24] = hex_decode_array(field(case, id, "input_blob_nonce_hex"));
                let expected = hex_decode(field(case, id, "expected_blob_hex"));

                let memory_key = derive_subkey(&root_key, SubkeyRole::AgentMemoryKey);
                if let Some(info_hex) = case
                    .get("informational_blob_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        memory_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_blob_key_hex disagrees with derive_subkey(root_key, AgentMemoryKey)",
                    );
                }

                let actual = encode_agent_memory_blob_raw(
                    &memory_key,
                    &account_hash,
                    &entry_id,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] agent-memory-blob encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let expected_plaintext =
                    hex_decode(field(case, id, "expected_plaintext_canonical_utf8_hex"));

                let memory_key = derive_subkey(&root_key, SubkeyRole::AgentMemoryKey);
                let decoded =
                    decode_agent_memory_blob(&memory_key, &account_hash, &entry_id, &blob)
                        .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] agent-memory-blob decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert_eq!(
                    field(case, id, "expected_kind"),
                    "aead_fail",
                    "[{id}] decrypt_aead_fail carries a non-aead expected_kind"
                );

                let memory_key = derive_subkey(&root_key, SubkeyRole::AgentMemoryKey);
                match decode_agent_memory_blob(&memory_key, &account_hash, &entry_id, &blob) {
                    Err(AgentMemoryBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected AgentMemoryBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let expected_error = field(case, id, "expected_error");
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => AgentMemoryBlobError::MagicMismatch,
                    "protocol_version_mismatch" => AgentMemoryBlobError::ProtocolVersionMismatch,
                    "format_unsupported" => AgentMemoryBlobError::FormatUnsupported,
                    "header_too_short" => AgentMemoryBlobError::HeaderTooShort,
                    "ciphertext_truncated" => AgentMemoryBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => AgentMemoryBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_kind '{other}': schema enforces enum, so update this match arm in lockstep with AgentMemoryBlobError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_agent_memory_blob(&dummy_key, &dummy_hash, &entry_id, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' (schema enforces enum)"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "agent-memory-blob missing every case of case_kind '{kind}': coverage regression"
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
            "agent-memory-blob missing parse_fail coverage for AgentMemoryBlobError '{err}': every structural reject must be pinned"
        );
    }
}

/// `MYX5` per-entry agent-memory blob vectors (§9.26 + §10.4.1, myne-md/myne#697).
/// The `chats_blob_v0_2_vectors` shape: golden `encrypt` (the bytes the
/// migration's 5b2 leg writes: v0.2 KEK + v0.2 per-entry AAD) +
/// `decode_fail_v0_1` (the §10.5 anti-downgrade pin). Unlike the singletons,
/// the per-entry families carry the generation in the header version byte
/// (0x02), which the runner pins rather than assuming.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn agent_memory_blob_v0_2_vectors() {
    use protocol::{decode_agent_memory_blob_versioned, derive_subkey_versioned, MetaVersion};

    let Some(raw) = cases_json_v0_2("agent-memory-blob") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[agent-memory-blob/v0.2] parse: {e}"));
    assert_eq!(doc["schema"], "agent-memory-blob");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("agent-memory-blob/v0.2", cases);

    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] case_kind"));
        seen.insert(kind.to_string());
        let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
        let account_hash: [u8; 16] =
            hex_decode_array(field(case, id, "input_account_number_hash_hex"));
        let entry_id: [u8; 16] = hex_decode_array(field(case, id, "input_memory_entry_id_hex"));
        let kek_v0_1 = derive_subkey_versioned(
            MetaVersion::V0_1,
            &root_key,
            protocol::SubkeyRole::AgentMemoryKey,
        );
        let kek_v0_2 = derive_subkey_versioned(
            MetaVersion::V0_2,
            &root_key,
            protocol::SubkeyRole::AgentMemoryKey,
        );
        match kind {
            "encrypt" => {
                let expected = hex_decode(field(case, id, "expected_blob_hex"));
                assert_eq!(
                    &expected[0..4],
                    field(case, id, "expected_magic_ascii").as_bytes(),
                    "[{id}] magic"
                );
                assert_eq!(
                    format!("{:02x}", expected[4]),
                    field(case, id, "expected_version_byte_hex"),
                    "[{id}] per-entry families carry the generation in the version byte"
                );
                let opened = decode_agent_memory_blob_versioned(
                    MetaVersion::V0_2,
                    &kek_v0_2,
                    &account_hash,
                    &entry_id,
                    &expected,
                )
                .unwrap_or_else(|e| panic!("[{id}] decode: {e:?}"));
                assert_eq!(
                    hex_encode(&opened),
                    field(case, id, "input_plaintext_hex"),
                    "[{id}] plaintext"
                );
            }
            "decode_fail_v0_1" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert_eq!(
                    field(case, id, "expected_error"),
                    "magic_mismatch",
                    "[{id}] the v0.1 expectation refuses a next-major blob at the magic check"
                );
                assert!(
                    decode_agent_memory_blob_versioned(
                        MetaVersion::V0_1,
                        &kek_v0_1,
                        &account_hash,
                        &entry_id,
                        &blob
                    )
                    .is_err(),
                    "[{id}] a MYX5 blob must not open under the v0.1 expectation"
                );
            }
            other => panic!("[{id}] unknown case_kind {other}"),
        }
    }
    for k in ["encrypt", "decode_fail_v0_1"] {
        assert!(
            seen.contains(k),
            "agent-memory-blob/v0.2 must cover case_kind {k}"
        );
    }
}

/// `MYZ1` personality singleton codec vectors (§9.27, myne-md/myne#697). The
/// singleton shape (no per-entry id in the AAD).
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn agent_personality_vectors() {
    use protocol::{
        decode_agent_personality_blob, derive_subkey, encode_agent_personality_blob_raw,
        AgentPersonalityBlobError, SubkeyRole,
    };

    let Some(raw) = cases_json("agent-personality") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[agent-personality] parse cases.json: {e}"));
    assert_eq!(doc["schema"], "agent-personality");
    assert_eq!(doc["protocol_version"], "v0.1");

    let cases = doc["cases"].as_array().expect("cases must be a JSON array");
    assert!(
        cases.len() >= 10,
        "agent-personality must carry at least 10 vectors (1 encrypt + 1 decrypt_ok + 2 decrypt_aead_fail + 6 parse_fail); found {}",
        cases.len()
    );
    assert_unique_vector_ids("agent-personality", cases);

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

        let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
        let account_hash: [u8; 16] =
            hex_decode_array(field(case, id, "input_account_number_hash_hex"));

        match case_kind {
            "encrypt" => {
                let plaintext = hex_decode(field(case, id, "input_plaintext_canonical_utf8_hex"));
                let nonce: [u8; 24] =
                    hex_decode_array(field(case, id, "input_personality_nonce_hex"));
                let expected = hex_decode(field(case, id, "expected_blob_hex"));

                let personality_key = derive_subkey(&root_key, SubkeyRole::AgentPersonalityKey);
                if let Some(info_hex) = case
                    .get("informational_personality_key_hex")
                    .and_then(|v| v.as_str())
                {
                    let info_bytes: [u8; 32] = hex_decode_array(info_hex);
                    assert_eq!(
                        personality_key.as_slice(),
                        info_bytes.as_slice(),
                        "[{id}] informational_personality_key_hex disagrees with derive_subkey(root_key, AgentPersonalityKey)",
                    );
                }

                let actual = encode_agent_personality_blob_raw(
                    &personality_key,
                    &account_hash,
                    &plaintext,
                    &nonce,
                )
                .unwrap_or_else(|e| panic!("[{id}] encode failed: {e:?}"));

                assert_eq!(
                    actual.as_slice(),
                    expected.as_slice(),
                    "[{id}] agent-personality encrypt mismatch ({} bytes)\n  expected_hex: {}\n  actual_hex:   {}",
                    expected.len(),
                    hex_encode(&expected),
                    hex_encode(&actual),
                );
            }
            "decrypt_ok" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let expected_plaintext =
                    hex_decode(field(case, id, "expected_plaintext_canonical_utf8_hex"));

                let personality_key = derive_subkey(&root_key, SubkeyRole::AgentPersonalityKey);
                let decoded = decode_agent_personality_blob(&personality_key, &account_hash, &blob)
                    .unwrap_or_else(|e| panic!("[{id}] decode failed: {e:?}"));

                assert_eq!(
                    decoded.as_slice(),
                    expected_plaintext.as_slice(),
                    "[{id}] agent-personality decrypt plaintext mismatch ({} bytes)",
                    expected_plaintext.len(),
                );
            }
            "decrypt_aead_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert_eq!(
                    field(case, id, "expected_kind"),
                    "aead_fail",
                    "[{id}] decrypt_aead_fail carries a non-aead expected_kind"
                );

                let personality_key = derive_subkey(&root_key, SubkeyRole::AgentPersonalityKey);
                match decode_agent_personality_blob(&personality_key, &account_hash, &blob) {
                    Err(AgentPersonalityBlobError::CannotDecrypt) => {}
                    Err(other) => panic!(
                        "[{id}] expected AgentPersonalityBlobError::CannotDecrypt (non-distinguishing AEAD failure per spec §6.4), got {other:?}"
                    ),
                    Ok(plaintext) => panic!(
                        "[{id}] expected aead_fail, decode returned Ok ({} byte plaintext)",
                        plaintext.len()
                    ),
                }
            }
            "parse_fail" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                let expected_error = field(case, id, "expected_error");
                seen_parse_errors.insert(expected_error.to_string());

                let expected_variant = match expected_error {
                    "magic_mismatch" => AgentPersonalityBlobError::MagicMismatch,
                    "protocol_version_mismatch" => AgentPersonalityBlobError::ProtocolVersionMismatch,
                    "format_unsupported" => AgentPersonalityBlobError::FormatUnsupported,
                    "header_too_short" => AgentPersonalityBlobError::HeaderTooShort,
                    "ciphertext_truncated" => AgentPersonalityBlobError::CiphertextTruncated,
                    "ciphertext_len_overflow" => AgentPersonalityBlobError::CiphertextLenOverflow,
                    other => panic!(
                        "[{id}] unknown expected_kind '{other}': schema enforces enum, so update this match arm in lockstep with AgentPersonalityBlobError"
                    ),
                };

                let dummy_key = [0u8; 32];
                let dummy_hash = [0u8; 16];
                match decode_agent_personality_blob(&dummy_key, &dummy_hash, &blob) {
                    Err(e) if e == expected_variant => {}
                    Err(other) => panic!(
                        "[{id}] expected parse_fail '{expected_error}' ({expected_variant:?}), got {other:?}"
                    ),
                    Ok(_) => panic!(
                        "[{id}] expected parse_fail '{expected_error}', decode returned Ok"
                    ),
                }
            }
            other => panic!("[{id}] unknown case_kind '{other}' (schema enforces enum)"),
        }
    }

    let required_kinds: [&str; 4] = ["encrypt", "decrypt_ok", "decrypt_aead_fail", "parse_fail"];
    for kind in required_kinds {
        assert!(
            seen_kinds.contains(kind),
            "agent-personality missing every case of case_kind '{kind}': coverage regression"
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
            "agent-personality missing parse_fail coverage for AgentPersonalityBlobError '{err}': every structural reject must be pinned"
        );
    }
}

/// `MYZ5` personality singleton vectors (§9.27 + §10.4.1, myne-md/myne#697).
/// The singleton v0.2 shape (catalog twin one above): golden `encrypt` +
/// `decode_fail_v0_1`.
#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test)]
fn agent_personality_v0_2_vectors() {
    use protocol::{decode_agent_personality_blob_versioned, derive_subkey_versioned, MetaVersion};

    let Some(raw) = cases_json_v0_2("agent-personality") else {
        return;
    };
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("[agent-personality/v0.2] parse: {e}"));
    assert_eq!(doc["schema"], "agent-personality");
    assert_eq!(doc["protocol_version"], "v0.2");
    let cases = doc["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty());
    assert_unique_vector_ids("agent-personality/v0.2", cases);

    let mut seen = std::collections::HashSet::new();
    for case in cases {
        let id = case["vector_id"].as_str().expect("vector_id");
        let kind = case["case_kind"]
            .as_str()
            .unwrap_or_else(|| panic!("[{id}] case_kind"));
        seen.insert(kind.to_string());
        let root_key: [u8; 32] = hex_decode_array(field(case, id, "input_root_key_hex"));
        let account_hash: [u8; 16] =
            hex_decode_array(field(case, id, "input_account_number_hash_hex"));
        let kek_v0_1 = derive_subkey_versioned(
            MetaVersion::V0_1,
            &root_key,
            protocol::SubkeyRole::AgentPersonalityKey,
        );
        let kek_v0_2 = derive_subkey_versioned(
            MetaVersion::V0_2,
            &root_key,
            protocol::SubkeyRole::AgentPersonalityKey,
        );
        match kind {
            "encrypt" => {
                let expected = hex_decode(field(case, id, "expected_blob_hex"));
                assert_eq!(
                    &expected[0..4],
                    field(case, id, "expected_magic_ascii").as_bytes(),
                    "[{id}] magic"
                );
                assert_eq!(
                    format!("{:02x}", expected[4]),
                    field(case, id, "expected_version_byte_hex"),
                    "[{id}] personality singletons keep 0x01 in v0.2"
                );
                let opened = decode_agent_personality_blob_versioned(
                    MetaVersion::V0_2,
                    &kek_v0_2,
                    &account_hash,
                    &expected,
                )
                .unwrap_or_else(|e| panic!("[{id}] decode: {e:?}"));
                assert_eq!(
                    hex_encode(&opened),
                    field(case, id, "input_plaintext_hex"),
                    "[{id}] plaintext"
                );
            }
            "decode_fail_v0_1" => {
                let blob = hex_decode(field(case, id, "input_blob_hex"));
                assert_eq!(
                    field(case, id, "expected_error"),
                    "magic_mismatch",
                    "[{id}] the v0.1 expectation refuses a next-major blob at the magic check"
                );
                assert!(
                    decode_agent_personality_blob_versioned(
                        MetaVersion::V0_1,
                        &kek_v0_1,
                        &account_hash,
                        &blob
                    )
                    .is_err(),
                    "[{id}] a MYZ5 blob must not open under the v0.1 expectation"
                );
            }
            other => panic!("[{id}] unknown case_kind {other}"),
        }
    }
    for k in ["encrypt", "decode_fail_v0_1"] {
        assert!(
            seen.contains(k),
            "agent-personality/v0.2 must cover case_kind {k}"
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
                // The two period fields (myne#177) are OPTIONAL here: every
                // case minted before they existed carries neither and uses
                // neither token, so defaulting them keeps those cases exact.
                // A case that DOES use a period token must pin it, or the
                // vector would be asserting against an empty string this
                // runner invented rather than against published bytes.
                let optional_utf8 = |key: &str| -> Option<String> {
                    case.get(key).map(|_| utf8_field(case, id, key))
                };
                let period_start = optional_utf8("input_ctx_period_start_utf8_hex");
                let period_end = optional_utf8("input_ctx_period_end_utf8_hex");
                for (token, pinned) in [
                    ("{{period_start}}", period_start.is_some()),
                    ("{{period_end}}", period_end.is_some()),
                ] {
                    assert!(
                        !template.contains(token) || pinned,
                        "[{id}] uses {token} but pins no value for it"
                    );
                }
                let ctx = RenderContext {
                    title: utf8_field(case, id, "input_ctx_title_utf8_hex"),
                    date: utf8_field(case, id, "input_ctx_date_utf8_hex"),
                    time: utf8_field(case, id, "input_ctx_time_utf8_hex"),
                    datetime: utf8_field(case, id, "input_ctx_datetime_utf8_hex"),
                    weekday: utf8_field(case, id, "input_ctx_weekday_utf8_hex"),
                    period_start: period_start.unwrap_or_default(),
                    period_end: period_end.unwrap_or_default(),
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
    use protocol::{
        canonical_encode_saved_views, canonical_encode_saved_views_with_opaque,
        parse_saved_views_array, parse_saved_views_array_with_opaque, SavedViewParseError,
    };

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
            "parse_ok_opaque" => {
                seen.insert("parse_ok_opaque");
                let (views, opaque, consumed) = parse_saved_views_array_with_opaque(&input)
                    .unwrap_or_else(|e| {
                        panic!("[{id}] parse_ok_opaque input did not parse: {e:?}")
                    });
                let want_consumed = case["expected_consumed_len"]
                    .as_u64()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_consumed_len"))
                    as usize;
                assert_eq!(consumed, want_consumed, "[{id}] consumed-len mismatch");

                let want_ids: Vec<String> = case["expected_opaque_ids"]
                    .as_array()
                    .unwrap_or_else(|| panic!("[{id}] missing expected_opaque_ids"))
                    .iter()
                    .map(|v| {
                        v.as_str()
                            .unwrap_or_else(|| {
                                panic!("[{id}] expected_opaque_ids entry not a string")
                            })
                            .to_owned()
                    })
                    .collect();
                let got_ids: Vec<String> = opaque
                    .iter()
                    .map(|o| String::from_utf8_lossy(o.id_bytes()).into_owned())
                    .collect();
                assert_eq!(
                    got_ids, want_ids,
                    "[{id}] retained-entry id set/order mismatch — a retained entry is sorted by its id and is never dropped, so a missing one means the decoder lost bytes it cannot reconstruct",
                );
                assert!(
                    !opaque.is_empty(),
                    "[{id}] every parse_ok_opaque case must retain at least one entry; a case that retains none belongs in parse_ok",
                );
                assert_eq!(
                    hex_encode(&canonical_encode_saved_views_with_opaque(&views, &opaque)),
                    field(case, id, "expected_canonical_utf8_hex"),
                    "[{id}] canonical re-encoding mismatch (retained entries are re-emitted verbatim and id-sorted together with the represented ones)",
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
    for kind in ["parse_ok", "parse_ok_opaque", "parse_fail"] {
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
