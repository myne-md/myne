// Mobile Sync settings panels — the wired counterparts of the SY-01/02/03/04/06/07
// gallery mocks (`src/screens/sync/`), rendered as drill-down panels inside the
// Settings sheet (MYND-459). Built directly against design tokens (no Penpot, owner
// directive; SYNC-48 gallery-mock authority). Each panel is self-contained and mounts
// its own hooks only while visible, so the device-roster poll (`useDevices`) does not
// run whenever Settings is merely open.
//
// Honesty discipline (SYNC-8/SYNC-42): every load-bearing enroll/revoke literal is
// imported VERBATIM from `@myne/copy` via `lib/load-bearing-copy` — never paraphrased.
// No per-device wall-clock string anywhere (AS6/AS15) — status is state, not a local
// timestamp. The cert-trust surface never claims "-PLUS"/channel-binding (cbind empty,
// R3 transport review-debt).

import { type CSSProperties, type ReactNode, useEffect, useId, useState } from "react";
import type { SyncStatus } from "../lib/use-sync-status";
import {
  syncGetEndpoint,
  syncSetEndpoint,
  syncHeadFingerprint,
  useEnroll,
  useDevices,
  type EnrollCredentialKind,
  type DeviceEntry,
  type PinSource,
} from "../lib/sync";
import { formatAccountNumberInput } from "../lib/account-number-format";
import { normalizeBip39Phrase } from "../lib/bip39-normalize";
import { usePrefs } from "../lib/use-prefs";
import {
  ENROLL_APPROVED_NOTICE,
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_PENDING_NOTICE,
  REMOVE_DEVICE_CONFIRM,
  REMOVE_DEVICE_DISCLOSURE,
} from "../lib/load-bearing-copy";
import { Banner, Segmented } from "./index";

const HAS_TAURI = "__TAURI_INTERNALS__" in window;

// ── Shared panel primitives (settings-card geometry) ─────────────────────────

const rowLabel: CSSProperties = { fontSize: 16, color: "var(--fg-1)" };

function SectionLabel({ children, mt = 18 }: { children: ReactNode; mt?: number }) {
  return (
    <div
      style={{
        marginTop: mt,
        padding: "0 4px 8px",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--line-3)",
      }}
    >
      {children}
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
      {children}
    </div>
  );
}

function Row({
  children,
  first = false,
  onClick,
  testId,
}: {
  children: ReactNode;
  first?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <div
      onClick={onClick}
      data-testid={testId}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "13px 14px",
        borderTop: first ? undefined : "1px solid var(--line-1)",
        cursor: onClick ? "pointer" : undefined,
      }}
    >
      {children}
    </div>
  );
}

function RowChevron() {
  return (
    <svg width="8" height="13" viewBox="0 0 8 14" style={{ flex: "none" }}>
      <path d="M1 1l6 6-6 6" stroke="var(--line-2)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FieldLabel({ children, mt = 18 }: { children: ReactNode; mt?: number }) {
  return (
    <div
      style={{
        marginTop: mt,
        marginBottom: 8,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
      }}
    >
      {children}
    </div>
  );
}

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  height: 50,
  border: "1px solid var(--line-2)",
  borderRadius: 6,
  background: "var(--bg-1)",
  padding: "0 14px",
  fontSize: 16,
  color: "var(--fg-1)",
  outline: "none",
  boxSizing: "border-box",
};

