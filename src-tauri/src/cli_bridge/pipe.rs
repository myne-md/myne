// SPDX-License-Identifier: AGPL-3.0
//! The Windows command door: a **named-pipe server**, the counterpart of
//! `socket.rs`'s Unix domain socket.
//!
//! `docs/threat-model.md`'s CLI-door entry has promised "a local Unix domain
//! socket (macOS/Linux) or named pipe (Windows)" since MYND-490. This is the
//! server half of that sentence; the client half is `cli/src/windows_pipe.rs`.
//!
//! ── The access rule, which is this module's whole security story ──────────
//!
//! The Unix arm gets "only this user can connect" from the filesystem: the
//! socket node is bound with the owner-only umask discipline in
//! `crate::uds::bind_owner_only`, so another account's process cannot open it.
//! A named pipe has no inode and no mode bits. Its equivalent is the **DACL on
//! the pipe object**, and it is set here, at creation, by passing a
//! `SECURITY_ATTRIBUTES` built from the SDDL `D:P(A;;GA;;;OW)`:
//!
//! - `P` is a PROTECTED DACL, so no inherited ACE from a parent object can
//!   widen it. Without `P`, a directory ACE could add a grant this code never
//!   asked for.
//! - `A;;GA;;;OW` is one allow ACE granting generic-all to **Owner Rights**,
//!   which is the object's owner: the account that created the pipe. Naming
//!   `OW` rather than a resolved SID string keeps this to one conversion call
//!   and means the rule is "the owner", not "whoever the token said at build
//!   time".
//!
//! `PIPE_REJECT_REMOTE_CLIENTS` is the second half: without it a pipe is
//! reachable over SMB by a remote caller who satisfies the DACL, and a
//! local-only door is the entire point.
//!
//! ── One connection at a time, deliberately ────────────────────────────────
//!
//! The Unix arm spawns a thread per connection and caps the count at
//! [`MAX_INFLIGHT_CONNECTIONS`](super::socket::MAX_INFLIGHT_CONNECTIONS)
//! because an unbounded thread-per-accept loop turns a shell typo into
//! app-wide thread exhaustion. This arm accepts one connection, serves it to
//! completion, disconnects, and creates the next instance: the cap is one, so
//! there is no count to bound and no thread to exhaust. `myne` opens one
//! connection per invocation, so the difference is invisible in use.
//!
//! ── The deadline, and why it is a thread here too ─────────────────────────
//!
//! Reading the request is bounded by [`Budget`](super::framing::Budget), which
//! dispatch already enforces on both platforms. WRITING the reply is not: a
//! peer that stops reading parks this thread in `WriteFile` indefinitely,
//! which is the same unbounded hold the Unix arm's socket timeouts exist to
//! prevent. The watchdog closes the handle under the blocked call instead,
//! which is the Windows spelling of `shutdown(2)`.
//!
//! ── Never executed, as of this commit ─────────────────────────────────────
//!
//! There is no Windows lane in this repository, so everything above compiles
//! and none of it has been RUN. The Unix arm's behaviour is covered by the
//! tests in `socket.rs`; this one's is covered by reading it. Stated here
//! rather than implied, because "it builds" is the exact claim that gets
//! mistaken for "it works" on a platform nobody boots.

use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{ReadFile, WriteFile, PIPE_ACCESS_DUPLEX};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

use super::activity::SharedLastAccess;
use super::dispatch::NoteLister;
use super::rate_limit::SharedRateLimiter;
use super::socket::{windows_pipe_name, IO_DEADLINE};

/// Owner-only, inherited-ACE-proof: see this module's header for the two
/// clauses and why each is load-bearing.
const DOOR_SDDL: &str = "D:P(A;;GA;;;OW)";

/// In/out buffer request, in bytes. The framing layer carries its own length
/// prefix and its own byte cap, so this is a transport courtesy rather than a
/// limit: a pipe that is asked for a large transfer completes it in more
/// round trips, it does not refuse.
const PIPE_BUFFER_BYTES: u32 = 64 * 1024;

/// A handle shared between the serving thread and the watchdog.
///
/// The watchdog closes the handle to break a blocked call, and the owner closes
/// it on drop. One handle cannot be closed twice, so both go through this and
/// the swap to `INVALID_HANDLE_VALUE` is what makes the second close a no-op
/// rather than a double free.
struct SharedHandle(Arc<std::sync::atomic::AtomicIsize>);

impl SharedHandle {
    fn new(handle: HANDLE) -> Self {
        Self(Arc::new(std::sync::atomic::AtomicIsize::new(
            handle as isize,
        )))
    }

    fn raw(&self) -> HANDLE {
        self.0.load(Ordering::Acquire) as HANDLE
    }

