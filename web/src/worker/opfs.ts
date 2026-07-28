// The OPFS filesystem, as `myne-core`'s `VaultIo` seam needs it
// (phase3-web-client task 17).
//
// # Why the storage layer is JavaScript and not Rust
//
// `myne-core` defines the `VaultIo` trait; `web/wasm/src/opfs.rs` implements it
// by calling the functions this module installs on `globalThis`. The actual OPFS
// mechanics live here, in JS, for three reasons:
//
//   1. `myne-core` stays free of JS glue entirely — no `web-sys`, no
//      `wasm-bindgen` for IO. The crate that desktop and mobile compile keeps
//      exactly the dependency graph it has.
//   2. OPFS is an async, handle-based API with no path concept. Expressing its
//      traversal, its per-file exclusive locks and its browser quirks in JS is
//      direct; expressing them through `web-sys` bindings is the same code with
//      a `JsValue` conversion on every line.
//   3. The quirks are browser facts that change with browsers, not protocol
//      facts. They belong on the side of the boundary that ships with the page.
//
// # Why every operation acquires and releases its own handle
//
// `createSyncAccessHandle()` takes an **exclusive lock** on the file. Holding a
// cache of open handles is the obvious optimisation and the obvious source of
// `NoModificationAllowedError`: any second acquisition — a retry, a concurrent
// command, a re-entrant call through a different code path — fails, and fails
// *intermittently*, which is far harder to diagnose than a slow read.
//
// So: acquire, use, `close()` in a `finally`. The measured cost is 0.42 ms/file
// (Safari), 1.21 (Chrome), 2.92 (Firefox) for 4 KiB, linear in file count. That
// is the budget a cache would be spending against, and it is not yet worth the
// failure mode. `core-io-seam-design.md` §7 records this as a decision to revisit
// against a measurement, not a permanent one.
//
// # Logging
//
// None. Paths are note ids and vault-internal names, and every error value here
// crosses into a page whose console is readable by devtools and by any extension
// with devtools access (`src-tauri/CLAUDE.md`, secret-handling logging
// discipline). Errors are reduced to a bounded kind before they leave.

/**
 * The closed failure vocabulary, mirroring `myne-core`'s `IoFailureKind`.
 *
 * Numbers, not strings, because these cross the wasm boundary on every failing
 * call and the Rust side matches on them exhaustively. Kept in lockstep with
 * `core/src/io_failure_kind.rs`; `web/wasm/src/opfs.rs` pins the mapping.
 */
export const IO_KIND = {
  permissionDenied: 0,
  notFound: 1,
  noSpace: 2,
  other: 3,
} as const;

/** Thrown across the boundary; `opfs.rs` reads `.kind` and discards the rest. */
class IoError extends Error {
  readonly kind: number;
  constructor(kind: number) {
    super(`vault io: ${kind}`);
    this.name = "MyneIoError";
    this.kind = kind;
  }
}

/**
 * Map a DOM exception onto the closed kind.
 *
 * Exported for its own test (phase3-web-client task 91). The property under test
 * is that **every** storage-pressure exception name has a DECIDED
 * classification — a condition that reaches the `default` arm has not been
 * decided, it has merely landed somewhere, and the one that matters most
 * (`QuotaExceededError`) would then arrive in Rust as an untyped `Other` on the
 * write path where the user is most likely to lose an edit.
 *
 * `QuotaExceededError` → `noSpace` is the one worth stating: `IoFailureKind`
 * documents `NoSpace` as "the underlying medium ran out of writable bytes —
 * frontend CTA is identical (free up space and retry)", which is exactly what a
 * browser storage quota means. A fifth variant would have split a distinction
 * the user's remedy does not make.
 */
