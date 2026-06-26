// Keep-both conflict materialization (MYND-427) — the TS half of the engine's
// keep-both resolution. When two devices edit the same note concurrently, the
// sync engine stages the remote revision under `<vault>/conflicts/` and surfaces
// its note id via `sync_pending_conflicts` (the local edit is left untouched).
// This hook finishes the keep-both: decrypt that remote revision, materialize it
// as a new note carrying `conflict_of: <original>`, then resolve the conflict so
// the local edit pushes as a clean linear advance. Both revisions survive — no
// edit is ever silently lost. Runs on mount + on every `sync://changed` event.

import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
      onMaterialized?.();
      // Push the new copy + the now-cleanly-advancing local edit.
      try {
        await invoke("plugin:sync|sync_now");
      } catch {
        // The background loop will pick it up on its next tick.
      }
    }
  }, [onMaterialized]);

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
