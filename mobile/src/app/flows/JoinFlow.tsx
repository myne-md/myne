import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Screen, FlowHeader, Title, Lead, FooterBar, Button, Banner, BlockingOverlay, Icon } from "../../components";
import { syncJoinAccount, syncNow, syncHeadFingerprint, syncResetLocal, errKind, type JoinResult } from "../../lib/sync";
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
function joinFailureMessage(kind: string): string {
  if (kind === "Transport" || kind === "NotConfigured") {
    return "Couldn't reach that sync server. Check the address and your connection, then try again.";
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
        placeholder="Your vault password"
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
        aria-label={revealed ? "Hide password" : "Show password"}
        style={{ border: "none", background: "transparent", padding: 0, marginLeft: 6, cursor: "pointer", display: "flex" }}
      >
        <Icon name={revealed ? "eye-off" : "eye"} size={20} color="var(--fg-3)" strokeWidth={1.6} />
      </button>
    </div>
  );
}

export function JoinFlow({ onComplete, onCancel }: JoinFlowProps) {
  const [serverUrl, setServerUrl] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "form" collects the credentials; "pending" waits for an existing device to
  // approve; "verify" shows the head-fingerprint SAS for the mandatory eye-compare.
  const [step, setStep] = useState<"form" | "pending" | "verify">("form");
  const [joinedVaultId, setJoinedVaultId] = useState<VaultId | undefined>(undefined);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);

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
        landOn({ vault_id: "demo-vault", pending: true, fingerprint: null });
      }, 700);
      return;
    }
    try {
      const result = await syncJoinAccount(serverUrl.trim(), accountNumber.trim(), password);
      setBusy(false);
      landOn(result);
    } catch (e) {
      setBusy(false);
      setError(joinFailureMessage(errKind(e)));
    }
  }

  function onBack() {
    pwRef.current = "";
    setPassword("");
    onCancel();
  }

  // While PENDING, drive the claim + watch for the adopted-head fingerprint. The
  // foreground loop claims the token + pulls once an existing device approves;
  // `sync_head_fingerprint` returns non-null only after that first sync. Poll it
  // (cheap local read) + nudge a `sync_now` each tick so approval is picked up
  // promptly → then advance to the mandatory verify step (SYNC-40).
  useEffect(() => {
    if (step !== "pending" || !HAS_TAURI) return;
    let cancelled = false;
    const tick = async () => {
      try {
        await syncNow(); // claim + sync if approved (no-op while still pending)
        const fp = await syncHeadFingerprint();
        if (!cancelled && fp) {
          setFingerprint(fp);
          setStep("verify");
        }
      } catch {
        /* transient — retry next tick */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [step]);

  // SAS mismatch → ABORT the join: un-enroll this device so it stops trusting the
  // (possibly forked) synced data, then back out.
  async function onMismatch() {
    setAborting(true);
    try {
      if (HAS_TAURI) await syncResetLocal();
    } catch {
      /* best-effort */
    }
    onCancel();
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
          <Title>Waiting for approval</Title>
          <div style={{ marginTop: 12, fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 320 }}>
            {ENROLL_PENDING_NOTICE}
          </div>
          <div style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)", maxWidth: 320 }}>
            Keep this screen open — once approved, a verification code appears here to compare with your other device.
          </div>
        </div>
        <FooterBar style={{ padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "none" }}>
          <Button variant="ghost" onClick={onBack} data-testid="sync.join.cancel">
            Cancel
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
          <Title>Verify this device</Title>
          <div style={{ marginTop: 12, fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 320 }}>
            Check that this code is the same one shown on the device you approved from.
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
        </div>
        <FooterBar style={{ padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "none", flexDirection: "column", gap: 10 }}>
          <Button disabled={aborting} onClick={() => onComplete(joinedVaultId)} data-testid="sync.join.sas-match">
            They match — continue
          </Button>
          <Button
            variant="ghost"
            disabled={aborting}
            onClick={() => void onMismatch()}
            style={{ color: "var(--danger)" }}
            data-testid="sync.join.sas-mismatch"
          >
            {aborting ? "Removing…" : "They don't match — remove this device"}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── Credential form ──────────────────────────────────────────────────────────
  const accountHint = !accountStructurallyPlausible(accountNumber);
  return (
    <Screen>
      <FlowHeader label="Connect to your account" onBack={onBack} />
      <div style={{ flex: 1, padding: "18px 22px 0", overflowY: "auto" }} data-testid="sync.join">
        <Title>Connect to your account</Title>
        <Lead>Enter your account details to bring your notes to this device. Everything stays encrypted end to end.</Lead>

        <div style={{ marginTop: 22 }}>
          <FieldLabel>Sync server</FieldLabel>
          <MonoField
            value={serverUrl}
            onChange={(v) => {
              setError(null);
              setServerUrl(v);
            }}
            placeholder="https://sync.example.com"
            inputMode="url"
            testId="sync.join.server-input"
          />
        </div>

        <div style={{ marginTop: 18 }}>
          <FieldLabel>Account number</FieldLabel>
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
              Double-check this number — it doesn't look right.
            </div>
          )}
        </div>

        <div style={{ marginTop: 18 }}>
          <FieldLabel>Password</FieldLabel>
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
          Your notes appear once you approve this device from a device that already has your account.
        </div>
      </div>
      <FooterBar style={{ padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "none" }}>
        <Button disabled={!canSubmit} onClick={() => void onSubmit()} data-testid="sync.join.submit">
          Connect
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title="Connecting…" subtitle="Fetching your account and unlocking your vault on this device." />}
    </Screen>
  );
}
