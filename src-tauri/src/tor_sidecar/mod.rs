//! Host-side lifecycle for the `myne-tor` sidecar — device-local Tor routing
//! (MYND-650 task 2).
//!
//! Task 1 put arti in the bundle as an `externalBin` that nothing links. This
//! module is the other half: the code that spawns that binary, waits for it to
//! bootstrap, watches it, and makes sure it dies when Myne does. It is
//! deliberately the ONLY place in the desktop crate that starts a process with
//! a network surface.
//!
//! ```text
//!   toggle (task 6) ─▶ TorSidecar::start ─▶ myne-tor (separate process)
//!                            │                    │ stderr
//!                            │◀───────────────────┘
//!                            ▼
//!                      ProxyGate  ──read──▶  sync transport (tasks 3/4)
//! ```
//!
//! Three files, split along what each can be tested without:
//!
//! * [`lifecycle`] — the phase machine. No process, no clock, no network.
//! * [`arti_cli`] — the config, the argv, and the one stderr line that means
//!   "bootstrapped". Pure string/path functions.
//! * [`supervisor`] — the process plumbing that connects the two and publishes
//!   into `myne_core::plugins::sync::proxy::ProxyGate`.
//!
//! ## What this module deliberately does not do
//!
//! It does not decide *when* Tor mode is on — that is the device-local
//! `tor_routing_enabled` pref and its command surface (task 6), which will call
//! `start`/`stop` here. And it does not connect through the proxy: the SOCKS5
//! `CONNECT` encoding lives in the shared sync core (task 3) because the web
//! and mobile transports have to agree with it, while spawning a subprocess is
//! desktop-only by nature.
//!
//! ## Decision: the Tor state directory is cached, not ephemeral
//!
//! The PRD left this open. It is resolved here as **cached**, at
//! `<app_data_dir>/tor/{state,cache}`:
//!
//! * arti's state directory is where **entry-guard selections persist**.
//!   Discarding it on every launch means re-picking guards on every launch,
//!   which raises the cumulative probability of eventually choosing a hostile
//!   guard — the exact outcome Tor's guard design exists to avoid. Ephemeral
//!   state is the *less* private option here, not the more private one.
//! * The privacy cost is a directory recording that this device used Tor. That
//!   is already true of the device-local `tor_routing_enabled` pref sitting on
//!   the same disk, so the marginal disclosure is nil, and the directory is
//!   created owner-only.
//! * The bootstrap-speed win (a warm cache is seconds rather than tens of
//!   seconds) is a real usability gain, but it is the tiebreaker, not the
//!   argument.
//!
//! It is app-data-rooted rather than per-vault because network posture belongs
//! to the device, not to a vault — the same reasoning that keeps the toggle out
//! of the synced `vault.prefs` blob (task 6).

pub mod arti_cli;
pub mod lifecycle;
pub mod supervisor;

// Only the supervisor is re-exported: `lib.rs` manages it, and everything else
// (`Phase`, `StartError`) is named through its own module by the task-6 command
// layer that will surface it.
pub use supervisor::TorSidecar;