function primaryBtn(disabled: boolean): CSSProperties {
  return {
    width: "100%",
    height: 50,
    border: "none",
    borderRadius: 8,
    background: disabled ? "var(--bg-3)" : "var(--accent)",
    color: disabled ? "var(--fg-3)" : "var(--accent-on)",
    fontFamily: "var(--font-sans)",
    fontSize: 16,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const HELP: CSSProperties = { marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" };
const NOTICE: CSSProperties = { marginTop: 14, fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" };

/** Honest status dot + label — state, never a wall-clock (AS6/AS15). */
function statusView(status: SyncStatus | null): { color: string; label: string } {
  switch (status?.state) {
    case undefined:
    case "disabled":
      return { color: "var(--line-3)", label: "Off" };
    case "not_enrolled":
      return { color: "var(--line-3)", label: "Not set up" };
    case "pending":
      return { color: "var(--warning)", label: "Awaiting approval" };
    case "idle":
      return { color: "var(--success)", label: "On" };
    case "syncing":
      return { color: "var(--accent)", label: "Syncing…" };
    case "error":
      return { color: "var(--warning)", label: "Offline" };
    case "conflicts":
      return {
        color: "var(--danger)",
        label: `${status.count} conflict${status.count === 1 ? "" : "s"}`,
      };
  }
}

// ── SY-01 · Sync hub ─────────────────────────────────────────────────────────

export interface SyncHubPanelProps {
  status: SyncStatus | null;
  onOpenEndpoint: () => void;
  onOpenEnroll: () => void;
  onOpenDevices: () => void;
}

/** SY-01: the honest enrollment status + drill-down entry points. */
export function SyncHubPanel({ status, onOpenEndpoint, onOpenEnroll, onOpenDevices }: SyncHubPanelProps) {
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const view = statusView(status);

  useEffect(() => {
    if (!HAS_TAURI) return;
    void syncGetEndpoint()
      .then((c) => setEndpoint(c.endpoint_url))
      .catch(() => setEndpoint(null));
  }, []);

  return (
    <div style={{ marginTop: 4 }} data-testid="sync.settings">
      <SectionLabel mt={6}>Server</SectionLabel>
      <Group>
        <Row first onClick={onOpenEndpoint} testId="sync.settings.endpoint">
          <span style={rowLabel}>Sync server</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 13,
                color: "var(--fg-3)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 150,
              }}
            >
              {endpoint ?? "Not set"}
            </span>
            <RowChevron />
          </div>
        </Row>
        <Row testId="sync.settings.status">
          <span style={rowLabel}>Status</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg-2)" }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: view.color, flex: "none" }} />
            <span style={{ fontSize: 15 }}>{view.label}</span>
          </div>
        </Row>
      </Group>

      <SectionLabel>Devices</SectionLabel>
      <Group>
        <Row first onClick={onOpenEnroll} testId="sync.settings.add-device">
          <span style={rowLabel}>Add this device</span>
          <RowChevron />
        </Row>
        <Row onClick={onOpenDevices} testId="sync.settings.devices">
          <span style={rowLabel}>Your devices</span>
          <RowChevron />
        </Row>
      </Group>

      <p style={{ ...HELP, marginTop: 16 }}>
        Sync keeps your notes up to date across devices. Everything is encrypted on this device
        before it is sent — the server never sees your notes.
      </p>
    </div>
  );
}

// ── SY-02 · Endpoint config ──────────────────────────────────────────────────

/** SY-02: set/get the self-host endpoint + the TOFU cert fingerprint for
 *  out-of-band eye-compare. https-only-off-loopback is enforced in shared core. */
export function SyncEndpointPanel() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [pinSource, setPinSource] = useState<PinSource | null>(null);

  useEffect(() => {
    if (!HAS_TAURI) return;
    void syncGetEndpoint()
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
    void syncSetEndpoint(trimmed)
      .then((r) => {
        setPinSource(r.pin_source);
        if (r.fingerprint) {
          setFingerprint(r.fingerprint);
          setMsg("Connected over TLS.");
        } else {
          setMsg("Connected on your local network.");
        }
      })
      .catch(() => setMsg("Couldn't reach that server. Check the address and try again."))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ marginTop: 4 }} data-testid="sync.endpoint-config">
      <FieldLabel mt={6}>Server address</FieldLabel>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://sync.example.com"
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        inputMode="url"
        style={{ ...INPUT_STYLE, fontFamily: "var(--font-mono)", fontSize: 15 }}
        data-testid="sync.endpoint-input"
      />
      <div style={{ marginTop: 14 }}>
        <button
          type="button"
          onClick={connect}
          disabled={busy}
          style={primaryBtn(busy)}
          data-testid="sync.endpoint-connect"
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>

      {msg && (
        <p style={NOTICE} data-testid="sync.endpoint-msg">
          {msg}
        </p>
      )}

      {fingerprint && (
        <div style={{ marginTop: 16 }}>
          <FieldLabel mt={0}>Certificate fingerprint</FieldLabel>
          <p style={{ fontSize: 13, color: "var(--fg-3)", margin: "0 0 8px", lineHeight: 1.5 }}>
            Compare this against the same screen on a device you already trust — they must match.
          </p>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              color: "var(--fg-1)",
              wordBreak: "break-all",
              padding: "10px 12px",
              background: "var(--paper-2)",
              border: "1px solid var(--line-1)",
              borderRadius: 6,
            }}
            data-testid="sync.cert-fingerprint"
          >
            {fingerprint}
          </div>
          {pinSource && (
            <p
              style={{ marginTop: 8, fontSize: 12, color: "var(--fg-3)" }}
              data-testid="sync.pin-source"
              data-pin-source={pinSource}
            >
              {pinSource === "static"
                ? "Verified against this server's known certificate."
                : "Pinned on first connect. Compare it across your devices to confirm."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── SY-03 / SY-04 · Enroll this device ───────────────────────────────────────

const PHRASE_CELL_COUNT = 24;
const MODE_VALUES: EnrollCredentialKind[] = ["password", "recovery"];

/** Map a non-secret `SyncDeviceError` kind to honest, non-distinguishing copy.
 *  Config/transport faults get their own (non-leaking) line; every
 *  credential/account/meta failure collapses to the single banner (SYNC-8). */
function enrollFailureMessage(kind: string): string {
  switch (kind) {
    case "NotConfigured":
      return "Set up a sync server first, then add this device.";
    case "Transport":
      return "Couldn't reach the sync server. Check your connection and try again.";
    default:
      return ENROLL_NON_DISTINGUISHING_BANNER;
  }
}

export interface SyncEnrollPanelProps {
  /** Called after a successful approval (token issued + syncing). */
  onEnrolled?: () => void;
}

// Structural Crockford pre-check — a typo aid ONLY. It flags the obvious
// malformations (wrong length, a Crockford-forbidden letter I/L/O/U) before a
// round-trip; it deliberately does NOT recompute the Damm-32 check digit. The
// frozen Damm-32 quasigroup table is load-bearing (a second TS copy would risk a
// cross-impl validity split — `account-number.md` §4.2), so the authoritative
// check stays the single Rust `parse_account_number`, whose failure collapses to
// the non-distinguishing enroll banner server-side (SYNC-8). Crockford base32
// omits I/L/O/U; the canonical body is 20 chars.
const CROCKFORD_BODY = /^[0-9A-HJKMNP-TV-Z]{20}$/;

/** True when the entered account number COULD be valid (right length + charset).
 *  Empty / still-typing returns true so the hint only fires on a completed typo. */
function accountStructurallyPlausible(display: string): boolean {
  const body = display.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^MY/, "");
  if (body.length < 20) return true; // still typing — no premature complaint
  return CROCKFORD_BODY.test(body);
}

/** SY-03 enroll + SY-04 pending — account# + Password/Recovery segmented control. */
export function SyncEnrollPanel({ onEnrolled }: SyncEnrollPanelProps) {
  const baseId = useId();
  const { busy, outcome, enroll, reset } = useEnroll();

  const [accountNumber, setAccountNumber] = useState("");
  const [mode, setMode] = useState<EnrollCredentialKind>("password");
  const [password, setPassword] = useState("");
  const [cells, setCells] = useState<string[]>(() => Array.from({ length: PHRASE_CELL_COUNT }, () => ""));

  // Any edit after a terminal outcome clears it so the user sees a fresh attempt.
  const clearOutcome = () => {
    if (outcome) reset();
  };

  useEffect(() => {
    if (outcome?.state === "approved") onEnrolled?.();
  }, [outcome, onEnrolled]);

  const accountFilled = accountNumber.trim().length > 0;
  const credentialFilled = mode === "password" ? password.length > 0 : cells.every((c) => c.length > 0);
  const canSubmit = accountFilled && credentialFilled && !busy;

  const setCell = (index: number, value: string) => {
    clearOutcome();
    const cleaned = value.replace(/\s+/g, "");
    setCells((prev) => prev.map((c, i) => (i === index ? cleaned : c)));
  };

  const handlePaste = (index: number) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    const tokens = e.clipboardData.getData("text").split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length < 2) return; // single token → native paste fills this cell
    e.preventDefault();
    clearOutcome();
    setCells((prev) => {
      const next = [...prev];
      for (let i = 0; i < tokens.length && index + i < PHRASE_CELL_COUNT; i++) {
        next[index + i] = tokens[i];
      }
      return next;
    });
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const credential = mode === "password" ? password : normalizeBip39Phrase(cells.join(" "));
    void enroll(accountNumber.trim(), credential, mode);
  };

  return (
    <div style={{ marginTop: 4 }} data-testid="sync.enroll">
      <FieldLabel mt={6}>Account number</FieldLabel>
      <input
        value={accountNumber}
        onChange={(e) => {
          clearOutcome();
          setAccountNumber(formatAccountNumberInput(e.target.value));
        }}
        placeholder="MY-XXXX-XXXX-XXXX-XXXX-XXXX"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="characters"
        autoCorrect="off"
        style={{ ...INPUT_STYLE, fontFamily: "var(--font-mono)", fontSize: 15 }}
        data-testid="sync.enroll.account-input"
      />
      {!accountStructurallyPlausible(accountNumber) && (
        <p style={{ margin: "8px 2px 0", fontSize: 13, color: "var(--warning)" }} data-testid="sync.enroll.account-hint">
          Double-check this number — it doesn't look right.
        </p>
      )}

      <FieldLabel>Sign in with</FieldLabel>
      <Segmented
        options={["Password", "Recovery phrase"]}
        active={MODE_VALUES.indexOf(mode)}
        onChange={(i) => {
          clearOutcome();
          setMode(MODE_VALUES[i]);
        }}
      />

      {mode === "password" ? (
        <>
          <FieldLabel>Password</FieldLabel>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              clearOutcome();
              setPassword(e.target.value);
            }}
            placeholder="Your vault password"
            autoComplete="off"
            style={INPUT_STYLE}
            data-testid="sync.enroll.password-input"
          />
        </>
      ) : (
        <>
          <FieldLabel>Recovery phrase</FieldLabel>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--fg-3)" }}>
            Enter or paste your 24 words. Pasting fills the cells in order.
          </p>
          <div
            style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}
            data-testid="sync.enroll.phrase-grid"
          >
            {Array.from({ length: PHRASE_CELL_COUNT }, (_, i) => {
              const inputId = `${baseId}-cell-${i}`;
              return (
                <label
                  key={i}
                  htmlFor={inputId}
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    background: "var(--bg-1)",
                    border: "1px solid var(--line-1)",
                    borderRadius: 4,
                    paddingLeft: 24,
                    paddingRight: 6,
                    height: 34,
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      left: 6,
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--fg-3)",
                      pointerEvents: "none",
                    }}
                  >
                    {i + 1}
                  </span>
                  <input
                    id={inputId}
                    type="text"
                    value={cells[i] ?? ""}
                    onChange={(e) => setCell(i, e.target.value)}
                    onPaste={handlePaste(i)}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    style={{
                      width: "100%",
                      height: "100%",
                      background: "transparent",
                      border: 0,
                      outline: "none",
                      fontFamily: "var(--font-mono)",
                      fontSize: 14,
                      color: "var(--fg-1)",
                      padding: 0,
                    }}
                    data-testid="sync.enroll.phrase-cell"
                    data-index={i + 1}
                  />
                </label>
              );
            })}
          </div>
        </>
      )}

      {outcome?.state === "error" && (
        <div style={{ marginTop: 14 }} data-testid="sync.enroll.error">
          <Banner kind="danger">{enrollFailureMessage(outcome.kind)}</Banner>
        </div>
      )}
      {outcome?.state === "pending" && (
        <p style={NOTICE} data-testid="sync.enroll.pending">
          {ENROLL_PENDING_NOTICE}
        </p>
      )}
      {outcome?.state === "approved" && (
        <p style={{ ...NOTICE, color: "var(--success)" }} data-testid="sync.enroll.approved">
          {ENROLL_APPROVED_NOTICE}
        </p>
      )}

      <div style={{ marginTop: 18 }}>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={primaryBtn(!canSubmit)}
          data-testid="sync.enroll.submit"
        >
          {busy ? "Connecting…" : "Add this device"}
        </button>
      </div>
    </div>
  );
}

