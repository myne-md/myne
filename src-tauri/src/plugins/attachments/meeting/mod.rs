//! Meeting sessions (myne-md/myne#789).
//!
//! A meeting session is the voice-note capture pipeline with a different
//! source, a different consumer and a different output: the microphone mixed
//! with the system-audio tap, a consumer that collects clips in order, and a
//! note rather than a single voice note. Everything it reuses is reused
//! unchanged (the capture loop, `attachment_import`, the encoder, the clip
//! cap), which is why this is a module rather than a new plugin.
//!
//! The three commands are registered by the parent `attachments` plugin and
//! gated under `attachments:default`, exactly as the voice-record commands are.

pub mod commands;
pub mod state;

pub use commands::abort_active_session;
pub use state::MeetingSessionState;
