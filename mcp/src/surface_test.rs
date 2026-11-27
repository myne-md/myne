// SPDX-License-Identifier: AGPL-3.0-only
//! The tool surface is ONE wire contract held in THREE places, and this module
//! compares them from inside the build.
//!
//! The three holders are [`crate::tool_list`] (the compiled catalog a client
//! reads), `core::plugins::mcp::tools::CATALOG_VERBS` (the copy Settings renders
//! one switch per verb from) and `core::plugins::mcp::tools::ToolName::from_wire`
//! (what the host will actually dispatch). They are three lists because the shim
//! and the host are separate processes by design: `mcp/` links neither
//! `myne-core` nor `myne-desktop`, so nothing makes them agree except a check.
//!
//! **What went wrong without this module.** `note_set_field` was in the catalog
//! and in the Settings switch bank, and had no dispatch arm, so `tools/list`
//! advertised a tool every call to which answered `invalid_request` with "this
//! app does not know that tool". The one test that mentioned the drift ASSERTED
//! it (`unimplemented == ["note_set_field"]`), so the suite was green while a
//! client was being handed a broken tool. A contract held by three lists needs a
//! comparison, not a comment.
//!
//! **Why node-free, when `scripts/check-mcp-tool-surface.mjs` already parses
//! these same files.** The guard asks a different question — is the surface still
//! the roster we meant, and does it hold no capability outside the vault — and it
//! runs in a pre-commit hook, which is the machine of whoever remembered to
//! commit. This asks "do the three holders agree", and it runs wherever
//! `cargo test -p myne-mcp` runs, including the CI job that gates the branch. The
//! two are not copies of one check: a verb added to all three lists at once
//! passes here and fails there, and a verb added to the catalog alone passes
//! there (its roster is a literal) and fails here.
//!
//! The core file is read as TEXT rather than imported, because importing it is
//! the coupling the crate split exists to prevent. The markers below are the same
//! ones the guard greps for, and each parse fails loudly with the file and the
//! marker named: a silent skip would make this module a green check that checks
//! nothing, which is the failure mode both checks exist to avoid.

use std::path::{Path, PathBuf};

/// The core crate's dispatch table and verb roster, relative to this crate.
///
/// `CARGO_MANIFEST_DIR` is `mcp/`, so the sibling crate is one level up. The
/// workspace is always checked out whole — the shim is `publish = false` and
/// ships inside the desktop bundle — so the file is always there; the `expect`
/// below names what moved rather than skipping when it is not.
fn core_tools_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../core/src/plugins/mcp/tools.rs")
}

fn core_tools_source() -> String {
    let path = core_tools_path();
    std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "surface contract: cannot read {} ({error}). The dispatch table moved; this \
             comparison reads that file itself, so it must be told where it now lives.",
            path.display()
        )
    })
}

/// The catalog's verb names, in catalog order.
fn catalog_names() -> Vec<String> {
    crate::tools::catalog()
        .iter()
        .map(|tool| {
            tool["name"]
                .as_str()
                .expect("every catalog entry carries a string name")
                .to_string()
        })
        .collect()
}

/// Every double-quoted string in `slice`, in order.
///
/// Good enough for both inputs below and deliberately not a Rust parser: the
/// arrays and match arms are string literals and nothing else, and a construct
/// that breaks this assumption makes the result differ from the catalog rather
/// than agreeing with it, so the comparison fails instead of passing wrongly.
fn quoted(slice: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = slice;
    while let Some(open) = rest.find('"') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('"') else { break };
        out.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    out
}

/// `CATALOG_VERBS`'s body, plus the length its type declares.
fn core_catalog_verbs(source: &str) -> (usize, Vec<String>) {
    const MARKER: &str = "pub const CATALOG_VERBS";
    let at = source.find(MARKER).unwrap_or_else(|| {
        panic!(
            "surface contract: {} no longer declares `{MARKER}` — the roster Settings renders \
             its switches from moved or was renamed",
            core_tools_path().display()
        )
    });
    let rest = &source[at..];
    let typed = |marker: &str| -> usize {
        let from = rest.find(marker).unwrap_or_else(|| {
            panic!("surface contract: `{MARKER}` no longer declares `{marker}` before its body")
        }) + marker.len();
        rest[from..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or_else(|_| panic!("surface contract: `{MARKER}`'s length is not a number"))
    };
    let declared = typed("[&str; ");
    let open = rest.find('[').expect("the roster's body opens with `[`");
    let close = rest[open..]
        .find("];")
        .expect("the roster's body closes with `];`")
        + open;
    (declared, quoted(&rest[open..close]))
}

/// The wire names `ToolName::from_wire` answers `Some` for.
fn core_dispatch_names(source: &str) -> Vec<String> {
    const MARKER: &str = "pub fn from_wire";
    const END: &str = "_ => None,";
    let at = source.find(MARKER).unwrap_or_else(|| {
        panic!(
            "surface contract: {} no longer declares `{MARKER}` — the dispatch table moved or \
             was renamed",
            core_tools_path().display()
        )
    });
    let body = &source[at..];
    let end = body.find(END).unwrap_or_else(|| {
        panic!("surface contract: `{MARKER}` no longer ends its arms with `{END}`")
    });
    quoted(&body[..end])
}

#[test]
fn the_catalog_is_exactly_the_roster_the_host_carries() {
    let source = core_tools_source();
    let (declared, verbs) = core_catalog_verbs(&source);
    assert_eq!(
        declared,
        verbs.len(),
        "CATALOG_VERBS declares `[&str; {declared}]` over {} names, so the type and the body \
         disagree (the compiler sees this first; the assertion is here so the reason is named)",
        verbs.len()
    );
    assert_eq!(
        catalog_names(),
        verbs,
        "the compiled catalog and core's CATALOG_VERBS are in different order or disagree: the \
         catalog is what a client reads, CATALOG_VERBS is what Settings renders a switch from, \
         and a verb in one and not the other is a switch that cannot be flipped or a tool with \
         no switch"
    );
}

#[test]
fn every_catalog_verb_has_a_dispatch_arm() {
    let dispatched = core_dispatch_names(&core_tools_source());
    let missing: Vec<String> = catalog_names()
        .into_iter()
        .filter(|name| !dispatched.contains(name))
        .collect();
    assert!(
        missing.is_empty(),
        "the catalog advertises {missing:?} but this build has no dispatch arm for them, so every \
         call answers `invalid_request` with \"this app does not know that tool\". A tool a client \
         can see and cannot call is worse than an absent tool: it looks like version skew, and a \
         client retries version skew"
    );
}

#[test]
fn no_dispatch_arm_is_absent_from_the_catalog() {
    let mut dispatch = core_dispatch_names(&core_tools_source());
    dispatch.sort();
    dispatch.dedup();
    let mut catalog = catalog_names();
    catalog.sort();
    let unreachable: Vec<String> = dispatch
        .into_iter()
        .filter(|name| !catalog.contains(name))
        .collect();
    assert!(
        unreachable.is_empty(),
        "this build dispatches {unreachable:?} but the catalog does not advertise them, so the \
         verb is reachable only by a client that guessed the name: `tools/call` refuses a name the \
         catalog omits before anything is forwarded, which makes the dispatch arm dead code that \
         reads as a served tool"
    );
}
