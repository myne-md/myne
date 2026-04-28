import { useState } from "react";
import { Button } from "../components/primitives/Button";
import { Input } from "../components/primitives/Input";
import { Icon } from "../components/primitives/Icon";

interface CreateVaultProps {
  onBack: () => void;
  onContinue: () => void;
}

const MIN_PASSWORD_LEN = 12;

export function CreateVault({ onBack, onContinue }: CreateVaultProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LEN;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    password.length >= MIN_PASSWORD_LEN && password === confirm;

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

        <PasswordField
          label="Master password"
          value={password}
          onChange={setPassword}
          show={showPassword}
          onToggleShow={() => setShowPassword((s) => !s)}
          invalid={tooShort}
          autoFocus
          caption={
            tooShort
              ? `Use at least ${MIN_PASSWORD_LEN} characters.`
              : `Used as input to Argon2id (m=256 MiB, t=3, p=2). Choose something you can remember; you cannot reset it.`
          }
          captionTone={tooShort ? "danger" : "muted"}
        />

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
  autoFocus?: boolean;
  caption?: string;
  captionTone?: "muted" | "danger";
}

function PasswordField({
  label,
  value,
  onChange,
  show,
  onToggleShow,
  invalid,
  autoFocus,
  caption,
  captionTone = "muted",
}: PasswordFieldProps) {
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
          autoFocus={autoFocus}
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
            color:
              captionTone === "danger" ? "var(--danger)" : "var(--fg-3)",
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}
