//! `myne-tor` — arti packaged as a standalone loopback SOCKS5 proxy sidecar
//! (desktop Tor routing, MYND-650, task 1).
//!
//! This binary is a thin re-export of arti's own CLI entry point. It exists as
//! a *separate process*, and as a separate crate, for three reasons that are
//! easier to break than to notice:
//!
//! 1. **Process isolation.** arti never shares an address space with the
//!    desktop app, so no bug in it can reach decrypted note plaintext,
//!    `root_key`, or any subkey. The host talks to it over a loopback TCP
//!    socket and nothing else.
//! 2. **The no-egress guarantee stays machine-checkable.** `myne-desktop` must
//!    not depend on this crate — it is *spawned* at runtime, not linked — so
//!    arti never enters `cargo tree -p myne-desktop -e normal`, which is the
//!    closure `src-tauri/scripts/ai-no-network-check.sh` and
//!    `src-tauri/src/no_egress.rs` scan. Adding a `myne-tor-sidecar` dependency
//!    to `src-tauri/Cargo.toml` would silently move a whole Tor client into the
//!    audited binary; there is no compiler error for that, only the gate.
//! 3. **Reproducible builds.** Being a workspace member puts arti's dependency
//!    tree in the single shared root `Cargo.lock` (the TB9 audit anchor), which
//!    a downloaded C-tor daemon could never be.
//!
//! The sidecar is staged into the bundle by `scripts/build-tor-sidecar.mjs` and
//! listed in `bundle.externalBin`; the host-side spawn/bootstrap/terminate
//! lifecycle is task 2.
//!
//! Invocation is arti's own CLI: `myne-tor proxy -p <socks-port>` (`-p 0`
//! disables the SOCKS listener, `-d` would enable arti's separate DNS listener —
//! which this build does not compile in). `myne-tor --help` for the rest.

fn main() {
    arti::main();
}
