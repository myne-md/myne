//! Native-messaging host-manifest **install wiring** (TB10).
//!
//! [`super::manifest`] GENERATES the per-browser native-host manifest JSON; this
//! module WRITES it to the per-OS `NativeMessagingHosts/` directories the browser
//! reads, so the keyless clipper extension can launch the desktop host with **zero
//! hand-created files**. It is the "thin per-OS file write the desktop installer
//! runs" the manifest module's docs referred to.
//!
//! ## Reconcile model (idempotent, best-effort)
//!
//! One entry point, [`reconcile_from_flag`], is called on every app startup
//! (`lib.rs` `.setup`) next to the relay listener — the SAME best-effort,
//! non-fatal discipline as the boot migration and the relay bind: a failure logs
//! a bounded event and the app still starts. The Settings toggle drives the same
//! reconcile immediately via [`set_enabled`].
//!
//! - **enabled** → write the launcher wrapper (see below), then for each
//!   supported browser whose base profile dir already exists, write the
//!   dialect-correct manifest (`allowed_extensions` for Firefox, `allowed_origins`
//!   for Chrome/Edge) to its `NativeMessagingHosts/` path. A browser that has
//!   never run (no base dir) is skipped, so we never scatter empty dirs; the next
//!   startup re-reconciles, so installing a browser later self-heals. Writes are
//!   write-if-changed to avoid needless churn.
//! - **disabled** → remove any manifest we previously wrote (best-effort).
//!
//! ## The launcher wrapper (why the manifest `path` is not the raw binary)
//!
//! A browser launches the manifest's `path` with ITS OWN args (the extension id /
//! `chrome-extension://` origin) and **cannot** pass
//! [`super::host::NATIVE_MESSAGING_ARG`] — the flag that selects host mode. So the
//! `path` points at a tiny wrapper (`<app_data_dir>/clipper-native-host`) that
//! `exec`s the real binary WITH that flag; pointing it at the raw binary would
//! boot the full app (single-instance) instead of the stdio host, and the browser
//! would see no native-messaging reply. The wrapper is rewritten every reconcile
//! so its target tracks the current binary (dev ↔ prod).
//!
//! ## The opt-in flag
//!
//! A per-install plaintext flag `<app_data_dir>/clipper-install.json` =
//! `{ "enabled": bool }`. It must be readable at BOOT — before any vault unlock —
//! so it cannot live in the vault-scoped `vault.prefs`; it follows the
//! `registry.json` / `backup-schedule.json` precedent (a small non-secret,
//! non-vault JSON written with plain `std::fs`). **Absent ⇒ disabled** (MYND-549:
//! privacy-preserving default — no native-messaging host is registered until the
//! user opts in); the Settings toggle writes `{ "enabled": true }` to opt in (the
//! reconcile then installs the manifests) or `{ "enabled": false }` to opt back
//! out (the reconcile removes them).
//!
//! ## Not a crypto site
//!
//! The manifest carries no secret — a host name, a binary path, public extension
//! IDs; it is config, not key material. Per `src-tauri/AGENTS.md`
//! "Secret-handling logging discipline" we still keep full paths out of logs (a
//! host path can leak the OS username): logs carry a `stage` tag + browser label +
//! the closed `io_failure_kind` only.
//!
//! ## Windows
//!
//! macOS + Linux write files (below). Windows registers the host through a HKCU
//! registry key instead of a file — a documented fast-follow; [`resolve_targets`]
//! returns empty there today, so [`reconcile_from_flag`] is a logged no-op on
//! Windows (the app still starts).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::manifest;

/// The per-install opt-in flag file name (under `<app_data_dir>`).
const FLAG_FILE_NAME: &str = "clipper-install.json";

/// The launcher-wrapper file name (under `<app_data_dir>`). The native-host
/// manifest's `path` points at THIS, not the raw binary: a browser launches the
/// `path` with ITS OWN args (extension id / origin) and cannot pass
/// [`super::host::NATIVE_MESSAGING_ARG`], so the raw binary would boot the full
/// app instead of the stdio host. The wrapper `exec`s the binary WITH the flag,
/// which is what selects host mode (`host.rs` — "the manifest's `path` wrapper
/// passes" the flag).
const WRAPPER_FILE_NAME: &str = "clipper-native-host";

