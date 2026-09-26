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
import { installGlobalFailureHandlers } from "./lib/global-failure";
// The shared token layer (myne-md/myne#478), one source for every design token,
// consumed by all three clients. FIRST, because the app-shell sheet below and
// the ornament sheet after it both read the values it supplies.
import "@myne/client-core/tokens.css";
import "@myne/client-core/components.css";
import "./styles/tokens.css";
// The ornament layer (myne#394). After the token sheet, because every rule in it
// reads tokens the theme supplies. Drawing nothing until a component declares a
// role AND the active theme selects a primitive, so importing it costs an
// unthemed session nothing.
import "@myne/ornaments/ornaments.css";

// MYND-567: subscribe to `myne://` URLs at module scope — BEFORE React mounts,
// so a cold launch from a theme-install link cannot race the subscription. The
// URL lands in the module's latch; `ThemeInstallDialog` (mounted by `Editor`,
// i.e. only past unlock) drains it. Deliberately here rather than in a
// component effect: StrictMode double-invokes effects, and this must subscribe
// exactly once.
void initThemeDeepLinks();

// Failures outside React render — a rejected seam call, a Worker error, a throw
// in an event handler — reach nothing but the console otherwise (task 114). On
// the web client that is the whole observable surface for those, and its user
// cannot read a devtools panel back to a maintainer. Installed at module scope,
// before mount, so a failure during the first render is caught too.
//
// It records a BOUNDED code and notifies; it does not render, navigate or
// swallow. Force-navigating on the first stray rejection would throw away work
// over a failure the app had already recovered from.
installGlobalFailureHandlers();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
