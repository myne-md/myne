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
//! **What this module deliberately cannot do.** It has three verbs, all of them
//! writes to a note's body or a new note: replace anchored text, append to the
//! end, and create a note. Deletion is not among them because it does not need
//! to be: every way Myne takes a note out of the working set is a frontmatter
//! field, so doing it is a body edit and is reversible.
//!
//! **And one thing the verbs may not do, added with the third**
//! (myne-md/myne#616): no write may change which folder a note is in. `folder:`
//! is what the `ai_excluded_folders` clamp reads, and the clamp runs before the
//! batch, so an edit rewriting that line would relocate a note past a control
//! that had already decided. [`frontmatter`] is the predicate; unlike the
//! removal carve-out it refuses under every approval label, because no user act
//! makes an agent-chosen folder move correct. That is
//! also why [`hide`] exists: those edits look like any other at the diff layer,
//! and an approve-all must not carry one. Note move, note rename, folder
//! operations and attachment operations are all absent. Rename in particular is
//! absent for a structural reason rather than a cautious one: it would require
//! rewriting every note that links to the renamed one, and those notes are not
//! in scope, so rename and the scope model are mutually exclusive.
//!
//! Spec: `docs/threat-model.md` §7 (the prompt-injection bullet this feature
//! amends, and the restated SYNC-17), `design-notes/ai/0461` (the provider
//! posture this inherits unchanged) and `design-notes/ai/0462` (the request
//! class and the described-backend registry).
//!
//! See: `src-tauri/CLAUDE.md` "Secret-handling logging discipline".

pub mod apply;
pub mod edit;
pub mod engine;
pub mod error;
pub mod frontmatter;
pub mod hide;
pub mod history;
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
