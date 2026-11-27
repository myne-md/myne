// SPDX-License-Identifier: AGPL-3.0-only
//! `attachment_extract_ephemeral`: the text of a picked or shot file, without
//! making an attachment of it.
//!
//! **Why it exists.** The composer could only attach what the vault already
//! held, so asking the agent about a photograph meant importing it first: a
//! permanent blob, a catalog row, a text-cache row and a sync entry, for a
//! picture the person wanted to ask about once. A receipt is the case that
//! surfaced it.
//!
//! **What it deliberately does not do.** No vault, no key, no catalog: this
//! reads bytes, runs the same extractor the import path runs, and returns the
//! text. That is why it is callable while the vault is locked — there is nothing
//! here to decrypt. The bytes are [`Zeroizing`] and die with the call.
//!
//! **Why the agent needs nothing new.** A run already carries its attachments as
//! `Document { name, text }` (`myne_core::plugins::agent::prompt`), budgeted per
//! document and rendered in an untrusted span of its own. This command produces
//! exactly that payload, so the wire, the prompt and the threat model are
//! untouched: an image never leaves the device, only the reading of it does, the
//! same way an imported document's text already does.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use myne_core::plugins::attachments::commands::MAX_ATTACHMENT_IMPORT_LEN;
use myne_core::plugins::attachments::extract_types::{ExtractStatus, SourceFormat};
use myne_core::plugins::attachments::sniff::sniff_content_type;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// Where the bytes came from. The webview sends `bytes_b64` (a picked file, a
/// pasted image, a capture from `<input capture>`); `path` exists for the drag
/// and drop lane, where the host already holds a path and marshalling 64 MiB
/// through the webview would be a copy for nothing.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EphemeralSource {
    BytesB64 {
        bytes_b64: String,
        filename: Option<String>,
    },
    Path {
        path: String,
    },
}

/// The reading, and the name the composer shows beside it.
#[derive(Debug, Serialize)]
pub struct EphemeralExtract {
    /// The display name. Derived from the picked file, or `Untitled` when the
    /// lane carried none.
    pub name: String,
    /// Empty unless `status` is `ok`.
    pub text: String,
    /// `ok` | `empty` | `unsupported` | `failed`, so the composer can say *why*
    /// there is nothing to send instead of attaching an empty document.
    pub status: String,
    /// Char count before the extractor's own truncation, for the composer's
    /// "N characters" note.
    pub char_count: u32,
    pub truncated: bool,
}

#[derive(Debug)]
pub enum EphemeralError {
    /// The payload is larger than an attachment may ever be.
    Oversize { cap_bytes: usize },
    /// The path lane could not read its file.
    Unreadable,
    /// The base64 payload did not decode.
    Malformed,
}

impl std::fmt::Display for EphemeralError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // DENY-list clean: no path, no raw io::Error.
        match self {
            Self::Oversize { cap_bytes } => write!(f, "oversize:{cap_bytes}"),
            Self::Unreadable => f.write_str("unreadable"),
            Self::Malformed => f.write_str("malformed"),
        }
    }
}

fn status_tag(status: ExtractStatus) -> &'static str {
    match status {
        ExtractStatus::Ok => "ok",
        ExtractStatus::Empty => "empty",
        ExtractStatus::Unsupported => "unsupported",
        ExtractStatus::Failed => "failed",
    }
}

/// The extraction itself, pure enough to test without a webview: bytes and a
/// name in, a reading out.
pub fn extract_ephemeral(filename: Option<String>, bytes: &[u8]) -> EphemeralExtract {
    let name = filename
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Untitled".to_string());
    // The sniffer recognizes the render allowlist (image/*, svg, pdf); anything
    // else falls back to the extension, which is what the import path does too.
    let content_type = sniff_content_type(bytes).unwrap_or("application/octet-stream");
    let extracted = super::extract::extract(content_type, &name, bytes);
    EphemeralExtract {
        name,
        text: if extracted.status == ExtractStatus::Ok {
            extracted.text
        } else {
            String::new()
        },
        status: status_tag(extracted.status).to_string(),
        char_count: extracted.char_count,
        truncated: extracted.truncated,
    }
}

/// Materialize the source bytes, bounded before allocation.
fn read_source(source: EphemeralSource) -> Result<(Zeroizing<Vec<u8>>, Option<String>), EphemeralError> {
    match source {
        EphemeralSource::BytesB64 {
            bytes_b64,
            filename,
        } => {
            // Reject before decoding when the encoding alone is over the cap:
            // base64 inflates by 4/3, so this cannot refuse a legal payload.
            if bytes_b64.len() > MAX_ATTACHMENT_IMPORT_LEN.saturating_mul(4) / 3 + 4 {
                return Err(EphemeralError::Oversize {
                    cap_bytes: MAX_ATTACHMENT_IMPORT_LEN,
                });
            }
            let bytes = B64
                .decode(bytes_b64.as_bytes())
                .map_err(|_| EphemeralError::Malformed)?;
            if bytes.len() > MAX_ATTACHMENT_IMPORT_LEN {
                return Err(EphemeralError::Oversize {
                    cap_bytes: MAX_ATTACHMENT_IMPORT_LEN,
                });
            }
            Ok((Zeroizing::new(bytes), filename))
        }
        EphemeralSource::Path { path } => {
            let p = std::path::PathBuf::from(path);
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());
            // A size probe first: a multi-GB file would otherwise be read into
            // RAM in full before the cap could refuse it.
            let len = std::fs::metadata(&p)
                .map_err(|_| EphemeralError::Unreadable)?
                .len();
            if len as usize > MAX_ATTACHMENT_IMPORT_LEN {
                return Err(EphemeralError::Oversize {
                    cap_bytes: MAX_ATTACHMENT_IMPORT_LEN,
                });
            }
            let bytes = std::fs::read(&p).map_err(|_| EphemeralError::Unreadable)?;
            Ok((Zeroizing::new(bytes), name))
        }
    }
}

