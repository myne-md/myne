// Endpoint screen — vault.meta has just been written to disk.
//
// Implements design session 2026-04-28-vault-creation-frontend.md Q9:
//   - No eyebrow (endpoint, not a numbered step).
//   - Success indicator: circle-check icon, var(--success).
//   - "Show vault folder" → the platform seam's opener module opens the OS
//     file manager at app_data_dir/vault/ (built via the seam's path module
//     `appDataDir()` + `join("vault")`).
//   - "Done" → calls the `onDone` callback prop. The orchestrator
//     (<CreateVault>) wires it through to App.tsx, which transitions
//     the stage to the terminal `editor` screen. Originally this called
//     `getCurrentWindow().close()`; revised by
//     myne-agents/features/empty-editor-shell/prd.md (2026-04-28).
//     Vault-detected Welcome and lock/relock semantics remain a future
//     vault-unlock feature — until then, the editor is terminal and
//     there is no path back to Welcome from inside it.
//
// Window-close prompt (Task 12) explicitly excludes ReadyStep — vault
// is committed, no progress to discard.

import { useTranslation } from "react-i18next";
import { ReadyLocalArtefacts } from "./ReadyLocalArtefacts";
import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
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
  return (
    <StepLayout align="center">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 56,
          height: 56,
          borderRadius: "var(--radius-pill)",
          color: "var(--success)",
          background: "color-mix(in srgb, var(--success) 14%, transparent)",
        }}
      >
        <Icon name="check" size={28} />
      </div>

      <StepHeading centered>{t("vaultCreation.ready.heading")}</StepHeading>

      <div
        style={{
          fontSize: "var(--text-base)",
          lineHeight: 1.6,
          color: "var(--fg-2)",
          textAlign: "center",
          maxWidth: 380,
        }}
      >
        {t("vaultCreation.ready.body")}
      </div>

      {/* One way forward, and it is the obvious one. The two local artefacts
          (a backup file, the folder on disk) are real but optional, so they sit
          under it as quiet actions rather than beside it as equals. */}
      <Button
        variant="primary"
        onClick={onDone}
        disabled={pending}
        data-testid="create.ready-done"
        style={{ minWidth: 220, justifyContent: "center", marginTop: "var(--space-2)" }}
      >
        {pending ? t("vaultCreation.ready.decrypting") : t("vaultCreation.ready.done")}
      </Button>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "var(--space-1)",
        }}
      >
        <ReadyLocalArtefacts pending={pending} vaultId={vaultId} />
      </div>
    </StepLayout>
  );
}
