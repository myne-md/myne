// `useDeviceNames` — the synced `device_names` map (MYND-548 / SYNC-41) for the
// device-management surface: `device_id` (hex) → the user-chosen label.
//
// Why its own hook rather than `usePrefs`: `usePrefs` is the Settings-wide prefs
// state machine (optimistic writes + toast rollback for ~30 fields). The device
// list needs exactly one field and is mounted from `SyncPanel`, so a narrow hook
// keeps the panel from owning a second copy of that whole state machine. Disk
// stays the single source of truth — this hook only caches the last successful
// read.
//
// A missing entry is NOT an error state: the panel falls back to its id-derived
// short label, which is exactly the pre-feature rendering.

import { useCallback, useEffect, useState } from "react";
import { prefsRead, setDeviceName } from "../lib/prefs";
import { usePrefsNonce } from "../notes/prefsNonce";

/** The maximum device-name length the UI accepts. Purely a readability bound —
 *  the row has to stay legible in a narrow Settings panel. There is no Rust-side
 *  cap (the `label` precedent has none either); the prefs blob's own size ceiling
 *  is the real backstop. */
export const DEVICE_NAME_MAX_LEN = 40;

/** What a rename attempt did. `cancelled` and `failed` are deliberately distinct:
 *  a blank submit is a user cancel and must stay silent, while a failed write has
 *  to surface — otherwise the row silently keeps a name the disk never took. */
export type RenameOutcome = "saved" | "cancelled" | "failed";

export interface DeviceNamesHook {
  /** `device_id` hex → display name. Empty until the first read resolves. */
  names: Record<string, string>;
  /** Re-read the map from disk (after a local write, or on a peer's change). */
  reload: () => Promise<void>;
  /** Rename one device. Blank/whitespace input is a cancel, never a write. */
  rename: (deviceIdHex: string, name: string) => Promise<RenameOutcome>;
}

export function useDeviceNames(): DeviceNamesHook {
  const [names, setNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const view = await prefsRead();
      setNames(view.device_names ?? {});
    } catch {
      // SlotNotUnlocked / Io / InvalidVaultMeta → keep the last-good map. Every
      // unnamed device already renders its id-derived fallback, so a failed read
      // degrades to the pre-feature list rather than to an error state.
    }
  }, []);

  // Re-read on every prefs-changed nonce advance. That nonce is the desktop's
  // shared refresh signal, and `Editor.tsx` already bridges the sync loop's
  // `PREFS_SYNC_APPLIED_EVENT` into it — so a peer's rename, and a newly
  // approved device's own name, land here with no second Tauri listener (the
  // Editor's bridge is deliberately subscribed ONCE) and nothing to clean up.
  const nonce = usePrefsNonce();
  useEffect(() => {
    void load();
  }, [load, nonce]);

  // Deliberately NOT optimistic. The panel renders straight off `names`, so on a
  // failed write the row simply never changed — which is the "revert to the
  // previous name" behaviour, for free and without a rollback path that could
  // itself desync from disk.
  const rename = useCallback(
    async (deviceIdHex: string, name: string): Promise<RenameOutcome> => {
      const trimmed = name.trim();
      if (trimmed === "") return "cancelled";
      try {
        await setDeviceName(deviceIdHex, trimmed);
        await load();
        return "saved";
      } catch {
        return "failed";
      }
    },
    [load],
  );

  return { names, reload: load, rename };
}
