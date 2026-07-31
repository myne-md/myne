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
// # What this panel is NOT
//
// It is the *preference* control. Whether traffic is actually flowing through a
// bootstrapped Tor client right now is a different question with a different
// answer (`TorProxyState`), and task 8 owns that indicator plus the fail-closed
// banner. The one state this panel does surface is `SidecarStartFailed`, because
// it is the direct outcome of the click the user just made — and it must never
// read as "the toggle did not take": the preference IS on, and sync is paused
// rather than routed directly (`src-tauri/src/plugins/sync/tor.rs` module doc).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import {
  getTorRouting,
  setTorRouting,
  torRoutingErrorKind,
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
  const [enabled, setEnabled] = useState(false);
  const [residualsOpen, setResidualsOpen] = useState(false);
  // One notice slot: the last thing that went wrong, or nothing. Cleared at the
  // start of every attempt so a stale message never sits under a fresh result.
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  // Read the persisted preference on mount. A rejection is genuinely ambiguous
  // about the running posture — the backend resolves an unreadable file to Tor
  // mode ON at startup (`tor_config::routing_enabled_at_startup`) but a path it
  // cannot resolve at all to OFF, and both arrive here as the same `Io` error.
  // So the switch stays at its default position and the notice says the setting
  // could not be read, rather than the position asserting an answer we do not
  // have. Flipping it writes the file, which is also the remedy.
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
    setBusy(true);
    try {
      const view = await setTorRouting(next);
      setEnabled(view.enabled);
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
