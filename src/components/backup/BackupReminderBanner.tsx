// 30-day backup-reminder banner (MYND-56 task 8; SYNC-9).
//
// A quiet nudge, not an alarm: paper tones, single line, session-scoped
// dismissal (deliberately NO persistent snooze — that would need a second
// prefs field or a plaintext localStorage cadence leak, rejected in
// SYNC-9). The pure show/hide decision lives in
// `lib/vault-backup.ts::shouldShowBackupReminder` (Vitest-pinned).

import type { CSSProperties } from "react";
import { BACKUP_REMINDER_DAYS } from "../../lib/vault-backup";

const BANNER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 16px",
  background: "var(--paper-2)",
  borderBottom: "1px solid var(--line-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const LINK_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--accent)",
  fontFamily: "inherit",
  fontSize: "inherit",
  cursor: "pointer",
  textDecoration: "underline",
};

interface BackupReminderBannerProps {
  onBackUpNow: () => void;
  onDismiss: () => void;
}

export function BackupReminderBanner({
  onBackUpNow,
  onDismiss,
}: BackupReminderBannerProps) {
  return (
    <div data-testid="backup-reminder.banner" style={BANNER_STYLE}>
      <span style={{ flex: 1 }}>
        This vault hasn't been backed up in {BACKUP_REMINDER_DAYS} days.
      </span>
      <button
        type="button"
        style={LINK_STYLE}
        onClick={onBackUpNow}
        data-testid="backup-reminder.backup-now"
      >
        Back up now
      </button>
      <button
        type="button"
        style={{ ...LINK_STYLE, textDecoration: "none", color: "var(--fg-3)" }}
        onClick={onDismiss}
        aria-label="Dismiss backup reminder"
        data-testid="backup-reminder.dismiss"
      >
        ×
      </button>
    </div>
  );
}
