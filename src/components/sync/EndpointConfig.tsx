// Sync server endpoint config (MYND-424 R3) — the server-URL input + the TOFU
// certificate-fingerprint surface. `sync_set_endpoint` validates the URL against
// the A4/TB5 policy and, for an `https` endpoint, TOFU-pins the server's leaf
// cert and returns its fingerprint (SHA-256 hex) for the user to eye-compare
// across devices (`self-host-policy.md` §6). A loopback `http` endpoint has no
// TLS, so no fingerprint. Built against design tokens; no Penpot (owner directive).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../../platform/core";

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
  background: "var(--paper-1)",
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
};

const HELP: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
  lineHeight: "var(--leading-normal)",
};

const FP: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  wordBreak: "break-all",
};

export function EndpointConfig() {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
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
        if (c.endpoint_url) setUrl(c.endpoint_url);
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
    })
      .then((r) => {
        setPinSource(r.pin_source);
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
      .catch(() => setMsg(t("sync.endpoint.unreachable")))
      .finally(() => setBusy(false));
  };

  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
      data-testid="sync.endpoint-config"
    >
      <div style={ROW}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("sync.endpoint.placeholder")}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          style={INPUT}
          data-testid="sync.endpoint-input"
        />
        <button
          type="button"
          onClick={connect}
          disabled={busy}
          style={{ ...BTN, opacity: busy ? 0.6 : 1 }}
          data-testid="sync.endpoint-connect"
        >
          {busy ? t("sync.endpoint.connecting") : t("sync.endpoint.connect")}
        </button>
      </div>
      {msg && (
        <p style={HELP} data-testid="sync.endpoint-msg">
          {msg}
        </p>
      )}
      {/* The pin note renders whenever a SOURCE is known — it used to be
          nested inside the fingerprint block, which meant the browser's
          "verified by your certificate store" line could never appear, because
          that case has no fingerprint to show. */}
      {(fingerprint || pinSource) && (
        <p style={HELP}>
          {fingerprint && (
            <>
              {t("sync.endpoint.fingerprintLabel")}
              <br />
              <span style={FP} data-testid="sync.cert-fingerprint">
                {fingerprint}
              </span>
            </>
          )}
          {pinSource && (
            <>
              {fingerprint && <br />}
              <span data-testid="sync.pin-source" data-pin-source={pinSource}>
                {t(PIN_SOURCE_COPY[pinSource])}
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
