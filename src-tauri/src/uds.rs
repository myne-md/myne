//! Unix-domain-socket plumbing shared by every local ingress this crate
//! binds — the browser clipper's relay (`clipper::relay`, TB10) and the CLI
//! terminal-access door (`cli_bridge::socket`, MYND-490).
//!
//! It lives here rather than in either of them because the bind→chmod TOCTOU
//! discipline below is the *same* security property for both, and a second
//! copy is a second thing to fix when it changes. Each ingress still owns its
//! own socket path, its own lifecycle and its own accept loop; only the bind
//! is shared.

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
    // into place. `UnixListener::bind` creates the socket node with umask-default
    // perms, so a bind-at-`path`-then-chmod sequence leaves a window where a
    // same-host peer could connect before the chmod lands (the bind→chmod
    // TOCTOU). Binding at a temp name closes it deterministically: a client
    // connects via `path`, which only ever appears already at 0600 — the rename
    // preserves the inode's perms, and the bound listener fd keeps serving across
    // the rename (the pathname is just the rendezvous address).
    let tmp = path.with_extension("sock.tmp");
    let _ = std::fs::remove_file(&tmp);
    // A stale socket / non-socket anomaly at the final path (previous unclean
    // exit) — remove it so the rename can replace it (the app owns its
    // app_data_dir).
    let _ = std::fs::remove_file(path);
    let listener = std::os::unix::net::UnixListener::bind(&tmp)?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    std::fs::rename(&tmp, path)?;
    Ok(listener)
}