/// The manifest file name the browser reads, keyed by the host name
/// (`md.myne.clipper.json`).
fn manifest_file_name() -> String {
    format!("{}.json", manifest::HOST_NAME)
}

/// A supported browser family.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Browser {
    Firefox,
    Chrome,
    Edge,
}

impl Browser {
    /// Stable lowercase label for logging + the status surface (never a path).
    fn label(self) -> &'static str {
        match self {
            Browser::Firefox => "firefox",
            Browser::Chrome => "chrome",
            Browser::Edge => "edge",
        }
    }
}

/// One browser's install target: where to probe for the browser's presence
/// (`base_dir`) and where its native-host manifest goes (`manifest_dir`).
struct BrowserTarget {
    browser: Browser,
    base_dir: PathBuf,
    manifest_dir: PathBuf,
}

impl BrowserTarget {
    fn manifest_path(&self) -> PathBuf {
        self.manifest_dir.join(manifest_file_name())
    }

    /// The dialect-correct manifest JSON for this browser. Firefox gets the
    /// `allowed_extensions` (gecko-id) dialect; Chrome/Edge get the
    /// `allowed_origins` (chrome-extension://) dialect — a Firefox strict parse
    /// rejects an unknown `allowed_origins` key, so the split is load-bearing.
    fn manifest_json(&self, host_path: &str) -> serde_json::Result<String> {
        match self.browser {
            Browser::Firefox => manifest::firefox_manifest_json(host_path),
            Browser::Chrome | Browser::Edge => {
                manifest::chromium_manifest_json(host_path, manifest::CHROMIUM_EXTENSION_ID)
            }
        }
    }
}

/// Resolve the current browser install targets for this OS from the environment
/// (`$HOME`, `$XDG_CONFIG_HOME`) — no `dirs` crate (the `host_mode_app_data_dir`
/// idiom). Windows returns empty for now (registry fast-follow).
#[cfg(target_os = "macos")]
fn resolve_targets() -> Vec<BrowserTarget> {
    match std::env::var_os("HOME") {
        Some(home) => macos_targets(Path::new(&home)),
        None => Vec::new(),
    }
}

/// macOS targets under `~/Library/Application Support/`. Split out so tests can
/// drive the layout against a temp `home`.
#[cfg(target_os = "macos")]
fn macos_targets(home: &Path) -> Vec<BrowserTarget> {
    let app_support = home.join("Library").join("Application Support");
    let target = |browser: Browser, base: PathBuf| BrowserTarget {
        browser,
        manifest_dir: base.join("NativeMessagingHosts"),
        base_dir: base,
    };
    vec![
        target(Browser::Firefox, app_support.join("Mozilla")),
        target(Browser::Chrome, app_support.join("Google").join("Chrome")),
        target(Browser::Edge, app_support.join("Microsoft Edge")),
    ]
}

#[cfg(all(unix, not(target_os = "macos")))]
fn resolve_targets() -> Vec<BrowserTarget> {
    let home = match std::env::var_os("HOME") {
        Some(h) => PathBuf::from(h),
        None => return Vec::new(),
    };
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    linux_targets(&home, &config)
}

/// Linux targets. Firefox lives under `~/.mozilla`; Chrome/Edge under the XDG
/// config dir. Split out so tests can drive the layout against temp roots.
#[cfg(all(unix, not(target_os = "macos")))]
fn linux_targets(home: &Path, config: &Path) -> Vec<BrowserTarget> {
    let mozilla = home.join(".mozilla");
    let chrome = config.join("google-chrome");
    let edge = config.join("microsoft-edge");
    vec![
        BrowserTarget {
            browser: Browser::Firefox,
            manifest_dir: mozilla.join("native-messaging-hosts"),
            base_dir: mozilla,
        },
        BrowserTarget {
            browser: Browser::Chrome,
            manifest_dir: chrome.join("NativeMessagingHosts"),
            base_dir: chrome,
        },
        BrowserTarget {
            browser: Browser::Edge,
            manifest_dir: edge.join("NativeMessagingHosts"),
            base_dir: edge,
        },
    ]
}

