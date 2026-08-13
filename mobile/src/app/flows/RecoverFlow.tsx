import { useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClipboardEvent, CSSProperties, ReactNode } from "react";
import {
  Screen,
  ScreenScroll,
  FlowHeader,
  Eyebrow,
  Title,
  Lead,
  FooterBar,
  Button,
  Banner,
  BlockingOverlay,
  StrengthMeter,
  Icon,
} from "../../components";
import {
  recoverWithPhrase,
  completeRecovery,
  resolveVaultByAccountNumber,
} from "../../lib/vault-recover";
import { normalizeBip39Phrase } from "../../lib/bip39-normalize";
import { HAS_TAURI } from "../../lib/app-window";
import { RECOVERY_NON_DISTINGUISHING_BANNER } from "../../lib/load-bearing-copy";
import { ioBanner } from "../../lib/io-banner";
import type { IoFailureKind, RecoverSubStep } from "../../lib/stage";
import type { RecoverFlowProps } from "./types";

/**
 * Recover — wired counterpart of `src/screens/recover/index.tsx`
 * (RC-01 account → RC-02 phrase 24 cells → RC-03 decrypting → RC-04 set
 * new password). Sub-step reducer; the phrase + new password are the
 * recovery secrets — held in component state, mirrored into a wipe ref,
 * and cleared on every exit path + on unmount. Argon2id-bound calls show
 * a `BlockingOverlay`; the credential/vault failure surfaces the single
 * non-distinguishing banner verbatim. The password-reset sub-step is
 * non-dismissible (no Cancel / no back) per recovery-flow.md §4.1.
 */

const WORD_COUNT = 24;
const MIN_PASSWORD_LEN = 12;

// Shared editable-input reset (the visible border lives on the wrapper).
const inputReset: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: "none",
  background: "transparent",
  outline: "none",
  padding: 0,
};

/** NFKD-agnostic word split — trims, lowercases, collapses whitespace
 *  runs, drops empties, caps at 24 (paste-to-grid helper). */
function splitWords(text: string): string[] {
  return text.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, WORD_COUNT);
}

/** Length-bucket strength label for the meter (presentational only —
 *  the backend `MIN_PASSWORD_LEN` floor is the real gate). */
function strengthLevel(pw: string): "Weak" | "Fair" | "Good" | "Strong" {
  const n = [...pw].length;
  if (n >= 20) return "Strong";
  if (n >= 16) return "Good";
  if (n >= MIN_PASSWORD_LEN) return "Fair";
  return "Weak";
}

// Small uppercase field label (12px / 600 / 0.06em) — mirrors the static.
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

// Account-number field (RC-01) — mono input, accent border on focus,
// danger border on a resolve miss.
function AccountField({
  value,
  error,
  onChange,
  onSubmit,
}: {
  value: string;
  error: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const borderColor = error ? "var(--danger)" : focused ? "var(--accent)" : "var(--line-2)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 52,
        border: `1.5px solid ${borderColor}`,
        borderRadius: 6,
        background: "var(--bg-1)",
        padding: "0 14px",
        boxShadow:
          focused && !error ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
      }}
    >
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit();
        }}
        placeholder="MY-XXXX-XXXX-XXXX-XXXX-X"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        style={{
          ...inputReset,
          fontFamily: "var(--font-mono)",
          fontSize: 16,
          letterSpacing: "0.04em",
          color: "var(--fg-1)",
        }}
      />
    </div>
  );
}

// One recovery-phrase grid cell (RC-02) — editable; supports paste-to-grid.
function WordCell({
  index,
  word,
  focused,
  onFocus,
  onBlur,
  onChange,
  onPaste,
}: {
  index: number;
  word: string;
  focused: boolean;
  onFocus: (i: number) => void;
  onBlur: () => void;
  onChange: (i: number, v: string) => void;
  onPaste: (i: number, e: ClipboardEvent<HTMLInputElement>) => void;
}) {
  const filled = word.trim() !== "";
  const border = focused
    ? "1.5px solid var(--accent)"
    : filled
      ? "1px solid var(--line-1)"
      : "1px solid var(--line-2)";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        height: 42,
        background: filled ? "var(--bg-2)" : "var(--bg-1)",
        border,
        borderRadius: 6,
        padding: "0 11px",
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)" : "none",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--line-3)",
          width: 16,
          textAlign: "end",
          flexShrink: 0,
        }}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <input
        value={word}
        onChange={(e) => onChange(index, e.target.value.toLowerCase())}
        onFocus={() => onFocus(index)}
        onBlur={onBlur}
        onPaste={(e) => onPaste(index, e)}
        autoCapitalize="none"
        autoComplete="off"
        spellCheck={false}
        style={{ ...inputReset, fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg-1)" }}
      />
    </div>
  );
}

