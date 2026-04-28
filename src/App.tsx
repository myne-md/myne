import { useState } from "react";
import { Welcome } from "./screens/Welcome";
import { CreateVault } from "./screens/CreateVault";

type Stage = "welcome" | "create-vault";

function App() {
  const [stage, setStage] = useState<Stage>("welcome");

  if (stage === "welcome") {
    return <Welcome onCreateVault={() => setStage("create-vault")} />;
  }

  return <CreateVault onBack={() => setStage("welcome")} />;
}

export default App;
