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
import { openSaveDialog, type SaveOutcome } from "../lib/save-dialog";
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
  kind: "Io",
  detail: { io_error_kind: "Other" },
};

/**
 * Which read or change failed, so the surface renders the sentence that matches.
 *
 * A failed READ gets its own arm because the row's change sentence ("Myne could
 * not change that setting") describes an action the user never took: the read
 * runs on mount, the switch is still off and untouched, and reporting a failed
 * change beside it is false. `clearCrash` refuses the same reuse one function
 * down. The state still folds to off either way, which is the direction in which
 * nothing is written.
 */
export type DiagnosticsFailure =
  | { source: "read" }
  | { source: "change"; error: DiagnosticLogError };

export interface DiagnosticsState {
  /** Whether this device writes a diagnostic log. False until the read lands. */
  enabled: boolean;
  /** True while the initial read is in flight; false once it settles. */
  loading: boolean;
  /** The last command failure, cleared on the next attempt. */
  error: DiagnosticsFailure | null;
  /** The crash record, or `null` when there is none. */
  crash: CrashState | null;
  /**
   * True when the crash record could not be READ, so its absence is unknown.
   *
   * Recorded rather than folded away: `crash === null` with this false means the
   * host answered "no record", while true means the host could not answer. A
   * no-consent artefact's existence must stay visible, and a refused read is not
   * the same statement as there being nothing to show.
   */
  crashReadFailed: boolean;
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
  saveReport: (block: string) => Promise<SaveOutcome>;
}

/**
 * Read and change the device-local diagnostic-log switch and crash record.
 *
 * Best effort in the same direction as the flag itself: a failed read leaves the
 * surface showing "off" and no crash record, which are the states in which
 * nothing is written, so a broken read can never be mistaken for consent. It is
 * not the same as a clean history either, which is why both read failures are
 * recorded (`error` for the flag, `crashReadFailed` for the record) rather than
 * folded into the benign answer.
 */
export function useDiagnostics(): DiagnosticsState {
  const available = has("diagnosticLog");
  const [enabled, setEnabledState] = useState(false);
  const [loading, setLoading] = useState(available);
  const [error, setError] = useState<DiagnosticsFailure | null>(null);
  const [crash, setCrash] = useState<CrashState | null>(null);
  const [crashReadFailed, setCrashReadFailed] = useState(false);
  const [manifest, setManifest] = useState<ReportManifest | null>(null);

  useEffect(() => {
    if (!available) return;
    // An effect that resolves late must not write into a state the component has
    // already moved past. `cancelled` is per-run, so a StrictMode double invoke
    // simply reads twice and the surviving run settles the state.
    let cancelled = false;
    Promise.all([
      // A refused READ is folded to the safe state, because a state nobody can
      // read is a state in which no log is written. What it must not be is
      // SILENT: the fold used to be indistinguishable from a real "off", which
      // is a wiring failure reporting itself as a benign answer
      // (myne#860 review). So it is recorded as a READ failure, which the surface
      // renders with its own sentence rather than the change sentence.
      diagnosticLogEnabledGet().catch(() => {
        if (!cancelled) setError({ source: "read" });
        return false;
      }),
      // `undefined` is the sentinel for a refused read, so the resolve branch can
      // tell it from the host answering "no record" with `null`.
      crashRecordState().catch(() => undefined),
      // `?? null` rather than a bare `.catch`: `invoke<T>` is an unchecked cast,
      // so a host that RESOLVES `undefined` (rather than rejecting) put
      // `undefined` into a state whose type says `ReportManifest | null`, and the
      // panel's `=== null` guard let it through to `.log_files` and crashed the
      // whole About panel. A non-answer is "we do not know", which is a state the
      // surface already has a sentence for.
      reportManifest()
        .then((manifest) => manifest ?? null)
        .catch(() => null),
    ])
      .then(([flag, record, manifest]) => {
        if (cancelled) return;
        // `flag === true` rather than a bare `flag`: `invoke<T>` is an unchecked
        // cast, so a host that RESOLVES a non-boolean (the catalogue's fake IPC
        // answers `""` for a command it does not know) put that value into a
        // state whose type says `boolean`. `aria-checked=""` is not a valid state
        // token, so axe reported the switch as missing its required attribute and
        // a screen reader announced no state at all. Same shape as the manifest's
        // `?? null` below, one field over: coerce the unchecked answer at the
        // boundary rather than trusting it downstream.
        setEnabledState(flag === true);
        if (record === undefined) {
          setCrashReadFailed(true);
        } else {
          setCrash(record);
        }
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
      // The same sentinel as the initial load: a refused read is recorded, so the
      // surface says it could not read the record rather than showing none.
      crashRecordState().catch(() => undefined),
      // The same `?? null` as the initial load, for the same reason: a resolved
      // `undefined` is a non-answer, not a manifest.
      reportManifest()
        .then((manifest) => manifest ?? null)
        .catch(() => null),
    ]);
    if (record === undefined) {
      setCrashReadFailed(true);
    } else {
      setCrash(record);
      setCrashReadFailed(false);
    }
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
        setError({ source: "change", error: foldFailure(raw) });
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
    async (block: string): Promise<SaveOutcome> => {
      // A dialog that FAILS to open is not a cancel, and collapsing the two
      // leaves a dead button with no toast while `diagnosticSaveFailed` exists
      // for exactly that outcome (myne#860 review). The separation is
      // `save-dialog.ts`'s now, shared with the two `secret-export` savers and
      // with `noteImageExport`, so the four surfaces cannot spell it four ways —
      // which is where the `"failed"` versus `"error"` split came from (R1.7).
      const target = await openSaveDialog("myne-report.txt", [
        { name: "Text", extensions: ["txt"] },
      ]);
      if (target.kind === "failed") return "failed";
      if (target.kind === "cancelled") return "cancelled";
      try {
        await saveReport(block, target.path);
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
    crashReadFailed,
    manifest,
    setEnabled,
    clearCrash,
    reveal,
    saveReport: saveReportTo,
  };
}

/** A rejected command, as the closed error set the surface matches on. */
function foldFailure(raw: unknown): DiagnosticLogError {
  if (typeof raw === "object" && raw !== null && "kind" in raw) {
    // The tag is the RUST VARIANT NAME, so it is `"Io"` and not `"io"`. Folding
    // on a lowercased tag made every real rejection collapse to
    // `UNKNOWN_FAILURE`, which the surface renders as an unnamed failure
    // (myne#860 review).
    if ((raw as { kind: unknown }).kind === "Io" && "detail" in raw) {
      return raw as DiagnosticLogError;
    }
    if ((raw as { kind: unknown }).kind === "InvalidDestination") {
      return { kind: "InvalidDestination" };
    }
  }
  return UNKNOWN_FAILURE;
}