// Editable password field (RC-04) — masked monospace, optional reveal eye.
function EditablePassword({
  value,
  onChange,
  withReveal = false,
  onEnter,
}: {
  value: string;
  onChange: (v: string) => void;
  withReveal?: boolean;
  onEnter?: () => void;
}) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const reveal = withReveal && revealed;
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
        type={reveal ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
        autoCapitalize="none"
        autoComplete="new-password"
        spellCheck={false}
        style={{
          ...inputReset,
          fontFamily: "var(--font-mono)",
          fontSize: reveal ? 16 : 14,
          letterSpacing: reveal ? "0" : "0.14em",
          color: "var(--fg-1)",
        }}
      />
      {withReveal && (
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          aria-label={revealed ? t("password.input.hide") : t("password.input.show")}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            marginInlineStart: 6,
            cursor: "pointer",
            display: "flex",
          }}
        >
          <Icon name={revealed ? "eye-off" : "eye"} size={20} color="var(--fg-3)" strokeWidth={1.6} />
        </button>
      )}
    </div>
  );
}

// ── Sub-step reducer ─────────────────────────────────────────────────────────

type Step = "account" | "phrase" | "decrypting" | "password";

interface State {
  step: Step;
  /** Resolved by the optional account-number selector; threaded to A8d/A8f. */
  resolvedVaultId: string | undefined;
  accountInput: string;
  accountError: boolean;
  accountBusy: boolean;
  words: string[];
  focused: number;
  phraseError: string | null;
  newPassword: string;
  confirmPassword: string;
  passwordError: string | null;
  busy: boolean;
}

type Action =
  | { type: "account.input"; value: string }
  | { type: "account.busy"; busy: boolean }
  | { type: "account.invalid" }
  | { type: "goto.phrase"; vaultId: string | undefined }
  | { type: "word.set"; index: number; value: string }
  | { type: "words.fill"; words: string[] }
  | { type: "cell.focus"; index: number }
  | { type: "cell.blur" }
  | { type: "goto.decrypting" }
  | { type: "phrase.fail"; message: string; wipe: boolean }
  | { type: "goto.password" }
  | { type: "pw.new"; value: string }
  | { type: "pw.confirm"; value: string }
  | { type: "pw.error"; message: string }
  | { type: "pw.busy"; busy: boolean }
  | { type: "wipe" };

const emptyWords = (): string[] => Array.from({ length: WORD_COUNT }, () => "");

/** Map the AppShell mount-time hint onto the local first sub-step. The
 *  account selector is the `select` entry (multi-vault); the chained
 *  password reset resumes at `password`; everything else lands on the
 *  phrase grid. */
function initStep(sub: RecoverSubStep): Step {
  switch (sub) {
    case "select":
      return "account";
    case "password-reset":
      return "password";
    case "phrase-entry":
    case "decrypting":
    case "delete-confirm":
    default:
      return "phrase";
  }
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "account.input":
      return { ...s, accountInput: a.value, accountError: false };
    case "account.busy":
      return { ...s, accountBusy: a.busy };
    case "account.invalid":
      return { ...s, accountBusy: false, accountError: true };
    case "goto.phrase":
      return { ...s, step: "phrase", resolvedVaultId: a.vaultId, accountBusy: false };
    case "word.set": {
      const words = s.words.slice();
      words[a.index] = a.value;
      return { ...s, words, phraseError: null };
    }
    case "words.fill":
      return { ...s, words: a.words, phraseError: null };
    case "cell.focus":
      return { ...s, focused: a.index };
    case "cell.blur":
      return { ...s, focused: -1 };
    case "goto.decrypting":
      return { ...s, step: "decrypting", phraseError: null };
    case "phrase.fail":
      return {
        ...s,
        step: "phrase",
        phraseError: a.message,
        focused: -1,
        words: a.wipe ? emptyWords() : s.words,
      };
    case "goto.password":
      return { ...s, step: "password", phraseError: null };
    case "pw.new":
      return { ...s, newPassword: a.value, passwordError: null };
    case "pw.confirm":
      return { ...s, confirmPassword: a.value, passwordError: null };
    case "pw.error":
      return { ...s, passwordError: a.message, busy: false };
    case "pw.busy":
      return { ...s, busy: a.busy };
    case "wipe":
      return { ...s, words: emptyWords(), newPassword: "", confirmPassword: "", accountInput: "" };
  }
}