/// Windows: registry-based registration is a documented fast-follow; no file
/// targets yet (the app still starts — reconcile is a logged no-op).
#[cfg(windows)]
fn resolve_targets() -> Vec<BrowserTarget> {
    Vec::new()
}

/// The absolute path to the currently-running Myne binary. `None` if it cannot
/// be resolved. The manifest never points here directly — see [`write_wrapper`].
fn real_binary_path() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    // Canonicalize to resolve symlinks (best-effort — keep the raw path if the
    // canonical form is unavailable).
    let resolved = std::fs::canonicalize(&exe).unwrap_or(exe);
    resolved.into_os_string().into_string().ok()
}

/// Write the launcher wrapper (the manifest's `path` target) and return its
/// path. The wrapper `exec`s the real binary WITH [`super::host::NATIVE_MESSAGING_ARG`]
/// — the flag a browser cannot pass itself but that selects host mode — and
/// forwards the browser's own args harmlessly. Rewritten every reconcile so the
/// path always tracks the current binary (dev ↔ prod).
#[cfg(unix)]
fn write_wrapper(app_data_dir: &Path, real_binary: &str) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(app_data_dir)?;
    let path = app_data_dir.join(WRAPPER_FILE_NAME);
    // `exec '<bin>' --native-messaging-host "$@"` — the binary path is POSIX
    // SINGLE-quoted (myne#381). This used to use double quotes with a comment
    // saying they "tolerate spaces", which was true and beside the point: inside
    // `sh` double quotes `$`, `` ` `` and `\` stay active, so a `current_exe()`
    // path containing `$(…)`, a backtick, a `"` or a trailing `\` was not
    // mis-parsed but EVALUATED — by a shell the browser spawns, unattended, on
    // every native-messaging connection. `crate::sh_quote` is the same helper
    // the CLI PATH shim has always used for the same value.
    //
    // `NATIVE_MESSAGING_ARG` is a constant and needs no quoting; `"$@"` must
    // stay double-quoted — that expansion is what forwards the browser's
    // extension-id / origin args (host mode ignores them) as separate words.
    let script = format!(
        "#!/bin/sh\nexec {} {} \"$@\"\n",
        crate::sh_quote::sh_single_quote(real_binary),
        super::host::NATIVE_MESSAGING_ARG,
    );
    std::fs::write(&path, script.as_bytes())?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    Ok(path)
}

/// Windows registration is a fast-follow; no wrapper is produced there yet.
#[cfg(windows)]
fn write_wrapper(_app_data_dir: &Path, real_binary: &str) -> std::io::Result<PathBuf> {
    Ok(PathBuf::from(real_binary))
}

