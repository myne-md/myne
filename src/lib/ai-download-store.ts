// Module-scope state for on-demand AI model downloads (myne-md/myne#814).
//
// # Why this outlives the panel
//
// The Settings AI panel kept a download's `busy` flag in component state, so
// switching panels unmounted it and the in-flight fetch became invisible: the
// row read "Not installed" again on return and offered Download, which started
// a second concurrent fetch of the same artefact. The host task was never
// cancelled (only the component was), so the fix is to own the fetch here, at
// module scope, and let the host's `local-inference://model-download-progress`
// events drive a progress bar. This module holds no plaintext and no secret:
// counts, an already UI-facing artefact id, and a caller-minted download id.
//
// The store owns the invoke promise, so the terminal state (complete / failed /
// cancelled) survives an unmount. Both the Settings row and the first-run
// onboarding card read it, so the two surfaces cannot disagree.

import { useSyncExternalStore } from "react";

import { listen } from "../platform/event";

import {
  cancelModelDownload,
  downloadModel,
  isChecksumMismatch,
  newDownloadId,
  type DownloadArtifactId,
} from "./ai-model-download";

/** Backend event, mirroring `MODEL_DOWNLOAD_PROGRESS_EVENT` (Rust,
 *  `src-tauri/src/plugins/local_inference/commands.rs`). */
const PROGRESS_EVENT = "local-inference://model-download-progress";

interface ProgressPayload {
  downloadId: string;
  artifact: string;
  downloaded: number;
  total: number;
}

export type ModelDownloadStatus =
  | "idle"
  | "downloading"
  | "complete"
  | "failed"
  | "cancelled";

export interface ModelDownloadState {
  status: ModelDownloadStatus;
  /** Bytes written so far, across the artefact. */
  downloaded: number;
  /** The artefact's approximate total, for the bar; `0` until the first frame. */
  total: number;
  /** Present only when `status === "failed"`. */
  cause?: "checksum" | "generic";
}

const IDLE: ModelDownloadState = {
  status: "idle",
  downloaded: 0,
  total: 0,
};

const states = new Map<DownloadArtifactId, ModelDownloadState>();
const downloadToArtifact = new Map<string, DownloadArtifactId>();
const activeByArtifact = new Map<DownloadArtifactId, string>();
const listeners = new Set<() => void>();
let subscribed = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function patch(
  artifact: DownloadArtifactId,
  next: Partial<ModelDownloadState>,
): void {
  states.set(artifact, { ...(states.get(artifact) ?? IDLE), ...next });
  notify();
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  listen<ProgressPayload>(PROGRESS_EVENT, (event) => {
    const artifact = downloadToArtifact.get(event.payload.downloadId);
    if (artifact === undefined) return;
    patch(artifact, {
      status: "downloading",
      downloaded: event.payload.downloaded,
      total: event.payload.total,
    });
  }).catch((err: unknown) => {
    // Handled, not fatal: the invoke still drives the terminal state, the bar
    // just stops at its last frame. See `lib/subscribe.ts` for the reasoning.
    console.warn(`[myne] could not subscribe to "${PROGRESS_EVENT}":`, err);
  });
}

export function getModelDownloadState(
  artifact: DownloadArtifactId,
): ModelDownloadState {
  return states.get(artifact) ?? IDLE;
}

/** Subscribe to any change. Stable identity, so it can be passed straight to
 *  `useSyncExternalStore`. */
export function subscribeModelDownloads(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Start a fetch. Idempotent while one is in flight for the same artefact, so a
 * double click (or a remount) cannot start a second.
 */
export async function startModelDownload(
  artifact: DownloadArtifactId,
): Promise<void> {
  ensureSubscribed();
  if (activeByArtifact.has(artifact)) return;
  const id = newDownloadId();
  activeByArtifact.set(artifact, id);
  downloadToArtifact.set(id, artifact);
  patch(artifact, { status: "downloading", downloaded: 0, total: 0, cause: undefined });
  try {
    await downloadModel(artifact, id);
    // Guard the terminal patch by the MINTED ID, not the artifact (myne-md/myne#826):
    // a cancel deletes this id's marker (and a restart points the artifact at a
    // NEW id), so a late resolution from an old fetch must not overwrite the
    // state the user (or the newer fetch) has since set.
    if (activeByArtifact.get(artifact) !== id) return;
    activeByArtifact.delete(artifact);
    downloadToArtifact.delete(id);
    patch(artifact, { status: "complete", cause: undefined });
  } catch (err) {
    // Same id guard as the success arm. Without it a user cancel (backend
    // rejects with ModelDownloadError::Cancelled) lands here and relabels
    // 'cancelled' as 'failed', and a cancel-then-restart lets the old rejection
    // clear the new fetch's marker.
    if (activeByArtifact.get(artifact) !== id) return;
    activeByArtifact.delete(artifact);
    downloadToArtifact.delete(id);
    patch(artifact, {
      status: "failed",
      cause: isChecksumMismatch(err) ? "checksum" : "generic",
    });
  }
}

/** Cancel an in-flight fetch, if any, and mark it cancelled immediately so the
 *  rejected invoke does not relabel a user cancel as a failure. */
export function cancelModelDownloadFor(
  artifact: DownloadArtifactId,
): void {
  const id = activeByArtifact.get(artifact);
  if (id === undefined) return;
  activeByArtifact.delete(artifact);
  downloadToArtifact.delete(id);
  patch(artifact, { status: "cancelled" });
  void cancelModelDownload(id).catch(() => {
    /* best-effort: the fetch is already marked cancelled locally */
  });
}

/** React binding. */
export function useModelDownload(
  artifact: DownloadArtifactId,
): ModelDownloadState {
  return useSyncExternalStore(
    subscribeModelDownloads,
    () => getModelDownloadState(artifact),
  );
}
