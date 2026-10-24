// SPDX-License-Identifier: AGPL-3.0
//! The named-pipe machinery every Windows local ingress shares.
//!
//! Two of them exist and both are trust boundaries: the CLI terminal door
//! (`cli_bridge::pipe`, MYND-490) and the browser clipper's relay
//! (`clipper::relay_app`, TB10). On Unix each binds its own `UnixListener`
//! through [`crate::uds::bind_owner_only`], which is where "only this user can
//! connect" lives. Windows has no inode and no mode bits, so both need the same
//! substitute, and it must be the SAME substitute: two copies of a security
//! descriptor is two chances to get it wrong, and the failure is silent in the
//! direction of "any local user can talk to a decrypted-note door".
//!
//! So this module owns, once:
//!
//! - **The DACL.** `D:P(A;;GA;;;OW)` is a PROTECTED DACL (no inherited ACE can
//!   widen it) granting generic-all to Owner Rights, i.e. the account that
//!   created the pipe; `PIPE_REJECT_REMOTE_CLIENTS` closes the SMB route a
//!   DACL-satisfying remote caller would otherwise have. Neither clause is
//!   optional and neither is repeated at a call site.
//! - **The close-once handle**, because a watchdog closes the handle under a
//!   blocked call and the owner closes it on drop, and one handle cannot be
//!   closed twice.
//! - **The instance loop**: create, wait, serve, disconnect, repeat.
//! - **The watchdog**, which bounds the WRITE side. Reading the request is
//!   bounded by each caller's own budget; a peer that stops reading the reply is
//!   bounded by nothing else, and parking a thread there is the unbounded hold
//!   the Unix arm's socket timeouts prevent.
//!
//! What a caller supplies is only what differs: the pipe name, and one closure
//! that serves a connected handle.

use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

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

/// Owner-only, inherited-ACE-proof. See this module's header.
const DOOR_SDDL: &str = "D:P(A;;GA;;;OW)";

/// In/out buffer request, in bytes. Each caller's own framing carries the real
/// byte caps, so this is a transport courtesy: a larger transfer completes in
/// more round trips rather than being refused.
const PIPE_BUFFER_BYTES: u32 = 64 * 1024;

/// How long the instance loop pauses after a failed creation, so a persistent
/// failure does not become a spin that also holds the stop flag off.
const CREATE_RETRY_PAUSE: Duration = Duration::from_millis(100);

/// A handle the serving thread, the watchdog and the owner all reach.
///
/// One handle cannot be closed twice, and the watchdog's whole job is to close
/// it under a blocked call, so both sides close through this and the swap to
/// `INVALID_HANDLE_VALUE` makes the second close a no-op.
#[derive(Clone)]
pub struct SharedHandle(Arc<AtomicIsize>);

impl SharedHandle {
    pub fn new(handle: HANDLE) -> Self {
        Self(Arc::new(AtomicIsize::new(handle as isize)))
    }

    pub fn closed() -> Self {
        Self::new(INVALID_HANDLE_VALUE)
    }

    pub fn raw(&self) -> HANDLE {
        self.0.load(Ordering::Acquire) as HANDLE
    }

    /// Publish a new live handle. Returns the previous one, already closed here
    /// unless it was the invalid sentinel.
    pub fn replace(&self, handle: HANDLE) {
        let previous = self.0.swap(handle as isize, Ordering::AcqRel);
        if previous != INVALID_HANDLE_VALUE as isize && previous != handle as isize {
            // SAFETY: `previous` was ours and the swap removed it from reach.
            unsafe {
                CloseHandle(previous as HANDLE);
            }
        }
    }

    /// Close once. Returns `false` for the caller that found it already closed.
    pub fn close(&self) -> bool {
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

/// Reads one side of a connected pipe.
pub struct PipeReader(pub HANDLE);

/// Writes the other. Two views rather than a duplicated handle: a pipe handle
/// serves both directions, and a caller's serve closure usually wants the halves
/// separately (its own framing takes `&mut r` and `&mut w`).
pub struct PipeWriter(pub HANDLE);

impl Read for PipeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let want = buf.len().min(u32::MAX as usize) as u32;
        let mut got: u32 = 0;
        // SAFETY: `buf` is live for at least `want` bytes; `got` is written only
        // by the call.
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

impl Write for PipeWriter {
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

/// Create one pipe instance at `name`, owner-only and local-only.
fn create_instance(name: &[u16]) -> io::Result<HANDLE> {
    let sddl: Vec<u16> = DOOR_SDDL.encode_utf16().chain(std::iter::once(0)).collect();
    let mut descriptor: *mut std::ffi::c_void = std::ptr::null_mut();
    let mut size: u32 = 0;
    // SAFETY: `sddl` is NUL-terminated; `descriptor` is a live out-parameter;
    // the trailing size pointer is the documented "tell me the size" form.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1, // SECURITY_DESCRIPTOR_REVISION
            &mut descriptor,
            &mut size,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        // Not inheritable: both clients are separate processes that connect by
        // name, never ones that inherit the door.
        bInheritHandle: 0,
    };
    // SAFETY: `name` is NUL-terminated and outlives the call; `attributes`
    // points at a live descriptor for the duration of the call.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            0,
            &attributes,
        )
    };
    if !descriptor.is_null() {
        // SAFETY: allocated by the conversion above with LocalAlloc, and freed
        // exactly once here after the creation copied it.
        unsafe {
            LocalFree(descriptor as *mut std::ffi::c_void);
        }
    }
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    Ok(handle)
}

