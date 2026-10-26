// SPDX-License-Identifier: AGPL-3.0
//! The browser clipper's native-messaging host, as its own executable.
//!
//! A browser launches the `path` in a native-messaging host manifest **with no
//! arguments**, and Myne's host mode is normally selected by one
//! (`--native-messaging-host`). macOS and Linux point the manifest at a two-line
//! shell script that adds it; Windows cannot, because a `.cmd` re-expands `%`
//! and an install path may contain one. That is the same class of quoting hazard
//! that cost this project a real bug (myne#381, where a `$(…)` inside a path was
//! EVALUATED by the shell a browser spawned unattended).
//!
//! So this binary exists: no arguments to inject, no shell in between. It runs
//! the host loop unconditionally, and it can do nothing else: the loop and every
//! capability behind it are `myne_desktop_lib`'s, unchanged.

fn main() {
    myne_desktop_lib::run_native_messaging_host();
}
