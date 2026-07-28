// The web build's Settings → Storage panel (phase3-web-client task 96).
//
// # Every control on the desktop panel is wrong here, for four different reasons
//
// * **The vault path.** It resolves `appDataDir()` + `join()` and prints an
//   absolute filesystem path. Browser storage is OPFS: origin-scoped, opaque,
//   and not addressable by any path a user could act on. There is nothing true
//   to print.
// * **"Open in Files".** `openPath` hands a directory to the OS file manager.
//   A page cannot ask the operating system to open anything.
// * **Back up / Restore + the automatic-backup block.** `backup` is a decided
//   absence (`decisions.md` 2026-07-26) — a browser cannot write a backup file
//   to a place the user keeps. Substituting the whole panel is also what takes
//   `lib/backup-schedule.ts` and `lib/vault-backup.ts` out of the bundle: they
//   are reachable only through the block this panel mounts, so gating the block
//   at render would have left both, and with them the `plugin:backup|*` command
//   names.
// * **"Import Obsidian vault…".** Nothing to restore here, and the reason is
//   worth stating because this comment used to claim otherwise. Task 71 settled
//   the verdict (2026-07-27: markdown import SHIPS on web) — and the flow was
//   never mounted from this panel on either client. `ObsidianImportModal` is
//   mounted by the SHARED `src/screens/Editor.tsx` and reached from the command
//   palette and the onboarding offer, so it arrives on web with the rest of the
//   shared tree the moment its directory picker works, which it now does.
//
// # What it says instead
//
// Where the notes actually live, in terms a browser user can act on: this
// origin's storage, managed by the browser, and the honest consequence — clearing
// site data removes the local copy, which on a sync-required client is a
// re-download rather than a loss. That last sentence is the one that matters: it
// is the difference between "my notes are gone" and "this browser forgot them".

import { useTranslation } from "react-i18next";
import { ControlBlock } from "../../../../src/components/settings/ControlBlock";
import { PANEL_ROOT_STYLE } from "../../../../src/components/settings/panel-styles";

export function StoragePanel() {
  const { t } = useTranslation();
  return (
    <div style={PANEL_ROOT_STYLE} data-testid="settings.storage-panel">
      <ControlBlock
        label={t("settings.storage.webLocationLabel")}
        helper={t("settings.storage.webLocationHelper")}
        control={null}
      />
    </div>
  );
}
