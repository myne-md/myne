// SPDX-License-Identifier: AGPL-3.0-only
//! The four registration sites of the `screen-capture` plugin, compared.
//!
//! `permissions/screen-capture/default.toml`'s own header says an ACL entry does
//! not wire a command and nothing checks that it does. This is the check, in the
//! shape `plugins::agent` and `plugins::prefs` already carry, and it is worth
//! more here than in either of those because the failure is silent in both
//! directions.
//!
//! A wrong or missing `allow-screen-capture-show-protected` leaves the window
//! HIDDEN after idle auto-lock (`lib.rs`: "the app looks frozen in the dock")
//! **and** unprotected, because that grant replaced `core:window:allow-show` and
//! is now the only door the WebView has to its own window. Its one caller is a
//! `try`/`catch` in `useRevealAfterIdleLock`, so nothing throws and nothing
//! renders differently. The other two would leave the pre-unlock escape's
//! controls present and refusing, on the screens a locked-out user cannot read.

#[cfg(test)]
mod tests {
    /// Every grant, every block, every handler and every `build.rs` name, in
    /// both directions.
    ///
    /// Both directions, because one is not enough in either: a permitted
    /// command missing from `generate_handler!` compiles, renders and rejects at
    /// runtime, while a registered command missing from the bundle sits there
    /// fail-closed and equally quiet.
    #[test]
    fn every_permitted_screen_capture_command_is_registered_and_vice_versa() {
        let toml = include_str!("../../../permissions/screen-capture/default.toml");
        let shim = include_str!("mod.rs");
        let build_rs = include_str!("../../../build.rs");

        // 1. The `[default]` bundle: which identifiers are actually granted. An
        //    identifier with a block but no bundle listing is refused at
        //    runtime, fail-closed and invisible from the block itself.
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
            .expect("the screen-capture plugin must register a handler list");
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

        // 4. `build.rs`'s `InlinedPlugin` arm. Checked here for the reason the
        //    agent's arm is: every command of this plugin IS named there, so a
        //    command added to `build.rs` and nowhere else is caught too. That is
        //    not true of `prefs`, whose blocks are hand-written, so do not copy
        //    this half to a plugin that relies on them.
        let arm_start = build_rs.find("\"screen-capture\",").expect(
            "build.rs must declare the screen-capture plugin, or the ACL namespace never exists",
        );
        let arm_end = arm_start
            + build_rs[arm_start..]
                .find("]),")
                .expect("unterminated screen-capture InlinedPlugin arm");
        let mut declared: Vec<String> = build_rs[arm_start..arm_end]
            .split('"')
            .filter(|t| t.starts_with("screen_capture_"))
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
                "screen-capture command {cmd:?} is permitted but NOT in generate_handler!: \
                 it compiles, its UI renders, and its invoke rejects at runtime"
            );
            assert!(
                declared.contains(cmd),
                "screen-capture command {cmd:?} is permitted but not named in build.rs's \
                 InlinedPlugin arm"
            );
        }
        for cmd in &registered {
            assert!(
                permitted.contains(cmd),
                "screen-capture command {cmd:?} is registered but NOT permitted: it sits \
                 there fail-closed, and nothing about the handler list says so"
            );
        }
        assert_eq!(
            registered, declared,
            "generate_handler! and build.rs's InlinedPlugin arm disagree"
        );
    }

    /// The one grant whose absence is silent end to end.
    ///
    /// `screen_capture_show_protected` replaced `core:window:allow-show`, so it
    /// is the WebView's only door to its own window after idle auto-lock, and
    /// its caller is a `try`/`catch`. This pins the exact identifier rather than
    /// leaving the set comparison above to speak for it, because a rename that
    /// moved consistently through all four sites would pass that comparison and
    /// still break the TypeScript literal in `src/lib/screen-capture-override.ts`.
    #[test]
    fn the_reveal_grant_is_named_exactly_as_the_frontend_invokes_it() {
        let toml = include_str!("../../../permissions/screen-capture/default.toml");
        assert!(
            toml.contains("identifier = \"allow-screen-capture-show-protected\""),
            "the reveal grant is missing; the window stays hidden after idle auto-lock \
             and nothing throws"
        );
        assert!(
            toml.contains("\"allow-screen-capture-show-protected\","),
            "the reveal grant has a block but is not in the [default] bundle, which is \
             refused at runtime"
        );
    }
}
