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

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { SyncStatus } from "../lib/use-sync-status";
import type { VaultId } from "../lib/stage";
import {
  syncGetEndpoint,
  syncSetEndpoint,
  syncAccountStatus,
  useEnroll,
  useDevices,
  useMembers,
  type EnrollCredentialKind,
  type DeviceEntry,
  type AccountStatusView,
} from "../lib/sync";
import { useHeadFingerprintCompare } from "../hooks/useHeadFingerprintCompare";
import { useMemberVault } from "../hooks/useMemberVault";
import { formatBytes } from "../lib/util";
import { formatAccountNumberInput } from "../lib/account-number-format";
import { normalizeBip39Phrase } from "../lib/bip39-normalize";
// From the shared tree, not the local twin: `PHRASE_CELL_COUNT` has ONE
// definition (`src/lib/bip39-normalize.ts`) and the twin is byte-identical to
// that module, so re-exporting through it would make the pair differ and grow
// the twin-drift ratchet for no gain. The normalizer stays on the twin because
// the twin predates this and resolving it is its own decision.
import { PHRASE_CELL_COUNT } from "@myne/client-core/phrase-cells";
import { usePrefs } from "../lib/use-prefs";
import { setDeviceName } from "../lib/prefs";
import { DEVICE_NAME_MAX_LEN, useDeviceNameField } from "../lib/device-name";
import {
  ENROLL_APPROVED_NOTICE,
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_PENDING_NOTICE,
  REMOVE_DEVICE_CONFIRM,
  REMOVE_DEVICE_DISCLOSURE,
} from "../lib/load-bearing-copy";
import { canAddThisDevice } from "@myne/enroll-gate";
import { Banner, PhraseEntryGrid, Segmented } from "./index";
// The host probe has ONE definition (`lib/app-window.ts`), which is also the one
// file `check-platform-seam.mjs` exempts from the runtime-global rule. This
// module used to re-spell it inline, and the copy was subtly weaker: no
// `typeof window` guard, so it threw off-DOM instead of answering `false`.
import { HAS_TAURI } from "../lib/app-window";
import { tappable } from "../app/a11y/tappable";

// ── Shared panel primitives (settings-card geometry) ─────────────────────────

const rowLabel: CSSProperties = { fontSize: 16, color: "var(--fg-1)" };
/** Right-aligned figure in a usage row (MYND-570) — mono, so the digits align. */
const usageValue: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  color: "var(--fg-2)",
};

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
      // A control only when it does something (myne#728), the same shape the
      // Settings sheet's own Row uses.
      {...(tappable({ onActivate: onClick }) ?? {})}
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
function statusView(status: SyncStatus | null, t: TFunction): { color: string; label: string } {
  switch (status?.state) {
    case undefined:
    case "disabled":
      return { color: "var(--line-3)", label: t("settings.archive.off") };
    case "not_enrolled":
      return { color: "var(--line-3)", label: t("settings.sync.summary.notSetUp") };
    case "pending":
      return { color: "var(--warning)", label: t("sync.status.awaitingApproval") };
    case "idle":
      return { color: "var(--success)", label: t("settings.archive.on") };
    case "syncing":
      return { color: "var(--accent)", label: t("sync.status.syncing") };
    case "error":
      // A TLS failure is not an offline device: certificate and server-name
      // validation must be fixed before this client can reconnect.
      return status.detail === "tls_failure"
        ? { color: "var(--danger)", label: t("sync.status.errorTls") }
        : { color: "var(--warning)", label: t("settings.sync.summary.offline") };
    case "conflicts":
      return {
        color: "var(--danger)",
        label: t("settings.sync.summary.conflicts", { count: status.count }),
      };
  }
}

// ── SY-01 · Sync hub ─────────────────────────────────────────────────────────

export interface SyncHubPanelProps {
  status: SyncStatus | null;
  /** The active vault's id, for ONE question: is this a MEMBER vault? It decides
   *  whether the usage block describes the vault or the member's own account (see
   *  `useMemberVault`). Optional so a caller with no vault in scope keeps the
   *  pre-change behaviour. */
  vaultId?: VaultId;
  /** Trigger an immediate sync (MYND-481). Result is reflected in `status`. */
  onSyncNow: () => void;
  /** True while a manual sync is in flight. */
  syncing: boolean;
  onOpenEndpoint: () => void;
  onOpenEnroll: () => void;
  onOpenDevices: () => void;
  onOpenMembers: () => void;
}

