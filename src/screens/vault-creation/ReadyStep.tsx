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
//     agent-tooling/features/empty-editor-shell/prd.md (2026-04-28).
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
      <div style={{ color: "var(--success)" }}>
        <Icon name="circle-check" size={36} />
      </div>

      <StepHeading centered>{t("vaultCreation.ready.heading")}</StepHeading>

      <div
        style={{
          fontSize: "var(--text-base)",
          lineHeight: 1.6,
          color: "var(--fg-2)",
          textAlign: "center",
          maxWidth: 360,
        }}
      >
        {t("vaultCreation.ready.body")}
      </div>

      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
        <ReadyLocalArtefacts pending={pending} vaultId={vaultId} />
        <Button
          variant="primary"
          onClick={onDone}
          disabled={pending}
          data-testid="create.ready-done"
        >
          {pending ? t("vaultCreation.ready.decrypting") : t("vaultCreation.ready.done")}
        </Button>
      </div>
    </StepLayout>
  );
}
