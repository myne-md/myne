import { useEffect, useRef, useState } from "react";
import { Welcome } from "./screens/Welcome";
import { CreateVault } from "./screens/CreateVault";
import { Unlock } from "./screens/Unlock";
import { Editor } from "./screens/Editor";
import { VaultRecover } from "./screens/VaultRecover";
import { initialStageFromProbe, transition, type Action, type Stage } from "./lib/stage";
import { probeVaultStatus } from "./lib/vault-status";
import { probeSlotKind } from "./lib/vault-slot-kind";

function App() {
  // Initial stage is `null` until the boot probe resolves (loading
  // shim renders blank). Production has no shortcut to bypass the
  // probe — MYND-80 acceptance forbids prod-guard bypass even in dev,
  // so the previous `?test-stage=` URL parameter shortcut is gone
  // (would have let dev users mount editor with an empty
  // VaultRuntimeState slot, defeating the editor mount guard).
  const [stage, setStage] = useState<Stage | null>(null);

  // Boot-time probe pair: `vault_status` (disk) + `vault_slot_kind`
  // (runtime slot). Issued in parallel via `Promise.all` — both are
  // cheap (vault.meta is 345 bytes; slot peek is microseconds) and
  // independent, so the boot blocking-time is bounded by the slower
  // of the two. The `probed` ref guards against React 18 StrictMode
  // double-effect in dev. Also re-fires when `reprobe()` resets
  // `stage` to null (Editor mount guard's "Kilitle" CTA →
  // fail-closed → re-route). Slot-priority routing applies: a
  // `Recovering` or `Unlocked` runtime slot pins the boot stage to
  // `recover(password-reset)` or `editor` regardless of disk state.
  const probed = useRef(false);
  useEffect(() => {
    if (stage !== null) return; // already-resolved probe
    if (probed.current) return; // StrictMode second invocation
    probed.current = true;
    void (async () => {
      const [vaultResult, slotKind] = await Promise.all([
        probeVaultStatus(),
        probeSlotKind(),
      ]);
      setStage(initialStageFromProbe(vaultResult, slotKind));
    })();
  }, [stage]);

  // Out-of-band stage reset for fail-closed recovery (Q5β-1
  // belt+suspenders). Bypasses the transition fn intentionally — the
  // transition fn is for explicit user-driven flow transitions, while
  // "reset to whatever vault_status now says" is a recovery path that
  // doesn't fit a (prev, action) → next mapping. Resets the `probed`
  // ref so the boot-probe useEffect re-runs.
  const reprobe = () => {
    probed.current = false;
    setStage(null);
  };

  if (stage === null) {
    // Loading shim — vault_status probe in flight (~ms on warm disk).
    // Returning null avoids a flash-of-welcome before existing-vault
    // users get routed to unlock.
    return null;
  }

  const dispatch = (action: Action) => setStage((prev) => (prev ? transition(prev, action) : prev));

  switch (stage.name) {
    case "welcome":
      return <Welcome onCreateVault={() => dispatch({ type: "create-vault.start" })} />;
    case "create-vault":
      return (
        <CreateVault
          onBack={() => dispatch({ type: "create-vault.back" })}
          onAutoUnlockSuccess={() =>
            dispatch({ type: "create-vault.auto-unlock-success" })
          }
          onAutoUnlockFailed={() =>
            dispatch({ type: "create-vault.commit-success" })
          }
        />
      );
    case "unlock":
      return (
        <Unlock
          initialStatus={stage.initialStatus}
          onUnlocked={() => dispatch({ type: "unlock.success" })}
          onStartRecovery={() => dispatch({ type: "unlock.start-recovery" })}
          onResumeRecovery={() => dispatch({ type: "unlock.resume-recovery" })}
        />
      );
    case "editor":
      return (
        <Editor
          onResetRequested={reprobe}
          onLock={() => dispatch({ type: "editor.lock" })}
        />
      );
    case "recover":
      return (
        <VaultRecover
          initialSubStep={stage.subStep}
          onCancel={() => dispatch({ type: "recover.cancel" })}
          onCompleteSuccess={() =>
            dispatch({ type: "recover.complete-success" })
          }
        />
      );
  }
}

export default App;
