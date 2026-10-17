// SPDX-License-Identifier: AGPL-3.0
//! POSIX shell quoting, shared by every generator in this crate that writes a
//! `/bin/sh` script around a path it did not choose.
//!
//! It lives here rather than inside either generator for the reason
//! [`crate::uds`] gives for the other thing both of them needed: the discipline
//! is the *same* security property in both places, and a second copy is a
//! second thing to fix when it changes. Today there are two such generators —
//! the CLI PATH shim (`cli_bridge::path_shim`, MYND-490) and the browser
//! clipper's native-messaging launcher (`clipper::install`, TB10) — and until
//! myne#381 only one of them was right.
//!
//! Both interpolate `current_exe()`, which is not a constant: a user may
//! install the app under a directory containing `"`, `` ` ``, `$` or a trailing
//! `\`. The wrapper is then executed by a browser, unattended, on every
//! native-messaging connection.

/// Wrap a string in POSIX single quotes, the one shell quoting form with no
/// interior escapes at all: `'` ends the literal, `\'` supplies one, `'`
/// reopens it. Everything else — `"`, `` ` ``, `$`, spaces, newlines — is
/// inert inside.
///
/// **Double quotes are not a weaker version of this; they are a different
/// thing.** Inside `sh` double quotes `$`, `` ` `` and `\` stay active, so
/// `"$(rm -rf ~)"` in a path is not mis-parsed — it is *evaluated*. Single
/// quotes have no such carve-out, which is why this is the only form either
/// generator may use.
pub fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::sh_single_quote;

    #[test]
    fn single_quoting_survives_an_apostrophe_in_the_path() {
        // The one character single quotes cannot hold verbatim.
        assert_eq!(
            sh_single_quote("/home/o'brien/app"),
            r"'/home/o'\''brien/app'"
        );
        assert_eq!(sh_single_quote("/plain/path"), "'/plain/path'");
    }

    #[test]
    fn every_double_quote_hazard_is_inert_inside_single_quotes() {
        // Each of these expands or breaks out inside `"…"` and is literal here.
        for raw in [
            "/opt/$(rm -rf ~)/Myne",
            "/opt/`id`/Myne",
            "/opt/${HOME}/Myne",
            "/opt/say \"hi\"/Myne",
            "/opt/trailing-backslash\\",
            "/Applications/Myne.app/Contents/MacOS/Myne",
        ] {
            let quoted = sh_single_quote(raw);
            assert!(quoted.starts_with('\''), "{raw}");
            assert!(quoted.ends_with('\''), "{raw}");
            // No apostrophe in any of these, so the body is the input verbatim
            // — nothing was escaped away, and nothing stayed active.
            assert_eq!(&quoted[1..quoted.len() - 1], raw, "{raw}");
        }
    }
}
