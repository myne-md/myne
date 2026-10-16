// The diagnostics plugin's host state (myne-md/myne#860).
//
// Owns the two things the About surface reads from the host: the device-local
// logging switch and the one crash record. Both come from the same plugin and
// both are device-local, which is why they share a hook rather than each getting
// their own: the surface renders them as one story, and two hooks would read two
// halves of the same directory.
//
// They are NOT preferences, which is why this does not go through `usePrefs`:
// the flag is a plaintext file read at process start, before any vault unlocks,
// so it has no prefs nonce to bump and no sibling `usePrefs` instance to notify.
//
// Gated on the `diagnosticLog` capability rather than on a runtime probe. On web
// the capability is absent, so the effect reads nothing and the surface that
// renders this hook is omitted rather than shown against a command that refuses
// (`decisions.md` 2026-07-26, and `src/platform/capabilities.ts`).

import { useCallback, useEffect, useState } from "react";
import { has } from "../platform/capabilities";
import { save as saveDialog } from "../platform/dialog";
import {
  crashRecordClear,
  crashRecordState,
  diagnosticLogEnabledGet,
  diagnosticLogEnabledSet,
  reportManifest,
  revealLogsFolder,
  saveReport,
  type CrashState,
  type DiagnosticLogError,
  type ReportManifest,
} from "../platform/diagnostics";

/** A rejected command with no structured payload, folded into the closed set. */
const UNKNOWN_FAILURE: DiagnosticLogError = {
  kind: "io",
  detail: { io_error_kind: "other" },
};

export interface DiagnosticsState {
  /** Whether this device writes a diagnostic log. False until the read lands. */
  enabled: boolean;
  /** True while the initial read is in flight; false once it settles. */
  loading: boolean;
  /** The last command failure, cleared on the next attempt. */
  error: DiagnosticLogError | null;
  /** The crash record, or `null` when there is none. */
  crash: CrashState | null;
  /** What a saved report would contain, or `null` before the first read. */
  manifest: ReportManifest | null;
  /** Flip the log switch. Resolves once the host has answered. */
  setEnabled: (enabled: boolean) => Promise<void>;
  /** Delete the crash record. Resolves `false` when the host refused. */
  clearCrash: () => Promise<boolean>;
  /** Open the log directory. Resolves `false` when the host refused. */
  reveal: () => Promise<boolean>;
  /**
   * Save one report bundle: ask for a destination, write it, then re-read the
   * manifest and the crash record (a bundle that included the record clears it).
   *
   * A discriminated result rather than a boolean, because a CANCELLED dialog is
   * not a failure and reporting it as one would tell the user something broke
   * when nothing was attempted.
   */
  saveReport: (block: string) => Promise<"saved" | "cancelled" | "failed">;
}

/**
 * Read and change the device-local diagnostic-log switch and crash record.
 *
 * Best effort in the same direction as the flag itself: a failed read leaves the
 * surface showing "off" and no crash record, which are the states in which
 * nothing is written, so a broken read can never be mistaken for consent or for
 * a clean history.
 */
export function useDiagnostics(): DiagnosticsState {
  const available = has("diagnosticLog");
  const [enabled, setEnabledState] = useState(false);
  const [loading, setLoading] = useState(available);
  const [error, setError] = useState<DiagnosticLogError | null>(null);
  const [crash, setCrash] = useState<CrashState | null>(null);
  const [manifest, setManifest] = useState<ReportManifest | null>(null);

  useEffect(() => {
    if (!available) return;
    // An effect that resolves late must not write into a state the component has
    // already moved past. `cancelled` is per-run, so a StrictMode double invoke
    // simply reads twice and the surviving run settles the state.
    let cancelled = false;
    Promise.all([
      diagnosticLogEnabledGet().catch(() => false),
      crashRecordState().catch(() => null),
      reportManifest().catch(() => null),
    ])
      .then(([flag, record, manifest]) => {
        if (cancelled) return;
        setEnabledState(flag);
        setCrash(record);
        setManifest(manifest);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [available]);

  const refresh = useCallback(async () => {
    const [record, next] = await Promise.all([
      crashRecordState().catch(() => null),
      reportManifest().catch(() => null),
    ]);
    setCrash(record);
    setManifest(next);
  }, []);

  const setEnabled = useCallback(
    async (next: boolean) => {
      setError(null);
      try {
        await diagnosticLogEnabledSet(next);
        setEnabledState(next);
        // The manifest is the consent half of the file-save decision (how many
        // log files and how big), so it has to move when the switch does: turning
        // logging ON and then reading a stale "Myne has not read the log yet"
        // makes that reading wrong on the very act the feature exists for. It
        // also re-reads the crash record, which the erase path leaves alone.
        await refresh();
      } catch (raw) {
        setError(foldFailure(raw));
      }
    },
    [refresh],
  );

  const clearCrash = useCallback(async () => {
    try {
      await crashRecordClear();
      setCrash(null);
      setManifest((current) =>
        current === null ? null : { ...current, crash_at_epoch_seconds: null },
      );
      return true;
    } catch {
      // Deliberately NOT `setError`: the row's error text says "Myne could not
      // change that setting", which is the wrong sentence for a failed delete on
      // a different row. The caller reports it where the action happened.
      return false;
    }
  }, []);

  const reveal = useCallback(async () => {
    try {
      await revealLogsFolder();
      return true;
    } catch {
      return false;
    }
  }, []);

  const saveReportTo = useCallback(
    async (block: string): Promise<"saved" | "cancelled" | "failed"> => {
      const destination = await saveDialog({
        defaultPath: "myne-report.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      }).catch(() => null);
      // A cancelled dialog is not a failure and must not read as one: nothing
      // was attempted, so nothing is reported.
      if (typeof destination !== "string") return "cancelled";
      try {
        await saveReport(block, destination);
        await refresh();
        return "saved";
      } catch {
        return "failed";
      }
    },
    [refresh],
  );

  return {
    enabled,
    loading,
    error,
    crash,
    manifest,
    setEnabled,
    clearCrash,
    reveal,
    saveReport: saveReportTo,
  };
}

/** A rejected command, as the closed error set the surface matches on. */
function foldFailure(raw: unknown): DiagnosticLogError {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "kind" in raw &&
    (raw as { kind: unknown }).kind === "io" &&
    "detail" in raw
  ) {
    return raw as DiagnosticLogError;
  }
  return UNKNOWN_FAILURE;
}
