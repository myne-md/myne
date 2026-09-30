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
import { Trans, useTranslation } from "react-i18next";
import { open as openFileDialog } from "../platform/dialog";
import { Button } from "../components/primitives/Button";
import { CenteredCard } from "../components/primitives/CenteredCard";
import {
  isBackupRestoreError,
  restoreErrorMessage,
  restoreFailureMessage,
  unknownRestoreMessage,
} from "../lib/backup-errors";
import {
  backupCancel,
  onBackupProgress,
  restoreBackup,
} from "../lib/vault-backup";
import type {
  BackupProgress,
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
  const { t } = useTranslation();
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
      // Narrow rather than cast (myne#662). The cast was worse here than in the
      // export modal: it read `.kind` and `.detail.vault_id` off an unvalidated
      // value, so a throw from outside the enum either fell through to
      // `restoreErrorMessage` and rendered `undefined`, or threw a TypeError
      // inside the catch block itself.
      if (!isBackupRestoreError(raw)) {
        // `unknownRestoreMessage`, not `restoreFailureMessage`: the latter
        // re-runs the guard we just answered, and would always take its
        // fallback arm.
        setState({ step: "error", message: unknownRestoreMessage() });
        return;
      }
      const e = raw;
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
    // Dismissed and FAILED are two different outcomes, and a `.catch(() => null)`
    // here collapsed them into one (myne#662, the same defect the export modal
    // fixed one file over). A dialog that THROWS, a capability-ACL denial, a
    // platform failure, a renamed command, was indistinguishable from the user
    // pressing Cancel: the function returned and the screen said nothing at all.
    // This is the screen somebody reaches after losing a vault, so a Choose-file
    // button that does nothing and explains nothing is the worst place for it.
    let picked: string | string[] | null;
    try {
      picked = await openFileDialog({
        multiple: false,
        filters: [{ name: "Myne backup", extensions: ["myne-backup"] }],
      });
    } catch (raw) {
      setState({ step: "error", message: restoreFailureMessage(raw) });
      return;
    }
    if (typeof picked === "string") {
      void runRestore(picked);
    }
  }

  const backLabel =
    entry === "settings" ? t("restore.backLabel") : t("restore.cancelLabel");

  return (
    <CenteredCard>
      <div
        data-testid="restore.root"
        style={{ display: "flex", flexDirection: "column", gap: 20 }}
      >
        <div
          style={{
            fontSize: "var(--text-xl)",
            fontWeight: "var(--weight-semibold)",
            letterSpacing: "-0.015em",
            color: "var(--fg-display)",
          }}
        >
          {t("restore.title")}
        </div>

        {state.step === "pick" && (
          <>
            <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
              <Trans
                i18nKey="restore.pick.body"
                components={{ code: <code /> }}
              />
              {entry === "corrupted" && (
                <>
                  {" "}
                  {t("restore.pick.corruptedSuffix")}
                </>
              )}
            </div>
            {/* Back on the left, the step's action on the right: the footer
                every first-run step uses. */}
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <Button
                variant="ghost"
                icon="arrow-left"
                onClick={onExit}
                data-testid="restore.back"
              >
                {backLabel}
              </Button>
              <div style={{ flex: 1 }} />
              <Button
                variant="primary"
                onClick={() => void pickFile()}
                data-testid="restore.pick-file"
              >
                {t("restore.pick.chooseFile")}
              </Button>
            </div>
          </>
        )}

        {state.step === "working" && (
          <>
            <div
              data-testid="restore.progress"
              style={{ fontSize: "var(--text-base)", color: "var(--fg-2)" }}
            >
              {state.progress === null
                ? t("restore.working.verifying")
                : state.progress.phase === "verify"
                  ? t("restore.working.verifyingProgress", {
                      done: state.progress.done,
                      total: state.progress.total,
                    })
                  : t("restore.working.restoringProgress", {
                      done: state.progress.done,
                      total: state.progress.total,
                    })}
            </div>
            <div>
              <Button
                variant="secondary"
                onClick={() => void backupCancel()}
                data-testid="restore.cancel"
              >
                {t("restore.working.cancel")}
              </Button>
            </div>
          </>
        )}

        {state.step === "collision" && (
          <>
            <div
              data-testid="restore.collision"
              style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}
            >
              {t("restore.collision.body")}
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <Button
                variant="primary"
                onClick={() =>
                  void runRestore(state.source, { on_collision: "keep-both" })
                }
                data-testid="restore.keep-both"
              >
                {t("restore.collision.keepBoth")}
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
                {t("restore.collision.replaceExisting")}
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
              style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}
            >
              {t("restore.damaged.body")}
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <Button
                variant="secondary"
                onClick={() => void runRestore(state.source, { salvage: true })}
                data-testid="restore.salvage"
              >
                {t("restore.damaged.salvage")}
              </Button>
              <Button variant="secondary" onClick={onExit}>
                {t("restore.damaged.close")}
              </Button>
            </div>
          </>
        )}

        {state.step === "summary" && (
          <>
            <div
              data-testid="restore.summary"
              style={{ fontSize: "var(--text-base)", lineHeight: 1.8, color: "var(--fg-2)" }}
            >
              <div style={{ color: "var(--fg-1)", fontWeight: "var(--weight-semibold)" }}>
                {state.outcome.skipped.length > 0
                  ? t("restore.summary.partialHeader", {
                      count: state.outcome.skipped.length,
                    })
                  : t("restore.summary.restored")}
              </div>
              <div>
                {t("restore.summary.notes", { n: state.outcome.notes })}
              </div>
              <div>
                {t("restore.summary.versionHistory", {
                  n: state.outcome.snapshots,
                })}
              </div>
              <div>
                {t("restore.summary.attachments", {
                  n: state.outcome.attachments,
                })}
              </div>
              {state.outcome.collided_vault_id !== null && (
                <div style={{ marginTop: "var(--space-2)" }}>
                  {t("restore.summary.collidedNote")}
                </div>
              )}
              {state.outcome.skipped.length > 0 && (
                <div
                  data-testid="restore.skipped-list"
                  style={{
                    marginTop: "var(--space-2)",
                    padding: "8px 12px",
                    background: "var(--paper-2)",
                    border: "1px solid var(--line-1)",
                    borderRadius: "var(--radius-2)",
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
                {t("restore.summary.openVaultList")}
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
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <Button variant="secondary" onClick={() => setState({ step: "pick" })}>
                {t("restore.error.tryAnotherFile")}
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
