// The AI surface's IPC bindings (myne-md/myne#456).
//
// Small on purpose: the provider settings live in `prefs.ts` beside every other
// preference, because they ARE preferences, and this file holds only the two
// things that are not, asking a provider what models it publishes, and asking
// the host whether the configured backend can hold the edit format.
//
// The agent's own run commands live in `agent-run.ts`.

import { invoke } from "../platform/core";

/** One model the provider publishes. Mirrors the Rust `ProviderModel`. */
export interface ProviderModel {
  /** The identifier a request names, e.g. `anthropic/claude-3.5-sonnet`. */
  id: string;
}

/**
 * The models the named provider currently publishes.
 *
 * **This opens a socket**, gated exactly like a completion: the host re-reads
 * every precondition first, and an authenticated listing call tells the provider
 * this account exists and is active. Call it when the user opens the chooser,
 * not on mount.
 *
 * It exists because Myne ships no model default and no fallback: the list has to
 * come from the provider, since a client-pinned model tag rots faster than the
 * release that pinned it.
 */
export async function listProviderModels(): Promise<ProviderModel[]> {
  return await invoke<ProviderModel[]>("plugin:agent|agent_list_provider_models");
}
