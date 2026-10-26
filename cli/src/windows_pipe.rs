// SPDX-License-Identifier: AGPL-3.0
//! The Windows transport for the desktop's CLI command door: a **named-pipe**
//! client, reached at a name derived from the same app-data directory the Unix
//! arm turns into `cli.sock`.
//!
//! Why a pipe and not a socket: Windows has no filesystem socket, and its
//! equivalent local rendezvous is `\\.\pipe\<name>`. `docs/threat-model.md`'s
//! CLI-door entry already says so ("over a local Unix domain socket
//! (macOS/Linux) or named pipe (Windows)"), so this arm closes a spec/code gap
//! rather than inventing a transport.
//!
//! ── The name, and why it is derived rather than fixed ─────────────────────
//!
//! Named pipes are machine-global, unlike `cli.sock`, which lives inside one
//! user's app-data directory. A fixed name would collide between two accounts
//! running Myne on the same machine, so the name carries a hash of the app-data
//! directory: `\\.\pipe\myne-cli-<hex>`.
//!
//! The hash is FNV-1a written out here, not `DefaultHasher`, because the
//! desktop and this binary must derive the SAME name and they need not be the
//! same build: `std::collections::hash_map::DefaultHasher` is explicitly not
//! stable across releases, so a version-skewed pair would silently disagree
//! about where the door is and every command would report "the app is not
//! running" against a running app. FNV-1a over the path's UTF-8 bytes is
//! frozen arithmetic, and `src-tauri/src/cli_bridge/pipe.rs` carries the same
//! function; `scripts/check-cli-sidecar.mjs` holds the two copies to one
//! prefix, the way it already holds the bundle identifier and the socket name.
//!
//! ── Access control is the SERVER's job ────────────────────────────────────
//!
//! A pipe client cannot restrict who else may connect; the DACL on the pipe
//! instance is what bounds access, and it is set by the desktop when it creates
//! the pipe (owner-only, the Windows equivalent of the `0600` bind discipline
//! in `cli_bridge::socket`). This side trusts the name because the name is not
//! a secret and the server is the gate.

use std::io::{self, Read, Write};
use std::path::Path;

use windows_sys::Win32::Foundation::{CloseHandle, ERROR_PIPE_BUSY, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_GENERIC_READ, FILE_GENERIC_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::WaitNamedPipeW;

/// The pipe-name prefix, duplicated in `src-tauri/src/cli_bridge/pipe.rs`.
pub const PIPE_PREFIX: &str = "myne-cli-";

/// How long a client waits for a busy pipe to become available, and how many
/// times it retries. A door that is open but has not yet created its next
/// instance reports `ERROR_PIPE_BUSY`; anything longer than this is a real
/// refusal, which the caller classifies from the status marker.
const BUSY_WAIT_MS: u32 = 500;
const BUSY_ATTEMPTS: u32 = 4;

/// The pipe this app-data directory's door lives at, as a full `\\.\pipe\…`
/// path.
pub fn pipe_path(app_data_dir: &Path) -> String {
    format!(
        r"\\.\pipe\{}{:016x}",
        PIPE_PREFIX,
        fnv1a64(app_data_dir.to_string_lossy().as_bytes())
    )
}

/// FNV-1a, 64-bit. Frozen arithmetic on purpose: see this module's header.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// A connected pipe handle.
///
/// `Read`/`Write` are what the framing layer needs, and nothing else is
/// exposed: no seeks, no async, no overlapped I/O. The door's protocol is one
/// framed request and one framed reply, so a blocking handle is the whole
/// requirement.
pub struct PipeClient {
    handle: HANDLE,
}

impl PipeClient {
    /// Connect to the door at `path`, waiting briefly for a busy pipe.
    pub fn connect(path: &str) -> io::Result<Self> {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut attempt = 0;
        loop {
            // SAFETY: `wide` is NUL-terminated and outlives the call; a null
            // security-attributes pointer means "default", and there is no
            // template file.
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE,
                    0,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    0,
                    std::ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(Self { handle });
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && attempt < BUSY_ATTEMPTS {
                attempt += 1;
                // SAFETY: `wide` is NUL-terminated and outlives the call.
                let waited = unsafe { WaitNamedPipeW(wide.as_ptr(), BUSY_WAIT_MS) };
                if waited != 0 {
                    continue;
                }
            }
            return Err(error);
        }
    }
}

impl Read for PipeClient {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let want = buf.len().min(u32::MAX as usize) as u32;
        let mut got: u32 = 0;
        // SAFETY: `buf` is a live mutable slice of at least `want` bytes, and
        // `got` is written only by the call.
        let ok = unsafe {
            ReadFile(
                self.handle,
                buf.as_mut_ptr(),
                want,
                &mut got,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(got as usize)
    }
}

impl Write for PipeClient {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let want = buf.len().min(u32::MAX as usize) as u32;
        let mut written: u32 = 0;
        // SAFETY: `buf` is a live slice of at least `want` bytes, and `written`
        // is written only by the call.
        let ok = unsafe {
            WriteFile(
                self.handle,
                buf.as_ptr(),
                want,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        // WriteFile is unbuffered: there is nothing above the handle to flush.
        Ok(())
    }
}

impl Drop for PipeClient {
    fn drop(&mut self) {
        // SAFETY: the handle came from a successful `CreateFileW` and is
        // closed exactly once, here.
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipe_path_is_namespaced_and_stable() {
        let a = pipe_path(Path::new(r"C:\Users\a\AppData\Roaming\md.myne.desktop"));
        let b = pipe_path(Path::new(r"C:\Users\a\AppData\Roaming\md.myne.desktop"));
        let c = pipe_path(Path::new(r"C:\Users\b\AppData\Roaming\md.myne.desktop"));
        assert_eq!(a, b, "the same directory must derive the same door");
        assert_ne!(a, c, "two app-data directories must not share a door");
        assert!(a.starts_with(r"\\.\pipe\myne-cli-"));
        // 16 hex digits of the hash, nothing else.
        assert_eq!(a.rsplit('-').next().unwrap().len(), 16);
    }

    #[test]
    fn fnv1a64_is_the_reference_vector() {
        // The published FNV-1a 64-bit vectors: "" and "a".
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }
}
