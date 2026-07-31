// Settings → Developer → Network: the device-local Tor-routing toggle
// (MYND-650 task 7).
//
// # Why it sits in the Developer group
//
// Tor mode is a *developer option* (PRD "Solution"), and the Developer group is
// where Myne puts the things it does not vouch for on the user's behalf. Turning
// this on makes sync depend on a Tor client Myne bundles but does not operate,
// and on a volunteer relay network nobody in this repo controls. That is the
// same shape as the AI panel beside it — a door the user opens deliberately —
// and it is why the rail hides both unless Developer mode is on.
//
// The panel is desktop-only twice over: the `torRouting` capability is absent on
// web (a page has no subprocess to spawn and no raw socket to tunnel), so the
// rail filters the whole entry out rather than rendering a greyed one. Web users
// route the entire browser through Tor Browser instead — task 12 documents that.
//
// # The copy is the load-bearing part
//
// The description is bounded by `docs/threat-model.md`: Tor mode is an opt-in
// client-side reduction of the **AS14 / A2 source-IP** exposure and nothing
// else. It does not touch A13 (the server still sees sync timing, blob count and
// blob size), it does not make anyone anonymous *to Myne*, and it does not undo
// the hosted-tier payment-correlation residual (`threat-model.md` §6's
// "Payment-as-deanonymization" note — a pseudonymity loss, never a
// confidentiality one). So the one-line helper states the negative cases in the
// same breath as the positive one, and the residual disclosure spells out the
// three the PRD names plus the scope limit a user is most likely to assume away
// (this routes Myne's sync traffic, not the device).
//
// Words that may never appear here: "anonymous" / "untraceable" as a claim.
// `tests/components/networkPanel.test.tsx` pins that against the real catalog,
// the same way the CLI access block's bounds are pinned.
//
// i18n, not `src/lib/load-bearing-copy.ts`: task 7's acceptance criteria require
// the copy through the catalog, and the CLI-access block already made this call
// for the same reason — a bound stated only in English is a bound most users
// never read. What keeps it honest across locales is the threat-model entry plus
// review, as with every other translated privacy string.
//
// # The switch is not the answer to "am I protected"
//
// The switch is the *preference*: what the user asked for. Whether traffic is
// actually flowing through a bootstrapped Tor client is a different question,
// and the two come apart in the case that matters — a Tor client that failed to
// start leaves the preference on and the tunnel down. So the panel carries a
// second row, the **posture** (MYND-650 task 8), read from the routing gate the
// transport itself obeys rather than from the file on disk.
//
// Four postures, and the copy for each is bounded by what is true of the user's
// data at that moment, not by our process bookkeeping:
//
//  - inactive — direct sync, the shipped default. Stated plainly, never as a
//    warning: turning Tor off is a legitimate choice, not a failure.
//  - connecting — sync PAUSED. Not "protected yet", not a spinner with no
//    consequence named.
//  - active — the one posture that may read as protected.
//  - unavailable — sync PAUSED, fail-closed. The transport refuses to connect
//    at all rather than falling back to a direct connection, and this row plus
//    the editor-chrome banner (`TorStatusBanner`) are the only places the user
//    can learn that. It must never read as "protected" or as a passing state.
//
// The `SidecarStartFailed` notice below is the click-scoped version of the same
// condition — it says what the button the user just pressed did. It must never
// read as "the toggle did not take": the preference IS on, and sync is paused
// rather than routed directly (`src-tauri/src/plugins/sync/tor.rs` module doc).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { useTorState } from "../../hooks/useTorState";
import {
  getTorRouting,
  setTorRouting,
  torRoutingErrorKind,
  type TorPosture,
  type TorRoutingErrorKind,
} from "../../lib/tor-routing";
import { Switch } from "../primitives/Switch";
import {
  BLOCK_STYLE,
  HELPER_STYLE,
  LABEL_STYLE,
  PANEL_ROOT_STYLE,
  TOGGLE_ROW_STYLE,
} from "./panel-styles";