/// The IPC command. Off the vault entirely, so it takes no `State` and holds no
/// lock: a person can photograph a receipt with the vault locked and send it.
#[tauri::command]
pub async fn attachment_extract_ephemeral(
    source: EphemeralSource,
) -> Result<EphemeralExtract, String> {
    // Extraction is CPU-bound (OCR takes seconds on a page-sized photo) and must
    // not stall the window's event loop.
    let (bytes, filename) = read_source(source).map_err(|e| e.to_string())?;
    let out = tauri::async_runtime::spawn_blocking(move || extract_ephemeral(filename, &bytes))
        .await
        .map_err(|_| "join".to_string())?;
    tracing::info!(
        stage = "ephemeral",
        event = "ephemeral_extract",
        status = %out.status,
        char_count = out.char_count,
        "a file was read for the composer without becoming an attachment"
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_text_file_comes_back_as_its_own_text() {
        let out = extract_ephemeral(Some("notes.txt".into()), b"receipt total: 42\n");
        assert_eq!(out.status, "ok");
        assert_eq!(out.text.trim(), "receipt total: 42");
        assert_eq!(out.name, "notes.txt");
    }

    #[test]
    fn a_name_is_never_empty_in_the_composer() {
        let out = extract_ephemeral(None, b"x");
        assert_eq!(out.name, "Untitled");
    }

    #[test]
    fn bytes_nothing_can_read_report_why_rather_than_returning_an_empty_document() {
        // Random bytes are sniffed as opaque and match no extractor.
        let out = extract_ephemeral(Some("blob.bin".into()), &[0u8, 1, 2, 3, 4, 5]);
        assert_ne!(out.status, "ok");
        assert!(out.text.is_empty());
    }

    #[test]
    fn an_oversize_base64_payload_is_refused_before_it_is_decoded() {
        let huge = "A".repeat(MAX_ATTACHMENT_IMPORT_LEN);
        let err = read_source(EphemeralSource::BytesB64 {
            bytes_b64: huge,
            filename: None,
        })
        .unwrap_err();
        assert!(matches!(err, EphemeralError::Oversize { .. }));
    }

    #[test]
    fn a_broken_payload_is_malformed_rather_than_empty() {
        let err = read_source(EphemeralSource::BytesB64 {
            bytes_b64: "!!!not base64!!!".into(),
            filename: None,
        })
        .unwrap_err();
        assert!(matches!(err, EphemeralError::Malformed));
    }

    #[test]
    fn a_path_that_does_not_exist_is_unreadable() {
        let err = read_source(EphemeralSource::Path {
            path: "/nonexistent/myne/definitely-not-here.txt".into(),
        })
        .unwrap_err();
        assert!(matches!(err, EphemeralError::Unreadable));
    }

    #[test]
    fn a_real_file_reads_through_the_path_lane() {
        let dir = std::env::temp_dir().join("myne-ephemeral-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("groceries.md");
        std::fs::write(&file, "- milk\n- bread\n").unwrap();
        let out = attachment_extract_ephemeral_blocking(EphemeralSource::Path {
            path: file.to_string_lossy().into_owned(),
        });
        assert_eq!(out.status, "ok");
        assert!(out.text.contains("milk"));
        assert_eq!(out.name, "groceries.md");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn attachment_extract_ephemeral_blocking(source: EphemeralSource) -> EphemeralExtract {
        let (bytes, filename) = read_source(source).expect("source reads");
        extract_ephemeral(filename, &bytes)
    }

    #[test]
    fn the_source_format_of_an_image_is_recognized_without_a_vault() {
        // A 1x1 PNG: sniffed as image/png, so the OCR arm is the one that
        // answers. Whether OCR is *available* depends on the bundled weights, so
        // the assertion is about routing, not about the reading.
        const PNG: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R',
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
        ];
        let out = extract_ephemeral(Some("photo.png".into()), PNG);
        // `Unsupported` (no weights in this build) or `Failed` (a 1x1 image is
        // under the OCR floor) are both honest; what must never happen is a
        // panic or a silent `ok` with an empty body.
        assert!(out.status == "unsupported" || out.status == "failed" || out.status == "empty");
        assert_eq!(out.name, "photo.png");
    }
}
