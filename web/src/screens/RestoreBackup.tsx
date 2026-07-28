// The web build's stand-in for backup restore (phase3-web-client task 70).
//
// # A decided absence, not a missing port
//
// Encrypted backup export and restore are absent on web by decision
// (`decisions.md` 2026-07-26; `backup` is in the capability descriptor's ABSENT
// set and the dispatcher answers `Unsupported` for every `backup_*` command).
// The reason is not portability — it is that a browser cannot write to a
// user-chosen location, and a restore whose OUTPUT the user cannot keep is not
// a backup story.
//
// The real screen drives those commands end to end: pick a file, enter a
// password, watch a progress stream. Shipping it would put a flow in the bundle
// whose every backend call is refused. Substituted instead, so the flow is
// absent rather than merely unreachable — and so the restore path's file
// picking, password handling and progress subscription do not travel with a
// client that cannot use them.
//
// **The user's route is not closed, it is elsewhere:** a web client's vault
// comes from the server, so its recovery from local damage is a re-sync, which
// boot routing already does (`initialStageFromProbe` sends a corrupt container
// to `account-entry` where `backup` is absent).

import { useTranslation } from "react-i18next";
import { CenteredCard } from "../../../src/components/primitives/CenteredCard";

export interface RestoreBackupProps {
  [key: string]: unknown;
}

export function RestoreBackup(_props: RestoreBackupProps) {
  const { t } = useTranslation();
  return (
    // The container anchor (phase3-web-client task 100). A scenario asserts
    // "absent, not disabled" POSITIVELY — it finds this surface and reads its
    // `data-surface` — rather than by the absence of a selector, which is
    // indistinguishable from a selector somebody renamed.
    <CenteredCard>
      <h1
        style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}
        data-testid="web.unavailable"
        data-surface="backup"
      >
        {t("web.unavailableHere.title")}
      </h1>
      <p style={{ color: "var(--fg-3)" }} data-testid="web.restore-absent">
        {t("web.unavailableHere.backup")}
      </p>
    </CenteredCard>
  );
}
