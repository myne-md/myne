// Web seam: `update`. The desktop self-update commands are absent on web:
// `selfUpdate` is not a web capability (`tauri-plugin-updater` has no browser
// target, and a served page cannot replace itself). These are typed refusals,
// matching the seam convention, not silent no-ops.
//
// Reaching one here is a wiring mistake, because every caller is gated on
// `has("selfUpdate")`; the typed error names which command was refused, at the
// IPC granularity the seam already admits (`unsupported` takes an
// `IpcCommandName`).

import { unsupported } from "../../../src/platform/unsupported";

// The type below is mirrored by TYPE-ONLY import rather than re-declared: it is
// what the desktop seam says the host emits, and a second hand-written union here
// is the drift `conformance.ts` exists to catch on the modules it covers. A
// type-only import is erased, so no Tauri code reaches this bundle.
import type { UpdateProgress } from "../../../src/platform/update";

export type { UpdateProgress };

export type UpdateStatus =
  | { kind: "up_to_date" }
  | { kind: "available"; version: string; notes: string | null };

export type UpdateCheckError =
  | "unreachable"
  | "verification"
  | "unsupported"
  | "other";

export async function updateCheck(): Promise<UpdateStatus> {
  return unsupported("plugin:update|update_check");
}

export async function updateInstall(): Promise<void> {
  return unsupported("plugin:update|update_install");
}

export async function getAutoCheck(): Promise<boolean> {
  return unsupported("plugin:update|update_get_auto_check");
}

export async function setAutoCheck(_enabled: boolean): Promise<void> {
  return unsupported("plugin:update|update_set_auto_check");
}

/**
 * The install's progress event name, at the same value as the desktop seam so the
 * shared hook imports one name on both clients. Written out rather than
 * re-exported: a VALUE re-export would pull `src/platform/update.ts` into this
 * bundle, and that module imports `@tauri-apps/api/core`. The type above is a
 * type-only import, which is erased at build time and so is safe; a value is not.
 * Nothing on this client emits this event, since no surface here renders an
 * update flow (the `selfUpdate` capability is desktop-only), and the subscription
 * itself goes through the `event` seam, which both clients implement.
 */
export const UPDATE_PROGRESS_EVENT = "update:progress";
