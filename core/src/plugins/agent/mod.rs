// SPDX-License-Identifier: AGPL-3.0
//! `agent` plugin core: agentic note editing (myne-md/myne#529).
//!
//! An agent run proposes changes to note bodies inside a scope the user
//! approved, and nothing reaches the vault until the user approves a diff.
//! This module owns the host-side half of that: the run, its scope, the tools
//! the model may call, the anchored edit format, and the apply.
//!
//! **Why the loop is here and the engine is not.** The AI engine
//! (`local_inference`) is desktop-only and stays there; this crate is compiled
//! by every client, so putting the loop here is what lets mobile inherit it
//! rather than reimplement it. The dependency runs the right way round: the
//! loop depends on a narrow generation trait ([`engine::AgentEngine`]) that the
//! host implements, not on the host's plugin. A change here that wants to reach
//! into `local_inference` has gone wrong.
//!
//! **What this module deliberately cannot do.** It has two verbs, edit a note
//! body and create a note, and no third. Deletion is not among them because it
//! does not need to be: every way Myne takes a note out of the working set is a
//! frontmatter field, so doing it is a body edit and is reversible. That is
//! also why [`hide`] exists: those edits look like any other at the diff layer,
//! and an approve-all must not carry one. Note move, note rename, folder
//! operations and attachment operations are all absent. Rename in particular is
//! absent for a structural reason rather than a cautious one: it would require
//! rewriting every note that links to the renamed one, and those notes are not
//! in scope, so rename and the scope model are mutually exclusive.
//!
//! Spec: `docs/threat-model.md` §7 (the prompt-injection bullet this feature
//! amends, and the restated SYNC-17), `docs/decisions/ai/0461` (the provider
//! posture this inherits unchanged) and `docs/decisions/ai/0462` (the request
//! class and the described-backend registry).
//!
//! See: `src-tauri/CLAUDE.md` "Secret-handling logging discipline".

pub mod apply;
pub mod edit;
pub mod engine;
pub mod error;
pub mod hide;
/// The host-generic half of the agent command surface: the session table, the
/// guards, the scope source, and `step`. Both Tauri clients call into it and
/// supply only their own engine and searcher; see the module doc for the split.
/// The Tauri-host adapters an agent run needs: reading a note, taking its
/// restore point, writing the approved batch.
///
/// **Here rather than in `crate::inference`, and that placement is
/// load-bearing.** It shipped there for one review round and broke the audit
/// build outright: `cargo check -p myne-desktop --no-default-features` failed
/// with `cannot find inference in crate`, because this plugin compiles
/// unconditionally while `crate::inference` is behind the default-off
/// `remote-ai` feature. The file has no remote-provider content at all, its
/// imports are this plugin, the notes command cores, `TauriHost`, the snapshot
/// store and `StdVaultIo`: so the gate it sat behind was buying nothing and
/// costing the one build that gate exists to protect.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub mod host_adapters;
pub mod host_commands;
pub mod probe;
pub mod prompt;
pub mod run;
/// The loop. Named `run_loop` because `loop` is a Rust keyword.
pub mod run_loop;
pub mod scope;
pub mod tools;

pub use apply::{
    apply_approved, ApplyOutcome, ApplyReader, Approval, BatchWriter, RefusedEdit,
    RestorePointTaker,
};
pub use edit::{place, ProposedEdit};
pub use engine::{
    AgentEngine, AgentRequest, AgentRequestClass, Content, Message, Role, AGENT_REQUEST_CLASS,
};
pub use error::{AgentError, EditRejection};
pub use hide::edit_hides_note;
pub use probe::{grade, run_probe, AttemptVerdict, ProbeThreshold, ProbeVerdict};
pub use prompt::{AgentAction, Proposal, ProposedNote};
pub use run::{AgentRunState, AgentRunView, GrantOrigin};
pub use run_loop::{drive, LoopDeps, LoopEnd, LoopOutcome, MAX_ITERATIONS};
pub use scope::{
    expand_run, is_root_grant, preview_grant, resolve_grant, start_run, ResolvedGrant, ScopeGrant,
    ScopeSource,
};
pub use tools::{
    list_scope, read_note, search_scope, NoteReader, ScopeEntry, ScopeSearcher, SearchHit,
};
