// SPDX-License-Identifier: AGPL-3.0
//! Unix-domain-socket plumbing shared by every local ingress this crate
//! binds — the browser clipper's relay (`clipper::relay`, TB10) and the CLI
//! terminal-access door (`cli_bridge::socket`, MYND-490).
//!
//! It lives here rather than in either of them because the bind→chmod TOCTOU
//! discipline below is the *same* security property for both, and a second
//! copy is a second thing to fix when it changes. Each ingress still owns its
//! own socket path, its own lifecycle and its own accept loop; only the bind
//! is shared.

/// Serializes the umask window in [`bind_owner_only`].
///
/// `umask(2)` is process-global, so two threads doing save→set→bind→restore
/// concurrently could interleave and have one restore the other's temporary
/// value. Both local ingresses bind from their own threads
/// (`cli_bridge::socket::spawn` and `clipper::relay_app::spawn_relay_listener`),
/// so that interleaving is reachable in this app rather than theoretical.
#[cfg(unix)]
static UMASK_BIND_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Bind a Unix domain socket listener, with the node owner-only **from the
/// moment it exists**.
///
/// `UnixListener::bind` creates the socket node with `0777 & ~umask`, and
/// nothing in the standard library takes a mode. So the mode is imposed the
/// only way POSIX offers: narrow the umask across the `bind` call, then put it
/// back (myne#389 item A).
///
/// The residual this leaves is **fail-safe in the one direction that matters**:
/// while the window is open, anything *else* this process creates is more
/// private than intended, never less. That is why a lock plus a briefly
/// over-restrictive umask is an acceptable trade where a briefly
/// over-permissive socket is not.
///
/// **The mask is `0o077`, not `0o177`, and the difference is not cosmetic.**
/// `0o177` would also strip the owner's execute bit — which is harmless for the
/// socket node this creates, and destructive for any *directory* another thread
/// creates inside the window, since a `0600` directory cannot be traversed even
/// by its owner. `0o077` removes group and other entirely and leaves the owner
/// bits alone, which is the conventional private umask for exactly this reason.
/// The socket lands at `0700` and the caller's `set_permissions` makes it
/// exactly `0600`.
#[cfg(unix)]
fn bind_owner_only(path: &std::path::Path) -> std::io::Result<std::os::unix::net::UnixListener> {
    // A poisoned lock means some other thread panicked mid-window. The umask is
    // process state we still have to manage, and refusing to bind would turn a
    // foreign panic into a dead ingress, so take the guard either way.
    let _guard = UMASK_BIND_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: `umask` is always successful and has no failure mode; it returns
    // the previous mask. The pair is not exception-safe across a panic, but
    // `UnixListener::bind` does not panic on a bind failure — it returns Err —
    // and the mask is restored on both arms below.
    let previous = unsafe { libc::umask(0o077) };
    let listener = std::os::unix::net::UnixListener::bind(path);
    unsafe {
        libc::umask(previous);
    }
    listener
}

/// Bind a Unix domain socket listener at `path` with owner-only (0600) perms.
///
/// Removes a stale socket file at `path` first (a leftover from a previous
/// unclean exit), binds, and sets `0600` BEFORE returning the listener so the
/// channel is owner-only from the first accept. Unix-only; the Windows arm is
/// a documented seam (named pipe + owner-only DACL) the dev/CI target does not
/// exercise.
#[cfg(unix)]
pub fn bind_listener(path: &std::path::Path) -> std::io::Result<std::os::unix::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    // Bind at a sibling TEMP path, lock it to 0600, then atomically rename it
    // into place. A bind-at-`path`-then-chmod sequence would leave a window
    // where a same-host peer could connect via `path` before the chmod lands
    // (the bind→chmod TOCTOU). Binding at a temp name closes it
    // deterministically: a client connects via `path`, which only ever appears
    // already at 0600 — the rename preserves the inode's perms, and the bound
    // listener fd keeps serving across the rename (the pathname is just the
    // rendezvous address).
    //
    // **Both names, not just the final one (myne#389 item A).** The temp name
    // is not a secret — it is derived from a `pub const` basename — and a
    // connection accepted on it keeps being served after the rename, since the
    // fd is the listener and the pathname only the address. So the temp node is
    // bound through [`bind_owner_only`], which narrows the umask across the
    // `bind` itself. The `set_permissions` below is then belt-and-braces rather
    // than the only control — and it stays, because the narrowed bind lands the
    // node at 0700 (see the mask choice there) and this is what makes it exactly
    // 0600. No group or other bit is ever set on either name.
    let tmp = path.with_extension("sock.tmp");
    let _ = std::fs::remove_file(&tmp);
    // A stale socket / non-socket anomaly at the final path (previous unclean
    // exit) — remove it so the rename can replace it (the app owns its
    // app_data_dir).
    let _ = std::fs::remove_file(path);
    let listener = bind_owner_only(&tmp)?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    std::fs::rename(&tmp, path)?;
    Ok(listener)
}

#[cfg(all(test, unix))]
mod tests {
    use super::bind_owner_only;
    use std::os::unix::fs::PermissionsExt;

    /// The property the doc comment used to assert for the final path only.
    ///
    /// The umask is set to `0` first, which is what makes this a test of
    /// `bind_owner_only` rather than of the ambient environment: under the
    /// common `0022` the node would land at `0755` and a non-owner could not
    /// connect anyway, so a test that inherited the runner's umask could pass
    /// while proving nothing. And the mode is read **before** any
    /// `set_permissions` runs — that call is what the old code relied on, and
    /// the whole point here is that the node is never observable without it.
    ///
    /// The path is hand-built short rather than taken from `ScopedTempDir`: a
    /// Unix socket path is capped at ~104 bytes by the kernel, and the temp
    /// directory a test helper produces overruns it (`SUN_LEN`). The CLI
    /// socket's own suite carries a `ShortDir` helper for the same reason.
    #[test]
    fn the_bound_node_is_owner_only_before_any_chmod() {
        let dir = std::path::PathBuf::from("/tmp").join(format!("myn-u{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s.sock");
        let _ = std::fs::remove_file(&path);

        // SAFETY: same contract as the production call — `umask` cannot fail.
        // Restored below so the rest of the suite is unaffected.
        let previous = unsafe { libc::umask(0) };
        let listener = bind_owner_only(&path);
        unsafe {
            libc::umask(previous);
        }
        let _listener = listener.expect("bind");

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(
            mode & 0o077,
            0,
            "no group or other bit may be set on the socket node from the moment \
             it exists — under umask 0 an unnarrowed bind lands at 0777, which is \
             exactly the window a peer could connect through before a chmod \
             arrives"
        );
        // The owner bits are deliberately NOT asserted to be exactly `rw-`: the
        // mask leaves them alone (see `bind_owner_only`), and it is the caller's
        // `set_permissions` that trims the execute bit. What this test owns is
        // the cross-UID property.
        assert_eq!(mode & 0o600, 0o600, "the owner must be able to use it");
    }
}
