// The plain-file surface's RAM-only store (myne-md/myne#788).
//
// Nothing here is persisted, by decision: no recents, no workspace entry, no
// buffer on disk. The store lives in module scope for the process lifetime and
// dies with the app. Its ONLY durable effect is the file itself, written
// through the compare-and-swap autosave below.
//
// Persistence is also why the tab strip is this surface's own rather than the
// note strip's: `vault.workspace` records the open-note set as AS3 activity
// metadata inside the encrypted vault, and a plaintext path landing in it
// would be both a vault interaction and a durable trace. Keeping the two
// strips apart makes that leak impossible by construction rather than by a
// filter somebody has to remember.

import { useSyncExternalStore } from "react";
import {
  onPlainFileOpened,
  plainFileClose,
  plainFileRead,
  plainFileSaveCopy,
  plainFileTakeUnclaimed,
  plainFileWrite,
  type PlainFileOpened,
} from "../platform/plainFile";

/** Autosave idle window. Mirrors the vault editor's shape, not its constant. */
const AUTOSAVE_IDLE_MS = 900;

export type PlainFileStatus =
  | "clean"
  | "editing"
  | "saving"
  | "saved"
  | "error"
  | "conflict";

export type PlainFile = {
  handle: number;
  /** File name only; a full path never reaches the frontend. */
  name: string;
  content: string;
  /** On-disk hash the next write must still match. */
  baseHash: string;
  status: PlainFileStatus;
  /** While `status === "conflict"`: what the file says now. */
  diskContent?: string;
  diskBaseHash?: string;
};

type State = {
  files: PlainFile[];
  /** Files held out of the strip during a vault lock (Q8's RAM restore). */
  dormant: PlainFile[];
  activeHandle: number | null;
};

let state: State = { files: [], dormant: [], activeHandle: null };
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/**
 * The write already running for a handle, keyed per handle.
 *
 * `save` used to return IMMEDIATELY while one was in flight (the `status ===
 * "saving"` guard), which is fine for the autosave caller and wrong for every
 * caller that has to READ the settled result: `flushForImport` below must wait
 * out the running write, or its conflict check reads a status that is about to
 * change. Joining the promise is the whole fix; the guard stays for the
 * (unreachable today) entry with no promise behind it.
 */
const inflight = new Map<number, Promise<void>>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: State): void {
  state = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): State {
  return state;
}

/** Subscribe a component to the whole store (small and infrequent by design). */
export function usePlainFileState(): State {
  return useSyncExternalStore(subscribe, getSnapshot);
}

function patch(handle: number, patchFn: (file: PlainFile) => PlainFile): void {
  setState({
    ...state,
    files: state.files.map((file) => (file.handle === handle ? patchFn(file) : file)),
  });
}

function find(handle: number): PlainFile | undefined {
  return state.files.find((file) => file.handle === handle);
}

/** Add or focus an open delivered by Rust. Idempotent per handle. */
export function upsertOpened(opened: PlainFileOpened): void {
  if (find(opened.handle)) {
    setState({ ...state, activeHandle: opened.handle });
    return;
  }
  const file: PlainFile = {
    handle: opened.handle,
    name: opened.name,
    content: opened.content,
    baseHash: opened.baseHash,
    status: "clean",
  };
  setState({
    ...state,
    files: [...state.files, file],
    activeHandle: opened.handle,
  });
}

/** A keystroke: update the buffer and arm the idle autosave. */
export function edit(handle: number, content: string): void {
  patch(handle, (file) => ({ ...file, content, status: "editing" }));
  const existing = timers.get(handle);
  if (existing) clearTimeout(existing);
  timers.set(
    handle,
    setTimeout(() => {
      timers.delete(handle);
      void save(handle);
    }, AUTOSAVE_IDLE_MS),
  );
}

