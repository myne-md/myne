import React from "react";
import ReactDOM from "react-dom/client";
// Install the mobile EditorHost into @myne/editor before any editor mounts.
import "./editor-host";
import App from "./App";
import { initDeepLinks } from "./lib/deep-link";
import { initCaptures } from "./lib/captures";
import "./styles/tokens.css";
import "./styles/mobile.css";

// Subscribe to the widget `myne://` deep links as early as possible so a
// cold launch from `myne://capture` latches its intent before the editor mounts.
void initDeepLinks();

// Subscribe to Apple Watch pending-capture staging (§9.18): seal any staged
// watch-dictated captures on boot + whenever the native receiver delivers one.
// Runs while the vault is locked (device-key based); the drain into notes
// happens later, on unlock, from EditorFlow.
void initCaptures();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
