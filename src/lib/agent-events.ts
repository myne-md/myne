// Host events the agent surface fires for the WebView (myne-md/myne#913).
//
// The only "notes changed" event this tree had was the CLI bridge's, so a writer
// that was not the CLI had no way to say so. The agent is that writer: its apply
// runs host-side and touches notes directly, which left the left panel showing the
// vault as it was before the run, and made an agent-created note look like a
// failed creation.
//
// The constant mirrors `AGENT_NOTES_CHANGED_EVENT` in
// `core/src/plugins/agent/host_commands.rs`, the same way `cli-access.ts` mirrors
// the CLI's. Deliberately a separate name from the CLI's event: one shared name
// would tell whoever reads the log that the CLI wrote the note.

export const AGENT_NOTES_CHANGED_EVENT = "myne://agent-notes-changed";
