// SPDX-License-Identifier: AGPL-3.0
//! The external MCP connection grant as a `vault.prefs` field
//! (external-mcp-connection task 3; myne-md/myne#923).
//!
//! Three properties, and each is an acceptance criterion rather than a
//! convenience: a blob written before this field existed decodes as "no
//! connection granted" AND re-encodes byte-identically (so the omission rule
//! is real rather than a claim in a doc comment), two grants round-trip
//! through the canonical encoder unchanged, and the folder set goes through
//! the canonical SET encoding (NFC, sorted, deduped) because the element set
//! is the value.
use super::*;
use alloc::vec;

/// A grant in the LEGACY allow-list model: the shape the released build
/// minted, which this build still reads and never writes.
fn grant(folders: &[&str], approved_at: u64, last_used_at: Option<u64>) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Folders,
        folders: folders
            .iter()
            .map(|f| alloc::string::String::from(*f))
            .collect(),
        excluded_folders: vec![],
        approved_at,
        last_used_at,
        write_folders: vec![],
        disabled_verbs: Vec::new(),
    }
}

/// A grant in the exclusion model: the shape this build mints. `excluded` is
/// what the connection may NOT read, so an empty slice means the whole vault.
fn exclusion_grant(
    excluded: &[&str],
    approved_at: u64,
    last_used_at: Option<u64>,
) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Exclude,
        folders: vec![],
        excluded_folders: excluded
            .iter()
            .map(|f| alloc::string::String::from(*f))
            .collect(),
        approved_at,
        last_used_at,
        write_folders: vec![],
        disabled_verbs: Vec::new(),
    }
}

/// A grant in the exclusion model that ALSO names where the connection may
/// write: the shape task 13 mints. `write` is a slice of `&str` so a test can
/// show the set encoding doing its work on unsorted, duplicated input.
fn writable_grant(excluded: &[&str], write: &[&str], approved_at: u64) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Exclude,
        folders: vec![],
        excluded_folders: excluded
            .iter()
            .map(|f| alloc::string::String::from(*f))
            .collect(),
        approved_at,
        last_used_at: None,
        write_folders: write
            .iter()
            .map(|f| alloc::string::String::from(*f))
            .collect(),
        disabled_verbs: Vec::new(),
    }
}

#[test]
fn the_write_grant_is_an_allow_list_and_rides_after_model() {
    // Key order is the format: `write_folders` sorts last (`model` <
    // `write_folders`), and the set encoding sorts and dedupes it, which is
    // what makes two spellings of the same grant one set of bytes. The list
    // is deliberately an ALLOW list while the read scope beside it is a deny
    // list: the two arrays mean opposite things in one object, which is why
    // both carry a distinct member name rather than a shared `folders`.
    let grant = writable_grant(
        &["Private/"],
        &["Projects/", "Areas/", "Projects/"],
        1765432100,
    );
    let text = alloc::string::String::from_utf8(canonical_encode_mcp_connection_grant(&grant))
        .expect("canonical bytes are UTF-8");
    assert_eq!(
            text,
            "{\"approved_at\":1765432100,\"excluded_folders\":[\"Private/\"],\"model\":\"exclude\",\"write_folders\":[\"Areas/\",\"Projects/\"]}"
        );

    // And the decoder agrees, including the set normalization on the way in.
    let (decoded, consumed) =
        parse_mcp_connection_grant(text.as_bytes()).expect("the grant round-trips");
    assert_eq!(consumed, text.len());
    assert_eq!(
        decoded.write_folders,
        vec![
            alloc::string::String::from("Areas/"),
            alloc::string::String::from("Projects/")
        ]
    );
    assert_eq!(
        canonical_encode_mcp_connection_grant(&decoded),
        text.as_bytes().to_vec()
    );
}

#[test]
fn no_write_list_omits_the_member_and_decodes_as_write_nowhere() {
    // The omission rule is what lets a grant written before the write scope
    // existed re-encode byte for byte, and it is asserted rather than
    // described because "absent" and "empty" both read as write-nowhere and a
    // later implementation could mistake one of them for "everywhere".
    let grant = exclusion_grant(&[], 1765432100, None);
    let text = alloc::string::String::from_utf8(canonical_encode_mcp_connection_grant(&grant))
        .expect("canonical bytes are UTF-8");
    assert!(
        !text.contains("write_folders"),
        "an empty write list must cost no bytes: {text}"
    );
    let (decoded, _) = parse_mcp_connection_grant(text.as_bytes()).expect("decodes");
    assert!(
        decoded.write_folders.is_empty(),
        "an absent write list is write-nowhere, not everywhere"
    );
}

