import { useState } from "react";
import { Welcome } from "./screens/Welcome";
import { CreateVault } from "./screens/CreateVault";

type Stage = "welcome" | "create-vault";

function App() {
  const [stage, setStage] = useState<Stage>("welcome");

  if (stage === "welcome") {
    return <Welcome onCreateVault={() => setStage("create-vault")} />;
  }

  return (
    <CreateVault
      onBack={() => setStage("welcome")}
      onContinue={() => {
        // UI-only stub. Backend wire-up (root_key generation, BIP-39 phrase,
        // vault.meta write) lands in a follow-up turn.
        // eslint-disable-next-line no-console
        console.log("[Myne] Recovery phrase generation: backend not wired yet.");
      }}
    />
  );
}

export default App;
