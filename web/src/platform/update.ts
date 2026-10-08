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