/** SY-01: the honest enrollment status + force-sync + drill-down entry points. */
export function SyncHubPanel({ status, vaultId, onSyncNow, syncing, onOpenEndpoint, onOpenEnroll, onOpenDevices, onOpenMembers }: SyncHubPanelProps) {
  const { t } = useTranslation();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  // Read-at-rest usage projection (MYND-570). `null` = unavailable → section omitted.
  const [usage, setUsage] = useState<AccountStatusView | null>(null);
  // On a member vault the projection is the member's own PERSON account: the
  // device count is genuinely theirs and matches the roster, while the storage
  // figure counts a namespace holding none of the shared vault's blobs, a true
  // "0 B" above a vault full of notes. The section waits for the plane to be
  // KNOWN rather than defaulting either way: `unknown` would otherwise print the
  // owner's label over the member's numbers, or the reverse.
  const plane = useMemberVault(vaultId);
  const view = statusView(status, t);
  // "Sync now" is only meaningful with an authed session to sync — a cycle while
  // disabled / not-enrolled / pending returns NotReady, so hide it there rather
  // than promise a sync that can't run (mirrors the old SY-08 detail sheet).
  const canSyncNow =
    status?.state !== "disabled" && status?.state !== "not_enrolled" && status?.state !== "pending";
  // "Add this device" is the enrol entry point for a device that is not a
  // member — and dead UI for one that is. It used to render unconditionally, so
  // an already-syncing phone was invited to enrol again; `sync_enroll` mints a
  // FRESH `device_id`, so doing that strands a second registration nobody can
  // identify rather than no-op'ing (myne-md/myne-mobile#38). The predicate is
  // the main repo's `@myne/enroll-gate`, shared with desktop and web so this
  // rule cannot be fixed in one client and missed in another again — which is
  // exactly how this bug reached a dogfood device.
  const showAdd = canAddThisDevice(status?.state);

  useEffect(() => {
    if (!HAS_TAURI) return;
    void syncGetEndpoint()
      .then((c) => setEndpoint(c.endpoint_url))
      .catch(() => setEndpoint(null));
    void syncAccountStatus()
      .then((s) => setUsage(s ?? null))
      .catch(() => setUsage(null));
  }, []);

  return (
    <div style={{ marginTop: 4 }} data-testid="sync.settings">
      <SectionLabel mt={6}>{t("sync.settings.serverSection")}</SectionLabel>
      <Group>
        <Row first onClick={onOpenEndpoint} testId="sync.settings.endpoint">
          <span style={rowLabel}>{t("sync.join.serverLabel")}</span>
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
              {endpoint ?? t("sync.settings.serverNotSet")}
            </span>
            <RowChevron />
          </div>
        </Row>
        <Row testId="sync.settings.status">
          <span style={rowLabel}>{t("sync.settings.statusLabel")}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg-2)" }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", background: view.color, flex: "none" }} />
            <span style={{ fontSize: 15 }}>{view.label}</span>
          </div>
        </Row>
        {canSyncNow && (
          // Force sync (MYND-481). The outcome surfaces in the status row above
          // (Synced / Offline / N conflicts) + the SyncBanners error channel —
          // never a silent no-op. Disabled while a sync is in flight.
          <Row onClick={syncing ? undefined : onSyncNow} testId="sync.settings.sync-now">
            <span style={{ ...rowLabel, color: syncing ? "var(--fg-3)" : "var(--accent)" }}>
              {syncing ? t("sync.status.syncing") : t("sync.status.syncNow")}
            </span>
          </Row>
        )}
      </Group>

      {/* Usage (MYND-570). Absent when the server has no /account/status route
          (self-hosted or older): the whole section is omitted rather than shown
          as an error. `0` ceilings mean unlimited, so the value is the bare
          figure with no limit and no upsell. */}
      {usage !== null && plane !== "unknown" && (
        <>
          <SectionLabel>
            {t(plane === "member" ? "sync.panel.usage.memberLabel" : "sync.panel.usage.label")}
          </SectionLabel>
          <Group>
            {plane === "owner" && (
              <Row first testId="sync.usage-storage">
                <span style={rowLabel}>{t("sync.usage.storage")}</span>
                <span style={usageValue}>
                  {usage.quota_bytes === 0
                    ? formatBytes(usage.stored_bytes)
                    : t("sync.usage.ofTotal", {
                        used: formatBytes(usage.stored_bytes),
                        total: formatBytes(usage.quota_bytes),
                      })}
                </span>
              </Row>
            )}
            <Row first={plane === "member"} testId="sync.usage-devices">
              <span style={rowLabel}>{t("sync.usage.devices")}</span>
              <span style={usageValue}>
                {usage.max_devices === 0
                  ? String(usage.device_count)
                  : t("sync.usage.ofTotal", {
                      used: String(usage.device_count),
                      total: String(usage.max_devices),
                    })}
              </span>
            </Row>
            {usage.frozen && (
              <Row testId="sync.usage-frozen">
                <span style={{ ...rowLabel, fontSize: 14 }}>{t("sync.usage.frozen")}</span>
              </Row>
            )}
          </Group>
        </>
      )}

      <SectionLabel>{t("sync.panel.devices.label")}</SectionLabel>
      <Group>
        {showAdd && (
          <Row first onClick={onOpenEnroll} testId="sync.settings.add-device">
            <span style={rowLabel}>{t("sync.enroll.submit")}</span>
            <RowChevron />
          </Row>
        )}
        <Row first={!showAdd} onClick={onOpenDevices} testId="sync.settings.devices">
          <span style={rowLabel}>{t("sync.devices.yourDevices")}</span>
          <RowChevron />
        </Row>
        <Row onClick={onOpenMembers} testId="sync.settings.members">
          <span style={rowLabel}>{t("sync.members.title")}</span>
          <RowChevron />
        </Row>
      </Group>
      {/* What the row is replaced BY while this device waits — stating the
          situation rather than offering an action, because there is no action
          to take here: approval happens on another device, and the only button
          this screen could honestly show would create a second pending record.
          Desktop renders the same sentence for the same reason (MYND-635).

          `ENROLL_PENDING_NOTICE` verbatim, not an i18n key: the load-bearing
          copy is byte-identical across clients by construction (SYNC-42). */}
      {status?.state === "pending" && (
        <p style={NOTICE} data-testid="sync.settings.awaiting-approval">
          {ENROLL_PENDING_NOTICE}
        </p>
      )}

      <p style={{ ...HELP, marginTop: 16 }}>{t("sync.settings.hubHelp")}</p>
    </div>
  );
}

