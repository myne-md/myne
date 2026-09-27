// Sync server endpoint config (MYND-424 R3) — the server-URL input + the TOFU
// certificate-fingerprint surface. `sync_set_endpoint` validates the URL against
// the A4/TB5 policy and, for an `https` endpoint, TOFU-pins the server's leaf
// cert and returns its fingerprint (SHA-256 hex) for the user to eye-compare
// across devices (`self-host-policy.md` §6). A loopback `http` endpoint has no
// TLS, so no fingerprint. Built against design tokens; no Penpot (owner directive).

import { useEffect, useState, type CSSProperties } from "react";
import { Trans, useTranslation } from "react-i18next";
import { invoke } from "../../platform/core";
import { refreshTorState } from "../../hooks/useTorState";
import { FingerprintConfirm, fingerprintGateRefusal } from "./FingerprintConfirm";
import { hoverSurface, HOVER_TRANSITION } from "../primitives/hoverSurface";
import { Icon } from "../primitives/Icon";

/**
 * Mirrors `myne_core::plugins::sync::config::PinSource` (`snake_case` on the
 * wire), plus `null` for "there is no TLS here / nothing pinned".
 *
 * `platform_trust_store` is the browser's answer and is deliberately NOT `null`:
 * a page cannot see a leaf certificate, so it has no fingerprint to show, but
 * the connection IS verified — by the browser's own trust store. Collapsing the
 * two is what made this screen tell a browser user they had connected to a
 * local server.
 */
type PinSource = "static" | "tofu" | "platform_trust_store" | null;

/**
 * The i18n key each source's explanatory line uses.
 *
 * Exported for `tests/sync/pin-source-copy.test.ts`: these are DYNAMIC keys
 * (`t(PIN_SOURCE_COPY[src])`), so `scripts/check-i18n.mjs` — which only sees
 * static `t("…")` literals — cannot tell whether they resolve. That test is
 * the guard instead.
 */
export const PIN_SOURCE_COPY: Record<NonNullable<PinSource>, string> = {
  static: "sync.endpoint.pinStatic",
  tofu: "sync.endpoint.pinTofu",
  platform_trust_store: "sync.endpoint.pinPlatformTrust",
};

const ROW: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "center",
};

const INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "var(--space-2) var(--space-3)",
  fontSize: "var(--text-sm)",
  background: "var(--paper)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
};

const BTN: CSSProperties = {
  padding: "var(--space-2) var(--space-3)",
  fontSize: "var(--text-sm)",
  background: "var(--accent)",
  color: "var(--accent-on)",
  border: "none",
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: HOVER_TRANSITION,
};

const HELP: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
  lineHeight: "var(--leading-normal)",
};

// The fingerprint/pin lines read as ONE accent notification block, pinned at the
// TOP of the section (right under the input) with a leading info icon — a
// verify-this callout, not a footnote.
const NOTE_BLOCK: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  background: "var(--accent-soft)",
  border: "1px solid var(--accent-soft)",
  borderRadius: "var(--radius-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  lineHeight: "var(--leading-normal)",
};

const NOTE_LABEL: CSSProperties = {
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--accent)",
};

// The "Connected" resting state of the connect button: muted, non-accent, and
// clearly inert (E4c) — the input matches the endpoint already in use.
const BTN_CONNECTED: CSSProperties = {
  ...BTN,
  background: "var(--bg-2)",
  color: "var(--fg-3)",
  border: "1px solid var(--line-1)",
  cursor: "default",
};

// The re-verify action offered beside the resting "Connected" state. Secondary
// rather than accent on purpose: it opens the fingerprint gate, it does not
// commit anything, so the accent stays on the primary "Connect".
const BTN_SECONDARY: CSSProperties = {
  ...BTN,
  background: "var(--bg-2)",
  color: "var(--fg-1)",
  border: "1px solid var(--line-1)",
};

const FP: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  wordBreak: "break-all",
};

