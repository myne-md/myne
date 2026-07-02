// IPC wrappers for the device-local model-path store (ai-ux-surface MYND-408
// task 4). The `local-inference` plugin records where a user's side-loaded model
// file lives (SYNC-1) — device-local, outside the vault tree, never copied. The
// commands exist only when the `local-inference` cargo feature is compiled in;
// callers wrap in try/catch so the feature-OFF build (command absent) degrades
// to local-only state rather than throwing.

import { invoke } from "@tauri-apps/api/core";

/** Which model a stored path refers to (mirrors the Rust `ModelRole`). */
export type ModelRole = "generation" | "embedding";

/**
 * Persist the user-picked model `path` for `role` device-locally. Returns the
 * accepted (normalized) path. Rejects (`InsideVaultTree`) a path inside the
 * vault tree — the caller surfaces the closed error kind, never the path.
 */
export async function saveModelPath(role: ModelRole, path: string): Promise<string> {
  return await invoke<string>("plugin:local-inference|set_model_path", { role, path });
}

/** Read back the device-local model path for `role`, or `null` if unset. */
export async function loadModelPath(role: ModelRole): Promise<string | null> {
  return await invoke<string | null>("plugin:local-inference|get_model_path", { role });
}