/** The Rust enum's internally-tagged variant name (`rename_all` on the enum). */
function errorKind(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

/**
 * Compare-and-swap write of the buffer.
 *
 * A conflict surfaces the banner and writes NOTHING. An external deletion is
 * one of its arms (the Rust side maps a missing file to the same refusal),
 * which is why closing a conflicted tab has no silent-discard path: the user
 * chooses between reloading and overwriting first.
 */
export async function save(handle: number): Promise<void> {
  const running = inflight.get(handle);
  if (running) {
    // Join the write already in flight rather than returning into a status
    // that is about to change; see `inflight` above.
    return running;
  }
  const file = find(handle);
  if (!file || file.status === "saving" || file.status === "conflict") return;
  const attempted = file.content;
  patch(handle, (f) => ({ ...f, status: "saving" }));
  const run = (async () => {
    try {
      const baseHash = await plainFileWrite(handle, attempted, file.baseHash);
      const after = find(handle);
      if (!after) return;
      patch(handle, (f) => ({
        ...f,
        baseHash,
        // A keystroke during the save moved the buffer on; the next idle pass
        // owns it, so the status must not read "saved" over newer text.
        status: after.content === attempted ? "saved" : "editing",
        diskContent: undefined,
        diskBaseHash: undefined,
      }));
    } catch (error) {
      if (errorKind(error) === "conflict") {
        try {
          const disk = await plainFileRead(handle);
          patch(handle, (f) => ({
            ...f,
            status: "conflict",
            diskContent: disk.content,
            diskBaseHash: disk.baseHash,
          }));
        } catch {
          patch(handle, (f) => ({ ...f, status: "error" }));
        }
        return;
      }
      patch(handle, (f) => ({ ...f, status: "error" }));
    }
  })();
  inflight.set(handle, run);
  try {
    await run;
  } finally {
    inflight.delete(handle);
  }
}

/** Flush every dirty buffer (blur, unmount, lock). Best effort. */
export async function flushAll(): Promise<void> {
  await Promise.all(state.files.map((file) => save(file.handle)));
}

/**
 * Flush the buffer so the file on disk holds it, and hand back the text to
 * copy into a note. `null` means the flush did not land.
 *
 * A conflict or an I/O failure refuses the import rather than copying text the
 * file does not hold: the banner owns that resolution, and the user's writing
 * would otherwise exist only in the new note while the tab still claims a
 * conflict. The loop covers a keystroke racing a write that was already
 * landing; the bound exists so a user typing through the click cannot spin the
 * import forever.
 */
export async function flushForImport(handle: number): Promise<string | null> {
  if (!find(handle)) return null;
  const timer = timers.get(handle);
  if (timer) {
    clearTimeout(timer);
    timers.delete(handle);
  }
  const current = find(handle);
  if (!current) return null;
  if (current.status === "conflict" || current.status === "error") return null;
  // Already settled: the file holds this exact buffer, so a write here would
  // only re-encrypt the same bytes.
  if (current.status === "clean" || current.status === "saved") return current.content;
  for (let attempt = 0; attempt < 3; attempt++) {
    await save(handle);
    const settled = find(handle);
    if (!settled) return null;
    if (settled.status === "conflict" || settled.status === "error") return null;
    if (settled.status === "clean" || settled.status === "saved") return settled.content;
  }
  const settled = find(handle);
  if (!settled || settled.status === "conflict" || settled.status === "error") return null;
  return settled.content;
}

/**
 * Import this tab's buffer into a new vault note and close the tab.
 *
 * `create` is injected because note creation is vault work and this module may
 * not reach vault modules (the plain-surface import guard,
 * `scripts/check-plain-surface-imports.mjs`); the caller owns it. The ordering
 * is the contract: the flush lands BEFORE `create` sees the text, and the tab
 * closes only after `create` resolved, so a failed import leaves the tab and
 * the file exactly as they were.
 *
 * Returns the note id `create` produced, or `null` when nothing was imported.
 * The original file on disk is untouched either way.
 */
export async function importToVault(
  handle: number,
  create: (file: { name: string; content: string }) => Promise<string>,
): Promise<string | null> {
  const content = await flushForImport(handle);
  if (content === null) return null;
  const file = find(handle);
  if (!file) return null;
  let noteId: string;
  try {
    noteId = await create({ name: file.name, content });
  } catch {
    return null;
  }
  // A keystroke may have landed while the note write ran. Settle it before the
  // tab can go, for the same reason `close` flushes first: dropping the tab
  // would drop that text with it (the note already holds the flush-time text).
  // `flushForImport` refuses on a conflict, which keeps the tab so the banner
  // owns the resolution; the note id is still returned because it did land.
  if ((await flushForImport(handle)) === null) return noteId;
  await plainFileClose(handle).catch(() => undefined);
  const files = state.files.filter((f) => f.handle !== handle);
  const nextActive =
    state.activeHandle === handle ? (files[files.length - 1]?.handle ?? null) : state.activeHandle;
  setState({ ...state, files, activeHandle: nextActive });
  return noteId;
}

/** Adopt the disk content the conflict banner read. */
export function resolveReload(handle: number): void {
  const file = find(handle);
  if (!file || file.status !== "conflict" || file.diskContent === undefined) return;
  patch(handle, (f) => ({
    ...f,
    content: f.diskContent ?? f.content,
    baseHash: f.diskBaseHash ?? f.baseHash,
    status: "saved",
    diskContent: undefined,
    diskBaseHash: undefined,
  }));
}

/** Keep the buffer and write it over the disk version. */
export function resolveOverwrite(handle: number): void {
  const file = find(handle);
  if (!file || file.status !== "conflict" || file.diskBaseHash === undefined) return;
  patch(handle, (f) => ({
    ...f,
    baseHash: f.diskBaseHash ?? f.baseHash,
    status: "editing",
    diskContent: undefined,
    diskBaseHash: undefined,
  }));
  void save(handle);
}

/** What the conflict banner's copy arm decided. */
export type SaveCopyOutcome = "saved" | "cancelled" | "failed";

/**
 * The conflict banner's third arm: write the buffer to a file the user names,
 * then re-read the ORIGINAL so the tab shows what is on disk now.
 *
 * The user's text lives in the copy from here on; the original file is never
 * written, and the banner clears only after the copy landed. A cancelled
 * dialog changes nothing, which is why "cancelled" is distinct from "failed":
 * only the latter owes the user a message.
 */
export async function resolveCopyWithSave(handle: number): Promise<SaveCopyOutcome> {
  const file = find(handle);
  if (!file || file.status !== "conflict") return "failed";
  try {
    if ((await plainFileSaveCopy(handle, file.content)) === null) return "cancelled";
  } catch {
    return "failed";
  }
  try {
    const disk = await plainFileRead(handle);
    patch(handle, (f) => ({
      ...f,
      content: disk.content,
      baseHash: disk.baseHash,
      status: "saved",
      diskContent: undefined,
      diskBaseHash: undefined,
    }));
  } catch {
    // The original vanished between the copy and the re-read. Fall back to the
    // snapshot the banner took; the next write surfaces whatever is true then.
    resolveReload(handle);
  }
  return "saved";
}

export function setActive(handle: number): void {
  setState({ ...state, activeHandle: handle });
}

/** Close a tab: flush first, then drop the Rust handle and the state. */
export async function close(handle: number): Promise<void> {
  const file = find(handle);
  if (!file) return;
  const timer = timers.get(handle);
  if (timer) {
    clearTimeout(timer);
    timers.delete(handle);
  }
  await save(handle).catch(() => undefined);
  const settled = find(handle);
  if (settled && (settled.status === "conflict" || settled.status === "error")) {
    // Closing here would destroy the only copy of the user's text: neither
    // state has a successful write behind it. Keep the tab; the banner owns
    // the resolution.
    return;
  }
  await plainFileClose(handle).catch(() => undefined);
  const files = state.files.filter((f) => f.handle !== handle);
  const nextActive =
    state.activeHandle === handle ? (files[files.length - 1]?.handle ?? null) : state.activeHandle;
  setState({ ...state, files, activeHandle: nextActive });
}

/** Vault lock: flush, hide the tabs, and keep the handles alive in RAM (Q8). */
export async function dormancyForLock(): Promise<void> {
  await flushAll();
  if (state.files.length === 0) return;
  setState({ files: [], dormant: [...state.dormant, ...state.files], activeHandle: null });
}

/** Vault unlock in the same session: bring the tabs back. */
export function restoreDormant(): void {
  if (state.dormant.length === 0) return;
  setState({
    ...state,
    files: [...state.dormant, ...state.files],
    dormant: [],
    activeHandle: state.activeHandle ?? state.dormant[state.dormant.length - 1]?.handle ?? null,
  });
}

/**
 * Subscribe to OS opens and drain any that arrived before this listener
 * existed (the argv ingest on a cold launch). Returns the unsubscribe.
 */
let initialized: Promise<void> | null = null;

export function initializePlainFiles(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      // The listener stays installed for the process lifetime, not for the
      // surface's lifetime: a lock parks the tabs and unmounts the surface, and
      // an open arriving while nothing is showing must still land.
      try {
        await onPlainFileOpened(upsertOpened);
      } catch {
        // No host event channel (a test environment, or a client without one):
        // opens simply never arrive, which is a valid state. The drain below
        // still runs, so a host that supports only the pull half works too.
      }
      try {
        const pending = await plainFileTakeUnclaimed();
        for (const opened of pending) upsertOpened(opened);
      } catch {
        // The gate is off, or this is the web client. Either way there is
        // nothing to drain; silence is the designed answer.
      }
    })();
  }
  return initialized;
}

/** @internal Test-only reset of the module-scope state. */
export function __resetPlainStoreForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  inflight.clear();
  listeners.clear();
  state = { files: [], dormant: [], activeHandle: null };
}