export function classify(e: unknown): IoError {
  const name = (e as { name?: string })?.name ?? "";
  switch (name) {
    case "NotFoundError":
      return new IoError(IO_KIND.notFound);
    case "QuotaExceededError":
      return new IoError(IO_KIND.noSpace);
    // `NoModificationAllowedError` is a file already locked by another sync
    // access handle. Classified as `permissionDenied` rather than `other`
    // because the caller's correct response is the same — stop, do not retry in
    // a loop — and `other` invites a retry.
    case "NotAllowedError":
    case "SecurityError":
    case "NoModificationAllowedError":
      return new IoError(IO_KIND.permissionDenied);
    // A path segment that exists as a file where a directory was expected (or
    // vice versa). A caller bug, not a storage condition.
    case "TypeMismatchError":
      return new IoError(IO_KIND.other);
    // A sync access handle that outlived what it pointed at — the file was
    // removed, or the handle was closed and used again. Classified `other`
    // deliberately rather than `permissionDenied`: the caller's correct response
    // is to RE-ACQUIRE, which is a retry, and `permissionDenied` is the kind
    // that means "stop, do not retry in a loop".
    //
    // Named rather than left to the `default` arm (phase3-web-client task 91),
    // because "every storage-pressure exception has a decided classification" is
    // the property, and a condition that reaches the catch-all has not been
    // decided — it has merely landed somewhere.
    case "InvalidStateError":
      return new IoError(IO_KIND.other);
    default:
      return e instanceof IoError ? e : new IoError(IO_KIND.other);
  }
}

/** Split a `/`-separated path into segments, dropping empties. */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "" && s !== ".");
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory();
}

/**
 * Walk to the directory containing `path`, returning it and the final segment.
 *
 * `create` controls whether missing intermediate directories are made. OPFS has
 * no `mkdir -p`, so this walk IS `create_dir_all`.
 */
async function parentOf(
  path: string,
  create: boolean,
): Promise<[FileSystemDirectoryHandle, string]> {
  const parts = segments(path);
  if (parts.length === 0) throw new IoError(IO_KIND.other);
  let dir = await root();
  for (const part of parts.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return [dir, parts[parts.length - 1]];
}

// ── the operations `VaultIo` needs ──────────────────────────────────────────
/**
 * Acquire a sync access handle, retrying briefly on a stale exclusive lock
 * (phase3-web-client task 82).
 *
 * # The lock this exists to outlive
 *
 * Every operation here acquires and releases its own handle in a `finally`, so a
 * lock cannot leak from an ordinary failure. It CAN leak from an abnormal one:
 * if the Worker dies mid-operation — a wasm panic, an `onerror`, the browser
 * reclaiming it under memory pressure — the `finally` never runs. The browser
 * releases the handle when it tears the agent down, but that release is not
 * instantaneous, and the replacement Worker starts immediately. The first thing
 * it does is read `vault.meta`, against a file the dead instance may still
 * nominally hold.
 *
 * Without this, that race surfaces as an unlock that fails with
 * `NoModificationAllowedError` on a vault that is completely intact — and it
 * fails again on the retry, because the user's retry is faster than the teardown.
 *
 * # Why the retry is BOUNDED, and short
 *
 * A genuinely contended file is a different situation with a different answer:
 * two tabs, which task 21's single-tab Web Lock exists to prevent. If that lock
 * ever fails open, this must surface the contention rather than paper over it —
 * so the budget is ~300 ms total, long enough to outlive a teardown and far too
 * short to hide a second tab.
 *
 * Only `NoModificationAllowedError` is retried. A `NotFoundError` is an absent
 * file and a `QuotaExceededError` is a full store; retrying either would turn a
 * clear answer into a delayed one.
 */
const LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const;

export async function acquireSyncHandle(
  file: FileSystemFileHandle,
): Promise<FileSystemSyncAccessHandle> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await file.createSyncAccessHandle();
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      if (name !== "NoModificationAllowedError" || attempt >= LOCK_RETRY_DELAYS_MS.length) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAYS_MS[attempt]));
    }
  }
}


async function read(path: string): Promise<Uint8Array> {
  const [dir, name] = await parentOf(path, false);
  const file = await dir.getFileHandle(name, { create: false });
  const handle = await acquireSyncHandle(file);
  try {
    const size = handle.getSize();
    const buf = new Uint8Array(size);
    handle.read(buf, { at: 0 });
    return buf;
  } finally {
    // In a `finally` and not after the return: a read that throws mid-way must
    // still release the exclusive lock, or every later access to that file
    // fails with `NoModificationAllowedError` until the Worker is replaced.
    handle.close();
  }
}

/**
 * Read at most `len` bytes from the start of a file.
 *
 * The natural OPFS operation — `handle.read(buf, { at: 0 })` fills as much of
 * the buffer as the file has and returns the count, so a short file needs no
 * special case. Truncating to that count is what makes "shorter than asked for"
 * a normal answer rather than an error.
 *
 * Motivated by the `.myn` nonce scan, which needs 47 bytes per note: reading
 * whole blobs for that on the unlock path would pull up to 16 MiB per note to
 * look at 47 bytes.
 */