const DISCLOSURE_BUTTON_STYLE: CSSProperties = {
  alignSelf: "flex-start",
  background: "none",
  border: "none",
  padding: 0,
  marginTop: "var(--space-1)",
  color: "var(--fg-2)",
  font: "inherit",
  fontSize: "var(--text-sm)",
  textDecoration: "underline",
  cursor: "pointer",
};

const RESIDUALS_STYLE: CSSProperties = {
  ...HELPER_STYLE,
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  margin: 0,
  paddingLeft: "var(--space-4)",
};

const POSTURE_BLOCK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  marginTop: "var(--space-3)",
};

const POSTURE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

const POSTURE_HEADING_STYLE: CSSProperties = {
  ...HELPER_STYLE,
  margin: 0,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const POSTURE_DOT_STYLE: CSSProperties = {
  width: "8px",
  height: "8px",
  borderRadius: "var(--radius-pill)",
  flexShrink: 0,
};

/**
 * The dot colour per posture.
 *
 * `--success` is reserved for `active` — the single posture in which the tunnel
 * is actually carrying traffic. `unavailable` is `--danger` and `connecting` is
 * `--accent`; `inactive` is the muted `--fg-3` used everywhere else for "this
 * feature is off", because direct sync is the default and colouring it as a
 * fault would be dishonest in the other direction.
 */
const POSTURE_DOT: Record<TorPosture, string> = {
  inactive: "var(--fg-3)",
  connecting: "var(--accent)",
  active: "var(--success)",
  unavailable: "var(--danger)",
  // Not `--success`: nothing is tunneled. Not `--danger` either: sync works and
  // the user has not lost anything. The muted ramp, as with `inactive`.
  exempt: "var(--fg-3)",
};

/**
 * Which notice is on screen. Kept as a discriminant rather than a resolved i18n
 * key so every `t()` call below stays a literal — `scripts/check-i18n.mjs` only
 * sees static ones, and a key it cannot see is a key nothing checks.
 */
type Notice = "read" | "save" | "sidecar";

/**
 * The notice a failed toggle leaves on screen.
 *
 * `SidecarStartFailed` is the one that must not be phrased as a failed save:
 * the preference was persisted and Tor mode is ON, so sync is paused rather
 * than sent out directly. The other two are ordinary write failures, where
 * nothing moved at all.
 */
export function writeFailureNotice(kind: TorRoutingErrorKind | null): Notice {
  return kind === "SidecarStartFailed" ? "sidecar" : "save";
}

export function NetworkPanel() {
  const { t } = useTranslation();
  const { posture, refresh } = useTorState();
  const [enabled, setEnabled] = useState(false);
  const [residualsOpen, setResidualsOpen] = useState(false);
  // One-shot acknowledgement of a successful turn-OFF (PRD story 8). The
  // posture row already says traffic goes direct, but a user who just changed
  // their protection deserves the change itself named, not only its outcome.
  const [justDisabled, setJustDisabled] = useState(false);
  // One notice slot: the last thing that went wrong, or nothing. Cleared at the
  // start of every attempt so a stale message never sits under a fresh result.
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  // Read the persisted preference on mount. The backend reduces it through the
  // same `tor_config::routing_enabled_at_startup` rule the startup restore uses,
  // so a present-but-corrupt file reads as ON here exactly as the routing gate
  // has it — the switch cannot say "off" about a transport that is refusing
  // every connection. What is left to reject is a config directory that cannot
  // be resolved at all, which is not a file anybody wrote: the switch stays at
  // its OFF default (the fresh-install posture, and what the backend restored)
  // and the notice says the setting could not be read. Flipping it writes the
  // file, which is also the remedy.
  useEffect(() => {
    let alive = true;
    getTorRouting()
      .then((view) => {
        if (alive) setEnabled(view.enabled);
      })
      .catch(() => {
        if (alive) setNotice("read");
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setNotice(null);
    setJustDisabled(false);
    setBusy(true);
    try {
      const view = await setTorRouting(next);
      setEnabled(view.enabled);
      setJustDisabled(!view.enabled);
    } catch (e) {
      setNotice(writeFailureNotice(torRoutingErrorKind(e)));
      // Re-read rather than guess which way the switch should land: on a spawn
      // failure the preference is ON and deliberately not rolled back, and on a
      // write failure it is whatever it already was. Asking is the only way to
      // show the same thing the transport is obeying.
      await getTorRouting()
        .then((view) => setEnabled(view.enabled))
        .catch(() => {
          /* the notice above already says the attempt failed */
        });
    } finally {
      setBusy(false);
      // Ask the gate what actually happened. This runs on the failure path too
      // — a spawn failure leaves the mode ON with nothing running, and the
      // posture row is where that becomes visible as "sync is paused" rather
      // than as a switch sitting in the on position with no consequence shown.
      refresh();
    }
  };

  return (
    <div data-testid="settings.network-panel" style={PANEL_ROOT_STYLE}>
      <div
        style={BLOCK_STYLE}
        data-setting-anchor="network.tor-routing"
        data-testid="settings.tor-routing"
        data-enabled={String(enabled)}
      >
        <div style={TOGGLE_ROW_STYLE}>
          <span style={LABEL_STYLE}>{t("settings.network.torLabel")}</span>
          <Switch
            checked={enabled}
            onChange={busy ? undefined : (next) => void toggle(next)}
            ariaLabel={t("settings.network.torLabel")}
            ariaDescribedBy="tor-routing-helper"
            testId="settings.tor-routing-toggle"
          />
        </div>
        <p id="tor-routing-helper" style={HELPER_STYLE}>
          {t("settings.network.torHelper")}
        </p>

        {posture !== null && (
          // `role="status"`: the posture changes on its own (a bootstrap
          // completing, a client dying) and a screen-reader user should hear
          // that their sync just stopped without having to come back and look.
          <div
            style={POSTURE_BLOCK_STYLE}
            role="status"
            data-testid="settings.tor-posture"
            data-posture={posture}
          >
            <p style={POSTURE_HEADING_STYLE}>{t("settings.network.postureHeading")}</p>
            <div style={POSTURE_ROW_STYLE}>
              <span
                aria-hidden="true"
                style={{ ...POSTURE_DOT_STYLE, background: POSTURE_DOT[posture] }}
              />
              <span data-testid="settings.tor-posture-label">
                {posture === "inactive" && t("settings.network.postureInactive")}
                {posture === "connecting" && t("settings.network.postureConnecting")}
                {posture === "active" && t("settings.network.postureActive")}
                {posture === "unavailable" && t("settings.network.postureUnavailable")}
                {posture === "exempt" && t("settings.network.postureExempt")}
              </span>
            </div>
            {posture === "connecting" && (
              <p style={HELPER_STYLE}>{t("settings.network.postureConnectingDetail")}</p>
            )}
            {posture === "unavailable" && (
              <p style={HELPER_STYLE}>{t("settings.network.postureUnavailableDetail")}</p>
            )}
            {posture === "exempt" && (
              <p style={HELPER_STYLE}>{t("settings.network.postureExemptDetail")}</p>
            )}
          </div>
        )}

        {justDisabled && (
          <p style={HELPER_STYLE} role="status" data-testid="settings.tor-disabled-cue">
            {t("settings.network.disabledCue")}
          </p>
        )}

        <button
          type="button"
          data-testid="settings.tor-residuals-toggle"
          aria-expanded={residualsOpen}
          aria-controls="tor-residuals"
          onClick={() => setResidualsOpen((open) => !open)}
          style={DISCLOSURE_BUTTON_STYLE}
        >
          {t("settings.network.residualsToggle")}
        </button>
        {residualsOpen && (
          <ul id="tor-residuals" data-testid="settings.tor-residuals" style={RESIDUALS_STYLE}>
            <li>{t("settings.network.residualExit")}</li>
            <li>{t("settings.network.residualMetadata")}</li>
            <li>{t("settings.network.residualPayment")}</li>
            <li>{t("settings.network.residualScope")}</li>
          </ul>
        )}

        {notice !== null && (
          <p style={HELPER_STYLE} role="status" data-testid="settings.tor-routing-notice">
            {notice === "read" && t("settings.network.errorRead")}
            {notice === "save" && t("settings.network.errorSave")}
            {notice === "sidecar" && t("settings.network.errorSidecar")}
          </p>
        )}
      </div>
    </div>
  );
}
