// SPDX-License-Identifier: AGPL-3.0
//! Inner plaintext framing for a share-import staging blob (§ 9.20.3).
//!
//! The `MYF1` codec ([`protocol::share_import_blob`]) seals an **opaque**
//! plaintext; this module defines what that plaintext IS: a shared file's bytes
//! prefixed with its filename + declared MIME:
//!
//! ```text
//! filename_len (u16 BE) ∥ filename (utf8) ∥ mime_len (u16 BE) ∥ mime (utf8) ∥ file_bytes
//! ```
//!
//! Filename + MIME are display / hint fields — the drain re-sniffs the MIME
//! authoritatively (§ 9.9) — so they live INSIDE the encrypted plaintext
//! (confidential), not in the AAD. A filename / MIME longer than 64 KiB is
//! truncated at frame time (no real filename approaches that; the cap keeps the
//! u16 length honest).

use zeroize::Zeroizing;

/// One decoded staged share, handed to the drain.
pub struct StagedShare {
    /// The 32-char hex `share_id` — the `sealed/` filename; pass back to `ack`.
    pub id: String,
    /// The caller-supplied display filename (a hint; the drain still re-sniffs).
    pub filename: String,
    /// The caller-declared MIME (a hint; the drain re-sniffs authoritatively).
    pub mime: String,
    /// The shared file's bytes (AS-sensitive plaintext until re-encrypted).
    pub bytes: Zeroizing<Vec<u8>>,
}

const MAX_HINT_LEN: usize = u16::MAX as usize;

fn push_u16_prefixed(out: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    let len = bytes.len().min(MAX_HINT_LEN);
    out.extend_from_slice(&(len as u16).to_be_bytes());
    out.extend_from_slice(&bytes[..len]);
}

/// Frame `{filename, mime, file_bytes}` into the opaque plaintext the `MYF1`
/// codec seals.
pub fn frame_record(filename: &str, mime: &str, file_bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(
        2 + filename.len().min(MAX_HINT_LEN) + 2 + mime.len().min(MAX_HINT_LEN) + file_bytes.len(),
    );
    push_u16_prefixed(&mut out, filename);
    push_u16_prefixed(&mut out, mime);
    out.extend_from_slice(file_bytes);
    out
}

/// Parse a framed plaintext back into `(filename, mime, file_bytes)`. Returns
/// `None` on any structural malformation (a queue entry that cannot be unframed
/// is dropped by the drain, never surfaced as an error). Non-UTF-8 filename /
/// MIME fields are a malformation.
pub fn unframe_record(plaintext: &[u8]) -> Option<(String, String, Vec<u8>)> {
    let mut off = 0usize;

    let filename = read_u16_prefixed(plaintext, &mut off)?;
    let mime = read_u16_prefixed(plaintext, &mut off)?;
    let file_bytes = plaintext.get(off..)?.to_vec();
    Some((filename, mime, file_bytes))
}

fn read_u16_prefixed(buf: &[u8], off: &mut usize) -> Option<String> {
    let len_bytes = buf.get(*off..*off + 2)?;
    let len = u16::from_be_bytes([len_bytes[0], len_bytes[1]]) as usize;
    *off += 2;
    let slice = buf.get(*off..*off + len)?;
    *off += len;
    core::str::from_utf8(slice).ok().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_filename_mime_and_binary_bytes() {
        let bytes = [0x00u8, 0xff, 0x89, 0x50, 0x4e, 0x47];
        let framed = frame_record("café — nöte.pdf", "application/pdf", &bytes);
        let (fname, mime, out) = unframe_record(&framed).expect("unframe");
        assert_eq!(fname, "café — nöte.pdf");
        assert_eq!(mime, "application/pdf");
        assert_eq!(out, bytes);
    }

    #[test]
    fn round_trips_empty_filename_and_empty_bytes() {
        let framed = frame_record("", "application/octet-stream", &[]);
        let (fname, mime, out) = unframe_record(&framed).expect("unframe");
        assert_eq!(fname, "");
        assert_eq!(mime, "application/octet-stream");
        assert!(out.is_empty());
    }

    #[test]
    fn truncated_frame_is_none_not_panic() {
        // A 1-byte buffer can't even hold the first u16 length.
        assert!(unframe_record(&[0x00]).is_none());
        // A length claiming more than the buffer holds.
        assert!(unframe_record(&[0xff, 0xff, 0x61]).is_none());
    }
}