    /// Close once. Returns `true` for the caller that actually closed.
    fn close(&self) -> bool {
        let previous = self.0.swap(INVALID_HANDLE_VALUE as isize, Ordering::AcqRel);
        if previous == INVALID_HANDLE_VALUE as isize {
            return false;
        }
        // SAFETY: `previous` came from a successful CreateNamedPipeW and no
        // other caller can reach it once the swap has replaced it.
        unsafe {
            CloseHandle(previous as HANDLE);
        }
        true
    }
}

/// Reads the request from one end of the pipe.
struct Reader(HANDLE);
/// Writes the reply to the same handle. Two views rather than a clone because
/// a pipe handle needs no duplication to be read and written at once, and
/// dispatch takes the halves separately.
struct Writer(HANDLE);

impl Read for Reader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let want = buf.len().min(u32::MAX as usize) as u32;
        let mut got: u32 = 0;
        // SAFETY: `buf` is live for at least `want` bytes; `got` is written
        // only by the call.
        let ok = unsafe {
            ReadFile(
                self.0,
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

impl Write for Writer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let want = buf.len().min(u32::MAX as usize) as u32;
        let mut written: u32 = 0;
        // SAFETY: `buf` is live for at least `want` bytes; `written` is written
        // only by the call.
        let ok = unsafe {
            WriteFile(
                self.0,
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
        // WriteFile is unbuffered: nothing sits above the handle to flush.
        Ok(())
    }
}

/// A running pipe listener, owned by the lifecycle supervisor. Same shape as
/// the Unix arm's handle so `cli_bridge::mod` needs no per-platform branch.
pub struct ListenerHandle {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    name: Vec<u16>,
    current: SharedHandle,
    last_access: SharedLastAccess,
}

/// Build the `SECURITY_ATTRIBUTES` that carries [`DOOR_SDDL`].
///
/// The returned descriptor is owned by the caller and must be freed with
/// [`free_security_descriptor`]: `CreateNamedPipeW` copies it into the object,
/// so it is freed immediately after each creation rather than held.
fn door_security_attributes(
    descriptor: &mut *mut std::ffi::c_void,
) -> io::Result<SECURITY_ATTRIBUTES> {
    let sddl: Vec<u16> = DOOR_SDDL.encode_utf16().chain(std::iter::once(0)).collect();
    let mut size: u32 = 0;
    // SAFETY: `sddl` is NUL-terminated; `descriptor` is a live out-parameter;
    // the trailing two nulls are the documented "no size hint" form.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1u32, // SECURITY_DESCRIPTOR_REVISION,
            descriptor,
            &mut size,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: *descriptor,
        // Not inheritable: the CLI binary is a separate process that connects
        // by name, never one that inherits the door.
        bInheritHandle: 0,
    })
}

fn free_security_descriptor(descriptor: *mut std::ffi::c_void) {
    if !descriptor.is_null() {
        // SAFETY: the pointer came from ConvertStringSecurityDescriptorTo…,
        // which allocates with LocalAlloc, and is freed exactly once here.
        unsafe {
            LocalFree(descriptor as *mut std::ffi::c_void);
        }
    }
}

/// Create one pipe instance at `name`, owner-only and local-only.
fn create_instance(name: &[u16]) -> io::Result<HANDLE> {
    let mut descriptor: *mut std::ffi::c_void = std::ptr::null_mut();
    let attributes = door_security_attributes(&mut descriptor)?;
    // SAFETY: `name` is NUL-terminated and outlives the call; `attributes`
    // points at a live descriptor for the duration of the call.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            // Open mode: duplex.
            PIPE_ACCESS_DUPLEX,
            // Pipe mode: byte stream, blocking, local clients only.
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            &attributes,
        )
    };
    free_security_descriptor(descriptor);
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(handle)
}

/// Block until a client connects to `handle`, or the instance is closed under
/// us by [`teardown`].
fn wait_for_client(handle: HANDLE) -> io::Result<()> {
    // SAFETY: `handle` is a live pipe instance.
    let ok = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
    if ok != 0 {
        return Ok(());
    }
    // SAFETY: reads a thread-local error set by the call above.
    let error = unsafe { GetLastError() };
    // Both of these mean a client is or was connected: ERROR_PIPE_CONNECTED is
    // the client that arrived between create and connect (documented as a
    // success for this call), and ERROR_NO_DATA is a client that connected and
    // left again. Serving the second one reads EOF immediately, which is the
    // honest answer.
    if error == ERROR_PIPE_CONNECTED || error == ERROR_NO_DATA {
        return Ok(());
    }
    Err(io::Error::last_os_error())
}

