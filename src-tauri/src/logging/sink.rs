// SPDX-License-Identifier: AGPL-3.0-only
//! The rotating file writer behind the diagnostic log (myne-md/myne#860).
//!
//! # Why this is hand-rolled rather than `tracing-appender`
//!
//! `tracing-appender` rotates on TIME (`RollingFileAppender`), and this feature
//! is bounded by SIZE: the threat model carries one number for the whole
//! footprint, and a time-based rotation turns that number into a function of how
//! long the user left the toggle on. A size-based rotation with a retained-file
//! count gives a constant ceiling, so `docs/threat-model.md` §7 can state a
//! figure instead of a proportionality argument.
//!
//! # The three things this module must guarantee
//!
//! 1. **Nothing is written while the toggle is off.** The writer holds no open
//!    file and `write_bytes` returns before touching the disk, so "off" is a
//!    state on disk and not only a state in the UI. Turning it off drops the
//!    handle; it does NOT erase (that is the erase pass, which the toggle's own
//!    command runs, and the split is deliberate: this module cannot reach the
//!    plugin's error type, and erasing is a user-visible action with its own
//!    failure surface).
//! 2. **Every file, including each rotated one, opens with a header record**
//!    naming the build. A log can leave the app on its own through
//!    `Reveal logs folder`, and a log with no build identity is a file of stages
//!    and durations that nobody can act on. The header is written by THIS
//!    module rather than emitted as a `tracing` record, which makes "the level
//!    filter cannot drop it" structural instead of a placement convention.
//! 3. **It never panics.** A panic in the logging path is a panic loop: the
//!    desktop panic hook writes a crash record, and the sink is what a
//!    subscriber does next. Every failure here drops the record and, where it
//!    matters, leaves the sink disabled.
//!
//! # What the header cannot carry, and why
//!
//! `version` and `channel` are host-readable at compile time. `commit` and
//! `bundleHash` are not: on the desktop they are Vite defines compiled into the
//! WebView bundle (`__BUILD_COMMIT__`, and the hash is an OUTPUT of the bundle
//! build, so a bundle cannot contain its own). A bare log therefore names the
//! version and the channel, and the two remaining identity fields arrive with
//! the nine-field block in the report bundle. Closing that gap means emitting a
//! `cargo:rustc-env` commit define from `build.rs` the way Vite does it, which
//! is its own change and is recorded as owed rather than half-done here.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// The active log file's name inside the log directory.
pub const LOG_FILE_NAME: &str = "myne.log";

/// How much one log file may hold before it rotates.
///
/// A ROTATION THRESHOLD, not a hard per-file cap: the test is taken before a
/// record is written, so one record larger than this lands whole in a freshly
/// rotated file and that file exceeds the figure. `docs/threat-model.md` §7 says
/// "threshold" for the same reason, because the published number has to be the
/// one the code enforces.
///
/// One mebibyte holds several thousand `info`-level records; the figure is
/// confirmed against a measured representative record by this module's own tests
/// rather than asserted.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;

/// How many files are retained: the active one plus its rotations.
pub const RETAINED_FILES: usize = 3;

/// The header's format generation, so a future reader can tell which layout it
/// is parsing without guessing from the field set.
pub const LOG_FORMAT: u32 = 1;

/// The build's update channel, from the one place that resolves it.
///
/// This used to be a private copy of the same `match` `plugins::update` kept,
/// which is the shape where a channel added to one of them and not the other
/// disagrees silently: the log names a channel the client is not fetching.
/// `crate::update::Channel::from_env` is the single reader now.
fn channel() -> &'static str {
    crate::update::Channel::from_env().as_str()
}

/// The header record, as it is written at the top of every log file.
///
/// Pure, so a test can assert its contents without touching a disk. `# ` prefixed
/// so a reader grepping a log for `^#` gets the metadata and nothing else.
pub fn header_bytes() -> Vec<u8> {
    format!(
        "# myne diagnostic log\n\
         # log_format: {LOG_FORMAT}\n\
         # version: {}\n\
         # channel: {}\n\
         # platform: {}\n\
         # max_file_bytes: {MAX_FILE_BYTES}\n\
         # retained_files: {RETAINED_FILES}\n",
        env!("CARGO_PKG_VERSION"),
        channel(),
        std::env::consts::OS,
    )
    .into_bytes()
}