async function readPrefix(path: string, len: number): Promise<Uint8Array> {
  const [dir, name] = await parentOf(path, false);
  const file = await dir.getFileHandle(name, { create: false });
  const handle = await acquireSyncHandle(file);
  try {
    const buf = new Uint8Array(len);
    const read = handle.read(buf, { at: 0 });
    return buf.subarray(0, read);
  } finally {
    handle.close();
  }
}

async function write(path: string, bytes: Uint8Array, replace: boolean): Promise<void> {
  const [dir, name] = await parentOf(path, true);

  if (!replace) {
    // OPFS has no `create_new`. Probing first is a TOCTOU window in general —
    // here it is not, because a single Worker is the only writer to this origin's
    // OPFS (the tab lock, task 21, is what makes that true).
    let exists = true;
    try {
      await dir.getFileHandle(name, { create: false });
    } catch {
      exists = false;
    }
    if (exists) throw new IoError(IO_KIND.other);
  }

  const file = await dir.getFileHandle(name, { create: true });
  const handle = await acquireSyncHandle(file);
  try {
    // `truncate(0)` BEFORE writing, not after: without it, overwriting a
    // 10 KiB blob with a 4 KiB one leaves 6 KiB of the previous ciphertext
    // beyond the new end. The AEAD tag would reject the result on read — so the
    // symptom would be "the vault is corrupt", not "the file is too long".
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    // `flush()` is as far as OPFS goes: it gives no crash-atomicity guarantee,
    // which is why the double-buffered `.a`/`.b` scheme (task 18) sits above
    // this layer rather than being attempted inside it.
    handle.flush();
  } finally {
    handle.close();
  }
}

async function removeFile(path: string): Promise<void> {
  const [dir, name] = await parentOf(path, false);
  await dir.removeEntry(name);
}

async function removeDirAll(path: string): Promise<void> {
  const [dir, name] = await parentOf(path, false);
  await dir.removeEntry(name, { recursive: true });
}