#[test]
fn a_legacy_grant_may_not_carry_a_write_list() {
    // A legacy grant is refused outright at call time, so a write scope beside
    // it would be a permission nothing serves. Refused at the decoder rather
    // than ignored, for the same reason two arrays under one model are.
    let legacy_with_write =
        b"{\"approved_at\":1765432100,\"folders\":[],\"write_folders\":[\"Projects/\"]}";
    assert!(parse_mcp_connection_grant(legacy_with_write).is_none());

    // The same grant without it still decodes, so the refusal is about the
    // disagreement and not about the legacy model.
    let legacy = b"{\"approved_at\":1765432100,\"folders\":[]}";
    assert!(parse_mcp_connection_grant(legacy).is_some());
}

#[test]
fn a_repeated_write_list_is_refused() {
    let twice = b"{\"approved_at\":1765432100,\"model\":\"exclude\",\"write_folders\":[\"A/\"],\"write_folders\":[\"B/\"]}";
    assert!(parse_mcp_connection_grant(twice).is_none());
}

#[test]
fn the_exclusion_model_writes_its_own_member_and_no_allow_list() {
    // The byte layout is pinned here because the discriminator is the whole
    // defence against reading one model as the other: an `Exclude` grant must
    // carry `model` and must carry NO `folders` member, or the two arrays sit
    // in one object with opposite meanings and the next reader guesses.
    let mut prefs = PrefsView::default();
    prefs.mcp_connections.insert(
        alloc::string::String::from("claude-desktop"),
        exclusion_grant(&["Private/"], 1765432100, None),
    );
    let text = alloc::string::String::from_utf8(canonical_json_encode(&prefs)).unwrap();
    assert_eq!(
            text,
            "{\"mcp_connections\":{\"claude-desktop\":{\"approved_at\":1765432100,\"excluded_folders\":[\"Private/\"],\"model\":\"exclude\"}},\"screen_capture_protection\":true}"
        );

    // And the decode side agrees: the model is read back as `Exclude` with
    // the canonicalized set, and no allow list appears beside it.
    let decoded = canonical_json_decode(text.as_bytes()).expect("round trip");
    let grant = decoded
        .mcp_connections
        .get("claude-desktop")
        .expect("the grant survives");
    assert_eq!(grant.model, McpScopeModel::Exclude);
    assert_eq!(
        grant.excluded_folders,
        vec![alloc::string::String::from("Private/")]
    );
    assert!(grant.folders.is_empty());
    assert_eq!(canonical_json_encode(&decoded), text.as_bytes().to_vec());
}

/// Encode ONE grant as its canonical object bytes, so an emitter can print
/// the exact form a decoder must produce.
///
/// Goes through the real map encoder and slices the single member's object
/// out of it rather than re-implementing the layout: a second opinion about
/// the key order in this file would be the drift the layout doc forbids.
fn encode_one_grant(grant: &McpConnectionGrant) -> alloc::vec::Vec<u8> {
    canonical_encode_mcp_connection_grant(grant)
}

fn hex_of(bytes: &[u8]) -> alloc::string::String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = alloc::string::String::new();
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn escape_json(text: &str) -> alloc::string::String {
    let mut out = alloc::string::String::new();
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c => out.push(c),
        }
    }
    out
}

