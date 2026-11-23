// Non-blocking reconcile banner (MYND-426 task 5) — a reassuring, one-time
// "this device was offline a while, re-syncing" notice shown during a background
// full-reconcile (410 cursor-expired / soft-retire return). RepairResidueBanner
// pattern: informational, dismissable, NEVER implies data loss, never blocks the
// editor. Penpot skipped per the owner directive; built against design tokens.

import { useTranslation } from "react-i18next";
import { NoticeCard } from "../notices/NoticeStack";

interface ReconcileBannerProps {
  /** Whether a background reconcile is in progress. */
  active: boolean;
  /** Dismiss handler (the banner is non-blocking + dismissable). */
  onDismiss?: () => void;
}

export function ReconcileBanner({ active, onDismiss }: ReconcileBannerProps) {
  const { t } = useTranslation();
  if (!active) return null;
  // Reassuring, non-alarming — re-syncing is routine, not a problem.
  return (
    <NoticeCard
      severity="info"
      role="status"
      testId="sync.reconcile-banner"
      onDismiss={onDismiss}
      dismissLabel={onDismiss ? t("common.dismiss") : undefined}
      dismissTestId="sync.reconcile-banner-dismiss"
    >
      {t("sync.reconcile.message")}
    </NoticeCard>
  );
}
