import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { CSSProperties, ReactNode } from "react";
import { Screen, FlowHeader, Title, Lead, FooterBar, Button, Banner, BlockingOverlay, Icon } from "../../components";
import { syncJoinAccount, syncResetLocal, errKind, syncDecodeJoinQr, scanQr, type JoinResult, type JoinQrView } from "../../lib/sync";
import { useHeadFingerprintCompare } from "../../hooks/useHeadFingerprintCompare";
import { DEVICE_NAME_MAX_LEN, useDeviceNameField } from "../../lib/device-name";
import { setDeviceName } from "../../lib/prefs";
import { formatAccountNumberInput } from "../../lib/account-number-format";
import { HAS_TAURI } from "../../lib/app-window";
import { ENROLL_NON_DISTINGUISHING_BANNER, ENROLL_PENDING_NOTICE } from "../../lib/load-bearing-copy";
import type { VaultId } from "../../lib/stage";
import type { JoinFlowProps } from "./types";

/**
 * JoinFlow — the wired "Connect to my account" flow, launched from the Welcome
 * screen (`onJoin`). A fresh device joins an existing account by proving ownership
 * with {server URL + account number + password}; `sync_join_account` fetches
 * `vault.meta` pre-auth, bootstraps + unlocks a NEW local vault, and SCRAM-enrolls
 * (password → pending). On success the device lands in the editor via
 * `welcome.join-success` (sync pulls the notes once an existing device approves).
 *
 * Password-only (the 24-word-phrase variant is the deferred F3-T5 follow-up).
 * The password is a secret: held in local state, mirrored to a wipe ref, and
 * cleared on every exit path + unmount (the load-bearing zeroize is Rust-side).
 * Honesty (SYNC-8): a wrong account#, a wrong password, and "no such account"
 * all collapse to the ONE non-distinguishing banner — only a transport fault is
 * distinguished (it leaks nothing about the account).
 */

// Crockford base32 omits I/L/O/U; the canonical account body is 20 chars. A
// presentation-only typo aid (the authoritative Damm-32 check is server-side).
const CROCKFORD_BODY = /^[0-9A-HJKMNP-TV-Z]{20}$/;
function accountStructurallyPlausible(display: string): boolean {
  const body = display.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^MY/, "");
  if (body.length < 20) return true; // still typing — no premature complaint
  return CROCKFORD_BODY.test(body);
}

/** Map a non-secret `SyncDeviceError` kind to honest copy. Only a transport
 *  fault gets a distinct (non-leaking) line; every account/password/existence
 *  failure collapses to the single non-distinguishing banner. */
function joinFailureMessage(kind: string, t: TFunction): string {
  if (kind === "TlsFailure") return t("sync.endpoint.tlsFailure");
  if (kind === "Transport" || kind === "NotConfigured") {
    return t("join.transportError");
  }
  return ENROLL_NON_DISTINGUISHING_BANNER;
}

const inputReset: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: "none",
  background: "transparent",
  outline: "none",
  padding: 0,
};

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

/** A read-only labelled value row on the QR confirm screen (MYND-466). */
function ConfirmRow({
  label,
  value,
  testId,
  breakAll,
}: {
  label: string;
  value: string;
  testId: string;
  breakAll?: boolean;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div
        style={{
          marginTop: 6,
          fontFamily: "var(--font-mono)",
          fontSize: 14,
          color: "var(--fg-1)",
          wordBreak: breakAll ? "break-all" : undefined,
        }}
        data-testid={testId}
      >
        {value}
      </div>
    </div>
  );
}

/** Mono editable field (server URL + account number) — accent border on focus. */
function MonoField({
  value,
  onChange,
  placeholder,
  autoCapitalize = "off",
  inputMode,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  autoCapitalize?: "off" | "characters";
  inputMode?: "url";
  testId: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 52,
        border: `1.5px solid ${focused ? "var(--accent)" : "var(--line-2)"}`,
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
      }}
    >
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        autoCapitalize={autoCapitalize}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode={inputMode}
        data-testid={testId}
        style={{ ...inputReset, fontFamily: "var(--font-mono)", fontSize: 15, letterSpacing: "0.02em", color: "var(--fg-1)" }}
      />
    </div>
  );
}