export function RecoverFlow({ initialSubStep, onComplete, onCancel }: RecoverFlowProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(reducer, initialSubStep, (sub): State => ({
    step: initStep(sub),
    resolvedVaultId: undefined,
    accountInput: "",
    accountError: false,
    accountBusy: false,
    words: emptyWords(),
    focused: -1,
    phraseError: null,
    newPassword: "",
    confirmPassword: "",
    passwordError: null,
    busy: false,
  }));

  // Secret-wipe artefact. Mirrors the in-flight phrase + passwords so the
  // unmount cleanup can overwrite them — V8 strings are immutable, so this
  // is best-effort on the JS side (the load-bearing zeroize is Rust-side),
  // but the reference is dropped on every exit.
  const secretsRef = useRef<{ words: string[]; newPassword: string; confirmPassword: string }>({
    words: [],
    newPassword: "",
    confirmPassword: "",
  });
  const demoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    secretsRef.current = {
      words: state.words,
      newPassword: state.newPassword,
      confirmPassword: state.confirmPassword,
    };
  });

  useEffect(() => {
    return () => {
      secretsRef.current = { words: [], newPassword: "", confirmPassword: "" };
      if (demoTimer.current !== null) clearTimeout(demoTimer.current);
    };
  }, []);

  function wipeSecrets() {
    secretsRef.current = { words: [], newPassword: "", confirmPassword: "" };
    dispatch({ type: "wipe" });
  }

  // ── Account selector (RC-01) ──────────────────────────────────────────────
  // Empty input == Skip (the account number is NEVER required); a typed
  // value resolves to a VaultId or surfaces the single non-distinguishing
  // "invalid account number" affordance.
  async function onAccountContinue() {
    const value = state.accountInput.trim();
    if (value === "" || !HAS_TAURI) {
      dispatch({ type: "goto.phrase", vaultId: undefined });
      return;
    }
    dispatch({ type: "account.busy", busy: true });
    try {
      const vid = await resolveVaultByAccountNumber(value);
      if (vid === null) {
        dispatch({ type: "account.invalid" });
        return;
      }
      dispatch({ type: "goto.phrase", vaultId: vid });
    } catch {
      // Non-distinguishing: a malformed number and a no-match look identical.
      dispatch({ type: "account.invalid" });
    }
  }

  // ── Phrase entry (RC-02) → decrypting (RC-03) ─────────────────────────────
  const filledCount = state.words.filter((w) => w.trim() !== "").length;

  function fillFromText(text: string) {
    const tokens = splitWords(text);
    if (tokens.length === 0) return;
    dispatch({ type: "words.fill", words: Array.from({ length: WORD_COUNT }, (_, i) => tokens[i] ?? "") });
  }

  async function onPasteClipboard() {
    try {
      fillFromText(await navigator.clipboard.readText());
    } catch {
      // Clipboard read denied / unavailable — leave the grid untouched.
    }
  }

  function onCellPaste(index: number, e: ClipboardEvent<HTMLInputElement>) {
    const tokens = splitWords(e.clipboardData.getData("text"));
    if (tokens.length <= 1) return; // single word → let the native paste land
    e.preventDefault();
    const words = state.words.slice();
    for (let i = 0; i < tokens.length && index + i < WORD_COUNT; i++) words[index + i] = tokens[i];
    dispatch({ type: "words.fill", words });
  }

  function mapPhraseError(e: unknown): { message: string; wipe: boolean } {
    const kind = (e as { kind?: string } | null)?.kind;
    if (kind === "InvalidCredentialOrVault") {
      // §3.4 single non-distinguishing outcome — cells wiped, one banner.
      return { message: RECOVERY_NON_DISTINGUISHING_BANNER, wipe: true };
    }
    if (kind === "IoError") {
      const ioKind = (e as { detail?: { io_error_kind?: IoFailureKind } }).detail?.io_error_kind ?? "Other";
      return { message: ioBanner(ioKind), wipe: false };
    }
    if (kind === "InvalidVaultMeta") {
      return { message: t("recover.vaultUnreadable"), wipe: false };
    }
    return { message: t("recover.genericError"), wipe: false };
  }

  async function onPhraseSubmit() {
    const trimmed = state.words.map((w) => w.trim());
    if (trimmed.some((w) => w === "")) return;
    const normalized = normalizeBip39Phrase(trimmed.join(" "));
    dispatch({ type: "goto.decrypting" });
    if (!HAS_TAURI) {
      // Browser dev — no IPC. Simulate a successful A8d after a beat so the
      // decrypting screen + password reset are demoable without a backend.
      demoTimer.current = setTimeout(() => dispatch({ type: "goto.password" }), 1200);
      return;
    }
    try {
      await recoverWithPhrase(normalized, state.resolvedVaultId);
      dispatch({ type: "goto.password" });
    } catch (e) {
      const { message, wipe } = mapPhraseError(e);
      if (wipe) secretsRef.current.words = [];
      dispatch({ type: "phrase.fail", message, wipe });
    }
  }

  function onCancelPhrase() {
    wipeSecrets();
    onCancel();
  }

  // ── Password reset (RC-04) ────────────────────────────────────────────────
  function mapPasswordError(e: unknown): string {
    const kind = (e as { kind?: string } | null)?.kind;
    if (kind === "WeakNewPassword") return t("recover.weakPassword", { min: MIN_PASSWORD_LEN });
    return t("recover.setPasswordError");
  }

  async function onPasswordContinue() {
    const pw = state.newPassword;
    if ([...pw].length < MIN_PASSWORD_LEN) {
      dispatch({ type: "pw.error", message: t("recover.weakPassword", { min: MIN_PASSWORD_LEN }) });
      return;
    }
    if (pw !== state.confirmPassword) {
      dispatch({ type: "pw.error", message: t("recover.passwordMismatch") });
      return;
    }
    const vaultId = state.resolvedVaultId;
    dispatch({ type: "pw.busy", busy: true });
    if (!HAS_TAURI) {
      wipeSecrets();
      onComplete(vaultId);
      return;
    }
    try {
      await completeRecovery(pw, vaultId);
      wipeSecrets();
      onComplete(vaultId);
    } catch (e) {
      dispatch({ type: "pw.error", message: mapPasswordError(e) });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (state.step === "decrypting") {
    return (
      <Screen>
        <BlockingOverlay
          title={t("unlock.decrypting")}
          subtitle={t("recover.decryptingSubtitle")}
        />
      </Screen>
    );
  }

  if (state.step === "account") {
    return (
      <Screen>
        <FlowHeader label={t("recover.restoreVaultHeader")} />
        <div style={{ flex: 1, padding: "18px 22px 0" }}>
          <Title>{t("recover.accountTitle")}</Title>
          <Lead>{t("recover.accountLead")}</Lead>
          <div style={{ marginTop: 22 }}>
            <FieldLabel>{t("sync.enroll.accountNumberLabel")}</FieldLabel>
            <AccountField
              value={state.accountInput}
              error={state.accountError}
              onChange={(v) => dispatch({ type: "account.input", value: v })}
              onSubmit={() => void onAccountContinue()}
            />
            {state.accountError && (
              <div
                style={{
                  marginTop: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  color: "var(--danger)",
                  fontSize: 13,
                }}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6.5" stroke="var(--danger)" strokeWidth="1.4" />
                  <path d="M8 5v4M8 11h.01" stroke="var(--danger)" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                {t("recover.accountInvalid")}
              </div>
            )}
            <div style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
              {t("recover.accountOptionalHint")}
            </div>
          </div>
        </div>
        <FooterBar style={{ padding: "14px 20px calc(14px + env(safe-area-inset-bottom, 0px))", borderTop: "none" }}>
          <Button disabled={state.accountBusy} onClick={() => void onAccountContinue()}>
            {t("common.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  if (state.step === "phrase") {
    return (
      <Screen>
        <div
          style={{
            flex: "none",
            padding: "56px 16px 10px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: "1px solid var(--line-1)",
          }}
        >
          <button
            onClick={onCancelPhrase}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--fg-3)",
              fontSize: 15,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {t("common.prompt.cancel")}
          </button>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>{t("sync.enroll.recoveryPhraseLabel")}</div>
          <button
            onClick={() => void onPasteClipboard()}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--accent)",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
              <rect x="6" y="6" width="11" height="11" rx="2" stroke="var(--accent)" strokeWidth="1.5" />
              <path d="M3 12V4a1 1 0 0 1 1-1h8" stroke="var(--accent)" strokeWidth="1.5" />
            </svg>
            {t("recover.paste")}
          </button>
        </div>
        <ScreenScroll style={{ padding: "14px 16px 8px" }}>
          {state.phraseError && (
            <Banner kind="danger" style={{ marginBottom: 12 }}>
              {state.phraseError}
            </Banner>
          )}
          <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)", marginBottom: 12 }}>
            {t("recover.phraseGridHint")}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
            {state.words.map((w, i) => (
              <WordCell
                key={i}
                index={i}
                word={w}
                focused={state.focused === i}
                onFocus={(idx) => dispatch({ type: "cell.focus", index: idx })}
                onBlur={() => dispatch({ type: "cell.blur" })}
                onChange={(idx, v) => dispatch({ type: "word.set", index: idx, value: v })}
                onPaste={onCellPaste}
              />
            ))}
          </div>
        </ScreenScroll>
        <FooterBar style={{ flexDirection: "column", gap: 8, padding: "10px 16px calc(12px + env(safe-area-inset-bottom, 0px))" }}>
          <Button
            disabled={filledCount < WORD_COUNT}
            onClick={() => void onPhraseSubmit()}
            style={{ height: 50 }}
          >
            {t("recover.submitProgress", { filled: filledCount, total: WORD_COUNT })}
          </Button>
        </FooterBar>
      </Screen>
    );
  }

  // state.step === "password" (RC-04) — non-dismissible: no Cancel, no back.
  return (
    <Screen>
      <div style={{ flex: "none", padding: "56px 20px 0" }}>
        <Eyebrow>{t("recover.restoreVaultHeader")}</Eyebrow>
      </div>
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <Title>{t("recover.newPasswordTitle")}</Title>
        <Lead>{t("recover.newPasswordLead")}</Lead>
        <div style={{ marginTop: 20 }}>
          <FieldLabel>{t("settings.changePassword.newLabel")}</FieldLabel>
          <EditablePassword
            value={state.newPassword}
            onChange={(v) => dispatch({ type: "pw.new", value: v })}
            withReveal
          />
        </div>
        {state.newPassword.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <StrengthMeter level={strengthLevel(state.newPassword)} />
          </div>
        )}
        <div style={{ marginTop: 20 }}>
          <FieldLabel>{t("recover.confirmPasswordLabel")}</FieldLabel>
          <EditablePassword
            value={state.confirmPassword}
            onChange={(v) => dispatch({ type: "pw.confirm", value: v })}
            onEnter={() => void onPasswordContinue()}
          />
        </div>
        {state.passwordError && (
          <Banner kind="danger" style={{ marginTop: 12 }}>
            {state.passwordError}
          </Banner>
        )}
        <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
          {t("recover.passwordHelper")}
        </div>
      </div>
      <FooterBar style={{ padding: "14px 20px", borderTop: "none" }}>
        <Button disabled={state.busy} onClick={() => void onPasswordContinue()}>
          {t("common.continue")}
        </Button>
      </FooterBar>
      {state.busy && (
        <BlockingOverlay
          title={t("editor.attachment.progress.encrypting")}
          subtitle={t("recover.encryptingSubtitle")}
        />
      )}
    </Screen>
  );
}
