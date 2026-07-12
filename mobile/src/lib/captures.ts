// Pending-capture bridge for the Apple Watch voice-quick-capture companion
// (`spec/protocol.md` §9.18). The watch app holds NO vault key and runs no
// crypto — it dictates note text and relays it to the phone over
// WatchConnectivity, where the native receiver stages it as a plaintext file.
//
// This module drives the two halves that live INSIDE the WebView trust boundary:
//
//   • sealStagedCaptures() — ask the Rust `captures` plugin to encrypt any staged
//     captures into the device-local `MYK1` queue. Device-key based, so it runs
//     while the vault is LOCKED. Triggered on boot, on the native `capture` event
//     (fired by the receiver when it stages a fresh delivery), and on the
//     in-app/test `myne-capture-staged` window event.
//
//   • drainPendingCaptures() — on unlock, decrypt every queued capture and turn
//     each into a note via the ordinary, audited `plugin:notes|note_create` path,
//     then acknowledge (delete) it. Called from EditorFlow's mount effect (the
//     editor mounts on every unlock path). At-least-once: an entry is acked only
//     after its note is created, so a crash mid-drain re-drains into a rare
//     duplicate; `isDraining` guards against a StrictMode double-mount.
//
// There is no second, unaudited native persistence path — the native side only
// stages plaintext + emits an event; all encryption + note creation is here /
// in Rust.

import { invoke } from "@tauri-apps/api/core";
import { HAS_TAURI } from "./app-window";
import { noteCreate } from "./notes";

/** Fired on the window when a watch capture has been staged (by the native
 *  receiver bridge, or by a test) so the app seals it promptly. */
export const CAPTURE_STAGED_EVENT = "myne-capture-staged";

interface PendingCapture {
  id: string;
  text: string;
}

/** Seal any staged watch captures into the encrypted queue. Inert (swallows) if
 *  the host / plugin is unavailable (browser dev) or a transient seal fails —
 *  the native staging file stays and the next trigger retries. */
export async function sealStagedCaptures(): Promise<void> {
  try {
    await invoke("plugin:captures|seal_staged");
  } catch {
    // No host / plugin, or a transient failure — inert.
  }
}

let isDraining = false;

/** Drain the pending-capture queue into the vault as new notes. Returns the
 *  number of notes created. Serialised by `isDraining` so a StrictMode
 *  double-mount does not double-create. */
export async function drainPendingCaptures(): Promise<number> {
  if (isDraining) return 0;
  isDraining = true;
  let created = 0;
  try {
    let pending: PendingCapture[];
    try {
      pending = await invoke<PendingCapture[]>("plugin:captures|take_pending");
    } catch {
      return 0; // no host / plugin — nothing to drain
    }
    for (const cap of pending) {
      try {
        await noteCreate(cap.text);
        created += 1;
      } catch {
        // Vault locked mid-drain (or note-create failure) — stop; the un-acked
        // entries remain for the next unlock.
        return created;
      }
      // Ack only AFTER the note exists (at-least-once). A failed ack leaves the
      // entry for a later drain (a rare duplicate), never a lost capture.
      await invoke("plugin:captures|ack", { id: cap.id }).catch(() => {});
    }
  } finally {
    isDraining = false;
  }
  return created;
}

/** Subscribe to watch-capture staging + seal on boot. Called once at boot,
 *  mirroring `initDeepLinks`. The window listener is always attached (in-app /
 *  test trigger); the boot poll + native `capture` event only run under Tauri. */
export async function initCaptures(): Promise<void> {
  if (typeof window !== "undefined") {
    window.addEventListener(CAPTURE_STAGED_EVENT, () => void sealStagedCaptures());
  }
  if (!HAS_TAURI) return;
  // Seal anything staged before this launch (a capture delivered while the app
  // was not running).
  void sealStagedCaptures();
  try {
    // The native WatchConnectivity receiver emits a `capture` event whenever it
    // stages a freshly-delivered capture; seal it promptly.
    const { listen } = await import("@tauri-apps/api/event");
    await listen("capture", () => void sealStagedCaptures());
  } catch {
    // Older host / no event API — the boot poll + window trigger still cover it.
  }
}
