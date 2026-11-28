// SPDX-License-Identifier: AGPL-3.0-only
//! `attachment_extract_ephemeral` — mobile host.
//!
//! Same contract as the desktop command (see
//! `src-tauri/src/plugins/attachments/ephemeral.rs`): read a picked or shot file,
//! return its text, write nothing. The difference is which extractors exist here:
//! images go through the shared on-device OCR (MYND-441) and text-like files are
//! read as UTF-8, because `lopdf` / `zip` / `quick-xml` — the PDF and DOCX
//! producers — are bound to the desktop crate and mobile does not compile them.
//!
//! No vault, no key, no catalog: callable while the vault is locked, and the
//! payload is `Zeroizing` so it dies with the call.

use myne_core::plugins::attachments::commands::MAX_ATTACHMENT_IMPORT_LEN;
use myne_core::plugins::attachments::extract_types::{ExtractStatus, ExtractedText, SourceFormat};
use myne_core::plugins::attachments::{ocr, sniff};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EphemeralSource {
    Bytes {
        bytes: Vec<u8>,
        filename: Option<String>,
    },
}

#[derive(Debug, Serialize)]
pub struct EphemeralExtract {
    pub name: String,
    pub text: String,
    /// `ok` | `empty` | `unsupported` | `failed`, a closed label of four tags.
    pub status: &'static str,
    pub char_count: u32,
    pub truncated: bool,
}

fn status_tag(status: ExtractStatus) -> &'static str {
    match status {
        ExtractStatus::Ok => "ok",
        ExtractStatus::Empty => "empty",
        ExtractStatus::Unsupported => "unsupported",
        ExtractStatus::Failed => "failed",
    }
}

/// Text-like by content type or by extension, which is all this host can read
/// beyond an image. Deliberately narrow: guessing wider would put binary noise
/// in front of the model as prose.
fn is_text_like(content_type: &str, filename: &str) -> bool {
    if content_type.starts_with("text/") {
        return true;
    }
    let lower = filename.to_ascii_lowercase();
    [".md", ".markdown", ".txt", ".csv", ".json", ".yaml", ".yml"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

pub fn extract_ephemeral(filename: Option<String>, bytes: &[u8]) -> EphemeralExtract {
    let name = filename
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Untitled".to_string());
    let content_type = sniff::sniff_content_type(bytes).unwrap_or("application/octet-stream");
    let extracted: ExtractedText = if content_type.starts_with("image/") {
        ocr::extract_image(bytes)
    } else if is_text_like(content_type, &name) {
        let text = String::from_utf8_lossy(bytes).into_owned();
        if text.trim().is_empty() {
            ExtractedText::negative(ExtractStatus::Empty, SourceFormat::Text)
        } else {
            ExtractedText {
                status: ExtractStatus::Ok,
                source_format: SourceFormat::Text,
                char_count: text.chars().count() as u32,
                text,
                truncated: false,
                model_hash: None,
            }
        }
    } else {
        // PDF and DOCX have no extractor on this host, and saying so is the
        // sentence the composer renders instead of an empty document.
        ExtractedText::negative(ExtractStatus::Unsupported, SourceFormat::Other)
    };
    EphemeralExtract {
        name,
        text: if extracted.status == ExtractStatus::Ok {
            extracted.text
        } else {
            String::new()
        },
        status: status_tag(extracted.status),
        char_count: extracted.char_count,
        truncated: extracted.truncated,
    }
}

fn read_source(source: EphemeralSource) -> Result<(Zeroizing<Vec<u8>>, Option<String>), String> {
    match source {
        EphemeralSource::Bytes { bytes, filename } => {
            if bytes.len() > MAX_ATTACHMENT_IMPORT_LEN {
                return Err("oversize".to_string());
            }
            Ok((Zeroizing::new(bytes), filename))
        }
    }
}

#[tauri::command]
pub async fn attachment_extract_ephemeral(
    source: EphemeralSource,
) -> Result<EphemeralExtract, String> {
    let (bytes, filename) = read_source(source)?;
    let out = tauri::async_runtime::spawn_blocking(move || extract_ephemeral(filename, &bytes))
        .await
        .map_err(|_| "join".to_string())?;
    tracing::info!(
        stage = "ephemeral",
        event = "ephemeral_extract",
        status = out.status,
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
        let out = extract_ephemeral(Some("notes.md".into()), b"- milk\n");
        assert_eq!(out.status, "ok");
        assert!(out.text.contains("milk"));
    }

    #[test]
    fn a_pdf_reports_unsupported_rather_than_empty() {
        let out = extract_ephemeral(Some("receipt.pdf".into()), b"%PDF-1.7\n");
        assert_eq!(out.status, "unsupported");
        assert!(out.text.is_empty());
    }

    #[test]
    fn a_blank_text_file_is_empty_not_ok() {
        let out = extract_ephemeral(Some("blank.txt".into()), b"   \n");
        assert_eq!(out.status, "empty");
    }

    #[test]
    fn a_payload_over_the_cap_is_refused_before_decoding() {
        let read = read_source(EphemeralSource::Bytes {
            bytes: vec![0u8; MAX_ATTACHMENT_IMPORT_LEN + 1],
            filename: None,
        });
        assert!(read.is_err());
    }
}
