// Enrollment UI (MYND-425 task 5) — the add-device entry flow. A fresh device
// joins an existing account by proving ownership with {account number + password
// OR 24-word recovery phrase}; `sync_enroll` fetches `vault.meta` pre-auth,
// derives root_key, runs the SCRAM enrollment handshake, and (on approval) stores
// the device token. Penpot skipped per the owner directive; built against design
// tokens, reusing the vault-creation/recover input precedents (Segmented,
// PasswordInput, the 24-cell paste-to-distribute grid).
//
// Honesty discipline (SYNC-8): a wrong account#, a wrong credential, and a
// missing/corrupt server vault.meta all collapse to ONE non-distinguishing
// failure message (ENROLL_NON_DISTINGUISHING_BANNER) — never a per-cause leg.
// The pending outcome states plainly that the approval gate holds the device.

import {
  useId,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ClipboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { Input } from "../primitives/Input";
import { Segmented } from "../primitives/Segmented";
import { PasswordInput } from "../PasswordInput";
import { DestructiveBanner } from "../DestructiveBanner";
import { normalizeBip39Phrase } from "../../lib/bip39-normalize";
import { formatAccountNumberInput } from "../../lib/account-number-format";
import { DEVICE_NAME_MAX_LEN, useDeviceNameField } from "../../lib/device-name";
import { useEnroll, type EnrollCredentialKind } from "../../hooks/useEnroll";
import {
  ENROLL_APPROVED_NOTICE,
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_PENDING_NOTICE,
} from "../../lib/load-bearing-copy";

const PHRASE_CELL_COUNT = 24;

const ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
};

const LABEL: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
};

const FIELD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const HINT: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
};

const GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 6,
};

const CELL_WRAP: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  background: "var(--paper-1)",
  border: "1px solid var(--line-1)",
  borderRadius: 2,
  paddingLeft: 28,
  paddingRight: 8,
  height: 32,
  cursor: "text",
};

const CELL_NUMBER: CSSProperties = {
  position: "absolute",
  left: 8,
  top: "50%",
  transform: "translateY(-50%)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  pointerEvents: "none",
  userSelect: "none",
};

const CELL_INPUT: CSSProperties = {
  width: "100%",
  height: "100%",
  background: "transparent",
  border: 0,
  outline: "none",
  appearance: "none",
  WebkitAppearance: "none",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
  padding: 0,
  margin: 0,
};

const NOTICE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  margin: 0,
};

