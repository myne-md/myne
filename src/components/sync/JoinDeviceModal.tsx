// "Add this device to an existing account" (MYND-424) — the fresh-device join
// flow. Server URL + account number + password → `sync_join_account` bootstraps
// the whole local vault from the server's meta (no 24-word recovery), unlocks
// it, and SCRAM-enrolls (password → pending until an existing device approves).
// On success the caller routes to the editor; sync starts once approved.
// Built against design tokens; Penpot skipped per the owner directive.

import { useId, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Input } from "../primitives/Input";
import { PasswordInput } from "../PasswordInput";
import { DestructiveBanner } from "../DestructiveBanner";

interface JoinResult {
  vault_id: string;
  pending: boolean;
  fingerprint: string | null;
}

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const CARD: CSSProperties = {
  width: 460,
  maxWidth: "calc(100vw - var(--space-7))",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-3)",
  padding: "var(--space-6)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  fontFamily: "var(--font-sans)",
  color: "var(--fg-1)",
};

const TITLE: CSSProperties = {
  fontSize: "var(--text-xl)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  margin: 0,
};

const HELP: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
  lineHeight: "var(--leading-normal)",
};

const FIELD: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const LABEL: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
};

const ROW: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  justifyContent: "flex-end",
};

function btn(primary: boolean, disabled: boolean): CSSProperties {
  return {
    padding: "8px 18px",
    fontSize: 13,
    fontWeight: 500,
    borderRadius: "var(--radius-2)",
    cursor: disabled ? "not-allowed" : "pointer",
    border: primary ? "none" : "1px solid var(--line-1)",
    background: primary ? "var(--accent)" : "var(--bg-2)",
    color: primary ? "var(--accent-on)" : "var(--fg-1)",
    opacity: disabled ? 0.6 : 1,
  };
}

interface JoinDeviceModalProps {
  /** Close the modal without joining. */
  onCancel: () => void;
  /** Join succeeded; the vault is unlocked — route to the editor. */
  onJoined: (vaultId: string) => void;
}

export function JoinDeviceModal({ onCancel, onJoined }: JoinDeviceModalProps) {
  const baseId = useId();
  const [url, setUrl] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    url.trim().length > 0 &&
    account.trim().length > 0 &&
    password.length > 0 &&
    !busy;

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void invoke<JoinResult>("plugin:sync|sync_join_account", {
      serverUrl: url.trim(),
      accountNumber: account.trim(),
      password,
    })
      .then((res) => onJoined(res.vault_id))
      .catch(() =>
        setError(
          "Couldn’t add this device. Check the server URL, account number, and password — and that the server is reachable.",
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${baseId}-title`}
      data-testid="join.modal"
      style={BACKDROP}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div style={CARD} onClick={(e) => e.stopPropagation()}>
        <h2 id={`${baseId}-title`} style={TITLE}>
          Add this device to an account
        </h2>
        <p style={HELP}>
          Sign in with your account number and password. This device will sync
          your notes once an existing device approves it. No recovery phrase
          needed.
        </p>

        <div style={FIELD}>
          <label style={LABEL} htmlFor={`${baseId}-url`}>
            Sync server
          </label>
          <Input
            id={`${baseId}-url`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-server.example"
            autoComplete="off"
            spellCheck={false}
            data-testid="join.server-input"
          />
        </div>

        <div style={FIELD}>
          <label style={LABEL} htmlFor={`${baseId}-account`}>
            Account number
          </label>
          <Input
            id={`${baseId}-account`}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="MY-XXXX-XXXX-XXXX-XXXX-X"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            data-testid="join.account-input"
          />
        </div>

        <PasswordInput
          label="Password"
          value={password}
          onChange={setPassword}
          show={showPassword}
          onToggleShow={() => setShowPassword((s) => !s)}
          testId="join.password-input"
        />

        {error && <DestructiveBanner testId="join.error">{error}</DestructiveBanner>}

        <div style={ROW}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={btn(false, busy)}
            data-testid="join.cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            style={btn(true, !canSubmit)}
            data-testid="join.submit"
          >
            {busy ? "Adding…" : "Add device"}
          </button>
        </div>
      </div>
    </div>
  );
}