/// Emit the `mcp-connection` vector family for `myne-test-vectors`.
///
/// `cargo test -p protocol --lib emit_mcp_connection_vectors_for_paste -- --ignored`
///
/// Pins the `mcp_connections` grant decoder: the canonical-JSON object one,
/// not the AEAD envelope around it. Two things are load-bearing enough to be
/// vectors rather than only unit tests: the **model discriminator** (an allow
/// list and a deny list are both arrays of folder paths, so a reimplementation
/// that guesses from the shape inverts consent), and the **refusal set** (a
/// grant whose model and arrays disagree, an unknown member, an unknown model
/// token). Those refusals are what a second implementation has to reproduce
/// exactly, because the alternative is silently reading one meaning as the
/// other.
#[test]
#[ignore]
fn emit_mcp_connection_vectors_for_paste() {
    extern crate std;

    let mut dump = alloc::string::String::new();
    dump.push_str("{\n");
    dump.push_str("  \"schema\": \"mcp-connection\",\n");
    dump.push_str("  \"protocol_version\": \"v0.1\",\n");
    dump.push_str("  \"spec_section\": \"protocol.md §9.5.2 (mcp_connections canonical JSON inside vault.prefs)\",\n");
    dump.push_str("  \"description\": \"Pins protocol::prefs::parse_mcp_connection_grant: the canonical-JSON decoder for one mcp_connections grant record inside vault.prefs (external MCP connection scopes, myne-md/myne#923). parse_ok cases pin the decoded grant as its canonical re-encoding (lexicographic member order approved_at < excluded_folders < folders < last_used_at < model < write_folders, NFC + sorted + deduped folder sets, model emitted only for exclude, write_folders omitted when empty) plus the exact consumed byte count; parse_reject cases pin the inputs a reader MUST refuse rather than reinterpret, which is where a second implementation drifts: a grant carrying both read arrays, a write list beside the retired model, an unknown model token, an unknown member, and a repeated member. The two scopes are deliberately asymmetric: the read scope is a DENY list (an exclusion is reversible by revoking it) and the write scope an ALLOW list (a write into a folder nobody anticipated is the surprise worth preventing), so an empty excluded_folders means the whole vault and an empty write_folders means write nowhere.\",\n");
    dump.push_str("  \"cases\": [\n");

    let emit_ok =
        |dump: &mut alloc::string::String, slug: &str, desc: &str, input: &[u8], trailing: bool| {
            let (grant, consumed) = parse_mcp_connection_grant(input)
                .unwrap_or_else(|| panic!("[{slug}] parse_ok input did not parse"));
            let canonical = encode_one_grant(&grant);
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"mcp-connection/v0.1/{slug}\",\n"
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                escape_json(desc)
            ));
            dump.push_str("      \"case_kind\": \"parse_ok\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_bytes_utf8_hex\": \"{}\",\n",
                hex_of(input)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_consumed_len\": {consumed},\n"
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_canonical_utf8_hex\": \"{}\"\n",
                hex_of(&canonical)
            ));
            dump.push_str(if trailing { "    },\n" } else { "    }\n" });
        };

    let emit_reject =
        |dump: &mut alloc::string::String, slug: &str, desc: &str, input: &[u8], trailing: bool| {
            assert!(
                parse_mcp_connection_grant(input).is_none(),
                "[{slug}] parse_reject input parsed Ok"
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"mcp-connection/v0.1/{slug}\",\n"
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                escape_json(desc)
            ));
            dump.push_str("      \"case_kind\": \"parse_reject\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_bytes_utf8_hex\": \"{}\"\n",
                hex_of(input)
            ));
            dump.push_str(if trailing { "    },\n" } else { "    }\n" });
        };

    // ---- parse_ok: the two models ----------------------------------
    emit_ok(
            &mut dump,
            "exclude-model-roundtrip",
            "An exclusion grant (the model this build writes) round-trips: model is emitted, the set is sorted, and the allow list is absent.",
            &encode_one_grant(&exclusion_grant(&["Private/"], 1765432100, None)),
            true,
        );

    emit_ok(
            &mut dump,
            "exclude-empty-is-the-whole-vault",
            "An exclusion grant with no exclusions is a COMPLETE grant meaning the whole vault, and costs no array at all: folded paths are the only thing an empty set omits.",
            &encode_one_grant(&exclusion_grant(&[], 1765432100, None)),
            true,
        );

    emit_ok(
            &mut dump,
            "legacy-folders-model-roundtrip",
            "A grant written under the retired allow-list model decodes and re-encodes byte for byte: `folders` is emitted even when empty, and `model` is absent.",
            &encode_one_grant(&grant(&["Projects/"], 1717000000, None)),
            true,
        );

    emit_ok(
            &mut dump,
            "legacy-folders-empty-array",
            "The legacy model REQUIRES its array: an empty `folders` is a different statement from an absent one and stays on the wire.",
            &encode_one_grant(&grant(&[], 1717000000, None)),
            true,
        );

    emit_ok(
            &mut dump,
            "last-used-at-emitted-when-present",
            "The optional last_used_at is emitted only when the connection has reached the door, and sorts after the folder set.",
            &encode_one_grant(&exclusion_grant(&["Private/"], 1765432100, Some(1765432999))),
            true,
        );

    emit_ok(
            &mut dump,
            "write-grant-rides-after-model",
            "A grant that also names where the connection may WRITE: write_folders sorts last, after model, and the set is canonical (sorted, deduped) like every other folder set here. An absent list means write nowhere, which is why it is omitted rather than written empty.",
            &encode_one_grant(&writable_grant(&["Private/"], &["Archive/", "Archive/", "Work/"], 1765432100)),
            true,
        );

    emit_ok(
            &mut dump,
            "write-grant-empty-list-is-omitted",
            "An explicitly empty write list decodes to 'write nowhere' and re-encodes WITHOUT the member: the empty case costs no bytes, and a reader must not read its absence as 'everywhere'.",
            b"{\"approved_at\":1,\"model\":\"exclude\",\"write_folders\":[]}",
            true,
        );

    emit_ok(
            &mut dump,
            "served-once-a-read-write-grant-records-it",
            "last_used_at and write_folders together: the door stamps the read once it has served a call, and neither member reorders anything about the other.",
            "{\"approved_at\":1,\"last_used_at\":2,\"model\":\"exclude\",\"write_folders\":[\"Work/\"]}".as_bytes(),
            true,
        );

    emit_ok(
            &mut dump,
            "folders-nfc-sorted-deduped",
            "A folder set is canonicalized as a SET: an NFD sequence folds to NFC, an exact duplicate collapses to one entry, case is PRESERVED (so a differently-cased sibling stays distinct here and is folded only by the resolver, which lowercases), and the order is lexicographic rather than the caller's.",
            "{\"approved_at\":7,\"excluded_folders\":[\"Work/2026/\",\"Prive\u{301}/\",\"Work/2026/\",\"prive\u{301}/\"],\"model\":\"exclude\"}".as_bytes(),
            true,
        );

    let mut trailing = encode_one_grant(&exclusion_grant(&["Private/"], 5, None));
    trailing.extend_from_slice(b",\"x\"");
    emit_ok(
            &mut dump,
            "consumes-only-the-object-trailing",
            "Trailing bytes after the grant object are left for the caller: consumed reports only the object length.",
            &trailing,
            true,
        );

    // ---- parse_reject: what a reader MUST refuse -------------------
    emit_reject(
            &mut dump,
            "reject-both-arrays",
            "A grant carrying BOTH arrays is refused, not resolved by precedence: the two arrays mean opposite things and a precedence rule is how one ends up read as the other.",
            b"{\"approved_at\":1,\"excluded_folders\":[\"b/\"],\"folders\":[\"a/\"]}",
            true,
        );

    emit_reject(
            &mut dump,
            "reject-exclusion-beside-allow-list",
            "An exclusion list beside no model is refused: without the discriminator the reader would have to guess which meaning the array carries.",
            b"{\"approved_at\":1,\"excluded_folders\":[\"Private/\"]}",
            true,
        );

    emit_reject(
            &mut dump,
            "reject-allow-list-without-array",
            "The legacy model without its array is refused, because that shape was never written and reading it as empty would claim the connection can read nothing.",
            b"{\"approved_at\":1,\"model\":\"folders\"}",
            true,
        );

    emit_reject(
            &mut dump,
            "reject-unknown-model-token",
            "An unknown model token is refused rather than defaulted, so a future third model cannot be read as whichever one this build happens to prefer.",
            b"{\"approved_at\":1,\"model\":\"allow\"}",
            true,
        );

    emit_reject(
            &mut dump,
            "reject-unknown-member",
            "An unknown member is refused rather than dropped: a dropped member would silently narrow what the user approved. write_folders was this case's example until this build learnt it, and the family moved to a member NO build writes, because a fixture that names a member a reader now accepts stops testing the refusal at all.",
            b"{\"approved_at\":1,\"model\":\"exclude\",\"future_member\":[\"Work/\"]}",
            true,
        );

    emit_reject(
            &mut dump,
            "reject-write-list-on-the-retired-model",
            "A write list beside the retired allow-list read model is refused, not merged: that model's array IS the connection's whole reach, the write grant was introduced with the deny list, and a grant claiming both would have two incompatible readings of one approval.",
            b"{\"approved_at\":1,\"folders\":[\"Projects/\"],\"write_folders\":[\"Projects/\"]}",
            true,
        );

    emit_reject(
            &mut dump,
            "reject-repeated-member",
            "A repeated member is refused, so a hand-edited blob cannot carry two answers to one question.",
            b"{\"approved_at\":1,\"approved_at\":2,\"model\":\"exclude\"}",
            true,
        );

    emit_reject(
            &mut dump,
            "reject-missing-approved-at",
            "approved_at is required: a grant nobody can date is not an approval, so its absence is refused rather than defaulted to zero.",
            b"{\"model\":\"exclude\"}",
            false,
        );

    dump.push_str("  ]\n}\n");

    std::fs::write("/tmp/myne_mcp_connection_vectors.json", dump.as_bytes())
        .expect("write mcp-connection vectors dump");
    std::eprintln!("[ok] wrote /tmp/myne_mcp_connection_vectors.json");
}

