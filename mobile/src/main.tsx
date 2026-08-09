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
import { initShareIntent } from "./lib/shareImport";
import { initReminderTaps } from "./lib/reminderTap";
import "./styles/tokens.css";
// The shared ornament layer (myne#394) — same sheet the desktop client loads, so
// a synced theme's ornament renders identically here. Draws nothing until a
// component declares a role and the active theme selects a primitive.
import "@myne/ornaments/ornaments.css";
import "./styles/mobile.css";

// Subscribe to the widget `myne://` deep links as early as possible so a
// cold launch from `myne://capture` latches its intent before the editor mounts.
void initDeepLinks();

// Subscribe to Apple Watch pending-capture staging (§9.18): seal any staged
// watch-dictated captures on boot + whenever the native receiver delivers one.
// Runs while the vault is locked (device-key based); the drain into notes
// happens later, on unlock, from EditorFlow.
void initCaptures();

// Subscribe to OS-share-sheet deliveries (SF3): a file shared into Myne from
// another app (Android ACTION_SEND) is sealed into the share-import staging
// queue here (device-key based, runs while the vault is locked); the drain into
// the attachment library happens later, on unlock, from EditorFlow.
void initShareIntent();

// Subscribe to reminder taps (MYND-619 task 7), as early as the deep links for
// the same reason: tapping a reminder on a locked phone cold-launches the app,
// so the identifier arrives long before anything can act on it. It is latched in
// memory, never written to disk, and consumed exactly once after unlock. A tap
// that lands before this runs is dropped — deliberately, because the only
// alternative to dropping is a queue, and a queue is a file.
void initReminderTaps();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
