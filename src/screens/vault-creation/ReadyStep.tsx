// Endpoint screen — vault.meta has just been written to disk.
//
// Implements design session 2026-04-28-vault-creation-frontend.md Q9:
//   - No eyebrow (endpoint, not a numbered step).
//   - Success indicator: circle-check icon, var(--success).
//   - "Show vault folder" → @tauri-apps/plugin-opener opens OS file
//     manager at app_data_dir/vault/ (built via @tauri-apps/api/path
//     `appDataDir()` + `join("vault")`).
//   - "Done" → calls the `onDone` callback prop. The orchestrator
//     (<CreateVault>) wires it through to App.tsx, which transitions
//     the stage to the terminal `editor` screen. Originally this called
//     `getCurrentWindow().close()`; revised by
//     agent-tooling/features/empty-editor-shell/prd.md (2026-04-28).
//     Vault-detected Welcome and lock/relock semantics remain a future
//     vault-unlock feature — until then, the editor is terminal and
//     there is no path back to Welcome from inside it.
//
// Window-close prompt (Task 12) explicitly excludes ReadyStep — vault
// is committed, no progress to discard.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { appDataDir, join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { logErrorKind } from "../../lib/vault-creation-logging";
import { backupDefaultFilename, exportBackup } from "../../lib/vault-backup";
import { StepHeading, StepLayout } from "./step-shell";

interface ReadyStepProps {
  onDone: () => void;
  /**
   * True while the auto-unlock IPC is in flight (PRD Q4(a)). Disables
   * both buttons and switches the "Done" label to "Decrypting…" so
   * the user sees that the click registered and Argon2id is running
   * (~1s baseline). False during the brief window between mount and
   * "Done" click.
   */
  pending?: boolean;
  /**
   * The vault `commit` just wrote (`vaults/<id>/`) — the "Show vault
   * folder" target (MYND-219 / SYNC-16: the pre-multi-vault `vault/`
   * path no longer exists). `null` only on the legacy sole-vault path,
   * where the affordance falls back to the legacy dir.
   */
  vaultId?: string | null;
}

export function ReadyStep({ onDone, pending = false, vaultId = null }: ReadyStepProps) {
  const { t } = useTranslation();
  // First-backup CTA (MYND-56 task 7, B13(b)): inline and non-blocking —
  // the user is at peak recovery-mindset (phrase just written down), and a
  // fresh vault's backup is a second copy of vault.meta (the credential
  // wraps), the repair scenario's raw material. The vault is still LOCKED
  // here (auto-unlock fires on Done) — locked export is supported by
  // design (SYNC-6). No modal stacking with the importer onboarding offer.
  const [backupState, setBackupState] = useState<"idle" | "saving" | "done" | "error">(
    "idle",
  );
  const handleBackupNow = async () => {
    setBackupState("saving");
    try {
      const suggested = await backupDefaultFilename().catch(
        () => t("vaultCreation.ready.backupDefaultFilename"),
      );
      const destination = await saveFileDialog({
        defaultPath: suggested,
        filters: [
          { name: t("vaultCreation.ready.backupFilterName"), extensions: ["myne-backup"] },
        ],
      });
      if (typeof destination !== "string") {
        setBackupState("idle"); // dialog dismissed — nothing started
        return;
      }
      // `vaultId` is always populated here (CreateVault passes the
      // committed id once commit succeeds); the null arm is type-level
      // defense only — sole-vault targeting would misfire under multi-vault.
      await exportBackup(destination, vaultId ?? undefined);
      setBackupState("done");
    } catch (e) {
      logErrorKind(e, "ready-step-backup-failed");
      setBackupState("error");
    }
  };

  const handleShowVaultFolder = async () => {
    try {
      const base = await appDataDir();
      const dir =
        vaultId != null
          ? await join(base, "vaults", vaultId)
          : await join(base, "vault");
      await openPath(dir);
    } catch (e) {
      logErrorKind(e, "show-vault-folder-failed");
    }
  };

  return (
    <StepLayout align="center">
      <div style={{ color: "var(--success)" }}>
        <Icon name="circle-check" size={36} />
      </div>

      <StepHeading centered>{t("vaultCreation.ready.heading")}</StepHeading>

      <div
        style={{
          fontSize: 14,
          lineHeight: 1.6,
          color: "var(--fg-2)",
          textAlign: "center",
          maxWidth: 360,
        }}
      >
        {t("vaultCreation.ready.body")}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Button
          variant="ghost"
          icon="folder"
          onClick={handleShowVaultFolder}
          disabled={pending}
          data-testid="create.ready-show-folder"
        >
          {t("vaultCreation.ready.showFolder")}
        </Button>
        <Button
          variant="secondary"
          onClick={handleBackupNow}
          disabled={pending || backupState === "saving" || backupState === "done"}
          data-testid="create.ready-backup-now"
        >
          {backupState === "saving"
            ? t("vaultCreation.ready.backingUp")
            : backupState === "done"
              ? t("vaultCreation.ready.backedUp")
              : t("vaultCreation.ready.backUpNow")}
        </Button>
        <Button
          variant="primary"
          onClick={onDone}
          disabled={pending}
          data-testid="create.ready-done"
        >
          {pending ? t("vaultCreation.ready.decrypting") : t("vaultCreation.ready.done")}
        </Button>
      </div>
      {backupState === "error" && (
        <div
          data-testid="create.ready-backup-error"
          style={{ fontSize: 13, color: "var(--fg-2)", textAlign: "center" }}
        >
          {t("vaultCreation.ready.backupError")}
        </div>
      )}
    </StepLayout>
  );
}