/// The file the sink appends to, and everything that decides when it rotates.
///
/// One of these lives for the process, behind an `Arc`: the subscriber can only
/// be installed once, so the sink has to be able to turn itself on and off in
/// place rather than being re-created.
pub struct LogSink {
    dir: PathBuf,
    max_file_bytes: u64,
    retained_files: usize,
    enabled: AtomicBool,
    /// The open active file, or `None` while the toggle is off.
    current: Mutex<Option<File>>,
    /// The active file's size in bytes, kept beside the handle so a rotation
    /// decision costs no `stat`.
    bytes: AtomicU64,
}

impl LogSink {
    /// A sink for `dir`, off unless `enabled`.
    ///
    /// Does not touch the disk: the file is created on the first write, so a
    /// device that enables logging and then produces no `info`-level record
    /// leaves no file behind. That is the same posture the flag itself has.
    pub fn new(dir: PathBuf, enabled: bool) -> Self {
        Self {
            dir,
            max_file_bytes: MAX_FILE_BYTES,
            retained_files: RETAINED_FILES,
            enabled: AtomicBool::new(enabled),
            current: Mutex::new(None),
            bytes: AtomicU64::new(0),
        }
    }

    /// A sink with test-sized bounds.
    #[cfg(test)]
    fn with_limits(dir: PathBuf, max_file_bytes: u64, retained_files: usize) -> Self {
        let sink = Self::new(dir, true);
        Self {
            max_file_bytes,
            retained_files,
            ..sink
        }
    }

    /// The directory this sink writes into.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// How many rotated files this sink keeps, so a reader can bound its own
    /// walk over them rather than stopping at the first absent index.
    pub fn retained_files(&self) -> usize {
        self.retained_files
    }