#[test]
fn an_exclusion_grant_with_no_exclusions_is_the_whole_vault_and_costs_no_array() {
    // Empty is a VALUE under this model, not an omission: the user approved
    // a connection that may read everything. The encoder emits no array, so
    // the grant is three members, and the decoder reads that back as the
    // whole vault rather than as a legacy grant with nothing readable.
    let mut prefs = PrefsView::default();
    prefs.mcp_connections.insert(
        alloc::string::String::from("lm-studio"),
        exclusion_grant(&[], 7, Some(9)),
    );
    let text = alloc::string::String::from_utf8(canonical_json_encode(&prefs)).unwrap();
    assert_eq!(
            text,
            "{\"mcp_connections\":{\"lm-studio\":{\"approved_at\":7,\"last_used_at\":9,\"model\":\"exclude\"}},\"screen_capture_protection\":true}"
        );
    let decoded = canonical_json_decode(text.as_bytes()).expect("round trip");
    let grant = decoded.mcp_connections.get("lm-studio").expect("survives");
    assert_eq!(grant.model, McpScopeModel::Exclude);
    assert!(grant.excluded_folders.is_empty());
    assert_eq!(canonical_json_encode(&decoded), text.as_bytes().to_vec());
}

#[test]
fn a_legacy_grant_is_read_as_the_allow_list_it_was_written_as() {
    // The released bytes, verbatim: no `model` member, an allow list. It must
    // decode as `Folders` (so the host can refuse it with a named reason
    // rather than serve it under the wrong rule) and re-encode to the same
    // bytes, which is what makes an upgrade a no-op on disk until the user
    // re-approves.
    let original = br#"{"mcp_connections":{"claude-desktop":{"approved_at":1,"folders":["Work/"]}},"screen_capture_protection":true}"#;
    let decoded = canonical_json_decode(original).expect("a legacy blob decodes");
    let grant = decoded
        .mcp_connections
        .get("claude-desktop")
        .expect("survives");
    assert_eq!(grant.model, McpScopeModel::Folders);
    assert_eq!(grant.folders, vec![alloc::string::String::from("Work/")]);
    assert!(grant.excluded_folders.is_empty());
    assert_eq!(canonical_json_encode(&decoded), original.to_vec());
}