// ── SY-06 / SY-07 · Your devices + remove confirm ────────────────────────────

/** The device's synced friendly name (SYNC-41), or a stable `device_id`-prefix
 *  fallback until it is explicitly named (no second default-name heuristic). */
function deviceName(d: DeviceEntry, names: Record<string, string>): string {
  return names[d.device_id_hex] ?? `Device ${d.device_id_hex.slice(0, 6)}`;
}

/** The device currently in the SY-05 approve-then-verify SAS step. */
interface SasState {
  deviceId: string;
  /** This device's adopted-head fingerprint (`XXXX-XXXX`), or null while it loads. */
  fingerprint: string | null;
  /** True until the fingerprint fetch resolves. */
  loading: boolean;
}

/** SY-06 devices list + inline SY-05 approve-then-verify SAS + SY-07 remove
 *  confirm (verbatim revocation copy). */
export function SyncDevicesPanel() {
  const { devices, pending, error, busy, approve, remove, resetLocal } = useDevices();
  const { prefs } = usePrefs();
  const names = prefs.device_names;
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [sas, setSas] = useState<SasState | null>(null);

  const approved = (devices ?? []).filter((d) => d.approved && !d.retired);
  const retiredSelf = (devices ?? []).find((d) => d.is_current && d.retired);

  // Approve-then-verify (SYNC-40): approve FIRST, then surface this device's
  // adopted-head fingerprint for the out-of-band eye-compare against the newcomer.
  const approveAndVerify = async (deviceId: string) => {
    // Only surface the SAS eye-compare once approval actually succeeded. If the
    // backend `sync_approve_device` failed, `approve` returns false (and set the
    // error banner) — stay on the device list rather than showing a verify
    // screen for a device that was never approved.
    if (!(await approve(deviceId))) return;
    setSas({ deviceId, fingerprint: null, loading: true });
    try {
      const fp = await syncHeadFingerprint();
      setSas((s) => (s?.deviceId === deviceId ? { ...s, fingerprint: fp, loading: false } : s));
    } catch {
      setSas((s) => (s?.deviceId === deviceId ? { ...s, fingerprint: null, loading: false } : s));
    }
  };

  // SY-05: approve-then-verify SAS — shown right after an approve, in place of
  // the list. Renders the frozen Crockford `XXXX-XXXX` (SYNC-17: one encoding,
  // no word-list, no `4F-2A-9C`) for the user to eye-compare against the new
  // device. A mismatch routes straight to Remove device.
  if (sas) {
    return (
      <div style={{ marginTop: 6 }} data-testid="sync.approve-verify">
        <h2 style={{ margin: "8px 4px 10px", fontSize: 20, fontWeight: 700, color: "var(--fg-1)" }}>
          Verify the new device
        </h2>
        <p style={{ margin: "0 4px 18px", fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)" }}>
          Check that the same code appears on the device you just approved. If it matches, they are
          on your account. If it doesn't, remove the device.
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "22px 16px",
            border: "1px solid var(--line-1)",
            borderRadius: 10,
            background: "var(--bg-2)",
          }}
        >
          {sas.loading ? (
            <span style={{ fontSize: 15, color: "var(--fg-3)" }}>Syncing…</span>
          ) : sas.fingerprint ? (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: "0.14em",
                color: "var(--fg-1)",
              }}
              data-testid="sync.sas-fingerprint"
            >
              {sas.fingerprint}
            </span>
          ) : (
            <span style={{ fontSize: 14, color: "var(--fg-3)", textAlign: "center" }} data-testid="sync.sas-pending">
              This code appears once the new device finishes its first sync.
            </span>
          )}
        </div>
        <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            type="button"
            onClick={() => setSas(null)}
            style={primaryBtn(false)}
            data-testid="sync.sas-match"
          >
            They match
          </button>
          <button
            type="button"
            onClick={() => {
              const id = sas.deviceId;
              setSas(null);
              setConfirmRemove(id);
            }}
            style={{
              width: "100%",
              height: 50,
              border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)",
              borderRadius: 8,
              background: "var(--danger-soft)",
              color: "var(--danger)",
              fontFamily: "var(--font-sans)",
              fontSize: 16,
              fontWeight: 600,
              cursor: "pointer",
            }}
            data-testid="sync.sas-mismatch"
          >
            They don't match
          </button>
        </div>
      </div>
    );
  }

  // SY-07: full-screen-ish confirm sheet body (rendered in place of the list).
  if (confirmRemove) {
    return (
      <div style={{ marginTop: 6 }} data-testid="sync.remove-confirm">
        <h2 style={{ margin: "8px 4px 12px", fontSize: 20, fontWeight: 700, color: "var(--fg-1)" }}>
          {REMOVE_DEVICE_CONFIRM}
        </h2>
        <p style={{ margin: "0 4px", fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)" }} data-testid="sync.remove-disclosure">
          {REMOVE_DEVICE_DISCLOSURE}
        </p>
        <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const id = confirmRemove;
              setConfirmRemove(null);
              void remove(id);
            }}
            style={{
              width: "100%",
              height: 50,
              border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)",
              borderRadius: 8,
              background: "var(--danger-soft)",
              color: "var(--danger)",
              fontFamily: "var(--font-sans)",
              fontSize: 16,
              fontWeight: 600,
              cursor: busy ? "not-allowed" : "pointer",
            }}
            data-testid="sync.remove-device-confirm"
          >
            Remove device
          </button>
          <button
            type="button"
            onClick={() => setConfirmRemove(null)}
            style={{
              width: "100%",
              height: 50,
              border: "1px solid var(--line-1)",
              borderRadius: 8,
              background: "var(--bg-1)",
              color: "var(--fg-1)",
              fontFamily: "var(--font-sans)",
              fontSize: 16,
              fontWeight: 600,
              cursor: "pointer",
            }}
            data-testid="sync.remove-device-cancel"
          >
            Keep it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 4 }} data-testid="sync.device-management">
      {error === "NotEnrolled" ? (
        <p style={{ ...HELP, marginTop: 10 }} data-testid="sync.device-not-enrolled">
          This device isn't syncing yet. Add it from the previous screen to see your devices.
        </p>
      ) : error === "Unauthenticated" ? (
        <div style={{ marginTop: 10 }} data-testid="sync.device-error">
          <p style={{ margin: 0, fontSize: 14, color: "var(--danger)" }}>
            This device's access was revoked, probably removed from another device.
          </p>
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void resetLocal()}
              style={primaryBtn(busy)}
              data-testid="sync.reset-local"
            >
              Reset sync on this device
            </button>
          </div>
        </div>
      ) : error ? (
        <p style={{ ...HELP, marginTop: 10, color: "var(--danger)" }} data-testid="sync.device-error">
          Couldn't reach the sync server. If the server moved or its certificate changed, re-connect it
          from the Sync server screen.
        </p>
      ) : retiredSelf ? (
        <div style={{ marginTop: 10 }} data-testid="sync.device-retired-self">
          <p style={{ margin: 0, fontSize: 14, color: "var(--danger)" }}>
            This device was removed from another device.
          </p>
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void resetLocal()}
              style={primaryBtn(busy)}
              data-testid="sync.reset-local"
            >
              Reset and add again
            </button>
          </div>
        </div>
      ) : null}

      {pending.length > 0 && (
        <div data-testid="sync.pending-devices">
          <SectionLabel mt={12}>Waiting for approval</SectionLabel>
          <Group>
            {pending.map((d, i) => (
              <Row key={d.device_id_hex} first={i === 0} testId="sync.pending-row">
                <span style={rowLabel}>{deviceName(d, names)}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void approveAndVerify(d.device_id_hex)}
                  style={{
                    padding: "7px 14px",
                    border: "none",
                    borderRadius: 8,
                    background: "var(--accent)",
                    color: "var(--accent-on)",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                  data-testid="sync.approve-device"
                >
                  Approve
                </button>
              </Row>
            ))}
          </Group>
        </div>
      )}

      <SectionLabel mt={12}>Your devices</SectionLabel>
      {devices === null ? (
        error ? null : <p style={{ ...HELP, marginTop: 4 }}>Loading…</p>
      ) : approved.length === 0 ? (
        <p style={{ ...HELP, marginTop: 4 }}>No devices yet.</p>
      ) : (
        <Group>
          {approved.map((d, i) => (
            <Row key={d.device_id_hex} first={i === 0} testId="sync.device-row">
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={rowLabel}>{deviceName(d, names)}</span>
                {d.is_current && (
                  <span
                    style={{
                      padding: "1px 7px",
                      fontSize: 11,
                      fontWeight: 600,
                      color: "var(--fg-2)",
                      border: "1px solid var(--line-1)",
                      borderRadius: 999,
                    }}
                    data-testid="sync.this-device"
                  >
                    This device
                  </span>
                )}
              </div>
              {d.is_current ? (
                <span style={{ fontSize: 13, color: "var(--fg-3)" }}>Syncing here</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmRemove(d.device_id_hex)}
                  style={{
                    padding: "7px 12px",
                    border: "1px solid var(--line-1)",
                    borderRadius: 8,
                    background: "var(--bg-1)",
                    color: "var(--danger)",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                  data-testid="sync.remove-device"
                >
                  Remove
                </button>
              )}
            </Row>
          ))}
        </Group>
      )}
    </div>
  );
}
