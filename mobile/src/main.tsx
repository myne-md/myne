import React from "react";
import ReactDOM from "react-dom/client";
// Install the mobile EditorHost into @myne/editor before any editor mounts.
import "./editor-host";
import App from "./App";
import { initDeepLinks } from "./lib/deep-link";
import "./styles/tokens.css";
import "./styles/mobile.css";

// Subscribe to the widget `myne://` deep links as early as possible so a
// cold launch from `myne://capture` latches its intent before the editor mounts.
void initDeepLinks();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
