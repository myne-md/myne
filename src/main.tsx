// i18n MUST initialise before any other module body runs, so module-level
// `i18n.t(...)` calls (command catalogs, error maps) resolve against loaded
// resources rather than returning raw keys. Keep this import first.
import "./i18n";
// Install the desktop EditorHost into @myne/editor before any editor mounts.
import "./editor-host";
// Repoint Excalidraw's font loader to the self-hosted /excalidraw-assets/ base
// before any lazy drawing chunk loads (drawing-notes SF1, MYND-498).
import "@myne/editor/drawing/excalidraw-asset-path";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import { initThemeDeepLinks } from "./lib/themeDeepLink";
import "./styles/tokens.css";

// MYND-567: subscribe to `myne://` URLs at module scope — BEFORE React mounts,
// so a cold launch from a theme-install link cannot race the subscription. The
// URL lands in the module's latch; `ThemeInstallDialog` (mounted by `Editor`,
// i.e. only past unlock) drains it. Deliberately here rather than in a
// component effect: StrictMode double-invokes effects, and this must subscribe
// exactly once.
void initThemeDeepLinks();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
