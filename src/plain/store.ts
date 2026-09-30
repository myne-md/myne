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

/**
 * Autosave max window (the γ2 safety net): during sustained typing a save
 * fires at most every `AUTOSAVE_MAX_MS` even without a pause, so a writer who
 * never stops typing still gets a landing. Mirrors `AUTOSAVE_MAX_MS` in
 * `src/notes/saveNote.ts` (same 10000), defined locally because the
 * plain-surface import guard (`scripts/check-plain-surface-imports.mjs`) keeps
 * this tree off `src/notes/`.
 */
const AUTOSAVE_MAX_MS = 10000;

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
/** Idle timers, per handle: one keystroke postpones this one, deliberately. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();
/**
 * Max timers, per handle: armed once per DIRTY RUN and cleared only when a
 * save of the unchanged buffer lands, so continuous typing cannot postpone the
 * write past `AUTOSAVE_MAX_MS` the way the idle timer alone allows.
 */
const maxTimers = new Map<number, ReturnType<typeof setTimeout>>();
/**
 * Handles whose save call arrived while a write was already in flight.
 *
 * The in-flight write joins rather than refusing (see `inflight`), so without
 * this the call would settle with the OLDER body still the newest on disk and
 * nothing would re-run until the next keystroke. A Set, and cleared before the
 * follow-up starts, so one write schedules exactly one more.
 */
const pendingFollowUp = new Set<number>();
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
/**
 * The buffer each in-flight write is writing, per handle. The join branch
 * compares against this to decide whether a follow-up is owed: a `save` whose
 * body is already being written owes nothing, and scheduling one for it would
 * rewrite identical bytes on every blur and every `flushAll`.
 */
const inflightContent = new Map<number, string>();

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

/**
 * A keystroke: update the buffer, re-arm the idle autosave and start the max
 * clock if this is the dirty run's first keystroke.
 */
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
  if (!maxTimers.has(handle)) {
    maxTimers.set(
      handle,
      setTimeout(() => {
        maxTimers.delete(handle);
        void save(handle);
      }, AUTOSAVE_MAX_MS),
    );
  }
}

/** Drop a handle's idle timer, if any. The max timer is deliberately kept. */
function clearIdleTimer(handle: number): void {
  const timer = timers.get(handle);
  if (timer) {
    clearTimeout(timer);
    timers.delete(handle);
  }
}

/** The dirty run is settled: drop the max clock too. */
function clearMaxTimer(handle: number): void {
  const timer = maxTimers.get(handle);
  if (timer) {
    clearTimeout(timer);
    maxTimers.delete(handle);
  }
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
    // that is about to change; see `inflight` above. A follow-up is owed only
    // when this call carries a buffer the running write is not writing: the
    // same body owes nothing, and scheduling one for it would rewrite
    // identical bytes.
    if (find(handle)?.content !== inflightContent.get(handle)) {
      pendingFollowUp.add(handle);
    }
    await running;
    // The settled write schedules at most one follow-up for the newest body
    // in its `finally`. Join that too, so a caller that awaits `save`
    // (flushAll, flushForImport) reads a state nothing is about to change.
    let next = inflight.get(handle);
    while (next) {
      await next;
      next = inflight.get(handle);
    }
    return;
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
      const unchanged = after.content === attempted;
      patch(handle, (f) => ({
        ...f,
        baseHash,
        // A keystroke during the save moved the buffer on; the next idle pass
        // owns it, so the status must not read "saved" over newer text.
        status: unchanged ? "saved" : "editing",
        diskContent: undefined,
        diskBaseHash: undefined,
      }));
      // The dirty run this max clock was armed for is on disk now. A moved-on
      // buffer stays in its run, and its timer must survive.
      if (unchanged) clearMaxTimer(handle);
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
          // The disk moved (that is why the write refused) AND the re-read
          // failed: the file was deleted, moved or replaced while the write
          // ran. Staying "conflict" keeps the banner and its copy arm, which
          // needs no source read; "error" would offer only a Retry that
          // cannot succeed. `diskContent` stays undefined, so the banner
          // hides Reload and shows only the arms that can still act.
          patch(handle, (f) => ({
            ...f,
            status: "conflict",
            diskContent: undefined,
            diskBaseHash: undefined,
          }));
        }
        return;
      }
      patch(handle, (f) => ({ ...f, status: "error" }));
    }
  })();
  inflight.set(handle, run);
  inflightContent.set(handle, attempted);
  try {
    await run;
  } finally {
    inflight.delete(handle);
    inflightContent.delete(handle);
    // A save that arrived while this one ran owes exactly one follow-up with
    // the latest body; `pendingFollowUp` is the latest-wins gate for it.
    if (pendingFollowUp.delete(handle)) void save(handle);
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
  clearIdleTimer(handle);
  clearMaxTimer(handle);
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

/**
 * Keep the buffer and write it over the disk version.
 *
 * The disk hash is optional on purpose: a conflict whose re-read failed (the
 * file was deleted or moved) has no new base to adopt, and refusing here would
 * make the banner's Overwrite button dead. With the old base the write either
 * fails the same conflict again (nothing changed, and the banner stays) or
 * lands when the disk came back to what the tab last saw.
 */
export function resolveOverwrite(handle: number): void {
  const file = find(handle);
  if (!file || file.status !== "conflict") return;
  patch(handle, (f) => ({
    ...f,
    baseHash: f.diskBaseHash ?? f.baseHash,
    status: "editing",
    diskContent: undefined,
    diskBaseHash: undefined,
  }));
  void save(handle);
}

/**
 * The tabs whose latest buffer has not landed: `close` refuses to drop these
 * because neither state has a successful write behind it.
 *
 * Exported for the close intercept, which must not destroy the window over
 * text that exists only in RAM without telling the user.
 */
export function unsettledTabs(): PlainFile[] {
  return state.files.filter((file) => file.status === "conflict" || file.status === "error");
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
  clearIdleTimer(handle);
  clearMaxTimer(handle);
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
 * The device-local gate was just turned off: flush, then close every tab.
 *
 * The PRD's disabled-gate contract is "no tabs stay open", and this is the one
 * place that owes it. `close` refuses to drop a tab whose latest buffer has
 * not landed (conflict or error), which is correct for the same reason it is
 * in the tab strip, so the caller gets the remaining handles back and must
 * surface them: silently leaving them open would read as the toggle not
 * working. Dormant tabs (parked by a lock earlier in the session) are dropped
 * the same way; they were flushed when they were parked.
 *
 * Returns the handles still open, so an empty array is the whole contract.
 */
export async function handleGateDisabled(): Promise<number[]> {
  await flushAll();
  for (const file of [...state.files, ...state.dormant]) {
    if (file.status === "conflict" || file.status === "error") continue;
    if (find(file.handle)) {
      await close(file.handle).catch(() => undefined);
      continue;
    }
    await plainFileClose(file.handle).catch(() => undefined);
    setState({
      ...state,
      dormant: state.dormant.filter((f) => f.handle !== file.handle),
    });
  }
  return [...state.files, ...state.dormant]
    .filter((file) => file.status === "conflict" || file.status === "error")
    .map((file) => file.handle);
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

/** @internal Test-only read of the module-scope state. */
export function __getPlainStoreStateForTest(): State {
  return state;
}

/** @internal Test-only reset of the module-scope state. */
export function __resetPlainStoreForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  for (const timer of maxTimers.values()) clearTimeout(timer);
  timers.clear();
  maxTimers.clear();
  pendingFollowUp.clear();
  inflight.clear();
  inflightContent.clear();
  listeners.clear();
  state = { files: [], dormant: [], activeHandle: null };
}
