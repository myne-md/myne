// Sync server endpoint config (MYND-424 R3) — the server-URL input + the TOFU
// certificate-fingerprint surface. `sync_set_endpoint` validates the URL against
// the A4/TB5 policy and, for an `https` endpoint, TOFU-pins the server's leaf
// cert and returns its fingerprint (SHA-256 hex) for the user to eye-compare
// across devices (`self-host-policy.md` §6). A loopback `http` endpoint has no
// TLS, so no fingerprint. Built against design tokens; no Penpot (owner directive).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";

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
  const [pinSource, setPinSource] = useState<"static" | "tofu" | null>(null);

  useEffect(() => {
    void invoke<{
      endpoint_url: string | null;
      cert_pin_hex: string | null;
      pin_source: "static" | "tofu" | null;
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
      pin_source: "static" | "tofu" | null;
    }>("plugin:sync|sync_set_endpoint", {
      endpointUrl: trimmed,
    })
      .then((r) => {
        setPinSource(r.pin_source);
        if (r.fingerprint) {
          setFingerprint(r.fingerprint);
          setMsg(t("sync.endpoint.connectedTls"));
        } else {
          setMsg(t("sync.endpoint.connectedLocal"));
        }
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
      {fingerprint && (
        <p style={HELP}>
          {t("sync.endpoint.fingerprintLabel")}
          <br />
          <span style={FP} data-testid="sync.cert-fingerprint">
            {fingerprint}
          </span>
          {pinSource && (
            <>
              <br />
              <span data-testid="sync.pin-source" data-pin-source={pinSource}>
                {t(
                  pinSource === "static"
                    ? "sync.endpoint.pinStatic"
                    : "sync.endpoint.pinTofu",
                )}
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