/// Install (write) the manifest for one browser, ONLY if the browser's base
/// profile dir already exists. Write-if-changed. Best-effort + bounded logging.
fn install_one(target: &BrowserTarget, host_path: &str) {
    if !target.base_dir.exists() {
        return; // browser not present — don't scatter a dir for it
    }
    let json = match target.manifest_json(host_path) {
        Ok(j) => j,
        Err(_) => {
            tracing::error!(
                stage = "clipper_install_serialize",
                browser = target.browser.label()
            );
            return;
        }
    };
    let bytes = json.into_bytes();
    let path = target.manifest_path();
    // Skip a no-op rewrite (avoid needless churn in the user's browser dir).
    if std::fs::read(&path)
        .map(|cur| cur == bytes)
        .unwrap_or(false)
    {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(&target.manifest_dir) {
        let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
        tracing::error!(
            stage = "clipper_install_mkdir",
            browser = target.browser.label(),
            io_failure_kind = ?kind
        );
        return;
    }
    // A user-owned directory (the browser profile) — `atomic_write_unclobbered`
    // is the repo's idiomatic write for exactly this case (randomized temp, never
    // clobbers a stray `<name>.tmp`, keeps the vault-artifact `.tmp` name out).
    if let Err(e) = crate::atomic_write::atomic_write_unclobbered(&path, &bytes, true) {
        let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
        tracing::error!(
            stage = "clipper_install_write",
            browser = target.browser.label(),
            io_failure_kind = ?kind
        );
        return;
    }
    tracing::debug!(
        stage = "clipper_install_write",
        browser = target.browser.label(),
        outcome = "installed"
    );
}

/// Remove a previously-written manifest for one browser (opt-out / disable).
/// A missing file is success; other errors are logged bounded, never fatal.
fn uninstall_one(target: &BrowserTarget) {
    let path = target.manifest_path();
    match std::fs::remove_file(&path) {
        Ok(()) => tracing::debug!(
            stage = "clipper_install_remove",
            browser = target.browser.label(),
            outcome = "removed"
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
            tracing::debug!(
                stage = "clipper_install_remove",
                browser = target.browser.label(),
                io_failure_kind = ?kind
            );
        }
    }
}

/// Drive every target to the desired state. Pure over its inputs (the tests'
/// seam): `host_path` is `None` only on an enable that could not resolve the
/// binary, in which case installs are skipped (removal still runs).
fn reconcile_targets(targets: &[BrowserTarget], enabled: bool, host_path: Option<&str>) {
    for target in targets {
        if enabled {
            if let Some(hp) = host_path {
                install_one(target, hp);
            }
        } else {
            uninstall_one(target);
        }
    }
}

/// Resolve the real OS targets, write the launcher wrapper, and reconcile the
/// per-browser manifests to `enabled`. The manifest `path` points at the wrapper
/// (`<app_data_dir>/clipper-native-host`), NOT the raw binary.
fn reconcile(app_data_dir: &Path, enabled: bool) {
    let targets = resolve_targets();
    if targets.is_empty() {
        return; // Windows today, or a home-less environment — nothing to do.
    }
    if !enabled {
        reconcile_targets(&targets, false, None); // removal needs no path
        return;
    }
    let Some(binary) = real_binary_path() else {
        tracing::error!(stage = "clipper_install_exe", outcome = "binary_unresolved");
        return;
    };
    let wrapper = match write_wrapper(app_data_dir, &binary) {
        Ok(w) => w,
        Err(e) => {
            let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
            tracing::error!(stage = "clipper_install_wrapper", io_failure_kind = ?kind);
            return;
        }
    };
    let Some(wrapper_path) = wrapper.to_str() else {
        tracing::error!(stage = "clipper_install_wrapper", outcome = "path_not_utf8");
        return;
    };
    reconcile_targets(&targets, true, Some(wrapper_path));
}

/// The opt-in flag payload (`<app_data_dir>/clipper-install.json`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct InstallFlag {
    enabled: bool,
}

fn flag_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(FLAG_FILE_NAME)
}

