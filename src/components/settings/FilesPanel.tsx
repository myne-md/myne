// Settings → Files panel: note-storage + startup behaviour (MYND-462). A thin
// composition shell — the persistence logic lives in the two child components.
// Added as a distinct panel (rather than folded into Editor) by the
// `design-notes.md` entry superseding the Editor-panel taxonomy change; it
// groups the file-oriented preferences (which note opens on launch + where new
// notes land), mirroring Obsidian's "Files & Links" grouping.

import { useTranslation } from "react-i18next";
import { StartupOpenSettings } from "./StartupOpenSettings";
import { NewNoteLocationSettings } from "./NewNoteLocationSettings";
import { FolderNotesSettings } from "./FolderNotesSettings";
import { AttachmentCompressionSettings } from "./AttachmentCompressionSettings";
import { AttachmentOcrSettings } from "./AttachmentOcrSettings";
import { SettingsSection } from "./SettingsSection";
import { PANEL_ROOT_STYLE } from "./panel-styles";

export function FilesPanel() {
  const { t } = useTranslation();
  return (
    <div style={PANEL_ROOT_STYLE} data-testid="settings.files-panel">
      {/* Two sections (myne-md/myne#885): where notes and folders live and how
          they open, against what happens to a file once it is an attachment.
          That is the boundary the five child components already drew by sitting
          in this order. */}
      <SettingsSection title={t("settings.files.sections.notes")}>
        {/* Default file to open on startup (MYND-462): last opened / new note /
            a specific note. First, as the launch-time behaviour. */}
        <StartupOpenSettings />

        {/* Default location for new notes (MYND-462): vault root / current note's
            folder / a specific folder. */}
        <NewNoteLocationSettings />

        {/* Folder-notes feature off-switch (myne-md/myne#661), default off. Gates
            the folder-index entry points and whether folder_index: true is
            honoured for sidebar / link presentation. A files-and-links behaviour,
            so it sits with the other note-organization preferences here. */}
        <FolderNotesSettings />
      </SettingsSection>

      <SettingsSection title={t("settings.files.sections.attachments")}>
        {/* Whether an imported image is downscaled + re-encoded at ingest time
            (ingest-image-compression). Shared vault-wide, unlike its neighbor
            below. See the preference's own doc comment for why. */}
        <AttachmentCompressionSettings />

        {/* Whether attachment text extraction reads images and scanned PDFs
            (MYND-441). Lives here rather than under Developer because OCR is search
            correctness, not an AI feature. It ships on by default. */}
        <AttachmentOcrSettings />
      </SettingsSection>
    </div>
  );
}
