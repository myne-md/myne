// Platform seam: the diagnostic-log commands (myne-md/myne#860).
//
// One device-local boolean, owned by the host rather than by `vault.prefs`,
// because the log sink is installed at process start and the vault is locked
// then. The page reaches exactly these two commands and never a path and never
// a byte of log content: the block the surface renders is assembled here in
// the WebView from fields it already has.
//
// A browser has no log to write, no platform log directory to resolve and no
// folder to reveal, so the capability descriptor omits the whole surface
// rather than showing it against a command that refuses.

import type { IoFailureKind } from "@myne/client-core/types/vault-unlock-error";

import { invoke } from "./core";

/**
 * Why a diagnostic-log command failed. A closed set the UI matches to a calm
 * line; the command rejects with one of these values.
 *
 * **The wire shape is the Rust enum's, and it is NOT lowercase.** The outer tag
 * is the variant name, so it is `"Io"`; `IoFailureKind` is the repo-wide
 * canonical enum and serializes as bare PascalCase strings (`"PermissionDenied"`),
 * which is why it is imported rather than re-spelled here. A lowercased copy of
 * this type shipped once, and because `foldFailure` folded on the lowercase tag
 * every real rejection collapsed to `UNKNOWN_FAILURE`: the surface said
 * "something went wrong" for a permission error it could have named, and the
 * binding test pinned the wrong shape so nothing caught it (myne#860 review).
 */
export type DiagnosticLogError =
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  | { kind: "InvalidDestination" };

/**
 * Whether this device writes a diagnostic log.
 *
 * `false` when the flag file is absent, and `false` when it is present but
 * untrusted: a caller never has to distinguish the two, because both mean no
 * log is written.
 */
export async function diagnosticLogEnabledGet(): Promise<boolean> {
  return await invoke<boolean>("plugin:diagnostics|diagnostic_log_enabled_get");
}

/**
 * Turn the diagnostic log on or off for this device.
 *
 * Turning it off is also the erase action: the host closes the writer and
 * removes the log files in the same call. The crash record deliberately
 * survives, which is the one exception the feature's rule admits.
 */
export async function diagnosticLogEnabledSet(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:diagnostics|diagnostic_log_enabled_set", { enabled });
}

/**
 * The crash record's state: when it was written, or `null` when there is none.
 *
 * One record maximum, written by the panic hook even while the toggle is off,
 * because it is host code rather than a `tracing` call site and its payload is a
 * closed set of scalars. Its presence and date are shown rather than hidden:
 * privacy requires a no-consent artefact's existence to be visible.
 */
export interface CrashState {
  /** Whole seconds since the Unix epoch. Zero when the record is unreadable. */
  at_epoch_seconds: number;
}

/** The crash record's state, or `null` when there is none. */
export async function crashRecordState(): Promise<CrashState | null> {
  return await invoke<CrashState | null>("plugin:diagnostics|crash_record_state");
}

/**
 * Delete the crash record.
 *
 * Absent is success: the caller's intent is "no record". The report bundle
 * clears it too, once a report that included it has been written, so this is the
 * manual half of a bounded lifetime.
 */
export async function crashRecordClear(): Promise<void> {
  await invoke<void>("plugin:diagnostics|crash_record_clear");
}

/** What a saved report would contain. */
export interface ReportManifest {
  /** Log files in the bundle, the active one included. */
  log_files: number;
  /** Their total size in bytes. */
  total_bytes: number;
  /** The crash record's date, or `null` when there is no record to include. */
  crash_at_epoch_seconds: number | null;
}

/**
 * Open the log directory in the file manager.
 *
 * Takes no argument on purpose: the path is resolved host-side, so the page
 * chooses only whether the folder opens and never what opens.
 */
export async function revealLogsFolder(): Promise<void> {
  await invoke<void>("plugin:diagnostics|reveal_logs_folder");
}

/** What a saved report would contain, before anything is written. */
export async function reportManifest(): Promise<ReportManifest> {
  return await invoke<ReportManifest>("plugin:diagnostics|report_manifest");
}

/**
 * Write one plaintext report bundle to a destination the user chose.
 *
 * The destination comes from the OS save dialog, and the host re-validates it
 * anyway: a page that skipped the dialog can call this directly, and the writer
 * renames over an existing path, so the host refuses any destination that
 * resolves inside the stores this feature owns: the app data directory (which
 * holds `vaults/`), the log directory and the config directory. That is the same
 * refusal `secret_export` and `export` make, and it is why a page-supplied
 * path is admissible here at all rather than trusted. The host owns everything
 * else, including every log byte.
 */
export async function saveReport(block: string, destination: string): Promise<void> {
  await invoke<void>("plugin:diagnostics|save_report", { block, destination });
}
