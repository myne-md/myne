// IPC wrappers for the device-local model-path store (ai-ux-surface MYND-408
// task 4). The `local-inference` plugin records where a user's side-loaded model
// file lives (SYNC-1) — device-local, outside the vault tree, never copied. The
// commands exist only when the `local-inference` cargo feature is compiled in;
// callers wrap in try/catch so the feature-OFF build (command absent) degrades
// to local-only state rather than throwing.

import { invoke } from "../platform/core";

/** Which model a stored path refers to (mirrors the Rust `ModelRole`). */
export type ModelRole = "generation" | "embedding" | "transcription";

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

// --- The device-local AI endpoint (ai-ollama-local task 4, SYNC-12) ---------
//
// Lives here rather than in a new module on purpose. `scripts/check-unwired.mjs`
// fails a module under `src/lib` with no PRODUCTION importer, and a test-only
// importer does not count — so a new file would have had to arrive with its UI,
// which is task 8. This module already has production importers and is the same
// seam family (device-local AI settings reached over IPC), so the wrappers land
// here and the settings row picks them up next.
//
// Host-side by necessity: the WebView's CSP `connect-src` cannot reach a
// loopback daemon, so the page could not validate or probe an endpoint even if
// it wanted to.

/**
 * A configured endpoint: where, and which model there.
 *
 * The two travel together because neither alone is a backend — SYNC-24 leaves
 * the model name to the user, so a URL with an empty `model` is stored and
 * shown but builds no engine.
 */
export interface AiEndpoint {
  url: string;
  model: string;
}

/** Why the host refused an endpoint URL — mirrors the Rust `EndpointRejection`. */
export type EndpointRejection = "malformed" | "unsupported_scheme" | "not_loopback";

/**
 * Read the configured AI endpoint, or `null` when none is set.
 *
 * `null` is the **unreachable** state, not a disabled one: nothing is configured,
 * so there is nothing for the provider arm to talk to. Wrapped in try/catch like
 * its siblings so a build without the `local-inference` feature (command absent)
 * degrades instead of throwing.
 */
export async function loadAiEndpoint(): Promise<AiEndpoint | null> {
  try {
    const pair = await invoke<[string, string] | null>(
      "plugin:local-inference|get_ai_endpoint",
    );
    return pair === null ? null : { url: pair[0], model: pair[1] };
  } catch {
    return null;
  }
}

/**
 * Validate and persist the AI endpoint; an empty string clears it.
 *
 * Deliberately **not** try/catch-wrapped: a refusal is the answer the caller
 * needs to render, and swallowing it would show "saved" for a URL the host threw
 * away. Rejects with the closed Rust error; the caller reads `reason`.
 */
export async function saveAiEndpoint(
  url: string,
  model: string,
): Promise<string | null> {
  return await invoke<string | null>("plugin:local-inference|set_ai_endpoint", {
    url,
    model,
  });
}

/**
 * Narrow a rejected {@link saveAiEndpoint} to the closed reason the host gave,
 * or `null` for anything else (an IO or parse failure, or a non-Myne throw).
 *
 * The wire shape (`AiEndpointError`, serde `tag = "kind"` / `content = "detail"`)
 * is read HERE and nowhere else, so a UI renders a reason it can switch on
 * rather than reaching into an error's internals. Note what it deliberately
 * does not return: the URL the user typed, or any path. A refusal names the
 * rule, never the input (`src-tauri/CLAUDE.md` DENY-list discipline — a settings
 * field's contents end up in screenshots and bug reports).
 */
export function endpointRejectionOf(err: unknown): EndpointRejection | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { kind?: unknown; detail?: { reason?: unknown } };
  if (e.kind !== "Rejected") return null;
  const reason = e.detail?.reason;
  return reason === "malformed" ||
    reason === "unsupported_scheme" ||
    reason === "not_loopback"
    ? reason
    : null;
}

/**
 * The models the **named remote provider** currently publishes (myne#415 task
 * 17, SYNC-24).
 *
 * The list comes from the provider, never from a constant in this tree — that
 * is the whole of SYNC-24, not an implementation detail. A pinned catalogue
 * would rot faster than the release that pinned it, and a chooser offering a
 * model the provider retired is worse than no chooser.
 *
 * **This call is an egress**, and the host gates it exactly like a completion:
 * developer mode, the AI beta, a selected provider, a stored key, and consent
 * naming that provider. It therefore rejects with the same closed taxonomy —
 * feed the rejection to `normalizeProviderError` rather than showing a raw
 * string. It deliberately does NOT swallow the error the way `loadAiEndpoint`
 * does: "we could not ask the provider" and "the provider has no models" are
 * different facts and a caller must be able to tell them apart.
 */
export async function listProviderModels(): Promise<string[]> {
  return await invoke<string[]>("plugin:local-inference|list_provider_models");
}