/** Masked password field with a reveal eye (mirrors RecoverFlow's). */
function PasswordField({ value, onChange, onEnter, testId }: { value: string; onChange: (v: string) => void; onEnter: () => void; testId: string }) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 52,
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
        border: `${focused ? 1.5 : 1}px solid ${focused ? "var(--accent)" : "var(--line-2)"}`,
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
      }}
    >
      <input
        type={revealed ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter();
        }}
        placeholder={t("join.passwordPlaceholder")}
        autoCapitalize="none"
        autoComplete="current-password"
        spellCheck={false}
        data-testid={testId}
        style={{
          ...inputReset,
          fontFamily: "var(--font-mono)",
          fontSize: revealed ? 16 : 14,
          letterSpacing: revealed ? "0" : "0.14em",
          color: "var(--fg-1)",
        }}
      />
      <button
        type="button"
        onClick={() => setRevealed((r) => !r)}
        aria-label={revealed ? t("password.input.hide") : t("password.input.show")}
        style={{ border: "none", background: "transparent", padding: 0, marginInlineStart: 6, cursor: "pointer", display: "flex" }}
      >
        <Icon name={revealed ? "eye-off" : "eye"} size={20} color="var(--fg-3)" strokeWidth={1.6} />
      </button>
    </div>
  );
}

/**
 * Persist the enrollment device name, retrying the transient window right after
 * a head is adopted (MYND-548). Returns whether it landed.
 *
 * Three attempts over ~1.5s: enough to outlast the prefs write that adopting a
 * head performs. Failures are deliberately not distinguished — the setter's
 * error surface is coarse and the caller's only recourse is the same either way.
 *
 * Deliberately NOT cancellable, and it touches no React state. The caller starts
 * it and stops waiting (MYND-537: nothing may sit in front of the match code),
 * which means it outlives the polling effect that started it — correct, because
 * a name the user typed should still land after the screen it was typed on has
 * moved on. There is no unmount hazard to guard: the only effect is the write.
 */
