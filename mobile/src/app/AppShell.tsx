import { useCallback, useEffect, useRef, useState } from "react";
import {
  transition,
  initialStageFromProbe,
  type Stage,
  type Action,
  type SlotMap,
  type VaultId,
} from "../lib/stage";
import { listVaults } from "../lib/vault-list";
import { probeSlotKind } from "../lib/vault-slot-kind";
import { lockVault } from "../lib/vault-unlock";
import { HAS_TAURI } from "../lib/app-window";

import { WelcomeFlow } from "./flows/WelcomeFlow";
import { JoinFlow } from "./flows/JoinFlow";
import { CreateVaultFlow } from "./flows/CreateVaultFlow";
import { UnlockFlow } from "./flows/UnlockFlow";
import { RecoverFlow } from "./flows/RecoverFlow";
import { EditorFlow } from "./flows/EditorFlow";
import { PickerFlow } from "./flows/PickerFlow";
import { RestoreBackupFlow } from "./flows/RestoreBackupFlow";
import { Spinner } from "../components";
import { Screen } from "../components";

/** Synthetic slotMap key for the active (sole-Unlocked under SYNC-1) slot. */
const ACTIVE_SLOT = "active-slot";

/**
 * The real, wired mobile app — a port of the desktop App.tsx Stage machine.
 * Boots from the vault-list + active-slot probes, dispatches `transition`
 * actions, and mounts the functional flow for the current stage. The static
 * design gallery is a separate dev route (see App.tsx).
 */
export function AppShell() {
  const [stage, setStage] = useState<Stage | null>(null);
  const probed = useRef(false);
  // Fresh-device sync-join overlay. Rendered full-screen WHILE the stage stays
  // `welcome` (the wired `welcome.join-success` arm lands the editor from there,
  // MYND-424) — an out-of-band local toggle, like recover's out-of-band entry.
  const [showJoin, setShowJoin] = useState(false);

  const boot = useCallback(async () => {
    if (!HAS_TAURI) {
      // Browser dev (pnpm dev, no Tauri host) — no IPC available. Land on
      // welcome so the flows are navigable; real IPC needs `pnpm tauri dev`.
      setStage({ name: "welcome" });
      return;
    }
    try {
      const [vaultList, slot] = await Promise.all([listVaults(), probeSlotKind()]);
      const slotMap: SlotMap = { [ACTIVE_SLOT]: slot };
      setStage(initialStageFromProbe(vaultList, slotMap));
    } catch {
      // Probe transport failure — fail-closed to welcome (the user can still
      // create/restore; a real vault would surface on the next probe).
      setStage({ name: "welcome" });
    }
  }, []);

  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    void boot();
  }, [boot]);

  const dispatch = useCallback((action: Action) => {
    setStage((prev) => (prev ? transition(prev, action) : prev));
  }, []);

  /** Out-of-band re-probe (back-from-create, restore-backup exit). */
  const reprobe = useCallback(() => {
    setStage(null);
    void boot();
  }, [boot]);

  if (stage === null) {
    return (
      <Screen style={{ alignItems: "center", justifyContent: "center" }}>
        <Spinner />
      </Screen>
    );
  }

  switch (stage.name) {
    case "welcome":
      // The join flow runs full-screen while the stage is still `welcome`; on a
      // successful bootstrap it dispatches the wired `welcome.join-success` →
      // editor. Cancel just closes the overlay back to Welcome.
      if (showJoin) {
        return (
          <JoinFlow
            onComplete={(vaultId) => {
              setShowJoin(false);
              dispatch({ type: "welcome.join-success", vaultId });
            }}
            onCancel={() => setShowJoin(false)}
          />
        );
      }
      return (
        <WelcomeFlow
          onCreate={() => dispatch({ type: "create-vault.start" })}
          // Out-of-band entry (no legal welcome→recover transition; same
          // pattern as reprobe). Recovery needs a vault.meta on disk — on a
          // fresh device with none, the backend returns the non-distinguishing
          // "invalid phrase" state, which RecoverFlow surfaces.
          onRecover={() => setStage({ name: "recover", subStep: "phrase-entry" })}
          onJoin={() => setShowJoin(true)}
        />
      );

    case "create-vault":
      return (
        <CreateVaultFlow
          briefing={stage.briefing}
          onCancel={reprobe}
          onCommitSuccess={(vaultId?: VaultId) => dispatch({ type: "create-vault.commit-success", vaultId })}
          onAutoUnlockSuccess={(vaultId?: VaultId) => dispatch({ type: "create-vault.auto-unlock-success", vaultId })}
          onAutoUnlockFailed={(vaultId?: VaultId) => dispatch({ type: "create-vault.commit-success", vaultId })}
        />
      );

    case "unlock":
      return (
        <UnlockFlow
          initialStatus={stage.initialStatus}
          vaultId={stage.vaultId}
          suspicionReason={stage.suspicionReason}
          fromPicker={stage.fromPicker}
          onUnlocked={() => dispatch({ type: "unlock.success" })}
          onStartRecovery={() => dispatch({ type: "unlock.start-recovery" })}
          onBackToPicker={stage.fromPicker ? () => dispatch({ type: "unlock.back-to-picker" }) : undefined}
          onDeleteVaultSuccess={() => dispatch({ type: "unlock.delete-vault-success" })}
        />
      );

    case "recover":
      return (
        <RecoverFlow
          initialSubStep={stage.subStep}
          onComplete={(vaultId?: VaultId) => dispatch({ type: "recover.complete-success", vaultId })}
          onCancel={() => dispatch({ type: "recover.cancel" })}
        />
      );

    case "editor":
      return (
        <EditorFlow
          vaultId={stage.vaultId}
          onLock={async () => {
            await lockVault().catch(() => {});
            dispatch({ type: "editor.lock" });
          }}
          onCreateVault={() => dispatch({ type: "editor.create-vault" })}
          onSwitchVault={async (vaultId: VaultId) => {
            await lockVault().catch(() => {});
            dispatch({ type: "editor.switch-vault", vaultId });
          }}
          onDeleteVaultSuccess={() => dispatch({ type: "editor.delete-vault-success" })}
        />
      );

    case "picker":
      return (
        <PickerFlow
          onSelect={(vaultId: VaultId) => dispatch({ type: "picker.select-vault", vaultId })}
          onCreate={() => dispatch({ type: "picker.create-vault" })}
        />
      );

    case "restore-backup":
      return <RestoreBackupFlow entry={stage.entry} onDone={reprobe} />;
  }
}
