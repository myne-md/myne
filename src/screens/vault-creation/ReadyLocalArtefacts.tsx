// The two local-disk affordances on the "vault created" step, extracted so the
// web build can substitute them away (`decisions.md` 2026-08-15).
//
// # Why one module rather than two capability checks
//
// "Back up now" writes a `.myne-backup` file through a native save dialog, and
// "Show vault folder" opens a directory in the OS file manager. Both are absent
// on the web client and for the same underlying reason: there is no disk it can
// name. `backup` and `nativeSaveAs` are both absent capabilities there, and OPFS
// has no path to reveal.
//
// Gating them at runtime was not enough, exactly as it was not enough for the
// enrolment phrase grid: `scripts/check-web-surfaces.mjs` reads the BUILT
// artefact, and a runtime branch leaves `src/lib/vault-backup.ts` and its five
// `plugin:backup|*` command names in the bundle — a module whose whole verdict
// is `excluded`. Substituting the one module that imports it removes the import
// EDGE, so the served code cannot reach those commands however the branch is
// later refactored.
//
// # Why creation is where this bit
//
// This step was inside a screen that used to be substituted wholesale, so its
// imports never reached the web bundle and nothing here needed a verdict. The
// moment creation shipped on web (2026-08-15) every one of its transitive
// imports became served code, and the surfaces gate said so within a minute of
// the first build. That is the gate working, and it is the reason a
// screen-level verdict is not a substitute for a module-level one.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/primitives/Button";
import { logErrorKind } from "../../lib/vault-creation-logging";
import { backupDefaultFilename, exportBackup } from "../../lib/vault-backup";
import { save as saveFileDialog } from "../../platform/dialog";
import { appDataDir, join } from "../../platform/path";
import { openPath } from "../../platform/opener";

export interface ReadyLocalArtefactsProps {
  /** Disables both controls while the chained auto-unlock is in flight. */
  pending: boolean;
  /** The vault `commit` just wrote; targets both the backup and the reveal. */
  vaultId: string | null;
}

export function ReadyLocalArtefacts({ pending, vaultId }: ReadyLocalArtefactsProps) {
  const { t } = useTranslation();
  // First-backup CTA (MYND-56 task 7, B13(b)): inline and non-blocking — the
  // user is at peak recovery-mindset (phrase just written down), and a fresh
  // vault's backup is a second copy of vault.meta (the credential wraps), the
  // repair scenario's raw material. The vault is still LOCKED here (auto-unlock
  // fires on Done) — locked export is supported by design (SYNC-6).
  const [backupState, setBackupState] = useState<"idle" | "saving" | "done" | "error">(
    "idle",
  );

  const handleBackupNow = async () => {
    setBackupState("saving");
    try {
      const suggested = await backupDefaultFilename().catch(() =>
        t("vaultCreation.ready.backupDefaultFilename"),
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
      // `vaultId` is always populated here (CreateVault passes the committed id
      // once commit succeeds); the null arm is type-level defense only —
      // sole-vault targeting would misfire under multi-vault.
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
        vaultId != null ? await join(base, "vaults", vaultId) : await join(base, "vault");
      await openPath(dir);
    } catch (e) {
      logErrorKind(e, "show-vault-folder-failed");
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        icon="download"
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
        variant="ghost"
        icon="folder"
        onClick={handleShowVaultFolder}
        disabled={pending}
        data-testid="create.ready-show-folder"
      >
        {t("vaultCreation.ready.showFolder")}
      </Button>
      {backupState === "error" && (
        <div
          data-testid="create.ready-backup-error"
          style={{
            flexBasis: "100%",
            fontSize: "var(--text-sm)",
            color: "var(--fg-2)",
            textAlign: "center",
          }}
        >
          {t("vaultCreation.ready.backupError")}
        </div>
      )}
    </>
  );
}