// ── SY-02 · Endpoint config ──────────────────────────────────────────────────

/** SY-02: set/get the endpoint; public-CA HTTPS is required off loopback. */
export function SyncEndpointPanel() {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  // The endpoint this device is currently connected to, so the invite field can
  // hide once connected (myne-md/myne#822) — the same behaviour desktop/web
  // gained in #815, mirrored here so the mobile twin does not drift.
  const [connectedUrl, setConnectedUrl] = useState<string | null>(null);
  // The shared admission code for a gated server (empty = open server).
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!HAS_TAURI) return;
    void syncGetEndpoint()
      .then((c) => {
        if (c.endpoint_url) {
          setUrl(c.endpoint_url);
          setConnectedUrl(c.endpoint_url);
        }
        setInviteCode(c.invite_code ?? "");
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
    void syncSetEndpoint(trimmed, inviteCode.trim())
      .then((r) => {
        setConnectedUrl(trimmed);
        setMsg(t(r.pin_source === "platform_trust_store" ? "sync.settings.connectedTls" : "sync.settings.connectedLocal"));
      })
      .catch((e: unknown) => setMsg(t((e as { kind?: string } | null)?.kind === "TlsFailure"
        ? "sync.endpoint.tlsFailure"
        : "sync.settings.connectError")))
      .finally(() => setBusy(false));
  };

  // Connected & unedited: the input still matches the endpoint in use, so the
  // invite field is hidden (it is for admission only) and the button rests as a
  // disabled "Connected".
  const trimmedUrl = url.trim();
  const isConnectedUnedited =
    connectedUrl !== null && trimmedUrl.length > 0 && trimmedUrl === connectedUrl;

  return (
    <div style={{ marginTop: 4 }} data-testid="sync.endpoint-config">
      <FieldLabel mt={6}>{t("sync.settings.serverAddressLabel")}</FieldLabel>
      <input
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          // Changing the address invalidates a code issued for the old server.
          setInviteCode("");
        }}
        placeholder={t("sync.settings.serverAddressPlaceholder")}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        inputMode="url"
        style={{ ...INPUT_STYLE, fontFamily: "var(--font-mono)", fontSize: 15 }}
        data-testid="sync.endpoint-input"
      />
      {!isConnectedUnedited && (
        <>
          <FieldLabel mt={14}>{t("sync.endpoint.inviteLabel")}</FieldLabel>
          <input
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            placeholder={t("sync.endpoint.invitePlaceholder")}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            style={{ ...INPUT_STYLE, fontFamily: "var(--font-mono)" }}
            data-testid="sync.endpoint-invite-input"
          />
        </>
      )}
      <div style={{ marginTop: 14 }}>
        {isConnectedUnedited ? (
          <button
            type="button"
            disabled
            style={primaryBtn(busy)}
            data-testid="sync.endpoint-connect"
          >
            {t("sync.endpoint.connected")}
          </button>
        ) : (
          <button
            type="button"
            onClick={connect}
            disabled={busy}
            style={primaryBtn(busy)}
            data-testid="sync.endpoint-connect"
          >
            {busy ? t("sync.endpoint.connecting") : t("sync.endpoint.connect")}
          </button>
        )}
      </div>

      {msg && (
        <p style={NOTICE} data-testid="sync.endpoint-msg">
          {msg}
        </p>
      )}

    </div>
  );
}

// ── SY-03 / SY-04 · Enroll this device ───────────────────────────────────────

const MODE_VALUES: EnrollCredentialKind[] = ["password", "recovery"];

/** Map a non-secret `SyncDeviceError` kind to honest, non-distinguishing copy.
 *  Config/transport faults get their own (non-leaking) line; every
 *  credential/account/meta failure collapses to the single banner (SYNC-8). */
