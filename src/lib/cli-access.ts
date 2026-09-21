// Tauri IPC wrapper for the `cli-bridge` plugin — the CLI door's SESSION state
// (cli-thin-client task 12, MYND-490).
//
// Everything about the CLI door that is a per-vault preference lives in
// `prefs.ts` (`setCliEnabled`, `setCliExcludedFolders`,
// `setCliRateLimitDisabled`). This module reads the two facts that deliberately
// are NOT preferences:
//
//   - how long ago the command socket last served a request — held in RAM on the
//     Rust side and cleared when the vault locks, because writing `vault.prefs`
//     on every `myne` command would turn a read loop into hundreds of encrypted
//     vault writes (`src-tauri/src/cli_bridge/activity.rs`);
//   - whether `myne` is typeable at all on this machine, plus where the PATH
//     shim lives — a property of the user's `$PATH`, not of the vault. The app
//     does not edit shell profiles, so Settings shows the one `export PATH=…`
//     line instead (`cli_bridge/path_shim.rs` rule 3).
//
// Signature parity (no codegen — see src/AGENTS.md "Tauri command bindings"):
// keep this in step with `cli_bridge::plugin::CliAccessState`.
//
// Desktop-only. The `cliAccess` capability is absent on web and the block that
// reads this is omitted there, so no web path reaches it; the wasm dispatcher
// also answers `cli-bridge` with a typed refusal.

import { invoke } from "../platform/core";

/**
 * The event the CLI bridge fires after a write lands (#258).
 *
 * Mirrors `CLI_NOTES_CHANGED_EVENT` in `src-tauri/src/cli_bridge/dispatch.rs`.
 * Duplicated by hand like every other Tauri event name in this tree — nothing
 * relates a Rust string literal to a TS listener, so the two are kept in step
 * by review, and drift shows up as an editor that silently stops noticing CLI
 * writes.
 */
export const CLI_NOTES_CHANGED_EVENT = "myne://cli-notes-changed";

/** Mirrors `cli_bridge::plugin::CliAccessState` (snake_case on the wire). */
interface CliAccessStateWire {
  last_used_secs_ago: number | null;
  command_on_path: boolean;
  shim_dir: string | null;
}

/** The CLI door's session state, camelCased for the UI. */
export interface CliAccessState {
  /**
   * Whole seconds since the CLI last reached the door, or `null` for "nothing
   * since this vault was unlocked". Every outcome counts — a refused or
   * rate-limited command still reached the door, and hiding those would hide
   * exactly the runaway script the user would want to know about.
   */
  lastUsedSecsAgo: number | null;
  /**
   * Whether `myne` resolves on the live `$PATH`. `false` means the user gets
   * `command not found` no matter what the toggle says — the ordinary macOS
   * case, where `~/.local/bin` is not on `$PATH` by default.
   */
  commandOnPath: boolean;
  /**
   * The directory the PATH shim was installed into, for the line the user adds
   * themselves. `null` where there is no shim mechanism (Windows) or `$HOME`
   * could not be resolved — in which case no hint is shown rather than a
   * guessed path.
   */
  shimDir: string | null;
}

/**
 * The state a fresh process would report: door never used, command not found,
 * no shim. Also what a non-Tauri context (dev, unit tests) and a rejected
 * invoke degrade to — the block stays readable and simply claims nothing,
 * rather than throwing inside a Settings panel.
 */
export const UNKNOWN_CLI_ACCESS_STATE: CliAccessState = {
  lastUsedSecsAgo: null,
  commandOnPath: false,
  shimDir: null,
};

/**
 * Read the CLI door's session state. Read-only, no arguments, no vault access —
 * safe to poll while Settings is open.
 */
export async function readCliAccessState(): Promise<CliAccessState> {
  const wire = await invoke<CliAccessStateWire>("plugin:cli-bridge|cli_access_state");
  return {
    lastUsedSecsAgo: wire?.last_used_secs_ago ?? null,
    commandOnPath: wire?.command_on_path ?? false,
    shimDir: wire?.shim_dir ?? null,
  };
}
