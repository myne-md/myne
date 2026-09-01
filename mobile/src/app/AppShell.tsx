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
import { useDateTimeDisplaySync } from "../lib/useDateTimeDisplaySync";

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
import { ToastHost } from "../components/ToastHost";

/** Synthetic slotMap key for the active (sole-Unlocked under SYNC-1) slot. */
const ACTIVE_SLOT = "active-slot";

/**
 * Which stage a join was launched from → the action its success dispatches
 * (myne-mobile#40). A lookup rather than a `${from}.join-success` template so
 * the three action names stay greppable and the mapping is checked by the
 * `Action` union rather than by contextual template-literal inference.
 */
const JOIN_SUCCESS = {
  welcome: "welcome.join-success",
  picker: "picker.join-success",
  editor: "editor.join-success",
} as const;

/** The stages that offer a door into `JoinFlow` (keys of `JOIN_SUCCESS`). */
type JoinEntry = keyof typeof JOIN_SUCCESS;

/**
 * The real, wired mobile app — a port of the desktop App.tsx Stage machine.
 * Boots from the vault-list + active-slot probes, dispatches `transition`
 * actions, and mounts the functional flow for the current stage. The static
 * design gallery is a separate dev route (see App.tsx).
 */
export function AppShell() {
  // Publish the date/time display settings into the shared store every
  // formatting surface reads (myne-md/myne#609). At the ROOT, and for the same
  // reason `ToastHost` is: `StageSwitch` returns early in several places, so a
  // hook mounted inside it would stop publishing on the stages that return
  // first, and a store that stops being written is indistinguishable from one
  // nobody ever wrote. That was the shape of the original defect.
  useDateTimeDisplaySync();
  return (
    <>
      <StageSwitch />
      {/* The mobile client's one toast surface (myne-md/myne#455), mounted at the
          ROOT rather than inside the editor flow. That placement is the point:
          the desktop client had its `<Toaster />` inside the post-unlock screen,
          so vault creation and unlock could not reach it and grew silences
          instead, and putting mobile's first host anywhere shallower would
          reproduce exactly that. `ShareImportToast` stays where it is, it is a
          single-purpose notice with its own trigger, not a general surface. */}
      <ToastHost />
    </>
  );
}

/**
 * The stage machine itself.
 *
 * Split out of {@link AppShell} only so a root-level surface can be mounted
 * beside it: this function returns early in several places (the join flow, the
 * boot shim) and then returns from a `switch`, so there is no single element to
 * hang a sibling off without restructuring every arm.
 */
function StageSwitch() {
  const [stage, setStage] = useState<Stage | null>(null);
  // The stage `dispatch` reduces from. It mirrors `stage` and is written
  // SYNCHRONOUSLY by `enterStage` — which the functional `setStage(prev => …)`
  // form cannot be, because entering the editor is awaited (the custom palette
  // is painted first), so the reducer's "previous" has to be readable outside
  // React's render cycle. Every write to `stage` goes through `enterStage`, so
  // the two never diverge.
  const stageRef = useRef<Stage | null>(null);
  const probed = useRef(false);
  // Sync-join overlay. Rendered full-screen WHILE the stage stays put; the
  // matching `*.join-success` arm lands the editor from there (MYND-424) — an
  // out-of-band local toggle, like recover's out-of-band entry. The value is the
  // stage the join was launched FROM, not a boolean: the door exists on three
  // surfaces (welcome, picker, the editor's vault switcher — myne-mobile#40) and
  // each dispatches its own success action. `null` = no join in flight.
  const [joinFrom, setJoinFrom] = useState<JoinEntry | null>(null);

  /**
   * Land a stage — the single writer of `stage` and its ref mirror.
   *
   * **Every entry into the editor stage paints the vault's selected custom
   * palette first** (MYND-598), so the editor's first frame already wears it.
   * The gate lives here rather than on the unlock handler because `stage.ts`
   * reaches `{name:"editor"}` from six transitions — `unlock.success`,
   * `recover.complete-success`, the three `*.join-success` arms and
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

  // The join flow runs full-screen while the stage underneath stays put; on a
  // successful bootstrap it dispatches that stage's `*.join-success` arm →
  // editor, addressed at the joined vault.
  //
  // It sits ABOVE the switch because the door is not a Welcome-only affordance
  // (myne-mobile#40): scoping the overlay to `case "welcome"` made joining an
  // existing account unreachable the moment the device held any vault, since
  // `initialStageFromProbe` only produces `welcome` at zero vaults.
  //
  // Cancel closes the overlay back to the stage it was opened from. It is
  // deliberately NOT `reprobe()`, tempting as the back-from-create precedent is:
  // the SAS-mismatch exit calls `syncResetLocal()`, which clears this device's
  // enrollment but never touches `vault.meta` (see the command's doc in
  // `core/src/plugins/sync/commands.rs`), so a re-probe would route the user
  // straight into the editor of the vault they had just rejected.
  if (joinFrom !== null) {
    return (
      <PhoneColumn>
        <JoinFlow
          onComplete={(vaultId) => {
            setJoinFrom(null);
            dispatch({ type: JOIN_SUCCESS[joinFrom], vaultId });
          }}
          onCancel={() => setJoinFrom(null)}
        />
      </PhoneColumn>
    );
  }

  // Every stage except the editor renders inside <PhoneColumn> — on tablets the
  // single-column flows stay a centered phone-width column (no-op on phones);
  // the editor is the adaptive multi-pane surface and fills the window.
  switch (stage.name) {
    case "welcome":
      return (
        <PhoneColumn>
          <WelcomeFlow
            onCreate={() => dispatch({ type: "create-vault.start" })}
            onJoin={() => setJoinFrom("welcome")}
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
            // #45: reprobe, not a hardcoded → welcome. Boot routing then picks
            // the return surface by REMAINING vault count (picker at ≥2, unlock
            // at 1, welcome at 0); the old arm stranded a multi-vault user on
            // the first-run screen with every other vault hidden. The delete IPC
            // has already resolved here, so the probe reads post-delete disk.
            onDeleteVaultSuccess={reprobe}
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
          // Not preceded by `lockVault()`, unlike `onSwitchVault`: the join
          // flow's own `sync_join_account` unlocks the vault it bootstraps,
          // which evicts this one at the IPC layer (SYNC-1) — the same posture
          // `onCreateVault` takes toward the create → auto-unlock chain.
          onJoinAccount={() => setJoinFrom("editor")}
          onSwitchVault={async (vaultId: VaultId) => {
            await lockVault().catch(() => {});
            dispatch({ type: "editor.switch-vault", vaultId });
          }}
          // Vault deletion is the one exit that does NOT go through `lockVault`
          // (the slot is gone, not locked), so it reverts the palette itself.
          onDeleteVaultSuccess={() => {
            clearCustomTheme();
            reprobe(); // #45 — see the unlock surface above
          }}
        />
      );

    case "picker":
      return (
        <PhoneColumn>
          <PickerFlow
            onSelect={(vaultId: VaultId) => dispatch({ type: "picker.select-vault", vaultId })}
            onCreate={() => dispatch({ type: "picker.create-vault" })}
            onJoin={() => setJoinFrom("picker")}
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