function enrollFailureMessage(kind: string, t: TFunction): string {
  switch (kind) {
    case "NotConfigured":
      return t("sync.settings.enrollNotConfigured");
    case "Transport":
      return t("sync.settings.enrollTransport");
    // The gated-server refusals are not credential failures: the remedy is the
    // operator's invite code, and the credential banner would send the user
    // round a loop that cannot terminate.
    case "InviteCodeRequired":
      return t("sync.enroll.error.inviteCodeRequired");
    case "InviteCodeInvalid":
      return t("sync.enroll.error.inviteCodeInvalid");
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
  const { t } = useTranslation();
  const { busy, outcome, enroll, reset } = useEnroll();

  // MYND-548: this device's own name. One hook for both mobile doors (and the
  // desktop twin), so they cannot drift.
  const deviceNameField = useDeviceNameField();

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

  const handleSubmit = () => {
    if (!canSubmit) return;
    const credential = mode === "password" ? password : normalizeBip39Phrase(cells.join(" "));
    void enroll(accountNumber.trim(), credential, mode, deviceNameField.resolved);
  };

  return (
    <div style={{ marginTop: 4 }} data-testid="sync.enroll">
      <FieldLabel mt={6}>{t("sync.enroll.accountNumberLabel")}</FieldLabel>
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
      {/* MYND-548: named here, at the one moment the user is provably holding
          this device. Held in RAM and written only AFTER the first authed sync
          cycle — never with the request, and never before that cycle. */}
      <FieldLabel mt={14}>{t("sync.enroll.deviceNameLabel")}</FieldLabel>
      <input
        value={deviceNameField.value}
        onChange={(e) => deviceNameField.setValue(e.target.value)}
        maxLength={DEVICE_NAME_MAX_LEN}
        placeholder={deviceNameField.suggestion}
        autoComplete="off"
        spellCheck={false}
        autoCorrect="off"
        style={INPUT_STYLE}
        data-testid="sync.enroll.device-name-input"
      />
      <p style={{ ...HELP, marginTop: 4 }}>{t("sync.enroll.deviceNameHelp")}</p>
      {!accountStructurallyPlausible(accountNumber) && (
        <p style={{ margin: "8px 2px 0", fontSize: 13, color: "var(--warning)" }} data-testid="sync.enroll.account-hint">
          {t("sync.settings.accountNumberHint")}
        </p>
      )}

      <FieldLabel>{t("sync.enroll.signInWith")}</FieldLabel>
      <Segmented
        options={[t("sync.enroll.passwordLabel"), t("sync.enroll.recoveryPhraseLabel")]}
        active={MODE_VALUES.indexOf(mode)}
        onChange={(i: number) => {
          clearOutcome();
          setMode(MODE_VALUES[i]);
        }}
        ariaLabel={t("sync.enroll.signInWith")}
      />

      {mode === "password" ? (
        <>
          <FieldLabel>{t("sync.enroll.passwordLabel")}</FieldLabel>
          <input
            type="password"
            value={password}
            onChange={(e) => {
              clearOutcome();
              setPassword(e.target.value);
            }}
            placeholder={t("sync.settings.passwordPlaceholder")}
            autoComplete="off"
            style={INPUT_STYLE}
            data-testid="sync.enroll.password-input"
          />
        </>
      ) : (
        <>
          <FieldLabel>{t("sync.enroll.recoveryPhraseLabel")}</FieldLabel>
          <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--fg-3)" }}>
            {t("sync.settings.recoveryPhraseHint")}
          </p>
          <PhraseEntryGrid
            cells={cells}
            onCells={(next) => {
              clearOutcome();
              // §3.2: no typed whitespace. The field is stripped here rather than
              // in the primitive, because "what a phrase cell may contain" is a
              // rule about this credential and not about a grid of text inputs.
              setCells(next.map((cell) => cell.replace(/\s+/g, "")));
            }}
            testIdPrefix="sync.enroll.phrase"
            columns={3}
            cellLabel={(index) => t("sync.enroll.wordAria", { number: index + 1 })}
          />
        </>
      )}

      {outcome?.state === "error" && (
        <div style={{ marginTop: 14 }} data-testid="sync.enroll.error">
          <Banner kind="danger">{enrollFailureMessage(outcome.kind, t)}</Banner>
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
          {busy ? t("sync.endpoint.connecting") : t("sync.enroll.submit")}
        </button>
      </div>
    </div>
  );
}

// ── SY-06 / SY-07 · Your devices + remove confirm ────────────────────────────

/** The device's synced friendly name (SYNC-41), or a stable `device_id`-prefix
 *  fallback until it is explicitly named (no second default-name heuristic). */
function deviceName(d: DeviceEntry, names: Record<string, string>, t: TFunction): string {
  const stored = names[d.device_id_hex];
  // A whitespace-only stored value counts as absent — the Rust setter refuses to
  // write one, so this is belt-and-braces against a hand-edited or foreign-client
  // blob. Desktop's `displayName` guards the same way.
  return stored !== undefined && stored.trim() !== ""
    ? stored
    : t("sync.devices.shortName", { hex: d.device_id_hex.slice(0, 6) });
}

/** The device currently in the SY-05 approve-then-verify SAS step. */
interface SasState {
  deviceId: string;
}

/** SY-06 devices list + inline SY-05 approve-then-verify SAS + SY-07 remove
 *  confirm (verbatim revocation copy). */
export function SyncDevicesPanel({ vaultId }: { vaultId?: VaultId }) {
  const { t } = useTranslation();
  const { devices, pending, error, busy, approve, remove, resetLocal } = useDevices();
  const { prefs } = usePrefs();
  const names = prefs.device_names;
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Which account plane this vault's device list describes — see `useMemberVault`.
  // The gates below read the POSITIVE answers only: `"owner"` for the destructive
  // arms, so an unresolved or failed probe renders neither of them.
  const plane = useMemberVault(vaultId);

  // MYND-548 inline rename. One row at a time — the Rename buttons disable while
  // any row is open, so a stray tap cannot strand a half-typed edit.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [renameFailed, setRenameFailed] = useState(false);

  // Enter and blur both land here. Closing the editor FIRST makes the two paths
  // idempotent (blur fires right after Enter; the second call sees `null`). A
  // blank value is a cancel — the backend refuses it too — so the previous name
  // survives and only a genuine write failure surfaces. Deliberately NOT
  // optimistic: the row renders off `prefs`, so a failed write simply never
  // changed it, which IS the revert.
  const commitRename = async () => {
    const target = renaming;
    if (target === null) return;
    setRenaming(null);
    const trimmed = target.value.trim();
    if (trimmed === "") return;
    try {
      await setDeviceName(target.id, trimmed);
      setRenameFailed(false);
    } catch {
      setRenameFailed(true);
    }
  };
  const [sas, setSas] = useState<SasState | null>(null);

  const approved = (devices ?? []).filter((d) => d.approved && !d.retired);
  // Not unless this is positively an OWNER vault: there the roster is the member's
  // PERSON account, so a retired row means this device was removed from that
  // ACCOUNT rather than from this vault, and the arm's copy is worded for the latter.
  const retiredSelf =
    plane === "owner" ? (devices ?? []).find((d) => d.is_current && d.retired) : undefined;

  // Approve-then-verify (SYNC-40): approve FIRST, then surface this device's
  // adopted-head fingerprint for the out-of-band eye-compare against the newcomer.
  const approveAndVerify = async (deviceId: string) => {
    // Only surface the SAS eye-compare once approval actually succeeded. If the
    // backend `sync_approve_device` failed, `approve` returns false (and set the
    // error banner) — stay on the device list rather than showing a verify
    // screen for a device that was never approved.
    if (!(await approve(deviceId))) return;
    setSas({ deviceId });
  };

  // myne#462: this surface had NO poll at all.
  //
  // It was a single `syncHeadFingerprint()` call — the exact shape #243 removed
  // from the desktop approving side in 2026, kept here because the two files are
  // twins that nothing compared. `None` is the honest answer while this device
  // has adopted no head, so a call landing early left "this code appears once
  // the new device finishes its first sync" on screen permanently, with no
  // retry and (unlike desktop) no way back into the compare. Nothing tested it:
  // `devices.flow.ts` covers the list, never this screen.
  //
  // Now the same hook the desktop panel uses, twinned per
  // `scripts/check-twin-drift.mjs`.
  const { fingerprint, syncing, changed: sasChanged, acknowledgeChange } =
    useHeadFingerprintCompare(sas !== null, "approver");

  // SY-05: approve-then-verify SAS — shown right after an approve, in place of
  // the list. Renders the frozen Crockford `XXXX-XXXX` (SYNC-17: one encoding,
  // no word-list, no `4F-2A-9C`) for the user to eye-compare against the new
  // device. A mismatch routes straight to Remove device.
  if (sas) {
    return (
      <div style={{ marginTop: 6 }} data-testid="sync.approve-verify">
        <h2 style={{ margin: "8px 4px 10px", fontSize: 20, fontWeight: 700, color: "var(--fg-1)" }}>
          {t("sync.devices.verifyTitle")}
        </h2>
        <p style={{ margin: "0 4px 18px", fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)" }}>
          {t("sync.settings.verifyBody")}
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
          {syncing ? (
            <span style={{ fontSize: 15, color: "var(--fg-3)" }}>{t("sync.status.syncing")}</span>
          ) : fingerprint ? (
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
              {fingerprint}
            </span>
          ) : (
            <span style={{ fontSize: 14, color: "var(--fg-3)", textAlign: "center" }} data-testid="sync.sas-pending">
              {t("sync.devices.verifyPending")}
            </span>
          )}
        </div>
        {/* The head moved mid-compare — a third device pushed, or the hold
            lapsed. Announced rather than swapped in silently. */}
        {sasChanged && (
          <p
            style={{ margin: "var(--space-4) var(--space-1) 0", fontSize: "var(--text-sm)", lineHeight: "var(--leading-relaxed)", color: "var(--fg-2)" }}
            data-testid="sync.sas-changed"
          >
            {t("sync.devices.verifyChanged")}
          </p>
        )}
        <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            type="button"
            onClick={() => setSas(null)}
            style={primaryBtn(false)}
            data-testid="sync.sas-match"
          >
            {t("sync.devices.verifyMatch")}
          </button>
          <button
            type="button"
            onClick={() => {
              const id = sas.deviceId;
              acknowledgeChange();
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
            {t("sync.settings.sasMismatch")}
          </button>
        </div>
      </div>
    );
  }

  // SY-07: full-screen-ish confirm sheet body (rendered in place of the list).
  if (confirmRemove) {
    const target = (devices ?? []).find((d) => d.device_id_hex === confirmRemove);
    const removeTargetLabel = `${target ? deviceName(target, names, t) : ""} · ${confirmRemove.slice(0, 6)}`;
    return (
      <div style={{ marginTop: 6 }} data-testid="sync.remove-confirm">
        <h2 style={{ margin: "8px 4px 12px", fontSize: 20, fontWeight: 700, color: "var(--fg-1)" }}>
          {REMOVE_DEVICE_CONFIRM}
        </h2>
        {/* MYND-548: which device is about to lose its token. Name + code, so the
            user can verify the target — revocation is the one place a mis-read row
            costs something. The disclosure copy below is load-bearing and stays
            verbatim. */}
        <p
          style={{ margin: "0 4px 10px", fontSize: 15, color: "var(--fg-1)", fontWeight: 600 }}
          data-testid="sync.remove-target"
        >
          {removeTargetLabel}
        </p>
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
            {t("sync.settings.removeDeviceButton")}
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
            {t("sync.settings.keepDevice")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 4 }} data-testid="sync.device-management">
      {error === "NotEnrolled" ? (
        <p style={{ ...HELP, marginTop: 10 }} data-testid="sync.device-not-enrolled">
          {t("sync.settings.notEnrolledHelp")}
        </p>
      ) : error === "Unauthenticated" ? (
        <div style={{ marginTop: 10 }} data-testid="sync.device-error">
          <p style={{ margin: 0, fontSize: 14, color: "var(--danger)" }}>
            {t("sync.settings.unauthenticated")}
          </p>
          {/* The remedy is NOT offered unless this is positively an OWNER vault:
              the reset clears the token in the vault directory, which on a member
              vault is the membership token the whole vault syncs on, and no UI
              path restores it. `unknown` (no id, a failed probe, or the first
              paint) is not an owner answer. The refusal itself is still reported —
              a member whose person account refused them needs to know. */}
          {plane === "owner" && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void resetLocal()}
                style={primaryBtn(busy)}
                data-testid="sync.reset-local"
              >
                {t("sync.devices.resetSyncOnThisDevice")}
              </button>
            </div>
          )}
        </div>
      ) : error ? (
        <p style={{ ...HELP, marginTop: 10, color: "var(--danger)" }} data-testid="sync.device-error">
          {t("sync.settings.transportError")}
        </p>
      ) : retiredSelf ? (
        <div style={{ marginTop: 10 }} data-testid="sync.device-retired-self">
          <p style={{ margin: 0, fontSize: 14, color: "var(--danger)" }}>
            {t("sync.settings.retiredSelf")}
          </p>
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void resetLocal()}
              style={primaryBtn(busy)}
              data-testid="sync.reset-local"
            >
              {t("sync.settings.resetAndAddAgain")}
            </button>
          </div>
        </div>
      ) : null}

      {pending.length > 0 && (
        <div data-testid="sync.pending-devices">
          <SectionLabel mt={12}>{t("sync.join.waitingTitle")}</SectionLabel>
          <Group>
            {pending.map((d, i) => (
              <Row key={d.device_id_hex} first={i === 0} testId="sync.pending-row">
                {/* The id-derived label, NEVER the names map (SYNC-40): a name
                    beside an unverified device reads as a trust signal while
                    nothing verifies it, which would weaken the SAS eye-compare
                    that is the actual defense. Desktop enforces the same rule
                    structurally in DeviceManagementPanel. */}
                <span style={rowLabel} data-testid="sync.pending-name">
                  {t("sync.devices.shortName", { hex: d.device_id_hex.slice(0, 6) })}
                </span>
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
                  {t("sync.devices.approve")}
                </button>
              </Row>
            ))}
          </Group>
        </div>
      )}

      <SectionLabel mt={12}>{t("sync.devices.yourDevices")}</SectionLabel>
      {renameFailed && (
        <p style={{ ...HELP, marginTop: 4, color: "var(--danger)" }} data-testid="sync.rename-error">
          {t("sync.devices.renameFailed")}
        </p>
      )}
      {devices === null ? (
        error ? null : <p style={{ ...HELP, marginTop: 4 }}>{t("sync.devices.loading")}</p>
      ) : approved.length === 0 ? (
        <p style={{ ...HELP, marginTop: 4 }}>{t("sync.settings.noDevices")}</p>
      ) : (
        <Group>
          {approved.map((d, i) => (
            <Row key={d.device_id_hex} first={i === 0} testId="sync.device-row">
              <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                {renaming?.id === d.device_id_hex ? (
                  <input
                    autoFocus
                    value={renaming.value}
                    maxLength={DEVICE_NAME_MAX_LEN}
                    aria-label={t("sync.devices.renameLabel")}
                    onChange={(e) => setRenaming({ id: d.device_id_hex, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenaming(null);
                      }
                    }}
                    onBlur={() => void commitRename()}
                    style={{
                      font: "inherit",
                      fontSize: 15,
                      color: "var(--fg-1)",
                      background: "var(--bg-1)",
                      border: "1px solid var(--line-1)",
                      borderRadius: 8,
                      padding: "4px 8px",
                      minWidth: 0,
                      width: "100%",
                    }}
                    data-testid="sync.device-name-input"
                  />
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    <span style={rowLabel} data-testid="sync.device-name">
                      {deviceName(d, names, t)}
                    </span>
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
                        {t("sync.devices.thisDevice")}
                      </span>
                    )}
                  </div>
                )}
                {/* The demoted device code — a permanent line, not a hover
                    affordance (mobile has no hover). It is what tells two
                    same-named devices apart. */}
                <span
                  style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}
                  data-testid="sync.device-code"
                >
                  {d.device_id_hex.slice(0, 6)}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {/* Rename is offered on EVERY approved row: devices enrolled
                    before names existed are named from whatever device the user
                    happens to be holding. */}
                <button
                  type="button"
                  disabled={busy || renaming !== null}
                  onClick={() => setRenaming({ id: d.device_id_hex, value: deviceName(d, names, t) })}
                  style={{
                    padding: "7px 12px",
                    border: "1px solid var(--line-1)",
                    borderRadius: 8,
                    background: "var(--bg-1)",
                    color: "var(--fg-1)",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: busy ? "not-allowed" : "pointer",
                  }}
                  data-testid="sync.rename-device"
                >
                  {t("sync.devices.rename")}
                </button>
              {d.is_current ? (
                <span style={{ fontSize: 13, color: "var(--fg-3)" }}>{t("sync.settings.syncingHere")}</span>
              ) : plane === "owner" ? (
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
                  {t("sync.devices.remove")}
                </button>
              ) : null}
              </div>
            </Row>
          ))}
        </Group>
      )}
    </div>
  );
}

