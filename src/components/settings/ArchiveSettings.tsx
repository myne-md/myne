// Settings → Editor: note-archive feature toggle (archive-disable, MYND-…).
// A single `<Switch>` toggle mirroring LineNumbersSettings' control, but
// with one extra responsibility: turning archiving OFF first empties the
// Archive (auto-unarchives every archived note) so no note is left inaccessible
// once the archive entry points are hidden. Only then is the disable flag
// persisted — if the bulk-unarchive partially fails the flag is NOT written, so
// a note can never end up both archived and unreachable.
//
// The bulk-unarchive runs through the sidebar context: this component is
// rendered inside <SettingsModal>, which mounts inside <SidebarStateProvider>,
// so `useSelectedNote()` is available here directly (no prop drilling).
//
// Default: archiving ENABLED. `archive_disabled === null` ≡ unset → host
// default-OFF (archiving on, the pre-feature behaviour); only an explicit choice
// is persisted. The setter bumps the prefs nonce, so the sidebar (its own
// `usePrefs`) re-reads and shows/hides the Archive button live (no remount).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { ControlBlock } from "./ControlBlock";
import {
  prefsRead,
  setArchiveDisabled,
  setArchivedFolders,
} from "../../lib/prefs";
import { archivedRecords, useSelectedNote } from "../../notes/sidebarState";

const ERROR_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

export function ArchiveSettings() {
  const { t } = useTranslation();
  // `enabled` tracks whether ARCHIVING is on (the user-facing polarity), which is
  // the inverse of the stored `archive_disabled` flag.
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ctx = useSelectedNote();

  useEffect(() => {
    let cancelled = false;
    void prefsRead()
      .then((p) => {
        if (cancelled) return;
        // null ≡ unset → archiving enabled (host default-OFF for the flag).
        setEnabled(!(p.archive_disabled ?? false));
      })
      .catch(() => {
        /* locked / no vault — leave default ON (archiving enabled) */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(next: boolean) {
    const prev = enabled;
    setEnabled(next); // optimistic
    try {
      if (!next) {
        // Disabling archiving: empty the Archive FIRST so nothing is stranded.
        const ids = archivedRecords(ctx.cache).map((r) => r.noteUuid);
        const result = await ctx.bulkUnarchiveWithSync(ids);
        if (result.failed.length > 0) {
          // Leave the flag unwritten — some notes are still archived, so keeping
          // the entry points visible is the safe state.
          throw new Error("bulk unarchive partially failed");
        }
        // Folder-archived subtrees (folder-archive) hide notes WITHOUT a per-note
        // marker, so bulkUnarchive can't reach them — clear the whole
        // archived_folders set too, else a folder stays hidden with no entry
        // point once the archive UI is gone.
        await setArchivedFolders([]);
      }
      await setArchiveDisabled(!next);
      setError(null);
    } catch {
      setEnabled(prev); // rollback
      setError(t("settings.archive.saveError"));
    }
  }

  return (
    <>
      <ControlBlock
        label={t("settings.archive.label")}
        helper={t("settings.archive.helper")}
        control={
          <Switch
            checked={enabled}
            onChange={() => toggle(!enabled)}
            ariaLabel={t("settings.archive.label")}
            testId="settings.archive-disabled"
          />
        }
      />
      {error !== null && <p style={ERROR_STYLE}>{error}</p>}
    </>
  );
}