/// Serve one connection to completion on the accept thread.
fn serve(
    handle: HANDLE,
    lister: &dyn NoteLister,
    limiter: &SharedRateLimiter,
    last_access: &SharedLastAccess,
    deadline: Duration,
) {
    let shared = SharedHandle::new(handle);
    // Arm the write-side watchdog before a byte moves. Dropping `disarm` at the
    // end of the exchange disconnects the channel and wakes the thread, so a
    // healthy connection never pays the deadline.
    let (disarm, rx) = std::sync::mpsc::channel::<()>();
    let watchdog_handle = shared.0.clone();
    let watchdog = std::thread::Builder::new()
        .name("myne-cli-pipe-watchdog".to_string())
        .spawn(move || {
            if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(deadline) {
                let previous = watchdog_handle.swap(
                    INVALID_HANDLE_VALUE as isize,
                    std::sync::atomic::Ordering::AcqRel,
                );
                if previous != INVALID_HANDLE_VALUE as isize {
                    // SAFETY: this is the only close for this handle if the
                    // swap won; the owner's `close` is then a no-op.
                    unsafe {
                        CloseHandle(previous as HANDLE);
                    }
                }
            }
        });

    let mut reader = Reader(handle);
    let mut writer = Writer(handle);
    super::dispatch::serve_connection(
        &mut reader,
        &mut writer,
        lister,
        limiter,
        Some(super::framing::Budget::new(deadline)),
    );
    drop(disarm);
    if let Ok(thread) = watchdog {
        let _ = thread.join();
    }
    shared.close();
    last_access.record(Instant::now());
}

/// The accept loop: instance, wait, serve, disconnect, repeat until stopped.
fn accept_loop(
    name: Vec<u16>,
    stop: Arc<AtomicBool>,
    current: SharedHandle,
    lister: Arc<dyn NoteLister>,
    limiter: Arc<SharedRateLimiter>,
    last_access: SharedLastAccess,
    deadline: Duration,
) {
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let handle = match create_instance(&name) {
            Ok(h) => h,
            Err(e) => {
                let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                tracing::debug!(stage = "cli_bridge_pipe_create", io_failure_kind = ?kind);
                // A failed creation leaves nothing to wait on; a short pause
                // keeps this from becoming a spin without holding the stop
                // flag hostage for long.
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        // Publish the live instance so `teardown` can close it and break the
        // blocking wait below.
        let previous = current.0.swap(handle as isize, Ordering::AcqRel);
        if previous != INVALID_HANDLE_VALUE as isize && previous != handle as isize {
            // SAFETY: a stale instance the loop already finished with.
            unsafe {
                CloseHandle(previous as HANDLE);
            }
        }
        if wait_for_client(handle).is_err() {
            current.close();
            return;
        }
        serve(handle, lister.as_ref(), &limiter, &last_access, deadline);
        // SAFETY: the instance is ours and no client is attached after serve.
        unsafe {
            DisconnectNamedPipe(handle);
        }
    }
}

/// Bind the command pipe for `app_data_dir` and serve connections on a
/// background thread until [`teardown`] is called. The Windows counterpart of
/// `socket::spawn`, same signature and same contract.
pub fn spawn(
    app_data_dir: &Path,
    lister: Arc<dyn NoteLister>,
    limiter: Arc<SharedRateLimiter>,
    last_access: SharedLastAccess,
) -> io::Result<ListenerHandle> {
    let name: Vec<u16> = windows_pipe_name(app_data_dir)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = stop.clone();
    let current = SharedHandle::new(INVALID_HANDLE_VALUE);
    let current_worker = SharedHandle(current.0.clone());
    let marker = last_access.clone();
    let name_worker = name.clone();
    let join = std::thread::Builder::new()
        .name("cli-bridge-pipe-accept".into())
        .spawn(move || {
            accept_loop(
                name_worker,
                stop_worker,
                current_worker,
                lister,
                limiter,
                marker,
                IO_DEADLINE,
            )
        })?;
    Ok(ListenerHandle {
        stop,
        join: Some(join),
        name,
        current,
        last_access,
    })
}

/// Tear down a running listener: signal the loop, close the live instance so a
/// blocked `ConnectNamedPipe` returns, and join off the caller's thread. Owns
/// the last-access reset for the same reason the Unix arm does: an age that
/// outlived its session would tell the user something used the CLI in a session
/// they can no longer see.
pub fn teardown(handle: Option<ListenerHandle>) {
    let Some(mut h) = handle else { return };
    h.last_access.clear();
    h.stop.store(true, Ordering::Relaxed);
    // Closing the instance is what breaks the blocking wait; the stop flag
    // alone would only be seen after the next client arrives.
    h.current.close();
    if let Some(join) = h.join.take() {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = join.join();
        });
    }
}