/**
 * Members & Security (B2B, myne-md/myne#712 task 9). READ-ONLY on mobile: it
 * lists the shared vault's members with their authority and the current
 * group-key epoch, and states the removal limits honestly. The invite and
 * removal flows need the person-identity phrase prompt, which stays desktop-first
 * until the member wire lands, so this panel never renders an owner-only control
 * a phone cannot use. Copy comes from the shared `sync.memberRoster.*` catalog keys
 * through `useTranslation`. The "plain English, no i18n" note this comment used to
 * carry was already false when it was written. Styling goes through the shared
 * primitives + tokens, never inline literals.
 *
 * Each row's identity follows the desktop list's ONE RULE (myne-md/myne#851 task 15,
 * `src/components/sync/MemberRosterPanel.tsx`): the VERIFIED name where the signed
 * store holds one — the caller's OWN row included, with a "You" marker beside it so
 * the owner sees the same name the other members do — the short fingerprint
 * otherwise, and a marker when a record exists that no signature backs. An unnamed
 * self row keeps the badge in the name slot, there being no name to show.
 * Read-only here means no rename affordance, not a second rule: a member reads the
 * same three answers on a phone as on a computer, so "who is this" cannot depend on
 * which client happens to be open.
 */
export function SyncMembersPanel() {
  const { t } = useTranslation();
  const { members, authority, groupKeyEpoch, error } = useMembers();

  return (
    <div style={MEMBERS_WRAP}>
      <SectionLabel mt={0}>{t("sync.members.title")}</SectionLabel>
      <Group>
        <Row first testId="sync.members.authority">
          <span style={rowLabel}>{t("sync.members.access")}</span>
          <span style={MEMBERS_VALUE}>
            {authority === "owner"
              ? t("sync.memberRoster.ownerBadge")
              : t("sync.memberRoster.memberBadge")}
          </span>
        </Row>
        {groupKeyEpoch !== null ? (
          <Row testId="sync.members.epoch">
            <span style={rowLabel}>{t("sync.members.epochLabel")}</span>
            <span style={MEMBERS_VALUE}>{groupKeyEpoch}</span>
          </Row>
        ) : null}
      </Group>

      <SectionLabel>{t("sync.members.people")}</SectionLabel>
      <Group>
        {error ? (
          <Row first testId="sync.members.error">
            <span style={MEMBERS_ERROR}>{t("sync.memberRoster.error")}</span>
          </Row>
        ) : members.length === 0 ? (
          <Row first testId="sync.members.empty">
            <span style={MEMBERS_MUTED}>{t("sync.memberRoster.empty")}</span>
          </Row>
        ) : (
          members.map((m, i) => (
            <Row key={m.fingerprint_hex} first={i === 0} testId="sync.members.row">
              <div style={MEMBERS_STACK}>
                {/* The one rule, in the desktop list's arm ORDER: the caller's OWN
                    row first, which now renders its VERIFIED name like every other
                    row and adds a "You" marker beside it, so its owner sees what the
                    other members see. An unnamed self row keeps the badge in the name
                    slot — there is no name to show. Then a VERIFIED name, then the
                    fingerprint. `unverified` is a real third answer rather than a
                    missing one: a record exists and nothing backs it, which is what
                    the marker says, and the name it
                    claimed is never rendered. */}
                {m.is_self ? (
                  <>
                    <span data-testid="sync.members.name" style={MEMBERS_VALUE}>
                      {m.name_state === "verified"
                        ? m.display_name
                        : t("sync.memberRoster.youBadge")}
                    </span>
                    {m.name_state === "verified" ? (
                      <span data-testid="sync.members.you" style={MEMBERS_MUTED}>
                        {t("sync.memberRoster.youBadge")}
                      </span>
                    ) : null}
                  </>
                ) : m.name_state === "verified" ? (
                  <span data-testid="sync.members.name" style={MEMBERS_VALUE}>
                    {m.display_name}
                  </span>
                ) : (
                  <>
                    <span data-testid="sync.members.fingerprint" style={MEMBERS_FINGERPRINT}>
                      {m.fingerprint_hex.slice(0, 16)}
                    </span>
                    {m.name_state === "unverified" ? (
                      <span data-testid="sync.members.name-unverified" style={MEMBERS_WARNING}>
                        {t("sync.memberRoster.nameUnverified")}
                      </span>
                    ) : null}
                  </>
                )}
              </div>
              <div style={MEMBERS_STACK}>
                <span style={MEMBERS_MUTED}>
                  {m.role === "owner"
                    ? t("sync.memberRoster.ownerBadge")
                    : t("sync.memberRoster.memberBadge")}
                </span>
                {m.continuity === "changed" ? (
                  <span style={MEMBERS_ERROR}>{t("sync.memberRoster.keyChanged")}</span>
                ) : null}
                {m.continuity === "owner-confirmed" ? (
                  <span style={MEMBERS_MUTED}>{t("sync.memberRoster.relinkConfirmed")}</span>
                ) : null}
                {(m.continuity === "current" || m.continuity === null) &&
                m.previous_fingerprint_hex ? (
                  <span style={MEMBERS_MUTED}>{t("sync.memberRoster.rotated")}</span>
                ) : null}
              </div>
            </Row>
          ))
        )}
      </Group>

      <SectionLabel>{t("sync.members.removalLimitsLabel")}</SectionLabel>
      <p style={MEMBERS_NOTICE}>{t("sync.memberRoster.removalLimits")}</p>
    </div>
  );
}

