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
import { prefsRead } from "../lib/prefs";
import { listCustomThemes } from "../lib/themes";
import { applyCustomTheme, clearCustomTheme, resolveCustomPalette } from "../lib/customTheme";

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
 * Paint the vault's selected custom theme, on the UNLOCK path (MYND-598).
 *
 * Both halves of the answer are vault content — the selection lives in the
 * encrypted `vault.prefs` blob and the palette in `vault.themes` — so neither
 * can be read a moment earlier than this, and neither is ever cached in
 * plaintext device storage to make it possible (`docs/decisions.md` 2026-07-31).
 * Reading here rather than at editor mount is what shrinks the window in which
 * the wrong appearance is on screen; it does not close it, and closing it is
 * exactly what the no-plaintext-cache rule declines to buy.
 *
 * Awaited before the editor stage is dispatched, so the editor never renders a
 * frame under the built-in appearance first. Failure is silent by design: a
 * cosmetic palette is not load-bearing, the host already collapses every
 * recoverable `vault.themes` read failure to an empty store (protocol.md
 * §9.21.4), and a toast at unlock about a colour scheme would be noise. The
 * built-in choice is applied at editor mount as it always has been, which is the
 * same fall-back a selection naming a since-deleted theme lands on.
 *
 * Never rejects — the caller's stage transition must not hang on it.
 */
async function paintSelectedCustomTheme(): Promise<void> {
  if (!HAS_TAURI) return;
  try {
    const [prefs, entries] = await Promise.all([prefsRead(), listCustomThemes()]);
    const palette = resolveCustomPalette(prefs.custom_theme, entries);
    // No selection, or one naming a theme this vault no longer holds: leave the
    // root alone. The preference is deliberately NOT rewritten — see
    // `resolveCustomPalette`, where the revival property is spelled out.
    if (palette) applyCustomTheme(palette);
  } catch {
    /* fall back to the built-in appearance, silently */
  }
}

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
            // The custom palette is painted BEFORE the editor stage is
            // dispatched (all three unlock routes — password, PIN, biometric —
            // land here), so the editor's first frame already wears it.
            onUnlocked={() => {
              void paintSelectedCustomTheme().then(() => dispatch({ type: "unlock.success" }));
            }}
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
          // Every exit from the unlocked vault reverts the palette FIRST, before
          // the lock itself is even awaited. Desktop holds "an explicit theme is
          // on screen ⟺ the vault is unlocked" as the UI-layer image of
          // zeroize-on-lock, and a palette says far more about vault contents
          // than a light/dark attribute does: someone who picks up the locked
          // phone must learn nothing from it. (The built-in `data-theme`
          // attribute's own lock behaviour is a separate, pre-existing mobile
          // divergence — deliberately untouched here.)
          onLock={async () => {
            clearCustomTheme();
            await lockVault().catch(() => {});
            dispatch({ type: "editor.lock" });
          }}
          onCreateVault={() => dispatch({ type: "editor.create-vault" })}
          onSwitchVault={async (vaultId: VaultId) => {
            clearCustomTheme();
            await lockVault().catch(() => {});
            dispatch({ type: "editor.switch-vault", vaultId });
          }}
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