    /// Whether the sink is currently writing.
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Turn the sink on or off.
    ///
    /// Turning it on is lazy: it marks the sink live and leaves the file to the
    /// first write. Turning it off drops the handle, so the next write returns
    /// before touching the disk. It deliberately does not erase; see the module
    /// doc.
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
        if !enabled {
            if let Ok(mut guard) = self.current.lock() {
                if let Some(mut file) = guard.take() {
                    let _ = file.flush();
                }
            }
            self.bytes.store(0, Ordering::Relaxed);
        }
    }

    /// Append one already-formatted record.
    ///
    /// Never fails loudly and never panics: a sink that cannot write drops the
    /// record. The alternative (surfacing an error) has no consumer inside a
    /// `tracing` subscriber, and would have to be a panic to be noticed at all.
    pub fn write_bytes(&self, buf: &[u8]) {
        if !self.is_enabled() {
            return;
        }
        let Ok(mut guard) = self.current.lock() else {
            return;
        };
        // Re-checked UNDER the lock, which is what makes "off" hold. The
        // unlocked check above is an optimisation; without this second one a
        // caller that passed it before `set_enabled(false)` could take the lock
        // after the toggle-off path had erased the log and re-create the file,
        // so a record would land after the user was told logging was off.
        if !self.is_enabled() {
            return;
        }
        if guard.is_none() {
            match self.open_current() {
                Ok(file) => *guard = Some(file),
                Err(_) => return,
            }
        }
        // Rotation is done IN PLACE under this one guard. An earlier revision
        // dropped the `File` and then re-acquired `self.current` to reopen it
        // while this `MutexGuard` was still alive; `std::sync::Mutex` is not
        // reentrant, so the first record past the cap self-deadlocked the sink
        // WHILE HOLDING the mutex, and every later `tracing` call in the process
        // then blocked behind it.
        if self.bytes.load(Ordering::Relaxed) + buf.len() as u64 > self.max_file_bytes {
            *guard = None;
            if self.rotate().is_err() {
                return;
            }
            match self.open_current() {
                Ok(file) => *guard = Some(file),
                Err(_) => return,
            }
        }
        if let Some(file) = guard.as_mut() {
            if file.write_all(buf).is_ok() {
                self.bytes.fetch_add(buf.len() as u64, Ordering::Relaxed);
            }
        }
    }

    /// Create the log directory (owner-only) and open the active file for
    /// append, writing the header when the file is new or empty.
    fn open_current(&self) -> std::io::Result<File> {
        prepare_dir(&self.dir)?;
        let path = self.dir.join(LOG_FILE_NAME);
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // At CREATE time, not after: the failure being prevented is a
            // window in which the file exists with the default mode. `0600`
            // carries no group or other bits for umask to strip, so this is
            // stable under any umask, and a chmod afterwards is not equivalent.
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        let existing = file.metadata().map(|m| m.len()).unwrap_or(0);
        if existing == 0 {
            let header = header_bytes();
            file.write_all(&header)?;
            file.flush()?;
            self.bytes.store(header.len() as u64, Ordering::Relaxed);
        } else {
            self.bytes.store(existing, Ordering::Relaxed);
        }
        Ok(file)
    }

    /// Shift the rotations and drop the oldest, then let the caller re-open.
    ///
    /// Called with the active file already closed and the sink's mutex HELD.
    /// Oldest first, so a failure partway through leaves fewer files rather than
    /// a half-shifted set. It must never take that mutex itself: `std::sync::Mutex`
    /// is not reentrant, and an earlier revision deadlocked here on the first
    /// record past the cap.
    fn rotate(&self) -> std::io::Result<()> {
        // `saturating_sub` and an explicit floor rather than `- 1`: the retained
        // count is a FIELD, not a const, and a zero or one would otherwise
        // underflow (a panic in the logging path is a panic loop) or leave the
        // active file in place with the byte counter reset, so it would grow
        // unbounded past the cap. Unreachable through `LogSink::new`, which
        // hardcodes three, which is exactly why it is asserted here rather than
        // left resting on a call convention.
        if self.retained_files < 2 {
            return Ok(());
        }
        let oldest = self.rotation_path(self.retained_files - 1);
        if oldest.exists() {
            std::fs::remove_file(&oldest)?;
        }
        for index in (1..self.retained_files.saturating_sub(1)).rev() {
            let from = self.rotation_path(index);
            if from.exists() {
                std::fs::rename(&from, self.rotation_path(index + 1))?;
            }
        }
        let active = self.dir.join(LOG_FILE_NAME);
        if active.exists() {
            std::fs::rename(&active, self.rotation_path(1))?;
        }
        self.bytes.store(0, Ordering::Relaxed);
        Ok(())
    }

    /// Remove the active log and every rotated file.
    ///
    /// This is the erase half of turning the toggle off, and it is deliberately
    /// narrow: the CRASH RECORD is not a log file and is not touched. That is
    /// the one exception the feature's own rule admits (the sink is inert while
    /// off, and the crash record is host-written, bounded to one file and
    /// payload-free), so an erase that swept the directory would delete an
    /// artefact the feature promised to keep.
    ///
    /// Also deliberately synchronous rather than deferred to the next launch: a
    /// deferred erase loses to a kill, and the point of the erase is that
    /// withdrawing consent withdraws the data.
    pub fn erase_log_files(&self) -> std::io::Result<()> {
        // Attempt every removal and treat `NotFound` as success, rather than
        // guarding each one on `Path::exists()`. `exists()` answers `false` on
        // any I/O error, so a guarded remove reports `Ok` for a path it never
        // actually looked at, and the plaintext survives the erase on the one
        // path where surviving is the whole defect. The loop also keeps going
        // after a failure, because one unremovable rotation must not spare the
        // files behind it, and the first error is returned at the end so the
        // partial erasure is an error rather than a silence.
        let mut first_error: Option<std::io::Error> = None;
        let paths = std::iter::once(self.dir.join(LOG_FILE_NAME))
            .chain((1..=self.retained_files).map(|index| self.rotation_path(index)));
        for path in paths {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    if first_error.is_none() {
                        first_error = Some(e);
                    }
                }
            }
        }
        self.bytes.store(0, Ordering::Relaxed);
        match first_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    /// `<dir>/myne.log.<index>`.
    fn rotation_path(&self, index: usize) -> PathBuf {
        self.dir.join(format!("{LOG_FILE_NAME}.{index}"))
    }
}

