// The Tor connection banner in the editor chrome (MYND-650 task 8).
//
// Two states get a banner and two deliberately do not:
//
//  - **connecting** — Tor mode is on, the client is bootstrapping, sync is
//    paused. Shown, because the user just turned something on and sync stopping
//    for half a minute with no explanation reads as a broken app.
//  - **unavailable** — Tor mode is on and the tunnel is not usable. Shown, and
//    this is the one this component exists for: the transport is fail-closed,
//    so nothing is leaving this device, and the *only* way a user learns that
//    is if we say it. A silent pause here is indistinguishable from "sync is
//    fine" right up until they lose a device.
//  - **active** — nothing. The posture indicator in Settings → Network answers
//    "am I protected"; a permanent banner asserting it would train the user to
//    ignore this strip, which is where the fail-closed message lives.
//  - **inactive** — nothing. Direct sync is the shipped default and the state
//    of every install that never opted in; a banner would turn the normal case
//    into an alarm.
//
// **Neither banner is dismissable, and that is the point.** Both describe a
// condition that is still true after it is dismissed — sync is paused either
// way — and `unavailable` does not resolve on its own. A dismiss button would
// let the user restore exactly the silence the banner exists to break, which is
// the same reasoning `SyncBanners` applies to the credential-ambiguous refusal.
// `connecting` clears itself within seconds by becoming a different posture.
//
// Copy discipline: the fail-closed message must never read as "protected" or as
// a passing state, and it must say what is happening to the user's data — sync
// is paused, nothing is going out directly — rather than naming our process.
// `tests/components/torStatusBanner.test.tsx` pins that against the catalog.

import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type { TorPosture } from "../../lib/tor-routing";

const BANNER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-3) var(--space-4)",
  borderRadius: "var(--radius-2)",
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

const DOT_STYLE: CSSProperties = {
  width: "8px",
  height: "8px",
  borderRadius: "var(--radius-pill)",
  flexShrink: 0,
};

const HINT_STYLE: CSSProperties = {
  marginInlineStart: "auto",
  color: "var(--fg-3)",
  whiteSpace: "nowrap",
};

export interface TorStatusBannerProps {
  /** The live posture; `null` while unknown or on a platform without Tor. */
  posture: TorPosture | null;
}

export function TorStatusBanner({ posture }: TorStatusBannerProps) {
  const { t } = useTranslation();
  if (posture !== "connecting" && posture !== "unavailable") return null;

  const unavailable = posture === "unavailable";
  return (
    <div
      // `alert` for the fail-closed state (a screen reader should not have to
      // wait for a pause in the user's typing to learn sync stopped) and
      // `status` for the transient one.
      role={unavailable ? "alert" : "status"}
      data-testid="sync.tor-banner"
      data-posture={posture}
      style={{
        ...BANNER_STYLE,
        border: `1px solid ${unavailable ? "var(--danger)" : "var(--line-1)"}`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          ...DOT_STYLE,
          background: unavailable ? "var(--danger)" : "var(--accent)",
        }}
      />
      <span>{unavailable ? t("sync.tor.unavailable") : t("sync.tor.connecting")}</span>
      {unavailable && <span style={HINT_STYLE}>{t("sync.tor.settingsHint")}</span>}
    </div>
  );
}