const MEMBERS_WRAP: CSSProperties = {
  padding: "0 var(--space-4) var(--space-6)",
};

const MEMBERS_STACK: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
  minWidth: 0,
};

const MEMBERS_VALUE: CSSProperties = {
  color: "var(--fg-1)",
  fontSize: "var(--text-sm)",
};

const MEMBERS_MUTED: CSSProperties = {
  color: "var(--fg-2)",
  fontSize: "var(--text-sm)",
};

const MEMBERS_ERROR: CSSProperties = {
  color: "var(--danger)",
  fontSize: "var(--text-sm)",
};

// The unverified-name marker (`myne-md/myne#851` task 5). `--warning` rather than
// `--danger`: a name record whose signature does not check out is a fact to state
// plainly, not an alarm about a vault that is broken here and now. The desktop twin
// (`src/components/sync/MemberRosterPanel.tsx`'s `WARNING_STYLE`) states the same rule,
// so the two lists cannot drift again.
const MEMBERS_WARNING: CSSProperties = {
  color: "var(--warning)",
  fontSize: "var(--text-sm)",
};

const MEMBERS_FINGERPRINT: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-xs)",
  fontFamily: "var(--font-mono)",
};

const MEMBERS_NOTICE: CSSProperties = {
  color: "var(--fg-2)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  marginTop: "var(--space-2)",
};
