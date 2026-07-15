import React from "react";
import ReactDOM from "react-dom/client";
// Initialise the shared react-i18next runtime (side-effect: detects the boot
// language + loads the 24 shared catalogs) before the React tree mounts, so the
// first render is already localized. Shared verbatim with desktop (MYND-485).
import "@myne/i18n";
// Install the mobile EditorHost into @myne/editor before any editor mounts.
import "./editor-host";
// Repoint Excalidraw's font loader to the self-hosted /excalidraw-assets/ base
// (boot side-effect, before any drawing chunk loads) — same as desktop main.tsx.
import "@myne/editor/drawing/excalidraw-asset-path";
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
