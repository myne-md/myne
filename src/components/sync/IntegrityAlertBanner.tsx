// Integrity-alert banner (MYND-427 task 3) — the hard, honest alert shown when
// the engine's head-verify rejects a rollback / non-extending head (or a fork
// verdict). SuspicionBanner-class: honest, NOT alarming (PRODUCT.md tone). The
// copy is the load-bearing `SYNC_INTEGRITY_ALERT` literal — rendered verbatim
// (E2E asserts it by full-literal equality). Penpot skipped per the owner
// directive; built against design tokens.

import { useTranslation } from "react-i18next";
import { SYNC_INTEGRITY_ALERT } from "../../lib/load-bearing-copy";
import { NoticeCard } from "../notices/NoticeStack";

interface IntegrityAlertBannerProps {
  /** Whether the alert is active (an integrity failure was raised). */
  present: boolean;
  /** Optional dismiss handler (the alert is acknowledgeable, not blocking). */
  onDismiss?: () => void;
}

export function IntegrityAlertBanner({ present, onDismiss }: IntegrityAlertBannerProps) {
  const { t } = useTranslation();
  if (!present) return null;
  // The one message here that is a WARNING rather than a status: it says the
  // server's answer was refused, so it keeps `alert` and the warning border.
  return (
    <NoticeCard
      severity="warning"
      role="alert"
      testId="sync.integrity-alert"
      onDismiss={onDismiss}
      dismissLabel={onDismiss ? t("common.dismiss") : undefined}
      dismissTestId="sync.integrity-alert-dismiss"
    >
      {SYNC_INTEGRITY_ALERT}
    </NoticeCard>
  );
}
