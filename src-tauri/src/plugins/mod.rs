// SPDX-License-Identifier: AGPL-3.0-only
//! Tauri 2 in-app plugins for vault flows.
//!
//! Each plugin is a self-contained module under `plugins/` with its
//! own commands, state, and error type. The plugin-pattern over
//! flat-app-level commands is documented in
//! `private-companion/sessions/design/2026-04-28-vault-creation-flow.md`
//! Q8.3 — domain isolation enforced at compile time, future
//! `vault-unlock` / `change-password` plugins follow the same shape.

// myne#529: agentic note editing. Gated behind the SAME `local-inference`
// feature as the engine below, and not by preference: this plugin's adapter
// binds to `local_inference` for the engine, the ChatML surface and the
// retrieval store, so with the feature off it does not compile at all. That is
// how the AI-free auditable build broke and stayed broken for four pipelines
// (`cargo check -p myne-desktop --no-default-features`, `.woodpecker/main.yml`
// `tauri-compile`) while every local gate stayed green: `pre-push` builds the
// DEFAULT features, so nothing a developer runs exercises the feature-off tree.
//
// The gate is also what the spec already required. An agent run drives a
// generation model over note plaintext, so it IS the AI path, and
// `decisions/ai/0337` and `threat-model.md` both state that the
// `--no-default-features` build "never compiles the AI path". A build carrying
// eight agent IPC commands that can never reach a backend would contradict that
// while looking like it honoured it.
#[cfg(feature = "local-inference")]
pub mod agent;
pub mod attachments;
pub mod backup;
pub mod chats;
pub mod clipper_pairing;
// myne-md/myne#697: the agent-memory + personality store. Like `chats`, the
// storage plane itself is vault content read/written by the agent loop, so it
// is NOT gated on `local-inference` (the loop compiles unconditionally); the
// `ai_enabled` pref is the runtime gate, re-read per command.
pub mod detached_window;
// myne-md/myne#860: the opt-in device-local diagnostic log and the bug-report
// surface's host side. Desktop-only: the web build installs no `tracing`
// subscriber at all (`decisions/ops/0366`), so both other clients carry
// `Unsupported` verdicts for the whole plugin.
pub mod diagnostics;
// B2B device-to-person bindings (`vault.device-bindings`, `MYU5`; protocol.md §9.30,
// the `member-devices` feature). Core in `myne-core::plugins::device_binding`; this
// shim registers the two commands.
pub mod device_binding;
pub mod export;
pub mod graph_layout;
pub mod importer;
pub mod reminders;
// live-collab (`collab-editor-bridge`): the collaborative-editor live-session
// commands. Core in `myne-core::plugins::live`; this shim registers them.
pub mod live;
pub mod member_names;
// external-mcp-connection (myne-md/myne#923): the Settings reads behind the
// external-access section. Core in `myne-core::plugins::mcp::commands`; this
// shim registers the two read-only commands. Desktop-only by construction (the
// `myne-mcp` sidecar ships in this bundle), and `Unsupported` on web.
pub mod mcp;
pub mod memory;
// local-ai epic (MYND-406): on-device inference plugin, gated behind the
// default-off `local-inference` cargo feature (SYNC-5). Absent — zero symbols —
// from the default build.
#[cfg(feature = "local-inference")]
pub mod local_inference;
pub mod notes;
pub mod pdf_export;
// myne-md/myne#788: the plain-file editor (device-local gate first; the file
// IO and ingress land in later tasks). Desktop-only: the two other clients
// carry `absent` verdicts for the whole feature.
pub mod plain_file;
pub mod prefs;
pub mod quick_unlock;
pub mod screen_capture;
pub mod secret_export;
pub mod snapshots;
pub mod sync;
pub mod text_file;
pub mod themes;
pub mod update;
pub mod vault_change_password;
// `vault_creation` core (commands + state + error + `init()`) moved to
// `myne-core` (shared with the mobile client). Re-exported so existing
// `crate::plugins::vault_creation::…` paths keep resolving.
pub use myne_core::plugins::vault_creation;
pub mod account;
pub mod vault_delete;
pub mod vault_indices;
pub mod vault_label;
pub mod vault_recover;
pub mod vault_repair;
pub mod vault_unlock;
pub mod workspace;