/// Read the opt-in flag. **Absent (or unreadable/malformed) ⇒ `false`** —
/// MYND-549: the clipper ships DISABLED by default (privacy-preserving; no
/// native-messaging host is registered until the user opts in). A flag file
/// written by the Settings toggle is honored verbatim, so a user who explicitly
/// enabled (`{ "enabled": true }`) stays enabled across upgrades. A malformed
/// flag fails closed to disabled.
pub fn read_enabled(app_data_dir: &Path) -> bool {
    match std::fs::read(flag_path(app_data_dir)) {
        Ok(bytes) => serde_json::from_slice::<InstallFlag>(&bytes)
            .map(|f| f.enabled)
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Persist the opt-in flag (plain `std::fs`, like `registry.json`).
fn write_enabled(app_data_dir: &Path, enabled: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(app_data_dir)?;
    let bytes = serde_json::to_vec(&InstallFlag { enabled })
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(flag_path(app_data_dir), bytes)
}

/// The install status surfaced to the Settings toggle: the opt-in flag, the
/// resolved host binary path, and which browsers currently have our manifest.
/// Carries no secret (public host path + browser labels).
#[derive(Debug, Clone, Serialize)]
pub struct InstallStatus {
    /// Whether the clipper host is registered (the opt-in flag; absent ⇒ false).
    pub enabled: bool,
    /// The absolute path the manifest points at (the running binary), if known.
    pub host_path: Option<String>,
    /// Labels of the browsers whose manifest is currently present on disk.
    pub installed_browsers: Vec<String>,
}

/// Compute the current install status (does not mutate anything).
pub fn status(app_data_dir: &Path) -> InstallStatus {
    let installed_browsers = resolve_targets()
        .into_iter()
        .filter(|t| t.manifest_path().exists())
        .map(|t| t.browser.label().to_string())
        .collect();
    InstallStatus {
        enabled: read_enabled(app_data_dir),
        host_path: real_binary_path(),
        installed_browsers,
    }
}

/// Set the opt-in flag and reconcile the on-disk manifests immediately (no
/// restart needed). Returns the resulting status. A flag-write failure is the
/// only hard error; the reconcile itself is best-effort.
pub fn set_enabled(app_data_dir: &Path, enabled: bool) -> std::io::Result<InstallStatus> {
    write_enabled(app_data_dir, enabled)?;
    reconcile(app_data_dir, enabled);
    Ok(status(app_data_dir))
}

/// Startup entry point: read the opt-in flag (default off) and reconcile the
/// on-disk manifests to it. Best-effort + non-fatal — the app starts regardless.
pub fn reconcile_from_flag(app_data_dir: &Path) {
    reconcile(app_data_dir, read_enabled(app_data_dir));
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    const HOST: &str = "/Applications/Myne.app/Contents/MacOS/Myne";

    fn firefox_target(root: &Path) -> BrowserTarget {
        let base = root.join("Mozilla");
        BrowserTarget {
            browser: Browser::Firefox,
            manifest_dir: base.join("NativeMessagingHosts"),
            base_dir: base,
        }
    }

    fn chrome_target(root: &Path) -> BrowserTarget {
        let base = root.join("Google").join("Chrome");
        BrowserTarget {
            browser: Browser::Chrome,
            manifest_dir: base.join("NativeMessagingHosts"),
            base_dir: base,
        }
    }

    fn parse(path: &Path) -> serde_json::Value {
        let bytes = std::fs::read(path).expect("manifest file present");
        serde_json::from_slice(&bytes).expect("valid JSON")
    }

    #[test]
    fn enable_writes_firefox_dialect_where_base_exists() {
        let dir = ScopedTempDir::new("clipper-install-fx").unwrap();
        let fx = firefox_target(dir.path());
        std::fs::create_dir_all(&fx.base_dir).unwrap(); // browser "present"

        reconcile_targets(&[firefox_target(dir.path())], true, Some(HOST));

        let json = parse(&fx.manifest_path());
        assert_eq!(json["name"], "md.myne.clipper");
        assert_eq!(json["type"], "stdio");
        assert_eq!(json["path"], HOST);
        assert_eq!(json["allowed_extensions"][0], "clipper@myne.md");
        // Firefox dialect must NOT carry the Chromium key.
        assert!(json.get("allowed_origins").is_none());
    }

    #[test]
    fn enable_writes_chromium_dialect_with_pinned_origin() {
        let dir = ScopedTempDir::new("clipper-install-cr").unwrap();
        let cr = chrome_target(dir.path());
        std::fs::create_dir_all(&cr.base_dir).unwrap();

        reconcile_targets(&[chrome_target(dir.path())], true, Some(HOST));

        let json = parse(&cr.manifest_path());
        assert_eq!(json["type"], "stdio");
        assert_eq!(
            json["allowed_origins"][0],
            "chrome-extension://ebbbblnjddeockegombcnbiljefmlhbh/"
        );
        // Chromium dialect must NOT carry the Firefox key.
        assert!(json.get("allowed_extensions").is_none());
    }

    #[test]
    fn enable_skips_browser_without_base_dir() {
        let dir = ScopedTempDir::new("clipper-install-skip").unwrap();
        let cr = chrome_target(dir.path()); // base dir deliberately NOT created

        reconcile_targets(&[chrome_target(dir.path())], true, Some(HOST));

        assert!(
            !cr.manifest_path().exists(),
            "must not write for an absent browser"
        );
    }

    #[test]
    fn disable_removes_a_previously_written_manifest() {
        let dir = ScopedTempDir::new("clipper-install-rm").unwrap();
        let fx = firefox_target(dir.path());
        std::fs::create_dir_all(&fx.base_dir).unwrap();

        reconcile_targets(&[firefox_target(dir.path())], true, Some(HOST));
        assert!(fx.manifest_path().exists());

        reconcile_targets(&[firefox_target(dir.path())], false, None);
        assert!(
            !fx.manifest_path().exists(),
            "disable must remove the manifest"
        );
    }

    #[test]
    fn enable_is_idempotent() {
        let dir = ScopedTempDir::new("clipper-install-idem").unwrap();
        let fx = firefox_target(dir.path());
        std::fs::create_dir_all(&fx.base_dir).unwrap();

        reconcile_targets(&[firefox_target(dir.path())], true, Some(HOST));
        let first = std::fs::read(fx.manifest_path()).unwrap();
        reconcile_targets(&[firefox_target(dir.path())], true, Some(HOST));
        let second = std::fs::read(fx.manifest_path()).unwrap();
        assert_eq!(first, second, "second reconcile is a no-op");
    }

    #[test]
    fn flag_absent_defaults_to_disabled() {
        let dir = ScopedTempDir::new("clipper-flag-absent").unwrap();
        assert!(
            !read_enabled(dir.path()),
            "no flag file ⇒ disabled (MYND-549 privacy-preserving default)"
        );
    }

    #[test]
    fn flag_malformed_defaults_to_disabled() {
        let dir = ScopedTempDir::new("clipper-flag-malformed").unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(flag_path(dir.path()), b"not json").unwrap();
        assert!(
            !read_enabled(dir.path()),
            "malformed flag ⇒ fails closed to disabled"
        );
    }

    #[test]
    fn flag_round_trips_disabled_then_enabled() {
        let dir = ScopedTempDir::new("clipper-flag-rt").unwrap();
        write_enabled(dir.path(), false).unwrap();
        assert!(!read_enabled(dir.path()));
        write_enabled(dir.path(), true).unwrap();
        assert!(read_enabled(dir.path()));
    }

    #[test]
    #[cfg(unix)]
    fn wrapper_is_executable_and_launches_binary_in_host_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScopedTempDir::new("clipper-wrapper").unwrap();
        let path = write_wrapper(dir.path(), HOST).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        // The wrapper is what makes the browser-launched binary enter host mode:
        // it execs the real binary WITH the flag the browser can't pass itself.
        assert!(body.starts_with("#!/bin/sh"));
        assert!(body.contains(super::super::host::NATIVE_MESSAGING_ARG));
        assert!(body.contains(HOST));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "wrapper must be executable");
    }

    /// myne#381, mirroring `cli_bridge::path_shim`'s long-standing sibling.
    ///
    /// **This RUNS the wrapper rather than asserting on its text**, and that is
    /// the whole point. The wrapper used to double-quote a `current_exe()`
    /// path, and the test above — `body.contains(HOST)` — passed just as
    /// happily either way. A substring assertion is what let this survive: it
    /// cannot tell an interpolation the shell will expand from one it will not.
    ///
    /// `current_exe()` is not a constant. A user may install the app under a
    /// directory containing `$`, a backtick or a `"`, and the resulting script
    /// is executed by the browser, unattended, on every native-messaging
    /// connection.
    #[test]
    #[cfg(unix)]
    fn a_binary_path_with_shell_metacharacters_is_execed_literally() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScopedTempDir::new("clipper-metachars").unwrap();
        let bundle = dir.path().join("we$ird `dir` \"x\"");
        std::fs::create_dir_all(&bundle).unwrap();

        // A stand-in for the real binary: it reports the args it was handed and
        // exits with a code no shell error would produce by accident.
        let binary = bundle.join("Myne");
        std::fs::write(&binary, b"#!/bin/sh\necho \"args:$*\"\nexit 3\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();

        let wrapper = write_wrapper(dir.path(), binary.to_str().unwrap()).unwrap();
        let out = std::process::Command::new(&wrapper)
            .args(["chrome-extension://abc/"])
            .output()
            .expect("the wrapper must be executable");

        // Under double quotes, `we$ird` expands `$ird` to nothing and the
        // backticks run `dir` as a command — so the exec target is a path that
        // does not exist and the stub never runs.
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            format!("args:{} chrome-extension://abc/", super::super::host::NATIVE_MESSAGING_ARG),
            "the wrapper must exec the real binary with the host flag and forward the browser's args"
        );
        assert_eq!(
            out.status.code(),
            Some(3),
            "the stub's exit code must round-trip, proving IT ran rather than a shell error"
        );
    }
}
