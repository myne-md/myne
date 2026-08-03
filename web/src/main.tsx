// Web entry point (phase3-web-client task 7).
//
// The desktop `src/main.tsx` minus the ONE boot step that is desktop-only: the
// `myne://` deep-link subscription (an OS registration a page cannot make).
// Everything else — i18n first, the editor host, Excalidraw asset base, the
// same `App` under the same error boundary — is deliberately identical, because
// divergence here is divergence in boot order, which is the hardest kind to
// notice.
//
// `editor-host` used to be the second omission, from when task 26's web host
// did not exist. It does now: `src/editor-host.ts` compiles unchanged for both
// clients, gating its optional members on `platform/capabilities` rather than
// forking into a second file. Leaving the import out after the host was
// finished cost exactly what an un-installed host costs — every CodeMirror
// plugin that reaches for it threw `setEditorHost() was not called before the
// editor mounted` on the first note opened, four times per mount, in
// production. Nothing failed loudly enough to notice: the editor still mounted
// and still saved.

import "../../src/i18n";
import "../../src/editor-host";
import "@myne/editor/drawing/excalidraw-asset-path";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "../../src/App";
import { RootErrorBoundary } from "../../src/components/RootErrorBoundary";
import "../../src/styles/tokens.css";
import { gateEnvironment } from "./environment-gate";
import { UnsupportedEnvironment } from "./UnsupportedEnvironment";
import { VaultOpenElsewhere } from "./VaultOpenElsewhere";
import { acquireVaultLock, WEB_CONTAINER_ID } from "./vault-lock";
import { warmWorker } from "./worker/host";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

// The environment gate runs FIRST, before `App` mounts and therefore before any
// Worker starts or any derivation is attempted (phase3-web-client task 29).
// A browser that cannot reserve the KDF's ~336 MiB — every phone browser, and
// iOS Safari in particular — would otherwise die part-way through Argon2id,
// after the user had already typed their password. The ordering here IS the
// guarantee: there is no later check to forget.
void gateEnvironment().then(async (env) => {
  if (!env.supported) {
    root.render(
      <React.StrictMode>
        <UnsupportedEnvironment missing={env.missing} />
      </React.StrictMode>,
    );
    return;
  }
  // The single-tab lock, taken BEFORE the Worker starts (#254).
  //
  // `vault-lock.ts` was written, documented and unit-tested for task 21 — and
  // nothing imported it, so the guarantee it describes never existed. Its lock
  // name was not even in the shipped bundle: tree-shaken, because no production
  // module referenced it. Meanwhile `worker/opfs.ts` skips its TOCTOU guard on
  // the strength of that lock, and `worker.ts` starts a sync loop in EVERY tab,
  // so two idle tabs wrote the same `sync-state.json`, the same
  // `vault.head-state` and the same pulled note blobs on their own timers.
  //
  // Here rather than deeper in: the property is "a second tab never writes",
  // and that is a property of the call ORDER — no Worker, no sync loop, no
  // derivation — not of a check inside each write path. An `unsupported` result
  // (no Web Locks) keeps today's behaviour rather than refusing a browser the
  // environment gate already accepted.
  const acquired = await acquireVaultLock(WEB_CONTAINER_ID);
  if (!acquired.held && acquired.reason === "open-elsewhere") {
    root.render(
      <React.StrictMode>
        <VaultOpenElsewhere vaultId={WEB_CONTAINER_ID} />
      </React.StrictMode>,
    );
    requestAnimationFrame(() => document.getElementById("boot-shell")?.remove());
    return;
  }

  // Start the vault Worker in parallel with React's first mount (task 68).
  // Everything expensive about it — fetching the wasm, compiling it, the CSPRNG
  // self-check — is off-thread, and the boot probe is going to need it a moment
  // from now. Left lazy, that work would start only once React had mounted and
  // issued the first `invoke`, serialising two costs that have no reason to be
  // in sequence. After the gate, never before: see `warmWorker`.
  warmWorker();
  root.render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </React.StrictMode>,
  );
  // The boot shell has done its job the moment React has painted something.
  // Removed rather than hidden so it cannot intercept a click, and removed HERE
  // rather than in `App` so the shared tree stays unaware of it.
  requestAnimationFrame(() => document.getElementById("boot-shell")?.remove());
});