#[test]
fn a_grant_whose_model_and_arrays_disagree_is_refused() {
    // Every one of these decodes "successfully" under a precedence rule, and
    // every one of those rules picks a meaning for an array the user was
    // never shown under that meaning. Refusing is the only answer that cannot
    // widen a grant quietly.
    for bad in [
            // An exclusion model next to an allow list.
            br#"{"mcp_connections":{"x":{"approved_at":1,"excluded_folders":["Private/"],"folders":["Work/"],"model":"exclude"}},"screen_capture_protection":true}"#.as_slice(),
            // A legacy model next to an exclusion list.
            br#"{"mcp_connections":{"x":{"approved_at":1,"excluded_folders":["Private/"],"folders":[]}},"screen_capture_protection":true}"#.as_slice(),
            // A model member this build does not know: read as `Folders` it
            // would be served under semantics it was not written under.
            br#"{"mcp_connections":{"x":{"approved_at":1,"model":"someFutureModel"}},"screen_capture_protection":true}"#.as_slice(),
            // The same member twice.
            br#"{"mcp_connections":{"x":{"approved_at":1,"model":"exclude","model":"exclude"}},"screen_capture_protection":true}"#.as_slice(),
        ] {
            assert_eq!(
                canonical_json_decode(bad),
                Err(PrefsBlobError::PlaintextParseFailed),
                "accepted {bad:?}"
            );
        }
}

#[test]
fn the_exclusion_set_is_nfc_sorted_and_exact_deduped() {
    // The same canonical SET discipline as `folders`, asserted separately
    // because a second array is a second chance to skip the encoder: an
    // exclusion list that round-trips unordered writes different bytes for
    // the same approval on two devices.
    let mut prefs = PrefsView::default();
    prefs.mcp_connections.insert(
        alloc::string::String::from("claude-desktop"),
        exclusion_grant(&["b/", "a/", "b/", "A\u{030A}/"], 1, None),
    );
    let decoded = canonical_json_decode(&canonical_json_encode(&prefs)).expect("round trip");
    assert_eq!(
        &decoded
            .mcp_connections
            .get("claude-desktop")
            .expect("survives")
            .excluded_folders,
        &vec![
            alloc::string::String::from("a/"),
            alloc::string::String::from("b/"),
            alloc::string::String::from("\u{00C5}/"),
        ]
    );
}

