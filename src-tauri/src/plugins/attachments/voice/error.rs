//! Error taxonomy for the voice-record commands (MYND-259).

use super::capture::RecordError;
use crate::plugins::attachments::error::AttachmentImportError;
use serde::Serialize;

/// Serialized to the WebView for the recording UI. Adjacently tagged so the
/// `Import` newtype carries the nested attachment-import error cleanly.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "detail", rename_all = "camelCase")]
pub enum VoiceRecordError {
    /// The vault is locked — recording is unlock-gated.
    Locked,
    /// A recording is already in progress.
    AlreadyRecording,
    /// `stop`/`cancel` with no active recording.
    NotRecording,
    /// The recording captured no audio at all.
    EmptyRecording,
    /// The recording captured only silence (muted / denied mic) — discarded
    /// rather than stored as an empty clip.
    SilentRecording,
    /// No microphone / input device is available (drives the disabled-record
    /// affordance + the "enable mic access" hint).
    NoInputDevice,
    /// The capture device/stream failed for another reason.
    CaptureFailed,
    /// Encrypting + storing the recorded WAV as an attachment failed.
    Import(AttachmentImportError),
    /// An unexpected internal failure (thread join, etc.).
    Internal,
}

impl From<RecordError> for VoiceRecordError {
    fn from(e: RecordError) -> Self {
        match e {
            RecordError::NoInputDevice => VoiceRecordError::NoInputDevice,
            RecordError::CaptureFailed => VoiceRecordError::CaptureFailed,
        }
    }
}
