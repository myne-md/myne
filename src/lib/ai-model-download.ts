// Download / cancel bindings for the on-demand AI model artefacts
// (myne-md/myne#805, `decisions/ai/0628`).
//
// The desktop command streams an artefact from `downloads.myne.md`, verifies
// every file against a SHA-256 compiled into the client binary, and only then
// registers it in the device-local model store. This module is the thin TS
// wrapper; the trust anchor and the verification live host-side, and this file
// never sees a digest, a URL or a byte of the model.
//
// The command exists only when the `local-inference` cargo feature is compiled
// in (`web/wasm/src/capability.rs` classifies the whole plugin absent-on-web),
// so callers on a build without it should catch and degrade.

import { invoke } from "../platform/core";

/**
 * The artefacts the client can fetch. Ids are stable strings minted host-side
 * (`src-tauri/src/plugins/local_inference/download.rs::ARTIFACTS`); the UI
 * never constructs a URL or a digest.
 */
export type DownloadArtifactId = "tag";

/**
 * The closed failure taxonomy, mirroring the Rust `ModelDownloadCommandError`
 * (serde `rename_all = "snake_case"`, so the wire `kind` is snake_case):
 * `unknown_artifact`, `download` (transport) and `store` (verification or
 * storage). Documented rather than exported as a live helper, because the only
 * decision a caller actually makes is the checksum-specific one below.
 */

/** Whether a rejected `download_model` was a compiled-in-digest refusal (a
 *  tampered or truncated artefact), as opposed to a transport failure. A digest
 *  mismatch arrives as `kind: "store"` whose `detail` is the string
 *  `"DigestMismatch"` (the Rust `ModelStoreError` unit variant). */
export function isChecksumMismatch(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const detail = (err as { detail?: unknown }).detail;
  return detail === "DigestMismatch";
}

/**
 * Fetch and install `artifactId`, verifying it against the compiled-in digest.
 * `downloadId` is minted by the caller so {@link cancelModelDownload} can target
 * exactly this fetch. Resolves with the installed primary file path.
 */
export async function downloadModel(
  artifactId: DownloadArtifactId,
  downloadId: string,
): Promise<string> {
  return await invoke<string>("plugin:local-inference|download_model", {
    artifact: artifactId,
    downloadId,
  });
}

/** Cancel an in-flight download by its caller-minted id. `false` if not running. */
export async function cancelModelDownload(downloadId: string): Promise<boolean> {
  return await invoke<boolean>("plugin:local-inference|cancel_model_download", {
    downloadId,
  });
}

/**
 * Remove a model for `role`. A downloaded bundle under the app's `models/`
 * directory is deleted; a side-loaded file the user chose elsewhere is only
 * unregistered, never deleted. `role` is the model-store role, not the artefact
 * id (one artefact can register a role; the remove acts on the role).
 */
export async function removeModel(role: string): Promise<void> {
  await invoke<void>("plugin:local-inference|remove_model", { role });
}

/**
 * Mint a per-download id. `crypto.randomUUID` is available in every WebView the
 * app ships; the fallback keeps an older engine from throwing on a UI action.
 * The fallback uses `crypto.getRandomValues`, not `Math.random`: the id is the
 * sole key for the staging directory, and a same-millisecond collision would
 * let one fetch's `remove_dir_all` truncate another's verified files
 * (myne-md/myne#826).
 */
export function newDownloadId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `dl-${Date.now()}-${hex}`;
  }
}