#[test]
fn encoding_places_the_grants_between_last_backup_and_meeting_prompt() {
    let mut prefs = PrefsView {
        last_backup_at: Some(1765432100),
        meeting_ai_prompt: Some(alloc::string::String::from("Summarize tersely.")),
        ..PrefsView::default()
    };
    prefs.mcp_connections.insert(
        alloc::string::String::from("claude-desktop"),
        grant(&["Work/"], 1765432100, None),
    );

    let encoded = canonical_json_encode(&prefs);
    let text = alloc::string::String::from_utf8(encoded).expect("canonical JSON is UTF-8");

    // The canonical slot is the load-bearing half: a decoder scans forward
    // from `last_backup_at`, so an older client steps over this unknown key
    // and reads `meeting_ai_prompt` and the mandatory
    // `screen_capture_protection` correctly after it.
    let pos = |needle: &str| {
        text.find(needle)
            .unwrap_or_else(|| panic!("no {needle} in {text}"))
    };
    assert!(pos("\"last_backup_at\"") < pos("\"mcp_connections\""));
    assert!(pos("\"mcp_connections\"") < pos("\"meeting_ai_prompt\""));
    assert!(pos("\"meeting_ai_prompt\"") < pos("\"screen_capture_protection\""));

    // And the exact bytes, so a reordering of the grant object's own keys is
    // caught here rather than by a byte diff in another repository.
    assert_eq!(
        text,
        "{\"last_backup_at\":1765432100,\"mcp_connections\":{\"claude-desktop\":\
             {\"approved_at\":1765432100,\"folders\":[\"Work/\"]}},\
             \"meeting_ai_prompt\":\"Summarize tersely.\",\"screen_capture_protection\":true}"
    );
}

#[test]
fn a_blob_without_the_field_is_no_connection_granted_and_re_encodes_byte_identically() {
    // A pre-feature blob: no `mcp_connections` key at all. Decoding must
    // produce the empty map (an absent key is "nobody was granted", not an
    // error and not a default grant), and re-encoding must reproduce the
    // input byte for byte, which is what makes "a vault that never granted a
    // connection is byte-identical to its pre-feature self" a fact rather
    // than a promise.
    let original = br#"{"last_backup_at":1765432100,"screen_capture_protection":true}"#;
    let decoded = canonical_json_decode(original).expect("a pre-feature blob decodes");
    assert!(decoded.mcp_connections.is_empty());
    assert_eq!(decoded.last_backup_at, Some(1765432100));
    assert_eq!(canonical_json_encode(&decoded), original.to_vec());
}

#[test]
fn two_grants_round_trip_byte_identically_and_an_absent_name_resolves_to_nothing() {
    let mut prefs = PrefsView::default();
    prefs.mcp_connections.insert(
        alloc::string::String::from("claude-desktop"),
        grant(&["Work/", "Projects/"], 1765432100, Some(1765432200)),
    );
    prefs.mcp_connections.insert(
        alloc::string::String::from("lm-studio"),
        grant(&["Archive/"], 1765432150, None),
    );

    let encoded = canonical_json_encode(&prefs);
    let decoded = canonical_json_decode(&encoded).expect("round trip");

    // The encoder canonicalizes the folder SET on the way out, so the decoded
    // map carries sorted folders rather than the caller's order. That is the
    // point of a set field, and it is asserted here rather than left implied.
    assert_eq!(
        decoded
            .mcp_connections
            .get("claude-desktop")
            .map(|g| g.folders.clone()),
        Some(vec![
            alloc::string::String::from("Projects/"),
            alloc::string::String::from("Work/"),
        ])
    );
    assert_eq!(
        decoded
            .mcp_connections
            .get("lm-studio")
            .map(|g| g.folders.clone()),
        Some(vec![alloc::string::String::from("Archive/")])
    );

    // Byte-identical, which is stronger than equal values: `last_used_at` is
    // omitted on the grant that has none and every set is already canonical,
    // so a read-then-write is a no-op on disk.
    assert_eq!(canonical_json_encode(&decoded), encoded);

    // The three names: two granted, one never mentioned.
    assert!(decoded.mcp_connections.contains_key("claude-desktop"));
    assert!(decoded.mcp_connections.contains_key("lm-studio"));
    assert_eq!(decoded.mcp_connections.get("cursor"), None);
}