function submitStyle(disabled: boolean): CSSProperties {
  return {
    alignSelf: "flex-start",
    background: disabled ? "var(--bg-3)" : "var(--accent)",
    color: disabled ? "var(--fg-3)" : "var(--accent-on)",
    border: disabled ? "1px solid var(--line-1)" : "none",
    borderRadius: "var(--radius-2)",
    padding: "8px 18px",
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    fontWeight: 500,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const MODE_VALUES = ["password", "recovery"] as const;

/** Map a non-secret `SyncDeviceError` kind to honest, non-distinguishing copy.
 *  Configuration + transport faults get their own (non-leaking) message; every
 *  credential/account/meta failure collapses to the single banner. */
function failureMessage(kind: string): string {
  switch (kind) {
    case "NotConfigured":
      return i18n.t("sync.enroll.error.notConfigured");
    case "Transport":
      return i18n.t("sync.enroll.error.transport");
    default:
      return ENROLL_NON_DISTINGUISHING_BANNER;
  }
}

export function EnrollDeviceForm() {
  const { t } = useTranslation();
  const baseId = useId();
  const { busy, outcome, enroll, reset } = useEnroll();

  const modeOptions = MODE_VALUES.map((value) => ({
    value,
    label:
      value === "password"
        ? t("sync.enroll.mode.password")
        : t("sync.enroll.mode.recovery"),
  }));

  const [accountNumber, setAccountNumber] = useState("");
  const [mode, setMode] = useState<EnrollCredentialKind>("password");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [cells, setCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );

  // MYND-548: the device's own name. One hook for all four enrollment doors, so
  // they cannot drift.
  const deviceNameField = useDeviceNameField();

  // Any edit after a terminal outcome clears it so the user sees a fresh attempt.
  const clearOutcome = () => {
    if (outcome) reset();
  };

  const accountFilled = accountNumber.trim().length > 0;
  const credentialFilled =
    mode === "password" ? password.length > 0 : cells.every((c) => c.length > 0);
  const canSubmit = accountFilled && credentialFilled && !busy;

  const setCell = (index: number, value: string) => {
    clearOutcome();
    // No typed whitespace inside a cell (paste-to-distribute handles multi-word).
    const cleaned = value.replace(/\s+/g, "");
    setCells((prev) => prev.map((c, i) => (i === index ? cleaned : c)));
  };

  const handleCellChange =
    (index: number) => (e: ChangeEvent<HTMLInputElement>) =>
      setCell(index, e.target.value);

  const handlePaste =
    (index: number) => (e: ClipboardEvent<HTMLInputElement>) => {
      const tokens = e.clipboardData
        .getData("text")
        .split(/\s+/)
        .filter((t) => t.length > 0);
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
    const credential =
      mode === "password"
        ? password
        : normalizeBip39Phrase(cells.join(" "));
    void enroll(accountNumber.trim(), credential, mode, deviceNameField.resolved);
  };

  return (
    <div style={ROOT} data-testid="sync.enroll">
      <div style={FIELD}>
        <label style={LABEL} htmlFor={`${baseId}-account`}>
          {t("sync.enroll.accountNumberLabel")}
        </label>
        <Input
          id={`${baseId}-account`}
          value={accountNumber}
          onChange={(e) => {
            clearOutcome();
            setAccountNumber(formatAccountNumberInput(e.target.value));
          }}
          placeholder={t("sync.enroll.accountNumberPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          data-testid="sync.enroll.account-input"
        />
      </div>

      {/* MYND-548: named here, at the one moment the user is provably standing in
          front of this machine. Written to THIS vault's local prefs on success —
          it never joins the enrollment request. */}
      <div style={FIELD}>
        <label style={LABEL} htmlFor={`${baseId}-device-name`}>
          {t("sync.enroll.deviceNameLabel")}
        </label>
        <Input
          id={`${baseId}-device-name`}
          value={deviceNameField.value}
          onChange={(e) => deviceNameField.setValue(e.target.value)}
          maxLength={DEVICE_NAME_MAX_LEN}
          placeholder={deviceNameField.suggestion}
          autoComplete="off"
          spellCheck={false}
          data-testid="sync.enroll.device-name-input"
        />
        <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
          {t("sync.enroll.deviceNameHelp")}
        </div>
      </div>

      <div style={FIELD}>
        <span style={LABEL}>{t("sync.enroll.signInWith")}</span>
        <Segmented
          options={modeOptions}
          value={mode}
          onChange={(v) => {
            clearOutcome();
            setMode(v as EnrollCredentialKind);
          }}
          ariaLabel={t("sync.enroll.credentialTypeAria")}
          testId="sync.enroll.mode"
        />
      </div>

      {mode === "password" ? (
        <PasswordInput
          label={t("sync.enroll.passwordLabel")}
          value={password}
          onChange={(next) => {
            clearOutcome();
            setPassword(next);
          }}
          show={showPassword}
          onToggleShow={() => setShowPassword((s) => !s)}
          testId="sync.enroll.password-input"
        />
      ) : (
        <div style={FIELD}>
          <span style={LABEL}>{t("sync.enroll.recoveryPhraseLabel")}</span>
          <p style={HINT}>{t("sync.enroll.recoveryPhraseHint")}</p>
          <div style={GRID} data-testid="sync.enroll.phrase-grid">
            {Array.from({ length: PHRASE_CELL_COUNT }, (_, i) => {
              const inputId = `${baseId}-cell-${i}`;
              return (
                <label key={i} htmlFor={inputId} style={CELL_WRAP}>
                  <span style={CELL_NUMBER}>{i + 1}</span>
                  <input
                    id={inputId}
                    type="text"
                    value={cells[i] ?? ""}
                    onChange={handleCellChange(i)}
                    onPaste={handlePaste(i)}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    inputMode="text"
                    style={CELL_INPUT}
                    aria-label={t("sync.enroll.wordAria", { number: i + 1 })}
                    data-testid="sync.enroll.phrase-cell"
                    data-index={i + 1}
                  />
                </label>
              );
            })}
          </div>
        </div>
      )}

      {outcome?.state === "error" && (
        <DestructiveBanner testId="sync.enroll.error">
          {failureMessage(outcome.kind)}
        </DestructiveBanner>
      )}
      {outcome?.state === "pending" && (
        <p style={NOTICE} data-testid="sync.enroll.pending">
          {ENROLL_PENDING_NOTICE}
        </p>
      )}
      {outcome?.state === "approved" && (
        <p style={NOTICE} data-testid="sync.enroll.approved">
          {ENROLL_APPROVED_NOTICE}
        </p>
      )}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={submitStyle(!canSubmit)}
        data-testid="sync.enroll.submit"
      >
        {busy ? t("sync.enroll.connecting") : t("sync.enroll.submit")}
      </button>
    </div>
  );
}
