import React from "react";
import ReactDOM from "react-dom/client";
// Install the mobile EditorHost into @myne/editor before any editor mounts.
import "./editor-host";
import App from "./App";
import "./styles/tokens.css";
import "./styles/mobile.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
