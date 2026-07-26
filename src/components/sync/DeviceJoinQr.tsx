// Device-join QR block (MYND-466) — the trusted device shows a QR another device
// scans to join. Penpot skipped per the owner directive (same as
// DeviceManagementPanel); built against design tokens.
//
// Option 1 (prompt-to-paste): the account# is an AS9 bearer token Myne never
// persists (account-number.md §8), so the user pastes it here to make the QR.
// The QR carries {server_url, account#, cert_pin} — NEVER the password (SYNC-47);
// the scanning phone still enters its own password. Ephemeral: regenerated before
// the backend TTL lapses so a photographed code can't be reused later (live
// co-presence — the basis for the scan replacing the cert eye-compare, SYNC-26).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { formatAccountNumberInput } from "../../lib/account-number-format";
import {
  generateDeviceJoinQr,
  deviceJoinQrErrorMessage,
} from "../../lib/deviceJoinQr";
import { svgToDataUri } from "../../lib/noteImageCard";

const ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const LABEL: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
};

const HINT: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const INPUT: CSSProperties = {
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  fontFamily: "var(--font-mono)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-1)",
};

const BTN: CSSProperties = {
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-1)",
  alignSelf: "flex-start",
};

const QR_WRAP: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "var(--space-3)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
};

// The rendered SVG is self-contained black-on-white (high-contrast, theme-agnostic
// — a QR must not be tinted), so a fixed square is all the wrapper needs.
const QR_IMG: CSSProperties = { width: 200, height: 200 };

const SCAN_LABEL: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
};

const ERROR: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--danger)",
};

// Regenerate this many seconds before the backend TTL lapses, so the visible QR
// is always fresh (and scannable) while the panel is open.
const REFRESH_BUFFER_SECS = 15;

export function DeviceJoinQr() {
  const { t } = useTranslation();
  const [account, setAccount] = useState("");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const generate = useCallback(
    async (accountNumber: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await generateDeviceJoinQr(accountNumber);
        setSvg(res.svg);
        clearTimer();
        const delay =
          Math.max(res.ttl_secs - REFRESH_BUFFER_SECS, REFRESH_BUFFER_SECS) *
          1000;
        timer.current = setTimeout(() => void generate(accountNumber), delay);
      } catch (e) {
        setSvg(null);
        clearTimer();
        setError(deviceJoinQrErrorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // Cancel any pending refresh on unmount.
  useEffect(() => clearTimer, []);

  const onInput = (raw: string) => {
    setAccount(formatAccountNumberInput(raw));
    setSvg(null);
    setError(null);
    clearTimer();
  };

  const canGenerate = account.trim().length > 0 && !busy;
  // Percent-encode the (multi-KB) SVG only when it actually changes, not per render.
  const imgSrc = useMemo(() => (svg ? svgToDataUri(svg) : undefined), [svg]);

  return (
    <div style={ROOT} data-testid="sync.device-join-qr">
      <div style={LABEL}>{t("sync.deviceJoinQr.title")}</div>
      <div style={HINT}>{t("sync.deviceJoinQr.hint")}</div>
      <label style={LABEL} htmlFor="device-join-qr-account">
        {t("sync.deviceJoinQr.accountLabel")}
      </label>
      <input
        id="device-join-qr-account"
        style={INPUT}
        value={account}
        onChange={(e) => onInput(e.target.value)}
        placeholder={t("sync.deviceJoinQr.accountPlaceholder")}
        autoComplete="off"
        spellCheck={false}
        data-testid="sync.device-join-qr.account-input"
      />
      <button
        type="button"
        style={{
          ...BTN,
          opacity: canGenerate ? 1 : 0.5,
          cursor: canGenerate ? "pointer" : "default",
        }}
        disabled={!canGenerate}
        onClick={() => void generate(account.trim())}
        data-testid="sync.device-join-qr.generate"
      >
        {t("sync.deviceJoinQr.generate")}
      </button>
      {error && (
        <div style={ERROR} data-testid="sync.device-join-qr.error">
          {error}
        </div>
      )}
      {svg && (
        <div style={QR_WRAP} data-testid="sync.device-join-qr.image">
          <img style={QR_IMG} src={imgSrc} alt={t("sync.deviceJoinQr.title")} />
          <div style={SCAN_LABEL} data-testid="sync.device-join-qr.scan-label">
            {t("sync.deviceJoinQr.scanWithApp")}
          </div>
        </div>
      )}
    </div>
  );
}
