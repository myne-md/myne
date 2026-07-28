// The web build's stand-in for the backup-export modal
// (phase3-web-client task 96).
//
// Mounted by `Editor.tsx` for the whole unlocked session and opened from
// Settings → Storage → "Back up vault…", a control the web Storage panel does
// not render. Unreachable, therefore — and substituted so it is also absent,
// which is what keeps the export orchestration and its `plugin:backup|*`
// command names out of the bundle.

export interface BackupExportModalProps {
  [key: string]: unknown;
}

export function BackupExportModal(_props: BackupExportModalProps) {
  return null;
}