#[test]
fn the_folder_set_is_nfc_sorted_and_exact_deduped() {
    // Set semantics: the element SET is the value, so order and repetition
    // are not. NFD input proves the NFC fold runs, and the duplicate proves
    // the dedup, because an encoder that trusted caller order would write
    // different bytes for the same grant on two devices.
    let mut prefs = PrefsView::default();
    prefs.mcp_connections.insert(
        alloc::string::String::from("claude-desktop"),
        // "b/", "a/", "b/" and a decomposed "\u{0041}\u{030A}/" (Å/) that
        // NFC-normalizes to "\u{00C5}/".
        grant(&["b/", "a/", "b/", "A\u{030A}/"], 1, None),
    );
    let decoded = canonical_json_decode(&canonical_json_encode(&prefs)).expect("round trip");
    let folders = &decoded
        .mcp_connections
        .get("claude-desktop")
        .expect("the grant survives")
        .folders;
    assert_eq!(
        folders,
        &vec![
            alloc::string::String::from("a/"),
            alloc::string::String::from("b/"),
            // NFC of "A" + U+030A is U+00C5, which sorts AFTER ASCII by its
            // UTF-8 bytes (0xC3 0x85 > 0x62). That ordering is the encoder's,
            // and pinning it here is what keeps two implementations from
            // disagreeing about the byte layout of one set.
            alloc::string::String::from("\u{00C5}/"),
        ],
        "the canonical set encoding must NFC-fold, sort and dedupe"
    );
}

#[test]
fn a_grant_missing_a_required_member_rejects_the_parse() {
    // `approved_at` and `folders` are required: a grant with no approval time
    // cannot be shown as approved, and an absent folder list is not the same
    // statement as an empty one. `{}` is the shape a partial writer produces.
    for bad in [
        br#"{"screen_capture_protection":true,"mcp_connections":{"x":{}}}"#.as_slice(),
        br#"{"screen_capture_protection":true,"mcp_connections":{"x":{"folders":[]}}}"#.as_slice(),
        br#"{"screen_capture_protection":true,"mcp_connections":{"x":{"approved_at":1}}}"#
            .as_slice(),
    ] {
        assert_eq!(
            canonical_json_decode(bad),
            Err(PrefsBlobError::PlaintextParseFailed),
            "accepted {bad:?}"
        );
    }
}

#[test]
fn an_unknown_member_inside_a_grant_is_refused_rather_than_dropped() {
    // Unlike a whole unknown TOP-LEVEL field (tolerated per §9.5.2), an
    // unknown member of a grant object is refused. The extension point is the
    // write scope task 13 adds, and silently dropping it would narrow a grant
    // this build cannot represent: an older client would report a connection
    // as read-only when the user had granted writes.
    let bad = br#"{"mcp_connections":{"x":{"approved_at":1,"folders":[],"write_folders":["Work/"]}},"screen_capture_protection":true}"#;
    assert_eq!(
        canonical_json_decode(bad),
        Err(PrefsBlobError::PlaintextParseFailed)
    );
}

#[test]
fn the_map_is_not_emitted_when_empty_and_a_malformed_value_rejects() {
    let text =
        alloc::string::String::from_utf8(canonical_json_encode(&PrefsView::default())).unwrap();
    assert!(!text.contains("mcp_connections"), "got: {text}");

    for bad in [
            // An array where the field is an object.
            br#"{"mcp_connections":[],"screen_capture_protection":true}"#.as_slice(),
            // A grant that is not an object.
            br#"{"mcp_connections":{"x":[]},"screen_capture_protection":true}"#.as_slice(),
            // A folder list that is not an array of strings.
            br#"{"mcp_connections":{"x":{"approved_at":1,"folders":[1]}},"screen_capture_protection":true}"#
                .as_slice(),
            // A fractional approval stamp (floats are FORBIDDEN in §9.5.2).
            br#"{"mcp_connections":{"x":{"approved_at":1.5,"folders":[]}},"screen_capture_protection":true}"#
                .as_slice(),
        ] {
            assert_eq!(
                canonical_json_decode(bad),
                Err(PrefsBlobError::PlaintextParseFailed),
                "accepted {bad:?}"
            );
        }
}

// ---------------------------------------------------------------------------
// The disabled-verb set (mcp external access rework, myne-md/myne#1052)
// ---------------------------------------------------------------------------

