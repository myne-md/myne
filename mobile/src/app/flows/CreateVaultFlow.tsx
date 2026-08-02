import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CSSProperties, ReactNode } from "react";
import {
  Screen,
  ScreenScroll,
  FlowHeader,
  Title,
  Lead,
  FooterBar,
  Button,
  StrengthMeter,
  RecoveryGrid,
  AccountNumber,
  Checkbox,
  Icon,
  MyneMark,
  Banner,
  BlockingOverlay,
} from "../../components";
import {
  beginVaultCreation,
  commitVaultCreation,
  cancelVaultCreation,
  unlockWithPassword,
} from "../../lib/commands";
import { HAS_TAURI } from "../../lib/app-window";
import { seedWelcomeNote } from "../../lib/welcomeNote";
import { LOST_BOTH_SECRETS_SENTENCE } from "../../lib/load-bearing-copy";
import { saveSecretToDocuments } from "../../lib/secret-export";
import type { CreateVaultFlowProps } from "./types";

// Browser-dev placeholders (no Tauri host → no IPC). Let the multi-step flow
// stay fully navigable under `pnpm dev`; the real backend runs `pnpm tauri dev`.
const PLACEHOLDER_PHRASE = [
  "ribbon", "kernel", "voyage", "marble", "harvest", "cobalt",
  "thistle", "quarry", "lantern", "pebble", "summit", "cedar",
  "anchor", "bishop", "candle", "dolphin", "ember", "falcon",
  "gravel", "hazel", "indigo", "jasmine", "kettle", "willow",
];
const PLACEHOLDER_ACCOUNT = "MY-4F2A-9C17-8E2D-1B5F-K";
const PLACEHOLDER_SESSION = "dev-session-token";
const PLACEHOLDER_VAULT_ID = "dev-vault";

type Step =
  | "briefing"
  | "password"
  | "encrypting"
  | "phrase"
  | "typeback"
  | "account"
  | "committing"
  | "ready"
  | "unlocking";

type StrengthLevel = "Weak" | "Fair" | "Good" | "Strong";

function strengthLevel(pw: string): StrengthLevel {
  if (pw.length >= 12) return "Strong";
  if (pw.length >= 10) return "Good";
  if (pw.length >= 8) return "Fair";
  return "Weak";
}

/** Read the `.kind` discriminant off a rejected invoke into a copy KEY (resolved
 *  with `t()` at the render site — never at module top level). */
function beginErrorMessage(e: unknown): string {
  const kind = (e as { kind?: string } | null)?.kind;
  if (kind === "WeakNewPassword") return "createVault.beginWeakPassword";
  return "createVault.beginGeneric";
}

/** Four distinct random word positions (0-based) to confirm by type-back. */
function pickChallenge(): number[] {
  const set = new Set<number>();
  while (set.size < 4) set.add(Math.floor(Math.random() * 24));
  return [...set].sort((a, b) => a - b);
}

// ── Shared bordered input shell (mirrors the design Field / PasswordField) ─────
function FieldShell({
  focused,
  error = false,
  height = 52,
  children,
  style,
}: {
  focused: boolean;
  error?: boolean;
  height?: number;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const borderColor = error ? "var(--danger)" : focused ? "var(--accent)" : "var(--line-2)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height,
        border: `${focused || error ? 1.5 : 1}px solid ${borderColor}`,
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── Editable password row (masked monospace + reveal eye) ─────────────────────
function PasswordRow({
  value,
  onChange,
  revealed,
  onToggleReveal,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  revealed: boolean;
  onToggleReveal: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  return (
    <FieldShell focused={focused}>
      <input
        type={revealed ? "text" : "password"}
        value={value}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          fontFamily: "var(--font-mono)",
          fontSize: revealed ? 16 : 14,
          letterSpacing: revealed ? "0" : "0.14em",
          color: "var(--fg-1)",
        }}
      />
      <button
        type="button"
        onClick={onToggleReveal}
        aria-label={revealed ? t("password.input.hide") : t("password.input.show")}
        style={{ border: "none", background: "transparent", padding: 0, marginInlineStart: 8, cursor: "pointer", display: "flex" }}
      >
        <Icon name={revealed ? "eye-off" : "eye"} size={20} color="var(--fg-3)" strokeWidth={1.6} />
      </button>
    </FieldShell>
  );
}

// ── Editable confirm row (masked, check when it matches) ──────────────────────
function ConfirmRow({
  value,
  onChange,
  match,
}: {
  value: string;
  onChange: (v: string) => void;
  match: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <FieldShell focused={focused}>
      <input
        type="password"
        value={value}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          fontFamily: "var(--font-mono)",
          fontSize: 14,
          letterSpacing: "0.14em",
          color: "var(--fg-1)",
        }}
      />
      {match && <Icon name="check" size={14} color="var(--success)" strokeWidth={2} />}
    </FieldShell>
  );
}

