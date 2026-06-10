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
//     myne-agents/features/empty-editor-shell/prd.md (2026-04-28).
//     Vault-detected Welcome and lock/relock semantics remain a future
//     vault-unlock feature — until then, the editor is terminal and
//     there is no path back to Welcome from inside it.
//
// Window-close prompt (Task 12) explicitly excludes ReadyStep — vault
// is committed, no progress to discard.

import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { appDataDir, join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { logErrorKind } from "../../lib/vault-creation-logging";
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

      <StepHeading centered>Your vault is ready.</StepHeading>

      <div
        style={{
          fontSize: 14,
          lineHeight: 1.6,
          color: "var(--fg-2)",
          textAlign: "center",
          maxWidth: 360,
        }}
      >
        Myne wrote your vault to your application data folder. Your master
        password and recovery phrase are the only way back in — make sure
        both are saved somewhere safe.
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <Button
          variant="ghost"
          icon="folder"
          onClick={handleShowVaultFolder}
          disabled={pending}
          data-testid="create.ready-show-folder"
        >
          Show vault folder
        </Button>
        <Button
          variant="primary"
          onClick={onDone}
          disabled={pending}
          data-testid="create.ready-done"
        >
          {pending ? "Decrypting…" : "Done"}
        </Button>
      </div>
    </StepLayout>
  );
}