async function createDirAll(path: string): Promise<void> {
  let dir = await root();
  for (const part of segments(path)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
}

/** `[name, isDir]` pairs. Flattened to a plain array for a cheap wasm crossing. */
async function readDir(path: string): Promise<Array<[string, boolean]>> {
  let dir = await root();
  for (const part of segments(path)) {
    dir = await dir.getDirectoryHandle(part, { create: false });
  }
  const out: Array<[string, boolean]> = [];
  for await (const [name, handle] of dir.entries()) {
    out.push([name, handle.kind === "directory"]);
  }
  return out;
}

/**
 * Size + last-modified for one file, without reading it.
 *
 * `getFile()` hands back a `File`, which carries both — so this costs one handle
 * acquisition and no bytes. `null` for anything that is not a readable file
 * (absent, a directory, a racing delete), because the caller is decorating a row
 * it already has and must not lose the whole listing over one entry.
 */
async function stat(path: string): Promise<[number, number] | null> {
  try {
    const [dir, name] = await parentOf(path, false);
    const handle = await dir.getFileHandle(name, { create: false });
    const file = await handle.getFile();
    return [file.size, file.lastModified];
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  const parts = segments(path);
  // The OPFS root always exists and has no parent to look it up in.
  if (parts.length === 0) return true;
  let dir: FileSystemDirectoryHandle;
  try {
    [dir] = await parentOf(path, false);
  } catch (e) {
    // A missing intermediate directory means the leaf is missing too. Any other
    // failure is a real error and must not be reported as "absent" — the two
    // have opposite recoveries.
    if (classify(e).kind === IO_KIND.notFound) return false;
    throw e;
  }
  const name = parts[parts.length - 1];

  // Probe as a file, then as a directory.
  //
  // The subtlety that broke this the first time: OPFS answers
  // `getFileHandle` on an existing DIRECTORY with `TypeMismatchError`, not
  // `NotFoundError`. The first version only tolerated `NotFoundError` before
  // trying the directory probe, so `exists()` **threw on every directory** —
  // which surfaced as an `Io { Other }` from the notes-dir resolver and cost a
  // browser round-trip to find. `TypeMismatchError` here means "it exists and
  // it is the other kind", which is the one answer this function cares about.
  try {
    await dir.getFileHandle(name, { create: false });
    return true;
  } catch (e) {
    const kind = classify(e).kind;
    const isDirectory = (e as { name?: string })?.name === "TypeMismatchError";
    if (isDirectory) return true;
    if (kind !== IO_KIND.notFound) throw e;
  }
  try {
    await dir.getDirectoryHandle(name, { create: false });
    return true;
  } catch (e) {
    if (classify(e).kind !== IO_KIND.notFound) throw e;
    return false;
  }
}

/**
 * Whether a path exists **and is a directory**.
 *
 * `getDirectoryHandle` answers precisely: it succeeds for a directory, throws
 * `TypeMismatchError` for a file, `NotFoundError` for nothing. Both non-directory
 * answers are `false` — the caller asked a yes/no question.
 */
async function isDir(path: string): Promise<boolean> {
  const parts = segments(path);
  if (parts.length === 0) return true; // the OPFS root is a directory
  let dir: FileSystemDirectoryHandle;
  try {
    [dir] = await parentOf(path, false);
  } catch (e) {
    if (classify(e).kind === IO_KIND.notFound) return false;
    throw e;
  }
  try {
    await dir.getDirectoryHandle(parts[parts.length - 1], { create: false });
    return true;
  } catch (e) {
    // `TypeMismatchError` = it exists and is a FILE. That is the case this
    // function exists to distinguish from a directory, so it is `false`, not an
    // error — see the `is_dir` doc comment in `core/src/vault_io.rs`.
    if ((e as { name?: string })?.name === "TypeMismatchError") return false;
    if (classify(e).kind !== IO_KIND.notFound) throw e;
    return false;
  }
}

/**
 * Move a file. **Copy-then-unlink, deliberately not `move()`.**
 *
 * The Phase 0 spike measured Safari not implementing `FileSystemHandle.move()`
 * at all — a `TypeError`, reproduced at both 400 and 3 000 files. So a
 * rename-based port has no correct implementation on a browser this product
 * ships to.
 *
 * The consequence is stated rather than hidden: this is **not atomic**. A crash
 * between the write and the unlink leaves both copies. That is survivable for
 * the callers that exist (both are cleanup moves), and it is exactly why task
 * 18's double-buffered singleton scheme is designed to need no rename at all.
 */
async function rename(from: string, to: string): Promise<void> {
  const bytes = await read(from);
  await write(to, bytes, true);
  await removeFile(from);
}

/**
 * Install the bridge on `globalThis`, before the wasm module is instantiated.
 *
 * Plain global functions rather than an imported module: the Rust side declares
 * them with `#[wasm_bindgen(js_namespace = ...)]`, which resolves against the
 * global scope. That keeps `web/wasm` free of any build-time link to this file
 * and makes the boundary one explicit, greppable list.
 */
export function installOpfsBridge(): void {
  const bridge = {
    read: classified(read),
    readPrefix: classified(readPrefix),
    write: classified(write),
    removeFile: classified(removeFile),
    removeDirAll: classified(removeDirAll),
    createDirAll: classified(createDirAll),
    readDir: classified(readDir),
    exists: classified(exists),
    isDir: classified(isDir),
    stat: classified(stat),
    rename: classified(rename),
  };
  (globalThis as unknown as { __myneOpfs: typeof bridge }).__myneOpfs = bridge;
}

/**
 * Wrap one bridge function so everything it throws leaves as an {@link IoError}.
 *
 * Applied **at the boundary**, once, rather than inside each function. The
 * failure that motivated it: the operations above throw raw `DOMException`s, and
 * `web/wasm/src/opfs.rs` reads `.kind` off the thrown value — which a
 * `DOMException` does not have. So every storage failure of every shape arrived
 * in Rust as `IoFailureKind::Other`, and the very first thing that broke was the
 * one case that matters most at boot: a **missing** vault reported as an IO
 * error instead of `Missing`, which routes a first-run user to a failure screen
 * instead of the create flow.
 *
 * Wrapping here rather than per-function is deliberate — a per-function
 * `try/catch` is something a new operation can be added without, and its absence
 * is invisible until a specific error fires in a browser.
 */
function classified<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      throw classify(e);
    }
  };
}

/** Exported for the browser test harness (task 105) and the reload proof. */
export const __testing = {
  read,
  readPrefix,
  write,
  removeFile,
  removeDirAll,
  createDirAll,
  readDir,
  exists,
  isDir,
  rename,
  segments,
  classify,
  IO_KIND,
};
