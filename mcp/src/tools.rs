// SPDX-License-Identifier: AGPL-3.0-only
//! The compiled tool surface's one question: does this server offer a verb?
//!
//! The list itself lives in [`crate::tool_list`], as data and nothing else, so
//! the guard that holds the surface to "no capability outside the vault" reads one
//! file whose whole content is the declaration. This module keeps the operation a
//! caller needs: [`offers`], the single implementation of "is this a verb we
//! serve", used by `tools/call` before anything is forwarded.

pub use crate::tool_list::catalog;

/// Whether the compiled surface offers a tool by this exact name.
///
/// One implementation of the question, so `tools/call` cannot accept a verb the
/// catalog does not list. The comparison is against the same constant
/// [`catalog`] serves, never against a second roster.
pub fn offers(name: &str) -> bool {
    catalog()
        .iter()
        .any(|tool| tool["name"].as_str() == Some(name))
}