/// A grant in the exclusion model with a verb set, in the wire order a client
/// sends rather than the canonical one, so the encoder's set semantics are what
/// the assertions measure.
fn verb_grant(excluded: &[&str], disabled: &[&str]) -> McpConnectionGrant {
    McpConnectionGrant {
        model: McpScopeModel::Exclude,
        folders: vec![],
        excluded_folders: excluded
            .iter()
            .map(|f| alloc::string::String::from(*f))
            .collect(),
        approved_at: 1765432100,
        last_used_at: None,
        write_folders: vec![],
        disabled_verbs: disabled
            .iter()
            .map(|v| alloc::string::String::from(*v))
            .collect(),
    }
}

#[test]
fn the_disabled_verb_set_is_a_canonical_set_that_rides_after_approved_at() {
    // Key order is the format (`approved_at` < `disabled_verbs` <
    // `excluded_folders`), and the set encoding sorts and dedupes, so two
    // spellings of one restriction are one set of bytes.
    let grant = verb_grant(&["Private/"], &["note_move", "note_edit", "note_edit"]);
    let text = alloc::string::String::from_utf8(canonical_encode_mcp_connection_grant(&grant))
        .expect("canonical bytes are UTF-8");
    assert_eq!(
        text,
        "{\"approved_at\":1765432100,\"disabled_verbs\":[\"note_edit\",\"note_move\"],\
\"excluded_folders\":[\"Private/\"],\"model\":\"exclude\"}"
    );

    let (decoded, consumed) =
        parse_mcp_connection_grant(text.as_bytes()).expect("the grant round-trips");
    assert_eq!(consumed, text.len());
    assert_eq!(
        decoded.disabled_verbs,
        vec![
            alloc::string::String::from("note_edit"),
            alloc::string::String::from("note_move")
        ]
    );
    assert_eq!(
        canonical_encode_mcp_connection_grant(&decoded),
        text.as_bytes().to_vec()
    );
}

#[test]
fn no_disabled_verbs_omits_the_member_and_decodes_as_all_enabled() {
    // This is the direction that matters most: absent means EVERY verb is
    // available, because that is the reading every grant written before the
    // member existed has to keep. The opposite default would turn an upgrade
    // into a revocation.
    let grant = exclusion_grant(&["Private/"], 1765432100, None);
    let text = alloc::string::String::from_utf8(canonical_encode_mcp_connection_grant(&grant))
        .expect("canonical bytes are UTF-8");
    assert!(
        !text.contains("disabled_verbs"),
        "an empty verb set must cost no bytes: {text}"
    );
    let (decoded, _) = parse_mcp_connection_grant(text.as_bytes()).expect("decodes");
    assert!(
        decoded.disabled_verbs.is_empty(),
        "an absent verb set is all-enabled, which is also the empty set's reading"
    );
}

#[test]
fn a_legacy_grant_may_not_carry_a_disabled_verb_set() {
    // A legacy grant serves nothing until it is approved again, so a verb set
    // beside one restricts nothing. Refused at the decoder for the same reason
    // a write list is, and the same grant without it still decodes.
    let legacy_with_verbs =
        b"{\"approved_at\":1765432100,\"disabled_verbs\":[\"note_edit\"],\"folders\":[]}";
    assert!(parse_mcp_connection_grant(legacy_with_verbs).is_none());

    let legacy = b"{\"approved_at\":1765432100,\"folders\":[]}";
    assert!(parse_mcp_connection_grant(legacy).is_some());
}

#[test]
fn a_repeated_disabled_verb_set_is_refused() {
    let twice = b"{\"approved_at\":1765432100,\"disabled_verbs\":[\"note_edit\"],\"disabled_verbs\":[\"note_move\"],\"model\":\"exclude\"}";
    assert!(parse_mcp_connection_grant(twice).is_none());
}

#[test]
fn a_verb_name_this_build_does_not_know_is_stored_verbatim_and_narrows_nothing() {
    // The codec keeps what it was given, canonicalized. Recognising a name is
    // the tool layer's job, and an unknown one is inert there rather than an
    // error here: refusing it in the codec would mean a downgrade that reads a
    // future verb's name loses the whole prefs blob.
    let grant = verb_grant(&[], &["note_teleport"]);
    let text = alloc::string::String::from_utf8(canonical_encode_mcp_connection_grant(&grant))
        .expect("canonical bytes are UTF-8");
    let (decoded, _) = parse_mcp_connection_grant(text.as_bytes()).expect("decodes");
    assert_eq!(
        decoded.disabled_verbs,
        vec![alloc::string::String::from("note_teleport")]
    );
}