async function persistDeviceNameWithRetry(
  deviceIdHex: string,
  name: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await setDeviceName(deviceIdHex, name);
      return true;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

export function JoinFlow({ onComplete, onCancel }: JoinFlowProps) {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "form" collects the credentials; "pending" waits for an existing device to
  // approve; "verify" shows the head-fingerprint SAS for the mandatory eye-compare.
  const [step, setStep] = useState<"form" | "confirm" | "pending" | "verify">("form");
  const [joinedVaultId, setJoinedVaultId] = useState<VaultId | undefined>(undefined);
  const [aborting, setAborting] = useState(false);
  /** The un-enrol failed — the device is STILL enrolled, and the screen must
   *  say so instead of closing (docs/decisions/ui/0482). */
  const [abortFailed, setAbortFailed] = useState(false);
  // Device-join via QR (MYND-466): the decoded QR held for the confirm step.
  const [scanned, setScanned] = useState<JoinQrView | null>(null);

  // MYND-548: this device's own name — the same hook the Settings enrollment panel
  // uses, so the two doors cannot drift.
  const deviceNameField = useDeviceNameField();
  // MYND-548: the id this join minted, kept so the poll below can name the device
  // once its first pull lands (never before — see the enroll hook's note).
  const joinedDeviceId = useRef<string | null>(null);

  // Secret-wipe artefact — mirrors the in-flight password so unmount can drop it.
  const pwRef = useRef("");
  const demoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    pwRef.current = password;
  });
  useEffect(() => {
    return () => {
      pwRef.current = "";
      if (demoTimer.current !== null) clearTimeout(demoTimer.current);
    };
  }, []);

  const canSubmit = serverUrl.trim() !== "" && accountNumber.trim() !== "" && password !== "" && !busy;

  function landOn(result: JoinResult) {
    const vaultId = result.vault_id as VaultId;
    pwRef.current = "";
    setPassword("");
    setJoinedVaultId(vaultId);
    if (result.pending) {
      // Password join → wait for approval, then the mandatory fingerprint verify.
      setStep("pending");
    } else {
      // Bootstrap/recovery self-approve (first device) → nothing to eye-compare
      // against, so go straight in.
      onComplete(vaultId);
    }
  }

  async function onSubmit() {
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    if (!HAS_TAURI) {
      // Browser dev — no IPC. Simulate a pending join after a beat so the flow is
      // demoable without a backend (and flow-logic testable via the mock).
      demoTimer.current = setTimeout(() => {
        setBusy(false);
        landOn({
          vault_id: "demo-vault",
          pending: true,
          fingerprint: null,
          device_id_hex: "00".repeat(16),
        });
      }, 700);
      return;
    }
    try {
      const result = await syncJoinAccount(serverUrl.trim(), accountNumber.trim(), password);
      joinedDeviceId.current = result.device_id_hex;
      setBusy(false);
      landOn(result);
    } catch (e) {
      setBusy(false);
      setError(joinFailureMessage(errKind(e), t));
    }
  }

  function onBack() {
    pwRef.current = "";
    setPassword("");
    onCancel();
  }

  // ── Device-join via QR (MYND-466) ──────────────────────────────────────────
  function qrErrorMessage(kind: string): string {
    switch (kind) {
      case "NotAQrJoinPayload":
        return t("join.qr.invalid");
      case "UnsupportedVersion":
        return t("join.qr.newerVersion");
      default:
        return t("join.qr.scanFailed");
    }
  }

  // Open the camera, decode the QR, and route to the confirm step. The QR fills the
  // server + account number; the user still types only their password (SYNC-47).
  async function onScan() {
    setError(null);
    if (!HAS_TAURI) return;
    setBusy(true);
    try {
      const res = await scanQr();
      if (!res.value) return; // scanner dismissed
      const view = await syncDecodeJoinQr(res.value);
      if (!view.fresh) {
        setError(t("join.qr.expired"));
        return;
      }
      setScanned(view);
      setStep("confirm");
    } catch (e) {
      const kind = errKind(e);
      setError(kind === "Unsupported" ? t("join.qr.scanUnavailable") : qrErrorMessage(kind));
    } finally {
      setBusy(false);
    }
  }

  // Confirm → prefill the form from the scanned QR; the user then enters only their
  // password. Endpoint cert trust rests on public CA roots + the ZK backstop (the
  // pin-source label surfaces which path); strict cert-pin-match at join is a
  // documented follow-up (thread the expected pin through sync_join_account).
  function onConfirmContinue() {
    if (scanned) {
      setServerUrl(scanned.endpoint_url);
      setAccountNumber(formatAccountNumberInput(scanned.account_number));
    }
    setStep("form");
  }

  // The adopted-head watch and the SYNC-40 compare, through the shared hook
  // (myne#462). Twin of `src/hooks/useHeadFingerprintCompare.ts` — registered in
  // `scripts/check-twin-drift.mjs`, because this side drifting away from that one
  // is precisely how the approving screen in `SyncSettingsPanels` kept a
  // pre-#243 shape for months.
  //
  // Armed from `pending`, not from `verify`: the device-name write below fires
  // the instant a head is adopted, before the compare screen exists, and
  // `device_names` lives in `vault.prefs`, so pushing it authors a head. The
  // hold catches the PUSH, never the write — `persistDeviceNameWithRetry` still
  // runs and still retries, so MYND-548 stays fixed.
  const { fingerprint, changed: sasChanged } = useHeadFingerprintCompare(
    (step === "pending" || step === "verify") && HAS_TAURI,
    "joiner",
  );

  // The pending → verify edge. A non-null fingerprint means this device pulled
  // and MAC-verified a head — which is also the point at which naming is safe,
  // because the §10.2.1 prefs seed has had its turn. `named` keeps the write to
  // once, since the poll now keeps running behind the compare.
  const named = useRef(false);
  useEffect(() => {
    if (step !== "pending" || fingerprint === null) return;
    if (joinedDeviceId.current && !named.current) {
      named.current = true;
      // NOT awaited, and it deliberately outlives this effect — see
      // `persistDeviceNameWithRetry`. Three attempts across ~1.5s in front of
      // `setStep` would put a delay back on the very screen MYND-537 removed one
      // from.
      void persistDeviceNameWithRetry(joinedDeviceId.current, deviceNameField.resolved);
    }
    setStep("verify");
  }, [step, fingerprint, deviceNameField.resolved]);

  // SAS mismatch → ABORT the join: un-enroll this device so it stops trusting the
  // (possibly forked) synced data, then back out.
  //
  // **Closing this screen IS the claim that it worked**, which is why the
  // failure cannot be swallowed. This used to `catch { /* best-effort */ }` and
  // call `onCancel()` unconditionally: if `sync_reset_local` failed, the device
  // stayed enrolled against the endpoint the user had just decided not to
  // trust, looking at a UI that had told them they backed out. A mismatch is the
  // one moment where "we could not tell you" and "it is fine" must not look the
  // same.
  //
  // `docs/decisions/ui/0482` fixed exactly this on the two desktop surfaces on
  // 2026-08-12 and recorded why mobile was left out — "companion repos are never
  // changed through this one". The mobile client moved in-repo on 2026-08-13, so
  // that reason is gone; this closes the other half, reusing 0482's own key
  // rather than inventing a second sentence for the same fact.
  async function onMismatch() {
    setAborting(true);
    setAbortFailed(false);
    try {
      if (HAS_TAURI) await syncResetLocal();
    } catch {
      setAborting(false);
      setAbortFailed(true);
      return; // stay on the compare screen — the device is still enrolled
    }
    onCancel();
  }

  // ── Confirm the scanned QR before the password (MYND-466, grill Q7) ──────────
  if (step === "confirm" && scanned) {
    return (
      <Screen>
        <FlowHeader label={t("join.qr.confirmTitle")} onBack={() => setStep("form")} />
        <div style={{ flex: 1, padding: "18px 22px 0", overflowY: "auto" }} data-testid="sync.join.qr-confirm">
          <Title>{t("join.qr.confirmTitle")}</Title>
          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 16 }}>
            <ConfirmRow
              label={t("join.qr.confirmServer")}
              value={scanned.endpoint_url}
              testId="sync.join.qr-confirm.server"
              breakAll
            />
            <ConfirmRow
              label={t("join.qr.confirmAccount")}
              value={formatAccountNumberInput(scanned.account_number)}
              testId="sync.join.qr-confirm.account"
            />
          </div>
        </div>
        <FooterBar style={{ padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "none" }}>
          <Button onClick={onConfirmContinue} data-testid="sync.join.qr-confirm.continue">
            {t("join.qr.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── Pending-approval screen: auto-polls for approval, then advances to verify ──
  if (step === "pending") {
    return (
      <Screen style={{ alignItems: "center", justifyContent: "center", padding: "0 32px" }}>
        <div data-testid="sync.join.pending" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none" style={{ marginBottom: 22, animation: "myne-spinner-rotate 2.4s linear infinite" }}>
            <circle cx="28" cy="28" r="24" stroke="var(--line-1)" strokeWidth="2" />
            <path d="M28 4a24 24 0 0 1 24 24" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
          <Title>{t("sync.join.waitingTitle")}</Title>
          <div style={{ marginTop: 12, fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 320 }}>
            {ENROLL_PENDING_NOTICE}
          </div>
          <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)", maxWidth: 320 }}>
            {t("join.waitingHint")}
          </div>
        </div>
        <FooterBar style={{ padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "none" }}>
          <Button variant="ghost" onClick={onBack} data-testid="sync.join.cancel">
            {t("common.prompt.cancel")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── Verify screen (SYNC-40): mandatory head-fingerprint eye-compare ───────────
  if (step === "verify") {
    return (
      <Screen style={{ alignItems: "center", justifyContent: "center", padding: "0 32px" }}>
        <div data-testid="sync.join.verify" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <Title>{t("sync.join.verifyTitle")}</Title>
          <div style={{ marginTop: 12, fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 320 }}>
            {t("join.verifyBody")}
          </div>
          <div
            style={{
              marginTop: 24,
              fontFamily: "var(--font-mono)",
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: "0.16em",
              color: "var(--fg-1)",
              padding: "18px 26px",
              background: "var(--paper-2)",
              border: "1px solid var(--line-1)",
              borderRadius: 12,
            }}
            data-testid="sync.join.sas-fingerprint"
          >
            {fingerprint}
          </div>
          {/* The head moved while the compare was open. Announced, not swapped
              silently: a code that changes under the reader is a guess, not a
              comparison. */}
          {sasChanged && (
            <div
              style={{ marginTop: "var(--space-4)", fontSize: "var(--text-sm)", lineHeight: "var(--leading-relaxed)", color: "var(--fg-2)", maxWidth: 320 }}
              data-testid="sync.join.sas-changed"
            >
              {t("join.verifyChanged")}
            </div>
          )}
          {abortFailed && (
            <div style={{ marginTop: "var(--space-4)", maxWidth: 320 }} data-testid="sync.join.sas-abort-failed">
              <Banner kind="danger">{t("sync.join.sasAbortFailed")}</Banner>
            </div>
          )}
        </div>
        <FooterBar style={{ padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "none", flexDirection: "column", gap: 10 }}>
          <Button disabled={aborting} onClick={() => onComplete(joinedVaultId)} data-testid="sync.join.sas-match">
            {t("sync.join.sasMatch")}
          </Button>
          <Button
            variant="ghost"
            disabled={aborting}
            onClick={() => void onMismatch()}
            style={{ color: "var(--danger)" }}
            data-testid="sync.join.sas-mismatch"
          >
            {aborting ? t("join.removing") : t("join.sasMismatch")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── Credential form ──────────────────────────────────────────────────────────
  const accountHint = !accountStructurallyPlausible(accountNumber);
  return (
    <Screen>
      <FlowHeader label={t("join.title")} onBack={onBack} />
      <div style={{ flex: 1, padding: "18px 22px 0", overflowY: "auto" }} data-testid="sync.join">
        <Title>{t("join.title")}</Title>
        <Lead>{t("join.lead")}</Lead>

        <button
          type="button"
          onClick={() => void onScan()}
          disabled={busy}
          data-testid="sync.join.scan-qr"
          style={{
            marginTop: 16,
            width: "100%",
            padding: 12,
            fontSize: 15,
            fontWeight: 600,
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 10,
            color: "var(--fg-1)",
            cursor: busy ? "default" : "pointer",
          }}
        >
          {t("join.qr.scan")}
        </button>

        <div style={{ marginTop: 22 }}>
          <FieldLabel>{t("sync.join.serverLabel")}</FieldLabel>
          <MonoField
            value={serverUrl}
            onChange={(v) => {
              setError(null);
              setServerUrl(v);
            }}
            placeholder={t("join.serverPlaceholder")}
            inputMode="url"
            testId="sync.join.server-input"
          />
        </div>

        <div style={{ marginTop: 18 }}>
          <FieldLabel>{t("sync.join.accountLabel")}</FieldLabel>
          <MonoField
            value={accountNumber}
            onChange={(v) => {
              setError(null);
              setAccountNumber(formatAccountNumberInput(v));
            }}
            placeholder="MY-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoCapitalize="characters"
            testId="sync.join.account-input"
          />
          {accountHint && (
            <div style={{ marginTop: 8, fontSize: 13, color: "var(--warning)" }} data-testid="sync.join.account-hint">
              {t("join.accountHint")}
            </div>
          )}
        </div>

        {/* MYND-548: named at the one moment the user is provably holding this
            device. Applied only once this device completes a pull — never at
            join time, which would disable the §10.2.1 seed. */}
        <div style={{ marginTop: 18 }}>
          <FieldLabel>{t("sync.enroll.deviceNameLabel")}</FieldLabel>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              height: 52,
              border: "1.5px solid var(--line-2)",
              borderRadius: 6,
              background: "var(--bg-1)",
              padding: "0 14px",
            }}
          >
            <input
              value={deviceNameField.value}
              onChange={(e) => deviceNameField.setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onSubmit();
              }}
              maxLength={DEVICE_NAME_MAX_LEN}
              placeholder={deviceNameField.suggestion}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              data-testid="sync.join.device-name-input"
              style={{ ...inputReset, fontSize: 16, color: "var(--fg-1)" }}
            />
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <FieldLabel>{t("sync.join.passwordLabel")}</FieldLabel>
          <PasswordField
            value={password}
            onChange={(v) => {
              setError(null);
              setPassword(v);
            }}
            onEnter={() => void onSubmit()}
            testId="sync.join.password-input"
          />
        </div>

        {error && (
          <div style={{ marginTop: 14 }} data-testid="sync.join.error">
            <Banner kind="danger">{error}</Banner>
          </div>
        )}

        <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
          {t("join.approvalHint")}
        </div>
      </div>
      <FooterBar style={{ padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "none" }}>
        <Button disabled={!canSubmit} onClick={() => void onSubmit()} data-testid="sync.join.submit">
          {t("sync.endpoint.connect")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("sync.endpoint.connecting")} subtitle={t("join.connectingSubtitle")} />}
    </Screen>
  );
}
