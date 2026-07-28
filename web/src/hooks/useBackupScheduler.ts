// The web build's `useBackupScheduler` (phase3-web-client task 96).
//
// The shared hook is already gated on `has("backup")` and issues nothing here —
// that gate is what stops the five-minute IPC loop. This substitute is the
// second half: it keeps `lib/backup-schedule.ts` and `lib/vault-backup.ts` out
// of the BUNDLE, along with the five `plugin:backup|*` command names they carry.
//
// Both are needed and they are not the same claim. The gate makes the client
// behave; the substitution makes the artefact honest — and this feature keeps
// choosing the second bar wherever it can reach it.

import type { ScheduleTick } from "../../../src/lib/backup-schedule";

export function useBackupScheduler(_onTick?: (tick: ScheduleTick) => void): void {
  // Nothing. `backup` is a decided absence on this client.
}
