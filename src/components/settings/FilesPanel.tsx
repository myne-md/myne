// Settings → Files panel: note-storage + startup behaviour (MYND-462). A thin
// composition shell — the persistence logic lives in the two child components.
// Added as a distinct panel (rather than folded into Editor) by the
// `design-notes.md` entry superseding the Editor-panel taxonomy change; it
// groups the file-oriented preferences (which note opens on launch + where new
// notes land), mirroring Obsidian's "Files & Links" grouping.

import { StartupOpenSettings } from "./StartupOpenSettings";
import { NewNoteLocationSettings } from "./NewNoteLocationSettings";
import { PANEL_ROOT_STYLE } from "./panel-styles";

export function FilesPanel() {
  return (
    <div style={PANEL_ROOT_STYLE} data-testid="settings.files-panel">
      {/* Default file to open on startup (MYND-462) — last opened / new note /
          a specific note. First, as the launch-time behaviour. */}
      <StartupOpenSettings />

      {/* Default location for new notes (MYND-462) — vault root / current note's
          folder / a specific folder. */}
      <NewNoteLocationSettings />
    </div>
  );
}
