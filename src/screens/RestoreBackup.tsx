// Restore-from-backup Stage screen (MYND-56 / MYND-218; epic MYND-217).
//
// One screen serves all four entries (welcome / picker / corrupted-vault /
// Settings) — pre-unlock-class, so a Stage screen, never a modal (the
// 2026-05-08 carve-out is post-unlock-only). Exit is reprobe-based: the
// caller's `onExit` re-runs boot routing, so after a successful restore the
// user lands wherever slot-priority routing says (picker at ≥2 vaults).
//
// State machine (local; the engine owns all validation/placement):
//   pick → working(progress) → summary
//                ├→ collision  (no intent declared; user chooses)
//                ├→ damaged    (default all-or-nothing reject; explicit
//                │              salvage opt-in re-invokes with salvage)
//                └→ error      (everything else, honest closed-enum copy)
//
// Copy discipline: threat-model §7 is the cap; "backup" terminology only.
// Replace-existing here only RECORDS the intent — the actual deletion of
// the matched vault stays behind the existing typed-confirm vault_delete
// flow (SYNC-5: the engine never deletes; the picker's delete flow is the
// chained step the summary points the user at).

import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "../components/primitives/Button";
import { CenteredCard } from "../components/primitives/CenteredCard";
import { restoreErrorMessage } from "../lib/backup-errors";
import {
  backupCancel,
  onBackupProgress,
  restoreBackup,
} from "../lib/vault-backup";
import type {
  BackupProgress,
  BackupRestoreError,
  CollisionIntent,
  RestoreOutcome,
} from "../types/backup-export-error";

interface RestoreBackupProps {
  /** Copy/back-label context only — the flow is identical for all entries. */
  entry: "welcome" | "picker" | "corrupted" | "settings";
  /** Reprobe-based exit (cancel AND done) — App.tsx's `reprobe()`. */
  onExit: () => void;
}

type RestoreState =
  | { step: "pick" }
  | { step: "working"; progress: BackupProgress | null }
  | { step: "collision"; source: string; existingVaultId: string }
  | { step: "damaged"; source: string }
  | { step: "summary"; outcome: RestoreOutcome }
  | { step: "error"; message: string };