export function EndpointConfig({ onConnected, onEdit }: { onConnected?: () => void; onEdit?: () => void } = {}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  // The endpoint this device is currently connected to (loaded, or set on a
  // successful connect). When the input still equals it, there is nothing to do
  // and the button rests as a disabled "Connected" (E4c).
  const [connectedUrl, setConnectedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  // The fingerprint the user obtained OUT-OF-BAND from their own server, and
  // whether the backend has asked for it. It is revealed on refusal rather than
  // rendered always, because the clearnet flow does not need it and a field
  // nobody has to fill is a field everybody skips.
  //
  // Deliberately an INPUT, never a "does this look right?" confirmation of the
  // captured value: over Tor the first handshake accepts any certificate, and
  // showing the captured fingerprint first would anchor the user on whatever an
  // exit node chose to serve. The backend never returns it on the mismatch path
  // for the same reason (`core/src/plugins/sync/pin_confirm.rs`). The gate's own
  // copy, echo and confirm/decline pair live in `FingerprintConfirm`, shared
  // with the join modal so the two enrollment doors cannot drift.
  const [expectedFingerprint, setExpectedFingerprint] = useState("");
  const [confirmNeeded, setConfirmNeeded] = useState(false);
  // Where the pin came from (SYNC-43): `static` (pre-vetted hosted cert) vs
  // `tofu` (self-host first-connect pin — the one the user eye-compares). Kept
  // distinct so a hosted endpoint is never shown as a bare TOFU pin.
  //
  // `platform_trust_store` is the third answer (phase3-web-client task 84): this
  // client cannot pin and the browser's certificate store did the verifying. It
  // is NOT the same as `null`, which means "there is no TLS here" — see the
  // message selection below, which used to read a missing fingerprint as
  // "connected to a local server" and would have said that about a real
  // `https://` server in a browser.
  const [pinSource, setPinSource] = useState<PinSource>(null);

  useEffect(() => {
    void invoke<{
      endpoint_url: string | null;
      cert_pin_hex: string | null;
      pin_source: PinSource;
    }>("plugin:sync|sync_get_endpoint")
      .then((c) => {
        if (c.endpoint_url) {
          setUrl(c.endpoint_url);
          setConnectedUrl(c.endpoint_url);
        }
        if (c.cert_pin_hex) setFingerprint(c.cert_pin_hex);
        setPinSource(c.pin_source);
      })
      .catch(() => {
        /* unconfigured — leave the field empty */
      });
  }, []);

  const connect = () => {
    const trimmed = url.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setMsg(null);
    setFingerprint(null);
    setPinSource(null);
    void invoke<{
      fingerprint: string | null;
      pin_source: PinSource;
    }>("plugin:sync|sync_set_endpoint", {
      endpointUrl: trimmed,
      confirmedFingerprint: expectedFingerprint.trim() || null,
    })
      .then((r) => {
        setConfirmNeeded(false);
        setConnectedUrl(trimmed);
        onConnected?.();
        setPinSource(r.pin_source);
        // The Tor posture is endpoint-aware (MYND-650 task 8): repointing a
        // loopback endpoint at a remote server — or the reverse — moves
        // `exempt`, and `exempt` sits on the slow poll because the toggle used
        // to be the only thing that could move it. Without this the Network
        // panel keeps saying "this address points at this device", with the
        // fail-closed banner suppressed, over the server that just replaced it.
        refreshTorState();
        if (r.fingerprint) setFingerprint(r.fingerprint);
        // Branch on the PIN SOURCE, not on whether a fingerprint came back.
        // A browser reaches a real `https://` server and gets no fingerprint —
        // it cannot see the leaf cert — so the old "no fingerprint means local"
        // reading told the user they had connected to a local server.
        setMsg(
          t(
            r.pin_source === "platform_trust_store"
              ? "sync.endpoint.connectedPlatformTrust"
              : r.fingerprint
                ? "sync.endpoint.connectedTls"
                : "sync.endpoint.connectedLocal",
          ),
        );
      })
      .catch((e: unknown) => {
        // Both Tor-mode refusals wrote NOTHING — no endpoint, no pin — so the
        // screen stays on the same form with the field revealed rather than
        // reporting a half-configured server. Everything else collapses into
        // the generic "couldn't reach that server" line, as before.
        const refusal = fingerprintGateRefusal(e);
        if (refusal !== null) {
          setConfirmNeeded(true);
          setMsg(
            t(
              refusal === "PinConfirmationRequired"
                ? "sync.endpoint.confirmFingerprintRequired"
                : refusal === "CertificateChanged"
                  ? "sync.endpoint.certificateChanged"
                  : "sync.endpoint.confirmFingerprintMismatch",
            ),
          );
          return;
        }
        setMsg(t("sync.endpoint.unreachable"));
      })
      .finally(() => setBusy(false));
  };

  // Re-open the out-of-band gate for an endpoint this device is ALREADY
  // connected to — the recovery both device-panel hints tell the user to
  // perform (myne#756).
  //
  // Until this existed that instruction named no reachable control. The hints
  // say "re-enter the server URL", and re-entering the SAME URL is exactly what
  // `isConnectedUnedited` below renders as a disabled "Connected", so the
  // `CertificateChanged` refusal could raise the gate for a URL the user had
  // edited and never for the one it was written about. The only way through was
  // to perturb the URL into a different string, which ALSO slipped
  // `replaces_a_trusted_pin` (it compared URL strings) and adopted the new
  // certificate with no compare at all — so the missing control did not merely
  // block the safe path, it left the unsafe one as the only one.
  //
  // Deliberately NOT gated on the sync status reporting `CertPinMismatch`. The
  // device in #756 showed "Server certificate changed" in the sync status and a
  // plain "the server didn't answer" transport error in the device panel at the
  // same moment, so a control that appeared only for the known tag would have
  // been missing precisely when it was needed. Re-verifying a pin costs nothing
  // when the certificate has not changed — `capture_pin` compares and keeps the
  // same value — so it is offered whenever there is a pin the user can compare.
  const reverify = () => {
    setMsg(null);
    setExpectedFingerprint("");
    setConfirmNeeded(true);
  };

  // Decline: back out of an enrollment the user cannot verify. The refused
  // attempt wrote nothing — no endpoint, no pin (`pin_confirm`'s contract) — so
  // this only has to clear the screen and say so plainly, rather than leave the
  // user wondering whether a half-configured server is now trusted.
  const decline = () => {
    setConfirmNeeded(false);
    setExpectedFingerprint("");
    setMsg(t("sync.endpoint.confirmFingerprintDeclined"));
  };

  // "Connected & unedited": the input still matches the endpoint in use, so the
  // button rests as a disabled "Connected". Editing it (or having nothing
  // connected yet) re-enables "Connect".
  const trimmedUrl = url.trim();
  const isConnectedUnedited =
    connectedUrl !== null &&
    trimmedUrl.length > 0 &&
    trimmedUrl === connectedUrl;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
      data-testid="sync.endpoint-config"
    >
      {/* Accent verify-this callout at the very TOP of the section — above the
          input — with a leading info icon: fingerprint label + hash + pin-source
          line. Renders whenever a SOURCE is known (the browser's "verified by
          your certificate store" line has no fingerprint to show, so gating on
          the source, not the fingerprint, keeps that path visible). */}
      {(fingerprint || pinSource) && (
        <div style={NOTE_BLOCK} data-testid="sync.pin-note">
          <span
            aria-hidden="true"
            style={{ display: "flex", flexShrink: 0, color: "var(--accent)", marginTop: 1 }}
          >
            <Icon name="info" size={16} />
          </span>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-1)",
              minWidth: 0,
            }}
          >
            {fingerprint && (
              <>
                <span style={NOTE_LABEL}>{t("sync.endpoint.fingerprintLabel")}</span>
                <span style={FP} data-testid="sync.cert-fingerprint">
                  {fingerprint}
                </span>
              </>
            )}
            {pinSource && (
              <span data-testid="sync.pin-source" data-pin-source={pinSource}>
                {t(PIN_SOURCE_COPY[pinSource])}
              </span>
            )}
          </div>
        </div>
      )}
      <div style={ROW}>
        <input
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            onEdit?.();
          }}
          placeholder={t("sync.endpoint.placeholder")}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          style={INPUT}
          data-testid="sync.endpoint-input"
        />
        {/* While the gate is open the retry lives inside it, next to the
            decline — two buttons that both mean "connect" would leave the user
            picking between identical actions at the one moment this screen is
            asking them to be careful. */}
        {!confirmNeeded &&
          (isConnectedUnedited ? (
            <>
              <button
                type="button"
                disabled
                style={BTN_CONNECTED}
                data-testid="sync.endpoint-connect"
              >
                {t("sync.endpoint.connected")}
              </button>
              {/* Only a TOFU pin is the user's to re-verify. A hosted static pin
                  is pre-vetted at build time and a browser's trust store has no
                  leaf fingerprint to compare, so neither offers this door. */}
              {pinSource === "tofu" && (
                <button
                  type="button"
                  onClick={reverify}
                  disabled={busy}
                  style={{ ...BTN_SECONDARY, opacity: busy ? 0.6 : 1 }}
                  {...hoverSurface({
                    restBg: "var(--bg-2)",
                    hoverBg: "var(--bg-3)",
                    disabled: busy,
                  })}
                  data-testid="sync.endpoint-reverify"
                >
                  {t("sync.endpoint.reverify")}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={busy}
              style={{ ...BTN, opacity: busy ? 0.6 : 1 }}
              {...hoverSurface({
                restBg: "var(--accent)",
                hoverBg: "var(--accent-hover)",
                disabled: busy,
              })}
              data-testid="sync.endpoint-connect"
            >
              {busy ? t("sync.endpoint.connecting") : t("sync.endpoint.connect")}
            </button>
          ))}
      </div>
      {/* The instructional helper sits directly under the input (E4a). */}
      <p style={HELP} data-testid="sync.endpoint-help">
        <Trans i18nKey="sync.panel.server.helper">
          Enter the same server URL on every device. For a self-hosted server
          use its <code>https://</code> address; verify the certificate
          fingerprint matches across your devices.
        </Trans>
      </p>
      {msg && (
        <p style={HELP} data-testid="sync.endpoint-msg">
          {msg}
        </p>
      )}
      {/* Revealed when the backend refuses for want of it, and when the user
          asks to re-verify an endpoint already connected (`reverify`) — see the
          state declaration for why this is an input rather than a confirm
          button. */}
      {confirmNeeded && (
        <FingerprintConfirm
          value={expectedFingerprint}
          onChange={setExpectedFingerprint}
          onConfirm={connect}
          onDecline={decline}
          confirmLabel={busy ? t("sync.endpoint.connecting") : t("sync.endpoint.connect")}
          confirmDisabled={busy}
          testIdPrefix="sync"
        />
      )}
    </div>
  );
}
