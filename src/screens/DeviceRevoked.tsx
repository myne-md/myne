// This browser was removed from the account (phase3-web-client task 94).
//
// # Why this is terminal on web and a retry ladder everywhere else
//
// `loop_control` parks flat on a 401 until re-auth. On desktop that is exactly
// right: the machine is the user's, the vault directory is theirs, re-enrolling
// is the fix. On web it is wrong in precisely the scenario the web client exists
// for — someone opens their vault on a borrowed or locked-down laptop, closes
// the tab, and later removes that device from another client **specifically to
// cut it off**. The browser it was cut off from still holds a complete OPFS copy
// that unlocks with the password, reads offline, and shows nothing but a red dot.
//
// So: lock, erase this browser's copy, and say what happened. On desktop and
// mobile the same server code keeps today's park-and-prompt behaviour, because
// erasing a user's own machine on a server signal would be a new and unasked-for
// destructive power.
//
// # What this screen must never imply
//
// Not a remote wipe. `REMOVE_DEVICE_DISCLOSURE` promises the person doing the
// removing that removal "does not lock a device that already has your vault and
// password", and this screen is read by the person it happened to — if the two
// disagree, a user who reads both concludes one is lying. The erase here is
// something this client did to ITSELF because it can no longer sync, and the
// shared literal says so. It also names the real loss, which is the part a
// reassuring paraphrase would drop: anything this browser had not synced is gone.
//
// # The Web Lock
//
// Task 21's single-tab lock is released by the reload this screen's CTA performs
// — the page and its Worker are torn down, and a `navigator.locks` grant does not
// outlive the context that holds it. Stated rather than left implicit because
// "release the Web Lock" reads like it needs a call, and reaching for one here
// would be a second release path racing the first.

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../components/primitives/CenteredCard";
import { DEVICE_REVOKED_DISCLOSURE } from "../lib/load-bearing-copy";

const CTA_STYLE: CSSProperties = {
  marginTop: "var(--space-2)",
  alignSelf: "flex-start",
  background: "var(--accent)",
  color: "var(--accent-on)",
  border: "none",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  cursor: "pointer",
};

export interface DeviceRevokedProps {
  /**
   * Lock the vault and erase this browser's copy. Runs on mount, once —
   * the user is not asked to confirm, and that is the decision: they already
   * confirmed it, on the other device, when they removed this one.
   */
  onEraseLocalCopy: () => Promise<void>;
  /** Leave the screen — a reload, which also releases the single-tab lock. */
  onDismiss: () => void;
}

export function DeviceRevoked({ onEraseLocalCopy, onDismiss }: DeviceRevokedProps) {
  const { t } = useTranslation();
  const [erased, setErased] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void onEraseLocalCopy()
      .catch(() => {
        // Deliberately not surfaced as a distinct state. The disclosure below
        // is about what the REVOCATION means, and it is true either way; a
        // failed unlink leaves an encrypted container this device can no longer
        // obtain a token for, which is not a second thing to explain. Retrying
        // is the reload's job.
      })
      .finally(() => {
        if (!cancelled) setErased(true);
      });
    return () => {
      cancelled = true;
    };
  }, [onEraseLocalCopy]);

  return (
    <CenteredCard>
      <div
        role="alert"
        aria-live="assertive"
        data-testid="device-revoked.root"
        data-erased={erased ? "true" : "false"}
        style={{ display: "contents" }}
      >
        <h1 style={CARD_TITLE_STYLE} data-testid="device-revoked.title">
          {t("deviceRevoked.title")}
        </h1>
        {/* Load-bearing: rendered verbatim in every locale, and E2E asserts it
            by full-literal equality. A paraphrase here would be a claim about
            what happened to the user's data. */}
        <p style={CARD_BODY_STYLE} data-testid="device-revoked.disclosure">
          {DEVICE_REVOKED_DISCLOSURE}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          style={CTA_STYLE}
          data-testid="device-revoked.cta"
        >
          {t("deviceRevoked.cta")}
        </button>
      </div>
    </CenteredCard>
  );
}
