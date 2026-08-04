// Keep-both conflict materialization (MYND-427) — the TS half of the engine's
// keep-both resolution. When two devices edit the same note concurrently, the
// sync engine stages the remote revision under `<vault>/conflicts/` and surfaces
// its note id via `sync_pending_conflicts` (the local edit is left untouched).
// This hook finishes the keep-both: decrypt that remote revision, materialize it
// as a new note carrying `conflict_of: <original>`, then resolve the conflict so
// the local edit pushes as a clean linear advance. Both revisions survive — no
// edit is ever silently lost. Runs on mount + on every `sync://changed` event.

import { useCallback, useEffect, useRef } from "react";
import { invoke } from "../platform/core";
import { listen } from "../platform/event";
import { createConflictCopy } from "../notes/conflictCopy";

/** 32-char hex note id → the canonical dashed UUID the `conflict_of:` field (and
 * the note cache) key on. */
function hexToUuid(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Drains the engine's staged keep-both conflicts. `onMaterialized` is called
 * after at least one copy is created so the caller can refresh the note list.
 */
export function useConflictMaterializer(onMaterialized?: () => void): void {
  // myne#319 — `onMaterialized` arrives as a fresh closure on every render of
  // the caller, so keeping it in the `materialize` dep list made `materialize`
  // change identity on every render, which made the effect below tear down and
  // re-run. Every autosave does that (`refreshOne` → new `SidebarState` → new
  // provider value → `EditorChrome` re-render), as does every selection change,
  // rename, trash and archive.
  //
  // The cost was not only churn: between the synchronous `unlisten()` in the
  // cleanup and the resolution of the next `await listen(...)`, this subscriber
  // is DEAF, so a `sync://changed` the background loop emitted in that window
  // was dropped for the conflict drain. And none of it was gated on sync being
  // configured, so a user with sync off paid an extra directory-listing IPC per
  // keystroke burst too.
  //
  // The ref is the pattern the Editor's own `sync://changed` subscriber already
  // uses for the same event — it subscribes once.
  const onMaterializedRef = useRef(onMaterialized);
  onMaterializedRef.current = onMaterialized;

  const materialize = useCallback(async () => {
    let ids: string[];
    try {
      ids = await invoke<string[]>("plugin:sync|sync_pending_conflicts");
    } catch {
      return; // sync not configured / vault locked — nothing to do
    }
    let materializedAny = false;
    for (const idHex of ids) {
      try {
        const remoteBody = await invoke<string>("plugin:sync|sync_take_conflict", {
          originalIdHex: idHex,
        });
        await createConflictCopy(remoteBody, hexToUuid(idHex));
        await invoke("plugin:sync|sync_resolve_conflict", { originalIdHex: idHex });
        materializedAny = true;
      } catch {
        // Leave this one staged; the next sync event retries it.
      }
    }
    if (materializedAny) {
      onMaterializedRef.current?.();
      // Push the new copy + the now-cleanly-advancing local edit.
      try {
        await invoke("plugin:sync|sync_now");
      } catch {
        // The background loop will pick it up on its next tick.
      }
    }
  }, []);

  useEffect(() => {
    void materialize();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen("sync://changed", () => void materialize());
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri (browser dev shim) → no sync events.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [materialize]);
}
