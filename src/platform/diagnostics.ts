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

import { invoke } from "./core";

/**
 * Why a diagnostic-log write failed. A closed set the UI matches to a calm
 * line; the command rejects with one of these values.
 */
export type DiagnosticLogError = {
  kind: "io";
  detail: { io_error_kind: "not_found" | "permission_denied" | "no_space" | "other" };
};

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
 * The destination comes from the OS save dialog, which is why a page-supplied
 * path is admissible here: it originates in the user's own dialog, so refusing
 * it at the seam would protect nothing. The host owns everything else, including
 * every log byte.
 */
export async function saveReport(block: string, destination: string): Promise<void> {
  await invoke<void>("plugin:diagnostics|save_report", { block, destination });
}
