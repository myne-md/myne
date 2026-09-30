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

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { kind?: string }).kind === "conflict"
  );
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
  const file = find(handle);
  if (!file || file.status === "saving" || file.status === "conflict") return;
  const attempted = file.content;
  patch(handle, (f) => ({ ...f, status: "saving" }));
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
    if (isConflict(error)) {
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
}

/** Flush every dirty buffer (blur, unmount, lock). Best effort. */
export async function flushAll(): Promise<void> {
  await Promise.all(state.files.map((file) => save(file.handle)));
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
export async function initializePlainFiles(): Promise<() => void> {
  const unlisten = await onPlainFileOpened(upsertOpened);
  try {
    const pending = await plainFileTakeUnclaimed();
    for (const opened of pending) upsertOpened(opened);
  } catch {
    // The gate is off, or this is the web client. Either way there is nothing
    // to drain; silence is the designed answer.
  }
  return unlisten;
}
