// i18n MUST initialise before any other module body runs, so module-level
// `i18n.t(...)` calls (command catalogs, error maps) resolve against loaded
// resources rather than returning raw keys. Keep this import first.
import "./i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import "./styles/tokens.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);
