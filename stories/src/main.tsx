// Story catalogue entry point (myne-md/myne#832).
//
// Import order is load-bearing:
//   1. `./host/install` FIRST, so the fake Tauri internals global exists before
//      any app module reads it at module scope.
//   2. The token sheets and the ornament sheet, in the same order the desktop
//      `main.tsx` uses (client-core first, then the app-shell sheet, then
//      ornaments), so the catalogue paints exactly as the app does.

import "./host/install";
import "@myne/client-core/tokens.css";
// The component layer (myne-md/myne#773): every primitive's appearance lives
// here as `.myne-*` classes, so without it the catalogue renders browser-default
// controls. Imported in the same order as `src/main.tsx` (client-core tokens,
// then client-core components, then the app-shell sheet, then ornaments).
import "@myne/client-core/components.css";
import "@app/styles/tokens.css";
import "@myne/ornaments/ornaments.css";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
