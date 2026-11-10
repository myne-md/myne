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
import { Button } from "../primitives/Button";
import { Segmented } from "../primitives/Segmented";
import { PasswordInput } from "../PasswordInput";
import { DestructiveBanner } from "../DestructiveBanner";
// The phrase credential lives in its own module because the WEB BUILD REPLACES
// IT (task 92) — see that file's header. Importing `normalizeBip39Phrase`
// directly here is what used to leave served code one import edge away from the
// BIP-39 wordlist.
import { buildPhraseCredential, PHRASE_CELL_COUNT } from "./phrase-credential";
import { applyPastedPhrase, phrasePasteTokens } from "@myne/client-core/phrase-cells";
import { formatAccountNumberInput } from "../../lib/account-number-format";
import { DEVICE_NAME_MAX_LEN, useDeviceNameField } from "../../lib/device-name";
import { useEnroll, type EnrollCredentialKind } from "../../hooks/useEnroll";
import { has } from "../../platform/capabilities";
import { PhraseEntryGrid } from "../PhraseEntryGrid";
import {
  ENROLL_APPROVED_NOTICE,
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_PENDING_NOTICE,
} from "../../lib/load-bearing-copy";

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
  fontWeight: "var(--weight-semibold)",
};

const FIELD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};






const NOTICE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  margin: 0,
};

const MODE_VALUES = ["password", "recovery"] as const;

/** Map a non-secret `SyncDeviceError` kind to honest copy.
 *
 *  The non-distinguishing banner is the DEFAULT, and it stays that way for
 *  every credential/account/meta failure — telling the user which of account
 *  number, password or phrase was wrong is an enumeration signal.
 *
 *  #268 adds the refusals that are NOT credential failures. The server already
 *  said why it refused; flattening those into the credential banner told a user
 *  with a frozen account or a hit device cap to check credentials that were
 *  correct, and no amount of re-typing could ever clear it. Each of these names
 *  a remedy the user can act on, and none of them leaks whether an account
 *  exists — you only reach them AFTER the SCRAM proof has succeeded. */
export function failureMessageForTest(kind: string): string {
  return failureMessage(kind);
}

function failureMessage(kind: string): string {
  switch (kind) {
    case "NotConfigured":
      return i18n.t("sync.enroll.error.notConfigured");
    case "Transport":
      return i18n.t("sync.enroll.error.transport");
    case "AccountFrozen":
      return i18n.t("sync.enroll.error.frozen");
    case "DeviceLimitReached":
      return i18n.t("sync.enroll.error.deviceLimit");
    case "AwaitingApproval":
      return i18n.t("sync.enroll.error.awaitingApproval");
    case "InviteCodeRequired":
      return i18n.t("sync.enroll.error.inviteCodeRequired");
    case "InviteCodeInvalid":
      return i18n.t("sync.enroll.error.inviteCodeInvalid");
    case "FingerprintMismatch":
      // Its own message rather than the credential banner: a mismatch here is
      // a typo or a man in the middle, and "check your password" is the one
      // instruction that must not follow it.
      return i18n.t("sync.enroll.error.serverMismatch");
    case "KdfTooLargeForHost":
      // Not a credential failure either: the vault's Argon2id cost is valid and
      // the password is right — this client just cannot afford the memory. The
      // remedy is a different machine, so the credential banner would send the
      // user round a loop that cannot terminate.
      return i18n.t("sync.enroll.error.kdfTooLarge");
    default:
      return ENROLL_NON_DISTINGUISHING_BANNER;
  }
}

export function EnrollDeviceForm() {
  const { t } = useTranslation();
  const baseId = useId();
  const { busy, outcome, enroll, reset } = useEnroll();

  // The recovery-phrase credential is a **decided absence** on the web client
  // (phase3-web-client task 32): `decisions.md` 2026-07-26 forbids the phrase
  // from being typed into served code as firmly as it forbids generating it
  // there, and enrolment is the third path to it after creation and recovery —
  // the one that is easy to miss, because the screen is about adding a device
  // rather than about the phrase. `protocol.md` §7 sets the bar: the phrase
  // survives every password change and no rotation command exists, so one
  // exposure is permanent.
  //
  // **`phraseEnrolment`, not `phraseRecovery`** (`decisions.md` 2026-08-15).
  // Those were one flag, and the reversal that ships creation and recovery on
  // web would have dragged this screen along with them — three phrase paths
  // opened by a decision that named two. This one stays shut: enrolment is
  // routine and already has a password credential, and a routine phrase prompt
  // in a browser is exactly what makes A18 phishing work. Reading
  // `phraseRecovery` here again would reopen it silently.
  const phraseCredentialAvailable = has("phraseEnrolment");
  const availableModes = MODE_VALUES.filter(
    (value) => value !== "recovery" || phraseCredentialAvailable,
  );
  const modeOptions = availableModes.map((value) => ({
    value,
    label:
      value === "password"
        ? t("sync.enroll.mode.password")
        : t("common.recoveryphrase"),
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

  const handlePaste = () => (e: ClipboardEvent<HTMLInputElement>) => {
    const tokens = phrasePasteTokens(e.clipboardData.getData("text"));
    if (tokens.length < 2) return; // single token → native paste fills this cell
    e.preventDefault();
    clearOutcome();
    setCells((prev) => applyPastedPhrase(prev, tokens));
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const credential =
      mode === "password"
        ? password
        : buildPhraseCredential(cells);
    void enroll(accountNumber.trim(), credential, mode, deviceNameField.resolved);
  };

  return (
    <div style={ROOT} data-testid="sync.enroll">
      <div style={FIELD}>
        <label style={LABEL} htmlFor={`${baseId}-account`}>
          {t("common.accountnumber")}
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
          front of this machine. The name is held in RAM and written to this
          vault's own prefs only AFTER the first authed sync cycle — never with
          the enrollment request, and never before that cycle (see useEnroll). */}
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

      {/* One credential kind means no choice to offer: ABSENT, not hidden.
          `hidden` still puts the control in the DOM, where a devtools attribute
          edit or an accessibility tree walk finds a "recovery phrase" segment
          the web client must not have — and task 92 sets the same bar task 32
          set for the screens: absent, not hidden. */}
      {modeOptions.length >= 2 && (
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
      )}

      {mode === "password" || !phraseCredentialAvailable ? (
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
        <PhraseEntryGrid
          baseId={baseId}
          cells={cells}
          onCellChange={handleCellChange}
          onCellPaste={handlePaste}
        />
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

      <Button
        variant="primary"
        onClick={handleSubmit}
        disabled={!canSubmit}
        style={{ alignSelf: "flex-start" }}
        data-testid="sync.enroll.submit"
      >
        {busy ? t("sync.enroll.connecting") : t("sync.enroll.submit")}
      </Button>
    </div>
  );
}
