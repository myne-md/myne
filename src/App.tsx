import { useState } from "react";
import { Welcome } from "./screens/Welcome";
import { CreateVault } from "./screens/CreateVault";
import { Editor } from "./screens/Editor";

type Stage = "welcome" | "create-vault" | "editor";

function getInitialStage(): Stage {
  if (!import.meta.env.DEV) return "welcome";
  const q = new URLSearchParams(location.search).get("test-stage");
  if (q === "create-vault" || q === "editor") return q;
  return "welcome";
}

function App() {
  const [stage, setStage] = useState<Stage>(getInitialStage);

  if (stage === "welcome") {
    return <Welcome onCreateVault={() => setStage("create-vault")} />;
  }

  if (stage === "create-vault") {
    return (
      <CreateVault
        onBack={() => setStage("welcome")}
        onComplete={() => setStage("editor")}
      />
    );
  }

  return <Editor />;
}

export default App;