/// Create `dir` if needed and hold it owner-only.
#[cfg(unix)]
pub(crate) fn prepare_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    // Defence in depth beside the per-file `0600`: a `0700` directory blocks
    // other local users from traversing into it at all, and it covers the
    // rotated files and the crash record without a per-file rule. It does not
    // replace the file mode, because the protection does not travel with the
    // file on a copy out of the directory.
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Create `dir` if needed.
///
/// Windows has no file modes; the directory sits under the user profile
/// (`%LOCALAPPDATA%`) and inherits its ACL, which is stated rather than implied.
#[cfg(not(unix))]
pub(crate) fn prepare_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// The `MakeWriter` the file layer is built with.
#[derive(Clone)]
pub struct SinkMaker {
    sink: Arc<LogSink>,
}

impl SinkMaker {
    /// Wrap a sink for `tracing_subscriber`'s file layer.
    pub fn new(sink: Arc<LogSink>) -> Self {
        Self { sink }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SinkMaker {
    type Writer = SinkWriter;
    fn make_writer(&'a self) -> Self::Writer {
        SinkWriter {
            sink: Arc::clone(&self.sink),
        }
    }
}

/// One record's writer. Writes whole buffers and cannot fail, so the layer above
/// never has to handle an error it has nowhere to put.
pub struct SinkWriter {
    sink: Arc<LogSink>,
}

impl Write for SinkWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.sink.write_bytes(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if let Ok(guard) = self.sink.current.lock() {
            if let Some(file) = guard.as_ref() {
                let _ = (&*file).flush();
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).expect("read log")
    }

    #[test]
    fn nothing_is_written_while_disabled_and_no_file_appears() {
        let dir = ScopedTempDir::new("log-sink-off").expect("tempdir");
        let sink = LogSink::new(dir.path().join("logs"), false);

        sink.write_bytes(b"INFO myne_core: should not land\n");

        assert!(!sink.dir().join(LOG_FILE_NAME).exists());
    }

    #[test]
    fn enabling_creates_the_file_with_the_header_then_the_records() {
        let dir = ScopedTempDir::new("log-sink-on").expect("tempdir");
        let sink = LogSink::new(dir.path().join("logs"), true);

        sink.write_bytes(b"INFO myne_core: event=\"vault_unlocked\"\n");

        let body = read(&sink.dir().join(LOG_FILE_NAME));
        assert!(body.starts_with("# myne diagnostic log\n"));
        assert!(body.contains("INFO myne_core: event=\"vault_unlocked\""));
    }

    #[test]
    fn turning_it_off_stops_writing_without_erasing() {
        let dir = ScopedTempDir::new("log-sink-toggle").expect("tempdir");
        let sink = LogSink::new(dir.path().join("logs"), true);

        sink.write_bytes(b"INFO first\n");
        sink.set_enabled(false);
        sink.write_bytes(b"INFO second\n");

        let body = read(&sink.dir().join(LOG_FILE_NAME));
        assert!(body.contains("INFO first"));
        assert!(
            !body.contains("INFO second"),
            "a record written while off must not land"
        );
        assert!(
            sink.dir().join(LOG_FILE_NAME).exists(),
            "off stops writing; erasing is the toggle command's job"
        );
    }

    #[test]
    fn a_rotated_file_carries_the_header_too() {
        // Test-sized bounds, because the shipped cap is a mebibyte and a test
        // that filled it would be a test nobody runs.
        let dir = ScopedTempDir::new("log-sink-rotate-header").expect("tempdir");
        let header_len = header_bytes().len() as u64;
        let sink = LogSink::with_limits(dir.path().join("logs"), header_len + 64, 3);

        sink.write_bytes(&[b'a'; 60]);
        sink.write_bytes(&[b'b'; 60]);

        let rotated = read(&sink.dir().join(format!("{LOG_FILE_NAME}.1")));
        assert!(
            rotated.starts_with("# myne diagnostic log\n"),
            "a rotated file is a log file and is self-identifying like the active one"
        );
        assert!(rotated.contains("aaaaaaaa"));
    }

    #[test]
    fn rotation_drops_the_oldest_file_first() {
        let dir = ScopedTempDir::new("log-sink-rotate-order").expect("tempdir");
        let header_len = header_bytes().len() as u64;
        // Two retained files, each holding the header plus one 60-byte record.
        let sink = LogSink::with_limits(dir.path().join("logs"), header_len + 64, 2);

        // Three records across a two-file window: the first must be evicted.
        sink.write_bytes(&[b'a'; 60]);
        sink.write_bytes(&[b'b'; 60]);
        sink.write_bytes(&[b'c'; 60]);

        let one = read(&sink.dir().join(format!("{LOG_FILE_NAME}.1")));
        let active = read(&sink.dir().join(LOG_FILE_NAME));
        assert!(
            !sink.dir().join(format!("{LOG_FILE_NAME}.2")).exists(),
            "two retained files means no third slot"
        );
        assert!(
            one.contains("bbbbbbbb"),
            "the previous active file rotated in"
        );
        assert!(
            active.contains("cccccccc"),
            "the newest record is in the active file"
        );
        assert!(
            !one.contains("aaaaaaaa") && !active.contains("aaaaaaaa"),
            "the oldest record is gone, evicted before its neighbours"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_owner_only_from_creation_and_the_directory_from_its_own() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScopedTempDir::new("log-sink-perms").expect("tempdir");
        let sink = LogSink::new(dir.path().join("logs"), true);
        sink.write_bytes(b"INFO first\n");

        let file_mode = std::fs::metadata(sink.dir().join(LOG_FILE_NAME))
            .expect("stat file")
            .permissions()
            .mode()
            & 0o777;
        let dir_mode = std::fs::metadata(sink.dir())
            .expect("stat dir")
            .permissions()
            .mode()
            & 0o777;

        assert_eq!(file_mode, 0o600, "the log file is owner-only");
        assert_eq!(dir_mode, 0o700, "the log directory is owner-only");
    }

    #[test]
    fn the_header_names_the_build_identity_it_can_actually_read() {
        let header = String::from_utf8(header_bytes()).expect("utf8");
        assert!(header.contains(&format!("# log_format: {LOG_FORMAT}\n")));
        assert!(header.contains(&format!("# version: {}\n", env!("CARGO_PKG_VERSION"))));
        assert!(header.contains(&format!("# platform: {}\n", std::env::consts::OS)));
        assert!(
            header.contains("# channel: stable\n") || header.contains("# channel: beta\n"),
            "the channel must be one of the two the updater itself matches on"
        );
    }

    #[test]
    fn the_erase_removes_every_log_file_and_leaves_the_crash_record() {
        let dir = ScopedTempDir::new("log-sink-erase").expect("tempdir");
        let header_len = header_bytes().len() as u64;
        let sink = LogSink::with_limits(dir.path().join("logs"), header_len + 64, 3);

        sink.write_bytes(&[b'a'; 60]);
        sink.write_bytes(&[b'b'; 60]);
        // The crash record is a sibling, not a log file: the erase must leave it.
        std::fs::write(sink.dir().join("crash.log"), b"# myne crash record\n")
            .expect("seed crash record");
        assert!(sink.dir().join(format!("{LOG_FILE_NAME}.1")).exists());

        sink.set_enabled(false);
        sink.erase_log_files().expect("erase");

        assert!(
            !sink.dir().join(LOG_FILE_NAME).exists(),
            "active log is gone"
        );
        assert!(
            !sink.dir().join(format!("{LOG_FILE_NAME}.1")).exists(),
            "the rotated back-catalogue is gone too"
        );
        assert!(
            sink.dir().join("crash.log").exists(),
            "the crash record is not a log file and survives the erase"
        );
    }

    #[test]
    fn the_erase_is_idempotent_and_does_not_depend_on_exists() {
        // The boot reconcile runs the erase on a directory that may already be
        // empty, and a repeat has to be `Ok` rather than an error about a file
        // that is not there (myne#860 review). It also pins that the erase no
        // longer guards each removal on `Path::exists()`, which answers `false`
        // on any I/O error and so reported `Ok` for a path it never looked at.
        let dir = ScopedTempDir::new("log-sink-erase-idempotent").expect("tempdir");
        let header_len = header_bytes().len() as u64;
        let sink = LogSink::with_limits(dir.path().join("logs"), header_len + 64, 3);

        sink.set_enabled(false);
        sink.erase_log_files()
            .expect("erase on a directory with nothing in it");
        sink.erase_log_files().expect("erase again");
    }

    #[test]
    fn rotation_completes_rather_than_deadlocking_the_sink() {
        // A BOUNDED regression test, and the bound is the point. The bug this
        // pins was a self-deadlock: `write_bytes` dropped the `File`, then
        // re-acquired `self.current` to reopen it while the first `MutexGuard`
        // was still alive, and `std::sync::Mutex` is not reentrant. The two
        // rotation tests below would have caught it by HANGING, which is worse
        // than failing: a hang inside `cargo test` blocks pre-push and CI with no
        // output, and the failure that produced it was an entire suite that
        // never ran while the tree looked green.
        //
        // So this one runs the write on a worker thread and waits with a
        // timeout. A reintroduced deadlock fails here in two seconds.
        let dir = ScopedTempDir::new("log-sink-rotate-deadlock").expect("tempdir");
        let header_len = header_bytes().len() as u64;
        let sink = std::sync::Arc::new(LogSink::with_limits(
            dir.path().join("logs"),
            header_len + 64,
            3,
        ));
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = {
            let sink = std::sync::Arc::clone(&sink);
            std::thread::spawn(move || {
                // First write opens the file; the second crosses the cap and
                // therefore rotates.
                sink.write_bytes(&[b'a'; 60]);
                sink.write_bytes(&[b'b'; 60]);
                let _ = tx.send(());
            })
        };
        let finished = rx.recv_timeout(std::time::Duration::from_secs(2));
        assert!(
            finished.is_ok(),
            "write_bytes did not return within 2s: the sink holds its own mutex \
             across a re-acquire, so rotation self-deadlocks the logging thread"
        );
        worker.join().expect("the sink worker must not panic");
        assert!(sink.dir().join(format!("{LOG_FILE_NAME}.1")).exists());
    }

    #[test]
    fn the_cap_holds_thousands_of_measured_records_and_not_a_handful() {
        // The ceiling is only meaningful against a record size, and the honest
        // way to state it is to MEASURE one. Format a representative record
        // through the same `fmt` layer the file uses, then hold the cap to a
        // floor derived from it. A cap that held a hundred records would make
        // the "history before the crash" half of this feature a fiction.
        let buf = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));
        {
            let sink = std::sync::Arc::clone(&buf);
            let writer = RecordingWriter(sink);
            let subscriber = tracing_subscriber::fmt()
                .with_writer(writer)
                .with_ansi(false)
                .with_target(true)
                .finish();
            tracing::subscriber::with_default(subscriber, || {
                tracing::info!(event = "vault_unlocked", "a representative record");
            });
        }
        let record_bytes = buf.lock().expect("buffer").len() as u64;
        assert!(record_bytes > 0, "the measurement must observe a record");

        let records_per_file = (MAX_FILE_BYTES - header_bytes().len() as u64) / record_bytes;
        assert!(
            records_per_file >= 2000,
            "the cap holds only {records_per_file} records of {record_bytes} bytes; \
             raise MAX_FILE_BYTES or accept that the log loses the run-up to a crash"
        );
    }

    #[derive(Clone, Default)]
    struct RecordingWriter(std::sync::Arc<Mutex<Vec<u8>>>);

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("buffer").extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RecordingWriter {
        type Writer = RecordingWriter;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }
}