// ── Editable type-back word field ─────────────────────────────────────────────
function WordEntry({
  position,
  value,
  onChange,
  error,
}: {
  position: number;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)", marginBottom: 6 }}>
        {t("createVault.wordNumber", { position })}
      </div>
      <FieldShell focused={focused} error={!!error} height={50}>
        <input
          value={value}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            fontFamily: "var(--font-mono)",
            fontSize: 16,
            fontWeight: 500,
            color: "var(--fg-1)",
          }}
        />
      </FieldShell>
      {error && (
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, color: "var(--danger)", fontSize: 13 }}>
          <Icon name="info" size={14} color="var(--danger)" strokeWidth={1.4} />
          {error}
        </div>
      )}
    </div>
  );
}

// ── Briefing acknowledgement row (interactive CheckRow) ───────────────────────
function AckRow({
  checked,
  onToggle,
  children,
  why,
  whyOpen,
  onToggleWhy,
  last,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
  why?: ReactNode;
  whyOpen?: boolean;
  onToggleWhy?: () => void;
  last?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: "14px 0",
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={checked}
        style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", flex: "none" }}
      >
        <Checkbox checked={checked} />
      </button>
      <div style={{ flex: 1 }}>
        <div
          onClick={onToggle}
          style={{ fontSize: 15, lineHeight: 1.45, color: "var(--fg-1)", cursor: "pointer" }}
        >
          {children}
        </div>
        {why && (
          <>
            <button
              type="button"
              onClick={onToggleWhy}
              style={{
                marginTop: 8,
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                color: "var(--accent)",
                fontSize: 13,
                fontWeight: 500,
                border: "none",
                background: "transparent",
                padding: 0,
                cursor: "pointer",
              }}
            >
              {t("vaultCreation.briefing.why")}
              <Icon name={whyOpen ? "chevron-up" : "chevron-down"} size={11} color="var(--accent)" strokeWidth={1.6} />
            </button>
            {whyOpen && (
              <div
                style={{
                  marginTop: 8,
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-1)",
                  borderRadius: 6,
                  padding: "10px 12px",
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: "var(--fg-2)",
                }}
              >
                {why}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// Small uppercase field label (mirrors the static FieldLabel).
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

/** Wordmark: mark + "myne" (ready screen). */
function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <MyneMark size={size} radius={6} />
      <span style={{ fontSize: 21, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>myne</span>
    </div>
  );
}

/**
 * Vault creation — the wired multi-step counterpart of the static onboarding
 * screens (OB-01…OB-06). Secrets (password, 24-word phrase) live in refs and
 * are wiped on every exit + on unmount; an uncommitted session is best-effort
 * cancelled on unmount.
 */
export function CreateVaultFlow({
  briefing,
  onCancel,
  onCommitSuccess,
  onAutoUnlockSuccess,
  onAutoUnlockFailed,
}: CreateVaultFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(briefing ? "briefing" : "password");

  // OB-01 acknowledgements
  const [acks, setAcks] = useState<boolean[]>([false, false, false]);
  const [why2Open, setWhy2Open] = useState(false);
  const [why3Open, setWhy3Open] = useState(false);

  // OB-02 password (authoritative secret in pwdRef; `pwd` mirrors for render).
  const pwdRef = useRef("");
  const [pwd, setPwd] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reveal, setReveal] = useState(false);
  const [beginError, setBeginError] = useState<string | null>(null);

  // Session-derived material.
  const phraseRef = useRef<string[]>([]);
  const sessionRef = useRef<string | null>(null);
  const vaultIdRef = useRef<string | null>(null);
  const committedRef = useRef(false);
  const startedRef = useRef(false);
  const [account, setAccount] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);

  // OB phrase reveal
  const [showSecondHalf, setShowSecondHalf] = useState(false);

  // OB-04 type-back
  const [challenge, setChallenge] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(["", "", "", ""]);

  // OB-05 account
  const [saved, setSaved] = useState(false);
  // Feedback for the "Save to file" (recovery phrase / account number) actions.
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const wipeSecrets = () => {
    pwdRef.current = "";
    phraseRef.current = [];
  };

  // Unmount: wipe secrets + best-effort cancel an uncommitted session.
  useEffect(() => {
    return () => {
      wipeSecrets();
      if (HAS_TAURI && sessionRef.current && !committedRef.current) {
        void cancelVaultCreation(sessionRef.current).catch(() => {});
      }
    };
  }, []);

  // OB-03 encrypting: derive keys + mint phrase/account on first entry.
  useEffect(() => {
    if (step !== "encrypting" || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        if (HAS_TAURI) {
          const res = await beginVaultCreation(pwdRef.current);
          if (cancelled) return;
          phraseRef.current = res.phrase;
          sessionRef.current = res.session_token;
          setAccount(res.account_number);
        } else {
          phraseRef.current = [...PLACEHOLDER_PHRASE];
          sessionRef.current = PLACEHOLDER_SESSION;
          setAccount(PLACEHOLDER_ACCOUNT);
        }
        if (cancelled) return;
        setStep("phrase");
      } catch (e) {
        if (cancelled) return;
        startedRef.current = false; // allow a retry from the password step
        setBeginError(beginErrorMessage(e));
        setStep("password");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Copy auto-reset.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const setPassword = (v: string) => {
    pwdRef.current = v;
    setPwd(v);
  };

  const strength = strengthLevel(pwd);
  const passwordValid = pwd.length >= 8 && pwd === confirm;
  const confirmMatch = confirm.length > 0 && pwd === confirm;

  const norms = answers.map((a) => a.trim().toLowerCase());
  const corrects = challenge.map((idx, i) => norms[i].length > 0 && norms[i] === (phraseRef.current[idx] ?? ""));
  const allCorrect = challenge.length === 4 && corrects.every(Boolean);

  // ── Handlers ────────────────────────────────────────────────────────────────
  const startTypeBack = () => {
    setChallenge(pickChallenge());
    setAnswers(["", "", "", ""]);
    setStep("typeback");
  };

  const commit = async () => {
    setCommitError(null);
    setStep("committing");
    try {
      if (HAS_TAURI) {
        vaultIdRef.current = await commitVaultCreation(sessionRef.current ?? "");
      } else {
        vaultIdRef.current = PLACEHOLDER_VAULT_ID;
      }
      committedRef.current = true;
      setStep("ready");
    } catch {
      setCommitError(t("createVault.commitError"));
      setStep("account");
    }
  };

  const openVault = async () => {
    setStep("unlocking");
    const id = vaultIdRef.current ?? undefined;
    try {
      if (HAS_TAURI) await unlockWithPassword(pwdRef.current, id);
      wipeSecrets();
      // MYND-118 mobile mirror — seed the onboarding Welcome note now the
      // new vault is unlocked (note_create requires an unlocked slot).
      // Best-effort: seedWelcomeNote never throws, so a failure here can't
      // bounce a successfully-unlocked user to the unlock-failed path.
      if (HAS_TAURI) await seedWelcomeNote();
      onAutoUnlockSuccess(id);
    } catch {
      wipeSecrets();
      onAutoUnlockFailed(id);
    }
  };

  const backUpNow = () => {
    const id = vaultIdRef.current ?? undefined;
    wipeSecrets();
    onCommitSuccess(id);
  };

  const copyAccount = () => {
    void navigator.clipboard?.writeText(account).catch(() => {});
    setCopied(true);
  };

  const saveAccountFile = () => {
    void (async () => {
      const label = await saveSecretToDocuments("myne-account-number.txt", account);
      setFileMsg(label ? t("createVault.savedToFile", { label }) : t("createVault.saveFileError"));
    })();
  };

  const savePhraseFile = () => {
    void (async () => {
      const label = await saveSecretToDocuments("myne-recovery-phrase.txt", phraseRef.current.join(" "));
      setFileMsg(label ? t("createVault.savedToFile", { label }) : t("createVault.saveFileError"));
    })();
  };

  // ── OB-01 · Safety briefing ─────────────────────────────────────────────────
  if (step === "briefing") {
    return (
      <Screen>
        <FlowHeader label={t("createVault.stepLabel", { current: 1, total: 5 })} />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          <Title>{t("createVault.briefingTitle")}</Title>
          <Lead>
            {t("createVault.briefingLead")}
          </Lead>
          <Banner kind="danger" icon={false} style={{ marginTop: 16 }}>
            {LOST_BOTH_SECRETS_SENTENCE}
          </Banner>
          <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 2 }}>
            <AckRow checked={acks[0]} onToggle={() => setAcks([!acks[0], acks[1], acks[2]])}>
              Myne has no access to my notes and cannot read or recover them.
            </AckRow>
            <AckRow
              checked={acks[1]}
              onToggle={() => setAcks([acks[0], !acks[1], acks[2]])}
              why="Your password and phrase never leave this device. Nothing on our servers can decrypt them, so there is nothing for us to reset."
              whyOpen={why2Open}
              onToggleWhy={() => setWhy2Open((v) => !v)}
            >
              There is no password reset and no email recovery.
            </AckRow>
            <AckRow
              checked={acks[2]}
              onToggle={() => setAcks([acks[0], acks[1], !acks[2]])}
              why={LOST_BOTH_SECRETS_SENTENCE}
              whyOpen={why3Open}
              onToggleWhy={() => setWhy3Open((v) => !v)}
              last
            >
              My 24-word recovery phrase is the only way back into my vault.
            </AckRow>
          </div>
        </ScreenScroll>
        <FooterBar>
          <Button variant="secondary" full={false} onClick={onCancel}>
            {t("common.back")}
          </Button>
          <Button disabled={!acks.every(Boolean)} onClick={() => setStep("password")}>
            {t("common.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── OB-02 · Create password ─────────────────────────────────────────────────
  if (step === "password") {
    return (
      <Screen>
        <FlowHeader label={t("createVault.stepLabel", { current: 2, total: 5 })} onBack={briefing ? () => setStep("briefing") : onCancel} />
        <div style={{ flex: 1, padding: "18px 22px 0" }}>
          <Title>{t("createVault.passwordTitle")}</Title>
          {beginError && (
            <Banner kind="danger" style={{ marginTop: 16 }}>
              {t(beginError)}
            </Banner>
          )}
          <div style={{ marginTop: 22 }}>
            <FieldLabel>{t("sync.enroll.passwordLabel")}</FieldLabel>
            <PasswordRow value={pwd} onChange={setPassword} revealed={reveal} onToggleReveal={() => setReveal((v) => !v)} autoFocus />
          </div>
          {pwd.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <StrengthMeter level={strength} />
            </div>
          )}
          <div style={{ marginTop: 20 }}>
            <FieldLabel>{t("createVault.confirmPasswordLabel")}</FieldLabel>
            <ConfirmRow value={confirm} onChange={setConfirm} match={confirmMatch} />
          </div>
          <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
            {t("createVault.passwordHelper")}
          </div>
        </div>
        <FooterBar style={{ padding: "14px 20px" }}>
          <Button variant="secondary" full={false} onClick={briefing ? () => setStep("briefing") : onCancel}>
            {t("common.back")}
          </Button>
          <Button disabled={!passwordValid} onClick={() => { setBeginError(null); setStep("encrypting"); }}>
            {t("common.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── OB-03 · Encrypting (blocking) ───────────────────────────────────────────
  if (step === "encrypting") {
    return (
      <Screen>
        <BlockingOverlay
          title={t("editor.attachment.progress.encrypting")}
          subtitle={t("createVault.encryptingSubtitle")}
        />
      </Screen>
    );
  }

  // ── OB · Recovery phrase reveal ─────────────────────────────────────────────
  if (step === "phrase") {
    const words = showSecondHalf ? phraseRef.current : phraseRef.current.slice(0, 12);
    return (
      <Screen>
        <ScreenScroll style={{ padding: "64px 24px 8px" }}>
          <Title>{t("createVault.phraseTitle")}</Title>
          <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
            {t("createVault.phraseIntro")}
          </p>
          <Banner kind="danger" icon={false} style={{ marginTop: 16 }}>
            This is the only key to your vault. We can't reset it — lose these words and the notes are
            gone for good.
          </Banner>
          <div style={{ marginTop: 20 }}>
            <RecoveryGrid words={words} />
          </div>
          {!showSecondHalf && (
            <Button
              variant="secondary"
              onClick={() => setShowSecondHalf(true)}
              style={{ marginTop: 14, height: 40, fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500 }}
            >
              {t("createVault.showSecondHalf")}
            </Button>
          )}
          {showSecondHalf && (
            <>
              <Button variant="secondary" onClick={savePhraseFile} style={{ marginTop: 14, height: 40, fontSize: 13 }}>
                <Icon name="download" size={16} color="var(--fg-2)" strokeWidth={1.5} />
                {t("createVault.saveToFile")}
              </Button>
              {fileMsg && <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--fg-3)", textAlign: "center" }}>{fileMsg}</p>}
            </>
          )}
        </ScreenScroll>
        <FooterBar>
          <Button disabled={!showSecondHalf} onClick={startTypeBack}>
            {t("createVault.writtenThemDown")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── OB-04 · Type-back confirmation ──────────────────────────────────────────
  if (step === "typeback") {
    return (
      <Screen>
        <FlowHeader label={t("createVault.stepLabel", { current: 3, total: 5 })} onBack={() => setStep("phrase")} />
        <div style={{ flex: 1, padding: "18px 22px 0" }}>
          <Title>{t("createVault.typebackTitle")}</Title>
          <Lead>{t("createVault.typebackLead")}</Lead>
          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 16 }}>
            {challenge.map((idx, i) => (
              <WordEntry
                key={idx}
                position={idx + 1}
                value={answers[i]}
                onChange={(v) => setAnswers((prev) => prev.map((a, j) => (j === i ? v : a)))}
                error={norms[i].length > 0 && !corrects[i] ? t("createVault.wordMismatch", { pos: idx + 1 }) : undefined}
              />
            ))}
          </div>
        </div>
        <FooterBar style={{ padding: "14px 20px" }}>
          <Button variant="secondary" full={false} style={{ fontSize: 14, padding: "0 18px" }} onClick={() => setStep("phrase")}>
            {t("createVault.backToPhrase")}
          </Button>
          <Button disabled={!allCorrect} onClick={() => setStep("account")}>
            {t("common.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── OB-05 · Account number ──────────────────────────────────────────────────
  if (step === "account") {
    return (
      <Screen>
        <FlowHeader label={t("createVault.stepLabel", { current: 4, total: 5 })} onBack={startTypeBack} />
        <div style={{ flex: 1, padding: "18px 22px 0" }}>
          <Title>{t("createVault.accountTitle")}</Title>
          <Lead>
            {t("createVault.accountLead")}
          </Lead>
          {commitError && (
            <Banner kind="danger" style={{ marginTop: 16 }}>
              {commitError}
            </Banner>
          )}
          <div style={{ marginTop: 20 }}>
            <AccountNumber value={account} />
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 10 }}>
            <Button variant="secondary" style={{ height: 46, fontSize: 14 }} onClick={copyAccount}>
              <Icon name={copied ? "check" : "copy"} size={16} color={copied ? "var(--success)" : "var(--fg-2)"} strokeWidth={1.5} />
              {copied ? t("vaultCreation.account.copied") : t("vaultCreation.account.copy")}
            </Button>
            <Button variant="secondary" style={{ height: 46, fontSize: 14 }} onClick={saveAccountFile}>
              <Icon name="download" size={16} color="var(--fg-2)" strokeWidth={1.5} />
              {t("vaultCreation.account.saveAsFile")}
            </Button>
          </div>
          {fileMsg && <p style={{ margin: "8px 0 0", fontSize: 13, color: "var(--fg-3)" }}>{fileMsg}</p>}
          <div style={{ marginTop: 22, display: "flex", gap: 12, paddingTop: 16, borderTop: "1px solid var(--line-1)" }}>
            <button
              type="button"
              onClick={() => setSaved((v) => !v)}
              aria-pressed={saved}
              style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", flex: "none" }}
            >
              <Checkbox checked={saved} />
            </button>
            <div onClick={() => setSaved((v) => !v)} style={{ flex: 1, fontSize: 15, lineHeight: 1.45, color: "var(--fg-1)", cursor: "pointer" }}>
              {t("createVault.accountSavedAck")}
            </div>
          </div>
        </div>
        <FooterBar>
          <Button variant="secondary" full={false} onClick={startTypeBack}>
            {t("common.back")}
          </Button>
          <Button disabled={!saved} onClick={() => void commit()}>
            {t("createVault.commit")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // ── Committing (blocking) ───────────────────────────────────────────────────
  if (step === "committing") {
    return (
      <Screen>
        <BlockingOverlay title={t("createVault.committingTitle")} subtitle={t("createVault.committingSubtitle")} />
      </Screen>
    );
  }

  // ── Unlocking (blocking) ────────────────────────────────────────────────────
  if (step === "unlocking") {
    return (
      <Screen>
        <BlockingOverlay title={t("createVault.unlockingTitle")} subtitle={t("createVault.unlockingSubtitle")} />
      </Screen>
    );
  }

  // ── OB-06 · Ready / vault created ───────────────────────────────────────────
  return (
    <Screen style={{ alignItems: "center", padding: "0 30px" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <Wordmark />
        <h1
          style={{
            margin: "26px 0 0",
            fontSize: 30,
            lineHeight: 1.12,
            letterSpacing: "-0.025em",
            fontWeight: 600,
            color: "var(--fg-display)",
          }}
        >
          {t("createVault.readyTitle")}
        </h1>
        <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 300 }}>
          {t("createVault.readyBody")}
        </p>
        <div
          style={{
            marginTop: 18,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 999,
            padding: "7px 14px",
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />
          <span style={{ fontSize: 13, color: "var(--fg-2)" }}>{t("createVault.personalLabel")} · </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-2)" }}>{account}</span>
        </div>
      </div>
      <div style={{ flex: "none", paddingBottom: 52, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        <Button onClick={() => void openVault()}>{t("createVault.openVault")}</Button>
        <Button variant="secondary" onClick={backUpNow}>
          {t("createVault.backUpNow")}
        </Button>
      </div>
    </Screen>
  );
}
