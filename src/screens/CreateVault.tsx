import { useEffect, useState } from "react";
import { Button } from "../components/primitives/Button";
import { Input } from "../components/primitives/Input";
import { Icon } from "../components/primitives/Icon";
import { PasswordStrength } from "../components/PasswordStrength";
import { generatePassword } from "../lib/password-generator";

interface CreateVaultProps {
  onBack: () => void;
  onContinue: () => void;
}

const MIN_PASSWORD_LEN = 12;
const MIN_ZXCVBN_SCORE = 3;
const SUGGESTED_PASSWORD_LEN = 24;

type ZxcvbnScore = 0 | 1 | 2 | 3 | 4;

interface ZxcvbnResult {
  score: ZxcvbnScore;
  feedback: {
    warning: string;
    suggestions: string[];
  };
}

type ZxcvbnFn = (password: string) => ZxcvbnResult;

export function CreateVault({ onBack, onContinue }: CreateVaultProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [zxcvbnFn, setZxcvbnFn] = useState<ZxcvbnFn | null>(null);
  const [result, setResult] = useState<ZxcvbnResult | null>(null);

  // Lazy-load zxcvbn-ts: ~140KB gzip stays out of the Welcome bundle and
  // arrives as a separate chunk when the user first lands on this screen.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [core, common, en] = await Promise.all([
        import("@zxcvbn-ts/core"),
        import("@zxcvbn-ts/language-common"),
        import("@zxcvbn-ts/language-en"),
      ]);
      core.zxcvbnOptions.setOptions({
        translations: en.translations,
        graphs: common.adjacencyGraphs,
        dictionary: { ...common.dictionary, ...en.dictionary },
      });
      if (!cancelled) {
        setZxcvbnFn(() => core.zxcvbn as unknown as ZxcvbnFn);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!zxcvbnFn || password.length === 0) {
      setResult(null);
      return;
    }
    setResult(zxcvbnFn(password));
  }, [password, zxcvbnFn]);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LEN;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    password.length >= MIN_PASSWORD_LEN &&
    password === confirm &&
    result !== null &&
    result.score >= MIN_ZXCVBN_SCORE;

  type CaptionTone = "muted" | "danger" | "pending";
  let passwordCaption: string | undefined;
  let passwordTone: CaptionTone = "muted";
  let showStrength = false;

  if (password.length === 0) {
    passwordCaption =
      "Used as input to Argon2id (m=256 MiB, t=3, p=2). Choose something you can remember; you cannot reset it.";
    passwordTone = "muted";
  } else if (tooShort) {
    passwordCaption = `Use at least ${MIN_PASSWORD_LEN} characters.`;
    passwordTone = "danger";
  } else if (!result) {
    passwordCaption = "Checking strength…";
    passwordTone = "pending";
  } else {
    showStrength = true;
  }

  const handleSuggest = () => {
    const generated = generatePassword(SUGGESTED_PASSWORD_LEN);
    setPassword(generated);
    setConfirm(generated);
    setShowPassword(true);
    setShowConfirm(true);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-1)",
        padding: 24,
      }}
    >
      <div
        style={{
          width: 420,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Icon name="lock" size={20} />
          <div
            style={{
              fontSize: 12,
              color: "var(--fg-3)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              fontWeight: 600,
            }}
          >
            Step 1 of 2 — master password
          </div>
        </div>

        <div
          style={{
            fontSize: 28,
            fontWeight: 600,
            letterSpacing: "-0.015em",
            lineHeight: 1.2,
            color: "var(--fg-display)",
          }}
        >
          Create vault
        </div>

        <div
          style={{
            padding: 12,
            background: "var(--paper-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 6,
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--fg-2)",
          }}
        >
          Myne does not store your password or recovery phrase.{" "}
          <strong style={{ color: "var(--fg-1)" }}>
            If you lose both your password and recovery phrase, your notes are
            unrecoverable. We cannot help.
          </strong>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <label
              style={{
                fontSize: 12,
                color: "var(--fg-3)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                fontWeight: 600,
              }}
            >
              Master password
            </label>
            <button
              type="button"
              onClick={handleSuggest}
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                fontWeight: 500,
                color: "var(--accent)",
                background: "none",
                border: 0,
                padding: 0,
                cursor: "pointer",
              }}
            >
              Suggest password
            </button>
          </div>
          <div style={{ position: "relative" }}>
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              invalid={tooShort}
              autoFocus
              autoComplete="new-password"
              spellCheck={false}
              style={{ paddingRight: 36 }}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              style={{
                position: "absolute",
                right: 8,
                top: 7,
                background: "none",
                border: 0,
                color: "var(--fg-3)",
                cursor: "pointer",
                padding: 4,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name={showPassword ? "eye-off" : "eye"} size={14} />
            </button>
          </div>
          {passwordCaption && (
            <div
              style={{
                fontSize: 12,
                color:
                  passwordTone === "danger" ? "var(--danger)" : "var(--fg-3)",
                fontStyle: passwordTone === "pending" ? "italic" : "normal",
              }}
            >
              {passwordCaption}
            </div>
          )}
        </div>

        {showStrength && result && (
          <PasswordStrength
            score={result.score}
            warning={result.feedback.warning || undefined}
            suggestion={result.feedback.suggestions[0]}
          />
        )}

        <PasswordField
          label="Confirm master password"
          value={confirm}
          onChange={setConfirm}
          show={showConfirm}
          onToggleShow={() => setShowConfirm((s) => !s)}
          invalid={mismatch}
          caption={mismatch ? "Passwords do not match." : undefined}
          captionTone="danger"
        />

        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <Button variant="ghost" onClick={onBack} icon="arrow-left">
            Back
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="primary" onClick={onContinue} disabled={!ready}>
            Generate recovery phrase
          </Button>
        </div>
      </div>
    </div>
  );
}

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  show: boolean;
  onToggleShow: () => void;
  invalid?: boolean;
  caption?: string;
  captionTone?: "muted" | "danger" | "pending";
}

function PasswordField({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  invalid,
  caption,
  captionTone = "muted",
}: PasswordFieldProps) {
  const captionColor =
    captionTone === "danger" ? "var(--danger)" : "var(--fg-3)";
  const captionFontStyle = captionTone === "pending" ? "italic" : "normal";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label
        style={{
          fontSize: 12,
          color: "var(--fg-3)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          fontWeight: 600,
        }}
      >
        {label}
      </label>
      <div style={{ position: "relative" }}>
        <Input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          invalid={invalid}
          autoComplete="new-password"
          spellCheck={false}
          style={{ paddingRight: 36 }}
        />
        <button
          type="button"
          onClick={onToggleShow}
          aria-label={show ? "Hide password" : "Show password"}
          style={{
            position: "absolute",
            right: 8,
            top: 7,
            background: "none",
            border: 0,
            color: "var(--fg-3)",
            cursor: "pointer",
            padding: 4,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={show ? "eye-off" : "eye"} size={14} />
        </button>
      </div>
      {caption && (
        <div
          style={{
            fontSize: 12,
            color: captionColor,
            fontStyle: captionFontStyle,
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}
