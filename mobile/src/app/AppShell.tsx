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
import { clearCustomTheme, paintSelectedCustomTheme } from "../lib/customTheme";

import { WelcomeFlow } from "./flows/WelcomeFlow";
import { JoinFlow } from "./flows/JoinFlow";
import { CreateVaultFlow } from "./flows/CreateVaultFlow";
import { UnlockFlow } from "./flows/UnlockFlow";
import { RecoverFlow } from "./flows/RecoverFlow";
import { EditorFlow } from "./flows/EditorFlow";
import { PickerFlow } from "./flows/PickerFlow";
import { RestoreBackupFlow } from "./flows/RestoreBackupFlow";
import { Spinner } from "../components";
import { Screen, PhoneColumn } from "../components";

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
  // The stage `dispatch` reduces from. It mirrors `stage` and is written
  // SYNCHRONOUSLY by `enterStage` — which the functional `setStage(prev => …)`
  // form cannot be, because entering the editor is awaited (the custom palette
  // is painted first), so the reducer's "previous" has to be readable outside
  // React's render cycle. Every write to `stage` goes through `enterStage`, so
  // the two never diverge.
  const stageRef = useRef<Stage | null>(null);
  const probed = useRef(false);
  // Fresh-device sync-join overlay. Rendered full-screen WHILE the stage stays
  // `welcome` (the wired `welcome.join-success` arm lands the editor from there,
  // MYND-424) — an out-of-band local toggle, like recover's out-of-band entry.
  const [showJoin, setShowJoin] = useState(false);

  /**
   * Land a stage — the single writer of `stage` and its ref mirror.
   *
   * **Every entry into the editor stage paints the vault's selected custom
   * palette first** (MYND-598), so the editor's first frame already wears it.
   * The gate lives here rather than on the unlock handler because `stage.ts`
   * reaches `{name:"editor"}` from four transitions — `unlock.success`,
   * `recover.complete-success`, `welcome.join-success` and
   * `create-vault.auto-unlock-success` — plus `initialStageFromProbe`'s
   * already-`Unlocked` short-circuit (a WebView reload over a live Rust slot).
   * Recovery in particular opens an EXISTING vault, which can carry both a
   * `custom_theme` selection and the themes it names. One gate covers all of
   * them, including the next route somebody adds.
   *
   * Non-editor stages never reach the `await`, so they still land
   * synchronously — the palette read is the only thing that ever defers a
   * transition.
   */
  const enterStage = useCallback(async (next: Stage | null) => {
    if (next?.name === "editor") await paintSelectedCustomTheme();
    stageRef.current = next;
    setStage(next);
  }, []);

  const boot = useCallback(async () => {
    if (!HAS_TAURI) {
      // Browser dev (pnpm dev, no Tauri host) — no IPC available. Land on
      // welcome so the flows are navigable; real IPC needs `pnpm tauri dev`.
      await enterStage({ name: "welcome" });
      return;
    }
    try {
      const [vaultList, slot] = await Promise.all([listVaults(), probeSlotKind()]);
      const slotMap: SlotMap = { [ACTIVE_SLOT]: slot };
      await enterStage(initialStageFromProbe(vaultList, slotMap));
    } catch {
      // Probe transport failure — fail-closed to welcome (the user can still
      // create/restore; a real vault would surface on the next probe).
      await enterStage({ name: "welcome" });
    }
  }, [enterStage]);

  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    void boot();
  }, [boot]);

  const dispatch = useCallback(
    (action: Action) => {
      const prev = stageRef.current;
      if (prev === null) return;
      const next = transition(prev, action);
      // `transition` returns `prev` unchanged for an illegal pair; re-landing it
      // would re-run the editor paint for a transition that did not happen.
      if (next === prev) return;
      void enterStage(next);
    },
    [enterStage],
  );

  /** Out-of-band re-probe (back-from-create, restore-backup exit). */
  const reprobe = useCallback(() => {
    void enterStage(null);
    void boot();
  }, [boot, enterStage]);

  if (stage === null) {
    return (
      <PhoneColumn>
        <Screen style={{ alignItems: "center", justifyContent: "center" }}>
          <Spinner />
        </Screen>
      </PhoneColumn>
    );
  }

  // Every stage except the editor renders inside <PhoneColumn> — on tablets the
  // single-column flows stay a centered phone-width column (no-op on phones);
  // the editor is the adaptive multi-pane surface and fills the window.
  switch (stage.name) {
    case "welcome":
      // The join flow runs full-screen while the stage is still `welcome`; on a
      // successful bootstrap it dispatches the wired `welcome.join-success` →
      // editor. Cancel just closes the overlay back to Welcome.
      if (showJoin) {
        return (
          <PhoneColumn>
            <JoinFlow
              onComplete={(vaultId) => {
                setShowJoin(false);
                dispatch({ type: "welcome.join-success", vaultId });
              }}
              onCancel={() => setShowJoin(false)}
            />
          </PhoneColumn>
        );
      }
      return (
        <PhoneColumn>
          <WelcomeFlow
            onCreate={() => dispatch({ type: "create-vault.start" })}
            onJoin={() => setShowJoin(true)}
          />
        </PhoneColumn>
      );

    case "create-vault":
      return (
        <PhoneColumn>
          <CreateVaultFlow
            briefing={stage.briefing}
            onCancel={reprobe}
            onCommitSuccess={(vaultId?: VaultId) => dispatch({ type: "create-vault.commit-success", vaultId })}
            onAutoUnlockSuccess={(vaultId?: VaultId) => dispatch({ type: "create-vault.auto-unlock-success", vaultId })}
            onAutoUnlockFailed={(vaultId?: VaultId) => dispatch({ type: "create-vault.commit-success", vaultId })}
          />
        </PhoneColumn>
      );

    case "unlock":
      return (
        <PhoneColumn>
          <UnlockFlow
            initialStatus={stage.initialStatus}
            vaultId={stage.vaultId}
            suspicionReason={stage.suspicionReason}
            fromPicker={stage.fromPicker}
            // All three unlock routes — password, PIN, biometric — land here.
            // The custom palette is painted before the editor stage lands; that
            // is `enterStage`'s job, for every route rather than this one.
            onUnlocked={() => dispatch({ type: "unlock.success" })}
            onStartRecovery={() => dispatch({ type: "unlock.start-recovery" })}
            onBackToPicker={stage.fromPicker ? () => dispatch({ type: "unlock.back-to-picker" }) : undefined}
            onDeleteVaultSuccess={() => dispatch({ type: "unlock.delete-vault-success" })}
          />
        </PhoneColumn>
      );

    case "recover":
      return (
        <PhoneColumn>
          <RecoverFlow
            initialSubStep={stage.subStep}
            onComplete={(vaultId?: VaultId) => dispatch({ type: "recover.complete-success", vaultId })}
            onCancel={() => dispatch({ type: "recover.cancel" })}
          />
        </PhoneColumn>
      );

    case "editor":
      return (
        <EditorFlow
          vaultId={stage.vaultId}
          // The palette revert rides `lockVault()` with the other per-vault
          // teardowns, so every route through the lock inherits it (MYND-598).
          onLock={async () => {
            await lockVault().catch(() => {});
            dispatch({ type: "editor.lock" });
          }}
          onCreateVault={() => dispatch({ type: "editor.create-vault" })}
          onSwitchVault={async (vaultId: VaultId) => {
            await lockVault().catch(() => {});
            dispatch({ type: "editor.switch-vault", vaultId });
          }}
          // Vault deletion is the one exit that does NOT go through `lockVault`
          // (the slot is gone, not locked), so it reverts the palette itself.
          onDeleteVaultSuccess={() => {
            clearCustomTheme();
            dispatch({ type: "editor.delete-vault-success" });
          }}
        />
      );

    case "picker":
      return (
        <PhoneColumn>
          <PickerFlow
            onSelect={(vaultId: VaultId) => dispatch({ type: "picker.select-vault", vaultId })}
            onCreate={() => dispatch({ type: "picker.create-vault" })}
          />
        </PhoneColumn>
      );

    case "restore-backup":
      return (
        <PhoneColumn>
          <RestoreBackupFlow entry={stage.entry} onDone={reprobe} />
        </PhoneColumn>
      );
  }
}
