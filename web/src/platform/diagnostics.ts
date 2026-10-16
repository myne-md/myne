// The diagnostic-log seam: browser implementation (myne-md/myne#860).
//
// A deliberate mirror of `src/platform/diagnostics.ts`: the browser arm keeps
// the identical signature, and there is no browser behaviour to give it. The
// feature is decided-absent on web (the PRD's `adapted` verdict, and
// `web/wasm/src/capability.rs` classifies the whole `diagnostics` plugin as
// `Unsupported`), so routing the commands into the Worker transport is the
// honest implementation: the transport answers the one typed
// `PlatformUnsupportedError`, and nothing here hand-rolls a refusal shape the
// seam contract would then have to special-case.
//
// The logging half of the surface never renders in a browser, so these
// commands are reachable only through a replayed command: exactly the path the
// typed refusal exists for.

import type { IoFailureKind } from "@myne/client-core/types/vault-unlock-error";

import { invoke } from "./core";

/**
 * Mirror of the desktop error shape, and of the Rust enum both mirror.
 *
 * The outer tag is the Rust variant name, so it is `"Io"`, and the inner
 * `IoFailureKind` serializes as bare PascalCase strings (`"PermissionDenied"`),
 * which is why that enum is imported from the shared package rather than spelled
 * out here. A lowercased, snake_cased copy of this type shipped once, and every
 * real rejection then folded to the unnamed failure.
 *
 * The union is restated rather than re-exported from `src/platform/diagnostics.ts`,
 * which is the desktop arm: the web build resolves that directory to this one, so
 * such an import would resolve to this module. The two arms are therefore held in
 * step by review, and `tests/types/rustEnumParity.test.ts` compares only the
 * desktop arm, which the parity file states in its own limits because
 * `web/src/platform` sits outside its `MIRROR_DIRS`.
 */
export type DiagnosticLogError =
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  | { kind: "InvalidDestination" };

/** Whether this device writes a diagnostic log. Browser: rejects. */
export async function diagnosticLogEnabledGet(): Promise<boolean> {
  return await invoke<boolean>("plugin:diagnostics|diagnostic_log_enabled_get");
}

/** Turn the diagnostic log on or off. Browser: rejects. */
export async function diagnosticLogEnabledSet(enabled: boolean): Promise<void> {
  await invoke<void>("plugin:diagnostics|diagnostic_log_enabled_set", { enabled });
}

/** Mirror of the desktop shape; the command refuses before it can occur. */
export interface CrashState {
  at_epoch_seconds: number;
}

/** The crash record's state. Browser: rejects. */
export async function crashRecordState(): Promise<CrashState | null> {
  return await invoke<CrashState | null>("plugin:diagnostics|crash_record_state");
}

/** Delete the crash record. Browser: rejects. */
export async function crashRecordClear(): Promise<void> {
  await invoke<void>("plugin:diagnostics|crash_record_clear");
}

/** Mirror of the desktop shape; the command refuses before it can occur. */
export interface ReportManifest {
  log_files: number;
  total_bytes: number;
  crash_at_epoch_seconds: number | null;
}

/** Open the log directory. Browser: rejects. */
export async function revealLogsFolder(): Promise<void> {
  await invoke<void>("plugin:diagnostics|reveal_logs_folder");
}

/** What a saved report would contain. Browser: rejects. */
export async function reportManifest(): Promise<ReportManifest> {
  return await invoke<ReportManifest>("plugin:diagnostics|report_manifest");
}

/** Write a report bundle. Browser: rejects. */
export async function saveReport(block: string, destination: string): Promise<void> {
  await invoke<void>("plugin:diagnostics|save_report", { block, destination });
}
