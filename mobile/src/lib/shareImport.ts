// Share-import drain bridge for files shared into Myne via the OS share sheet
// (`spec/protocol.md` §9.19). The native side (iOS Share Extension / Android
// ACTION_SEND intent) seals a shared file into a device-local encrypted `MYF1`
// queue while the vault may be locked; this module drives the drain that lives
// inside the WebView trust boundary:
//
//   • drainPendingShares() — on unlock, ask the Rust `share-import` plugin to
//     decrypt every queued file and import it into the vault's attachment
//     library. The whole decrypt→import→ack runs HOST-SIDE (SYNC-4 — the
//     up-to-64 MiB bytes never cross the WebView as a JSON number[]); this
//     returns only the small SYNC-9 confirmation list. Called from EditorFlow's
//     mount effect (the editor mounts on every unlock path). At-least-once: the
//     host acks each entry only after its import succeeds.
//
// There is no JS seal step (unlike captures): a shared file is sealed natively
// at arrival, so the WebView only drains.

import { invoke } from "@tauri-apps/api/core";
import { HAS_TAURI } from "./app-window";

/** One received share, mirroring the native `tauri-plugin-share-intent`
 *  `share-intent` event payload (SF3). `dataB64` is the base64 of the shared
 *  file's raw bytes. */
interface ShareIntentEvent {
  filename: string;
  mime: string;
  dataB64: string;
}

/** One imported share, mirroring the Rust `ImportedShare` (SYNC-9). */
export interface ImportedShare {
  /** Content-addressed attachment id (hex) in the library. */
  id: string;
  /** Display filename recorded in the catalog. */
  filename: string;
  /** `true` when the file already existed (dedup hit — a re-share). */
  deduplicated: boolean;
}

/** Fired on the window after a drain imports one or more NON-dedup files, so the
 *  SF5 confirmation toast can show. `detail` is the imported list. */
export const SHARES_IMPORTED_EVENT = "myne-shares-imported";

let isDraining = false;

/** Drain the share-import staging queue into the vault's attachment library.
 *  Returns the imported files (SYNC-9). Serialised by `isDraining` so a
 *  StrictMode double-mount does not double-drain; inert (returns `[]`) without a
 *  host / plugin, or when the vault re-locks mid-drain. Dispatches
 *  {@link SHARES_IMPORTED_EVENT} when at least one fresh file was imported (pure
 *  dedup hits are silent — SYNC-9). */
export async function drainPendingShares(): Promise<ImportedShare[]> {
  if (isDraining) return [];
  isDraining = true;
  try {
    let imported: ImportedShare[];
    try {
      imported = await invoke<ImportedShare[]>("plugin:share-import|drain_pending_shares");
    } catch {
      return []; // no host / plugin, or the vault re-locked mid-drain — inert
    }
    // Announce only genuinely-new files; a batch that was ALL dedup hits (a
    // re-share of files already in the library) shows no toast.
    const fresh = imported.filter((s) => !s.deduplicated);
    if (fresh.length > 0 && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(SHARES_IMPORTED_EVENT, { detail: imported }));
    }
    return imported;
  } finally {
    isDraining = false;
  }
}

/** Decode a base64 string to a byte array. WebView-global `atob` (the shared
 *  file bytes crossed Rust base64-encoded, undecoded — see
 *  `tauri-plugin-share-intent`). */
function base64ToBytes(b64: string): number[] {
  const bin = atob(b64);
  const out = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Seal one received share into the staging queue (SF3). Always-stage
 *  (SYNC-5): it does NOT branch on lock state — `seal_share` is device-key
 *  based and runs while the vault is locked, and staging-then-draining an
 *  already-unlocked vault is correct too (the drain runs on the next editor
 *  mount). Inert (swallows) without a host/plugin, when the Android Keystore
 *  device key is still unavailable, or on a transient seal failure — the native
 *  side does not re-deliver, so a dropped share is simply re-shared by the user. */
async function sealSharedFile(item: ShareIntentEvent): Promise<void> {
  try {
    await invoke("plugin:share-import|seal_share", {
      filename: item.filename,
      mime: item.mime,
      bytes: base64ToBytes(item.dataB64),
    });
  } catch {
    // No host / plugin, device key unavailable (Android Keystore pending), or a
    // transient failure — inert.
  }
}

/** Subscribe to native OS-share-sheet deliveries (SF3) and seal each received
 *  file into the share-import staging queue. Called once at boot, mirroring
 *  {@link initCaptures}. Under Tauri only: the native `tauri-plugin-share-intent`
 *  emits a global `share-intent` event per shared file (cold-launch + warm
 *  delivery both routed through it); in browser dev there is no such event. */
export async function initShareIntent(): Promise<void> {
  if (!HAS_TAURI) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<ShareIntentEvent>("share-intent", (event) => {
      void sealSharedFile(event.payload);
    });
  } catch {
    // Older host / no event API — nothing to subscribe to.
  }
}
