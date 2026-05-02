import { useEffect, useRef, useState } from "react";
import { Welcome } from "./screens/Welcome";
import { CreateVault } from "./screens/CreateVault";
import { Unlock } from "./screens/Unlock";
import { Locked } from "./screens/Locked";
import { Editor } from "./screens/Editor";
import { initialStageFromProbe, transition, type Action, type Stage } from "./lib/stage";
import { probeVaultStatus } from "./lib/vault-status";

function App() {
  // Initial stage is `null` until the boot probe resolves (loading
  // shim renders blank). Production has no shortcut to bypass the
  // probe — MYND-80 acceptance forbids prod-guard bypass even in dev,
  // so the previous `?test-stage=` URL parameter shortcut is gone
  // (would have let dev users mount editor with an empty
  // VaultRuntimeState slot, defeating the editor mount guard).
  const [stage, setStage] = useState<Stage | null>(null);

  // Boot-time `vault_status` probe. Fires once per process — the
  // `probed` ref guards against React 18 StrictMode double-effect in
  // dev (both invocations would otherwise hit the IPC). Production
  // doesn't double-invoke; the guard is defensive belt+suspenders.
  // Also re-fires when `reprobe()` resets `stage` to null (Editor
  // mount guard's "Kilitle" CTA → fail-closed → re-route).
  const probed = useRef(false);
  useEffect(() => {
    if (stage !== null) return; // already-resolved probe
    if (probed.current) return; // StrictMode second invocation
    probed.current = true;
    void (async () => {
      const result = await probeVaultStatus();
      setStage(initialStageFromProbe(result));
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
        />
      );
    case "locked":
      return <Locked onUnlock={() => dispatch({ type: "locked.unlock" })} />;
    case "editor":
      return (
        <Editor
          onResetRequested={reprobe}
          onLock={() => dispatch({ type: "editor.lock" })}
        />
      );
  }
}

export default App;