/// Block until a client connects, or the instance is closed under us.
fn wait_for_client(handle: HANDLE) -> io::Result<()> {
    // SAFETY: `handle` is a live pipe instance.
    let ok = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
    if ok != 0 {
        return Ok(());
    }
    // SAFETY: reads the thread-local error set by the call above.
    let error = unsafe { GetLastError() };
    // ERROR_PIPE_CONNECTED is the client that arrived between create and
    // connect (documented as success for this call); ERROR_NO_DATA is a client
    // that connected and left, which reads EOF immediately and is the honest
    // answer.
    if error == ERROR_PIPE_CONNECTED || error == ERROR_NO_DATA {
        return Ok(());
    }
    Err(io::Error::last_os_error())
}

/// Serve one connected handle, bounded on the write side by `deadline`.
///
/// The body gets the two halves; it is expected to bound its own reads (each
/// caller has a framing budget) and is handed a watchdog for the write it cannot
/// bound itself.
pub fn serve_one<F>(handle: HANDLE, deadline: Duration, body: F)
where
    F: FnOnce(&mut PipeReader, &mut PipeWriter),
{
    let shared = SharedHandle::new(handle);
    let (disarm, rx) = std::sync::mpsc::channel::<()>();
    let watchdog_handle = shared.0.clone();
    let watchdog = std::thread::Builder::new()
        .name("myne-pipe-watchdog".to_string())
        .spawn(move || {
            if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(deadline) {
                let previous =
                    watchdog_handle.swap(INVALID_HANDLE_VALUE as isize, Ordering::AcqRel);
                if previous != INVALID_HANDLE_VALUE as isize {
                    // SAFETY: this is the only close if the swap won; the
                    // caller's `close` below is then a no-op.
                    unsafe {
                        CloseHandle(previous as HANDLE);
                    }
                }
            }
        });

    let mut reader = PipeReader(handle);
    let mut writer = PipeWriter(handle);
    body(&mut reader, &mut writer);

    // Disconnecting the channel wakes the thread out of `recv_timeout`
    // immediately, so a healthy exchange never pays the deadline.
    drop(disarm);
    if let Ok(thread) = watchdog {
        let _ = thread.join();
    }
    shared.close();
}

/// A running pipe listener: the instance loop lives on its own thread.
pub struct Server {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    current: SharedHandle,
}

impl Server {
    /// Start serving `name`. `serve` is called with each connected handle and
    /// must not return before it is done with it.
    ///
    /// One connection at a time: a named-pipe accept loop that spawned a thread
    /// per connection would need the Unix arm's `MAX_INFLIGHT_CONNECTIONS` bound
    /// to stay safe against a shell typo. A cap of one removes the count instead
    /// of bounding it, and both of this module's callers answer one request per
    /// invocation.
    pub fn start<F>(name: Vec<u16>, deadline: Duration, body: F) -> io::Result<Server>
    where
        F: Fn(&mut PipeReader, &mut PipeWriter) + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_worker = stop.clone();
        let current = SharedHandle::closed();
        let current_worker = current.clone();
        let join = std::thread::Builder::new()
            .name("myne-pipe-accept".into())
            .spawn(move || {
                while !stop_worker.load(Ordering::Relaxed) {
                    let handle = match create_instance(&name) {
                        Ok(h) => h,
                        Err(e) => {
                            let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                            tracing::debug!(stage = "pipe_create", io_failure_kind = ?kind);
                            std::thread::sleep(CREATE_RETRY_PAUSE);
                            continue;
                        }
                    };
                    // Publish the live instance so `stop` can close it and break
                    // the blocking wait below.
                    current_worker.replace(handle);
                    if wait_for_client(handle).is_err() {
                        current_worker.close();
                        return;
                    }
                    serve_one(handle, deadline, &body);
                    // SAFETY: the instance is ours and no client is attached
                    // once `serve` has returned.
                    unsafe {
                        DisconnectNamedPipe(handle);
                    }
                }
            })?;
        Ok(Server {
            stop,
            join: Some(join),
            current,
        })
    }

    /// Stop the loop and join it off the caller's thread.
    ///
    /// Closing the live instance is what breaks a blocked `ConnectNamedPipe`;
    /// the stop flag alone is only seen after the next client arrives.
    pub fn stop_and_join(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.current.close();
        if let Some(join) = self.join.take() {
            tauri::async_runtime::spawn_blocking(move || {
                let _ = join.join();
            });
        }
    }
}