export function RestoreBackup({ entry, onExit }: RestoreBackupProps) {
  const [state, setState] = useState<RestoreState>({ step: "pick" });

  // Progress subscription lives for the screen's lifetime; payloads are
  // counts-only (SYNC-7).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void onBackupProgress((progress) => {
      setState((prev) =>
        prev.step === "working" ? { step: "working", progress } : prev,
      );
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function runRestore(source: string, options?: {
    on_collision?: CollisionIntent;
    salvage?: boolean;
  }) {
    setState({ step: "working", progress: null });
    try {
      const outcome = await restoreBackup(source, options);
      setState({ step: "summary", outcome });
    } catch (raw) {
      const e = raw as BackupRestoreError;
      if (e.kind === "VaultAlreadyExists") {
        setState({
          step: "collision",
          source,
          existingVaultId: e.detail.vault_id,
        });
      } else if (e.kind === "DamagedBackup" && !options?.salvage) {
        setState({ step: "damaged", source });
      } else {
        setState({ step: "error", message: restoreErrorMessage(e) });
      }
    }
  }

  async function pickFile() {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "Myne backup", extensions: ["myne-backup"] }],
    }).catch(() => null);
    if (typeof picked === "string") {
      void runRestore(picked);
    }
  }

  const backLabel = entry === "settings" ? "Back" : "Cancel";

  return (
    <CenteredCard>
      <div
        data-testid="restore.root"
        style={{ display: "flex", flexDirection: "column", gap: 20 }}
      >
        <div
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "-0.015em",
            color: "var(--fg-display)",
          }}
        >
          Restore from backup
        </div>

        {state.step === "pick" && (
          <>
            <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-2)" }}>
              Pick a <code>.myne-backup</code> file. The backup is verified
              before anything is restored; the restored vault unlocks with
              that vault's password or recovery phrase — exactly like unlock.
              {entry === "corrupted" && (
                <>
                  {" "}
                  Your current vault is not touched: the backup is restored as
                  a separate vault first.
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                variant="primary"
                onClick={() => void pickFile()}
                data-testid="restore.pick-file"
              >
                Choose backup file…
              </Button>
              <Button variant="secondary" onClick={onExit} data-testid="restore.back">
                {backLabel}
              </Button>
            </div>
          </>
        )}

        {state.step === "working" && (
          <>
            <div
              data-testid="restore.progress"
              style={{ fontSize: 14, color: "var(--fg-2)" }}
            >
              {state.progress === null
                ? "Verifying backup…"
                : state.progress.phase === "verify"
                  ? `Verifying backup… ${state.progress.done} of ${state.progress.total}`
                  : `Restoring… ${state.progress.done} of ${state.progress.total}`}
            </div>
            <div>
              <Button
                variant="secondary"
                onClick={() => void backupCancel()}
                data-testid="restore.cancel"
              >
                Cancel
              </Button>
            </div>
          </>
        )}

        {state.step === "collision" && (
          <>
            <div
              data-testid="restore.collision"
              style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-2)" }}
            >
              A vault from this backup already exists on this device. You can
              keep both — the restored copy appears as a separate vault in
              your vault list — or restore now and then remove the existing
              vault from the vault list yourself (removal asks you to type
              DELETE, and only makes sense after you confirm the restored
              vault opens).
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                variant="primary"
                onClick={() =>
                  void runRestore(state.source, { on_collision: "keep-both" })
                }
                data-testid="restore.keep-both"
              >
                Keep both
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  void runRestore(state.source, {
                    on_collision: "replace-existing",
                  })
                }
                data-testid="restore.replace-existing"
              >
                Restore, then replace existing…
              </Button>
              <Button variant="secondary" onClick={onExit}>
                {backLabel}
              </Button>
            </div>
          </>
        )}

        {state.step === "damaged" && (
          <>
            <div
              data-testid="restore.damaged"
              style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-2)" }}
            >
              The backup file is damaged, so nothing was restored. If this is
              the only copy you have, salvage can restore the intact notes and
              list exactly what could not be read — the result is always
              labeled as a partial restore.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button
                variant="secondary"
                onClick={() => void runRestore(state.source, { salvage: true })}
                data-testid="restore.salvage"
              >
                Salvage intact notes…
              </Button>
              <Button variant="secondary" onClick={onExit}>
                Close
              </Button>
            </div>
          </>
        )}

        {state.step === "summary" && (
          <>
            <div
              data-testid="restore.summary"
              style={{ fontSize: 14, lineHeight: 1.8, color: "var(--fg-2)" }}
            >
              <div style={{ color: "var(--fg-1)", fontWeight: 600 }}>
                {state.outcome.skipped.length > 0
                  ? `Restored partially — ${state.outcome.skipped.length} item${state.outcome.skipped.length === 1 ? "" : "s"} could not be read.`
                  : "Vault restored."}
              </div>
              <div>Notes: {state.outcome.notes}</div>
              <div>Version history entries: {state.outcome.snapshots}</div>
              <div>Attachments: {state.outcome.attachments}</div>
              {state.outcome.collided_vault_id !== null && (
                <div style={{ marginTop: 8 }}>
                  The previously existing copy of this vault is still in your
                  vault list. Once you confirm the restored vault opens, you
                  can remove the old one from the vault list (it will ask you
                  to type DELETE).
                </div>
              )}
              {state.outcome.skipped.length > 0 && (
                <div
                  data-testid="restore.skipped-list"
                  style={{
                    marginTop: 8,
                    padding: "8px 12px",
                    background: "var(--paper-2)",
                    border: "1px solid var(--line-1)",
                    borderRadius: 6,
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    maxHeight: 160,
                    overflowY: "auto",
                  }}
                >
                  {state.outcome.skipped.map((path) => (
                    <div key={path}>{path}</div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Button
                variant="primary"
                onClick={onExit}
                data-testid="restore.done"
              >
                Open vault list
              </Button>
            </div>
          </>
        )}

        {state.step === "error" && (
          <>
            <div
              data-testid="restore.error"
              style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-2)" }}
            >
              {state.message}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="secondary" onClick={() => setState({ step: "pick" })}>
                Try another file
              </Button>
              <Button variant="secondary" onClick={onExit}>
                {backLabel}
              </Button>
            </div>
          </>
        )}
      </div>
    </CenteredCard>
  );
}
