import { getHost } from "../../host";
export function attachmentExport(id: string, dest: string, overwrite: boolean): Promise<void> { return getHost().attachments.attachmentExport(id, dest, overwrite); }
export function attachmentRename(id: string, name: string): Promise<void> { return getHost().attachments.attachmentRename(id, name); }
/** Whether this platform can export an attachment to a chosen destination.
 *
 * Callers must consult this BEFORE offering the affordance: the answer is a
 * platform fact, and an Export menu item on a platform that cannot export is an
 * offer that cannot be honoured (`decisions.md` 2026-07-26 — absent, never
 * disabled). */
export function canExportAttachment(): boolean {
  return typeof getHost().attachments.pickExportDestination === "function";
}

export function pickExportDestination(filename: string): Promise<string | null> {
  const pick = getHost().attachments.pickExportDestination;
  if (pick === undefined) {
    // Reached only if a caller skipped `canExportAttachment`. Rejecting rather
    // than resolving `null` is deliberate: `null` means "the user cancelled",
    // and silently swallowing a missing capability as a cancellation is exactly
    // the stub-that-pretends-to-work this seam refuses.
    return Promise.reject(
      new Error("@myne/editor: this platform has no attachment export destination"),
    );
  }
  return pick(filename);
}
