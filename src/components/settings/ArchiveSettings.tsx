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

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../primitives/Switch";
import { SettingRow } from "./SettingRow";
import {
  prefsRead,
  setArchiveDisabled,
  mutateArchivedFolders,
} from "../../lib/prefs";
import { archivedRecords, useSelectedNote } from "../../notes/sidebarState";

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
        // marker, so bulkUnarchive can't reach them. Clear the whole
        // archived_folders set too, else a folder stays hidden with no entry
        // point once the archive UI is gone.
        //
        // myne#613: clearing has to SAY what it removes. There is no "make this
        // empty" verb, deliberately, because that verb is what let a caller
        // erase entries it had never seen. Read the stored set here rather than
        // trusting a local copy, and if that read fails the clear does not
        // happen: the catch below rolls the toggle back, which is the honest
        // outcome when we cannot know what we would be removing.
        //
        // The REACH of this clear grew inside myne#613 and the copy had to
        // follow. `archived_folders` propagates removals now, so the clear
        // reaches every device; before the removal clock a peer's clockless
        // union restored it, which made the folder half effectively
        // device-local while the note half above (`bulkUnarchiveWithSync`,
        // which rewrites frontmatter) always propagated. So this change made
        // the toggle coherent rather than making it destructive, and the
        // helper string now says the scale out loud. Whether an action of this
        // reach should also CONFIRM is a product decision about the whole
        // toggle, note half included, and it is not this branch's to take.
        const stored = (await prefsRead()).archived_folders;
        if (stored.length > 0) {
          await mutateArchivedFolders({ remove: stored });
        }
      }
      await setArchiveDisabled(!next);
      setError(null);
    } catch {
      setEnabled(prev); // rollback
      setError(t("settings.archive.saveError"));
    }
  }

  return (
    <SettingRow
      label={t("settings.archive.label")}
      helper={t("settings.archive.helper")}
      error={error}
      control={(helperId) => (
        <Switch
          checked={enabled}
          onChange={() => toggle(!enabled)}
          ariaLabel={t("settings.archive.label")}
          ariaDescribedBy={helperId}
          testId="settings.archive-disabled"
        />
      )}
    />
  );
}
