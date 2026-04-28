// Endpoint screen — vault.meta has just been written to disk.
//
// Implements design session 2026-04-28-vault-creation-frontend.md Q9:
//   - No eyebrow (endpoint, not a numbered step).
//   - Success indicator: circle-check icon, var(--success).
//   - "Show vault folder" → @tauri-apps/plugin-opener opens OS file
//     manager at app_data_dir/vault/ (built via @tauri-apps/api/path
//     `appDataDir()` + `join("vault")`).
//   - "Done" → getCurrentWindow().close(). Returning to Welcome was
//     rejected because it would let the user re-trigger Create-new-vault
//     and overwrite the just-written vault.meta — a vault-unlock concern
//     out of this PRD's scope.
//
// Window-close prompt (Task 12) explicitly excludes ReadyStep — vault
// is committed, no progress to discard.

import { Button } from "../../components/primitives/Button";
import { Icon } from "../../components/primitives/Icon";
import { appDataDir, join } from "@tauri-apps/api/path";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logErrorKind } from "../../lib/vault-creation-logging";
import { StepHeading, StepLayout } from "./step-shell";

export function ReadyStep() {
  const handleShowVaultFolder = async () => {
    try {
      const base = await appDataDir();
      const dir = await join(base, "vault");
      await openPath(dir);
    } catch (e) {
      logErrorKind(e, "show-vault-folder-failed");
    }
  };

  const handleDone = async () => {
    try {
      await getCurrentWindow().close();
    } catch (e) {
      logErrorKind(e, "window-close-failed");
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
        <Button variant="ghost" icon="folder" onClick={handleShowVaultFolder}>
          Show vault folder
        </Button>
        <Button variant="primary" onClick={handleDone}>
          Done
        </Button>
      </div>
    </StepLayout>
  );
}
