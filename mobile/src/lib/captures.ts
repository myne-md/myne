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
//   • sealMeetingChunk() — the watch MEETING lane (myne-md/myne#812). The iOS
//     receiver (`WCMeetingReceiver`) dispatches a `myne-meeting-chunk` window
//     event with the arrived chunk's inbox path + manifest fields; this seals it
//     on arrival (`plugin:captures|seal_meeting_chunk`, device-key based, so it
//     runs while the vault is LOCKED) rather than staging plaintext. The grouped
//     drain into a note lives in `meetingDrain.ts`.
//
// There is no second, unaudited native persistence path — the native side only
// stages plaintext + emits an event; all encryption + note creation is here /
// in Rust.

import { invoke } from "../platform/core";
import { HAS_TAURI } from "./app-window";
import { noteCreate } from "./notes";

/** Fired on the window when a watch capture has been staged (by the native
 *  receiver bridge, or by a test) so the app seals it promptly. */
export const CAPTURE_STAGED_EVENT = "myne-capture-staged";

/** Fired on the window by the native `WCMeetingReceiver` when a meeting audio
 *  chunk has arrived (myne-md/myne#812), so the app seals it immediately. */
export const MEETING_CHUNK_EVENT = "myne-meeting-chunk";

interface PendingCapture {
  id: string;
  text: string;
}

/** One arrived watch meeting-audio chunk, mirroring the native dispatcher's
 *  `CustomEvent.detail`. `path` is the file WatchConnectivity placed in the app
 *  inbox; the seal reads it and deletes it. */
export interface MeetingChunkDelivery {
  path: string;
  /** Watch-supplied opaque session id (groups the chunks). */
  sessionId: string;
  /** The watch's ordering position within the session. */
  chunkIndex: number;
  /** Session start, milliseconds since the Unix epoch. */
  startedAt: number;
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

/** Seal one arrived watch meeting-audio chunk on arrival (myne-md/myne#812).
 *  Device-key based, so it runs while the vault is LOCKED; the Rust command
 *  reads `path`, seals it under the share-import wrap key into the meeting
 *  entries dir, records it in the pending-meeting manifest, and deletes the
 *  source. Inert (swallows) without a host / plugin or on a transient failure.
 *
 *  A swallowed failure does NOT lose the chunk: the native receiver names each
 *  inbox file with its delivery metadata, so the chunk stays in the app-owned
 *  inbox and `sealMeetingInbox` (below) retries it on the next boot / unlock.
 *  WatchConnectivity does NOT re-deliver — the native move consumed the transfer
 *  — which is exactly why the inbox re-scan exists. */
export async function sealMeetingChunk(delivery: MeetingChunkDelivery): Promise<void> {
  try {
    await invoke("plugin:captures|seal_meeting_chunk", {
      sessionId: delivery.sessionId,
      chunkIndex: delivery.chunkIndex,
      startedAt: delivery.startedAt,
      path: delivery.path,
    });
  } catch {
    // No host / plugin, or a transient failure — the inbox re-scan retries it.
  }
}

/** Seal every chunk left in the app-owned meeting inbox (myne-md/myne#812
 *  review). The retry half of the on-arrival seal: the native receiver MOVES a
 *  delivery into the inbox (consuming the WatchConnectivity transfer), so a seal
 *  that failed or never ran — a keychain error before the first post-boot
 *  unlock, or a process death between the move and the seal — would otherwise
 *  orphan the plaintext chunk forever. Called on boot and on unlock; the Rust
 *  command recovers each chunk's grouping from its filename and is idempotent.
 *  Inert without a host / plugin. */
export async function sealMeetingInbox(): Promise<void> {
  try {
    await invoke("plugin:captures|seal_meeting_inbox");
  } catch {
    // No host / plugin, or a transient failure — the next boot / unlock retries.
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
        // A watch dictation carries no folder: it lands at the vault root.
        await noteCreate(cap.text, null);
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
    // The native `WCMeetingReceiver` dispatches this for each arrived meeting
    // chunk (myne-md/myne#812); seal it on arrival. Always attached, so an
    // in-app / test trigger works too; inert without a host.
    window.addEventListener(MEETING_CHUNK_EVENT, (e) => {
      const detail = (e as CustomEvent<MeetingChunkDelivery>).detail;
      if (detail?.path) void sealMeetingChunk(detail);
    });
  }
  if (!HAS_TAURI) return;
  // Seal anything staged before this launch (a capture delivered while the app
  // was not running).
  void sealStagedCaptures();
  // Seal any meeting-audio chunk left in the app-owned inbox: a delivery whose
  // on-arrival seal failed or never ran (the receiver moved it and consumed the
  // WatchConnectivity transfer, so nothing re-delivers it). Idempotent.
  void sealMeetingInbox();
  try {
    // The native WatchConnectivity receiver emits a `capture` event whenever it
    // stages a freshly-delivered capture; seal it promptly.
    const { listen } = await import("../platform/event");
    await listen("capture", () => void sealStagedCaptures());
  } catch {
    // Older host / no event API — the boot poll + window trigger still cover it.
  }
}
