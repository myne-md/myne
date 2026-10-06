//! The four registration sites of the `vault-recover` plugin, compared.
//!
//! Added with the recovery drill (myne-md/myne#468), which is the fourth command
//! this plugin declares across four files no compiler compares: the `[default]`
//! bundle, the `[[permission]]` blocks, `generate_handler!`, and `build.rs`'s
//! `InlinedPlugin` arm. The permissions file's own header has said since task 4
//! that adding a command without its `commands.allow` entry is a security
//! regression — this is the check that statement was missing.
//!
//! Silent in both directions, and worse here than on most plugins because every
//! command in it is on a credential path. A permitted command absent from
//! `generate_handler!` compiles, renders its UI, and rejects at runtime: a user
//! locked out of their vault types twenty-four words into a form whose Submit
//! answers with a generic failure, on the one screen that is their last way in.
//! A registered command absent from the bundle is the mirror image, fail-closed
//! and equally quiet — `tauri-utils` resolves a `<plugin>:default` with no
//! matching permission to an EMPTY set rather than erroring, which is the
//! failure `scripts/check-mobile-plugin-acl.mjs` records observing by injection.
//!
//! The shape is `plugins::screen_capture::acl_parity`'s, deliberately: same
//! extraction, same both-directions comparison, same non-vacuity guard first.
//! What differs is the `build.rs` name filter, because this plugin's commands
//! carry no shared prefix.

#[cfg(test)]
mod tests {
    /// Every grant, every block, every handler and every `build.rs` name, in
    /// both directions.
    #[test]
    fn every_permitted_vault_recover_command_is_registered_and_vice_versa() {
        let toml = include_str!("../../../permissions/vault-recover/default.toml");
        let shim = include_str!("mod.rs");
        let build_rs = include_str!("../../../build.rs");

        // 1. The `[default]` bundle: which identifiers are actually granted. An
        //    identifier with a block but no bundle listing is refused at runtime.
        let bundle_start = toml
            .find("permissions = [")
            .expect("the [default] bundle must list its permissions");
        let bundle_end = bundle_start
            + toml[bundle_start..]
                .find(']')
                .expect("unterminated permissions list");
        let mut granted: Vec<String> = toml[bundle_start..bundle_end]
            .split('"')
            .filter_map(|t| t.strip_prefix("allow-"))
            .map(|t| t.replace('-', "_"))
            .collect();
        granted.sort();
        granted.dedup();

        // 2. Every `commands.allow = [...]`: what each block actually permits.
        let mut permitted: Vec<String> = toml
            .lines()
            .filter_map(|l| l.trim().strip_prefix("commands.allow = ["))
            .flat_map(|rest| {
                rest.split('"')
                    .filter(|t| {
                        !t.is_empty() && t.chars().all(|c| c.is_ascii_lowercase() || c == '_')
                    })
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .collect();
        permitted.sort();
        permitted.dedup();

        // 3. `generate_handler!`: the only thing that actually wires a command.
        let gh_start = shim
            .find("generate_handler![")
            .expect("the vault-recover plugin must register a handler list");
        let gh_end = gh_start
            + shim[gh_start..]
                .find(']')
                .expect("unterminated generate_handler!");
        let mut registered: Vec<String> = shim[gh_start..gh_end]
            .lines()
            .filter_map(|l| l.trim().strip_prefix("commands::"))
            .map(|l| l.trim_end_matches(',').trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        registered.sort();
        registered.dedup();

        // 4. `build.rs`'s `InlinedPlugin` arm. This plugin's commands share no
        //    prefix, so the arm is sliced and every quoted snake_case token in it
        //    is taken — which is why the slice bounds matter more than they do in
        //    the screen-capture twin: a wrong end bound would swallow the NEXT
        //    plugin's commands and the comparison would fail confusingly rather
        //    than vacuously.
        let arm_start = build_rs.find("\"vault-recover\",").expect(
            "build.rs must declare the vault-recover plugin, or the ACL namespace never exists",
        );
        let arm_end = arm_start
            + build_rs[arm_start..]
                .find("]),")
                .expect("unterminated vault-recover InlinedPlugin arm");
        let mut declared: Vec<String> = build_rs[arm_start..arm_end]
            .split('"')
            .filter(|t| {
                !t.is_empty()
                    && t.chars().all(|c| c.is_ascii_lowercase() || c == '_')
                    && t.contains('_')
            })
            .map(str::to_string)
            .collect();
        declared.sort();
        declared.dedup();

        // Non-vacuity first. An extraction that silently returned nothing makes
        // every comparison below compare an empty set against an empty set,
        // which is the exact failure this family of checks keeps producing.
        for (name, list) in [
            ("granted", &granted),
            ("permitted", &permitted),
            ("registered", &registered),
            ("declared", &declared),
        ] {
            assert!(
                !list.is_empty(),
                "the {name} extraction returned nothing, so every comparison below \
                 would compare an empty set against an empty set"
            );
        }
        // And a floor, because "not empty" is satisfied by one. Four commands
        // ship today; a drop below that is a command that left one of the four
        // sites, which is precisely what this test exists to catch.
        assert!(
            permitted.len() >= 4,
            "only {} permitted command(s) found; the extraction is reading less than \
             the file declares",
            permitted.len()
        );

        // Then the comparisons, which NAME the offending command rather than
        // reporting a count and leaving the reader to find it.
        assert_eq!(
            granted, permitted,
            "the [default] bundle and the [[permission]] blocks disagree; an identifier \
             in one and not the other is refused at runtime"
        );
        for cmd in &permitted {
            assert!(
                registered.contains(cmd),
                "vault-recover command {cmd:?} is permitted but NOT in generate_handler!: \
                 it compiles, its UI renders, and its invoke rejects at runtime — on a \
                 credential path"
            );
            assert!(
                declared.contains(cmd),
                "vault-recover command {cmd:?} is permitted but not named in build.rs's \
                 InlinedPlugin arm"
            );
        }
        for cmd in &registered {
            assert!(
                permitted.contains(cmd),
                "vault-recover command {cmd:?} is registered but NOT permitted: it sits \
                 there fail-closed, and nothing about the handler list says so"
            );
        }
        assert_eq!(
            registered, declared,
            "generate_handler! and build.rs's InlinedPlugin arm disagree"
        );
    }

    /// The drill's grant, by name.
    ///
    /// Pinned separately from the set comparison above for the reason its
    /// screen-capture twin gives: a rename that moved consistently through all
    /// four Rust sites would pass that comparison and still break the TypeScript
    /// literal the frontend invokes, which lives outside every one of them.
    #[test]
    fn the_drill_grant_is_named_exactly_as_the_frontend_invokes_it() {
        let toml = include_str!("../../../permissions/vault-recover/default.toml");
        assert!(
            toml.contains("identifier = \"allow-verify-recovery-phrase\""),
            "the drill grant is missing"
        );
        assert!(
            toml.contains("\"allow-verify-recovery-phrase\","),
            "the drill grant has a block but is not in the [default] bundle, which \
             resolves to an EMPTY permission set at runtime"
        );
    }
}
