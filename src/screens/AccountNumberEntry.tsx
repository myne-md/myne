// The web client's first-run identity step (phase3-web-client task 30).
//
// # Why this screen exists on web and nowhere else
//
// On desktop the vault is already on disk, so unlock is password-only: the
// client knows *which* account because it can see it. A browser starting from an
// empty origin knows nothing, and `decisions.md` 2026-07-26 makes sync a
// requirement rather than an option there — so the first thing it has to learn
// is which account to pull, and that is the 20-character account number in its
// 27-character display form (`account-number.md` §3).
//
// # Rejection is local, and that is a requirement rather than a nicety
//
// A mistyped account number is caught **here**, before any network call: the
// Damm-32 check character exists precisely so a transposition or a wrong
// character is detectable offline (`account-number.md` §4.2). Sending it to a
// server to be told "no" would turn a typo into a failed authentication attempt
// — slower, noisier, and an account-existence oracle for anyone watching.
//
// # The validation is Rust's, not this file's
//
// `invoke("plugin:vault-unlock|account_number_check")` runs
// `protocol::parse_account_number` — in the wasm Worker on web, in the host
// process on desktop. Local either way: no request leaves the client. A
// TypeScript re-implementation would be a second copy of a **frozen** quasigroup
// table, and a table that drifts rejects account numbers that are valid.
//
// # What is displayed and what is sent
//
// The input is masked into the grouped display form as the user types
// (`lib/account-number-format.ts` — presentation only, no validation). What
// eventually crosses the wire is the **hash** form, never the raw number
// (`server-protocol.md` §3.1); this screen hands the raw value to its caller and
// nowhere else.
//
// # One message, whatever failed
//
// `account-number.md` §5: the result is non-distinguishing. The backend returns
// one bit, and this screen renders one message. Naming the failing character
// would tell someone holding a partially-known number which half to work on.

import { useState, type CSSProperties, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "../platform/core";
import { CenteredCard, ctaInteraction, ctaStyle } from "../components/primitives/CenteredCard";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { formatAccountNumberInput } from "../lib/account-number-format";

/** The 27-character display form: `MY-` + five dash-separated 4-char groups. */
const DISPLAY_FORM_LENGTH = 27;

const FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  marginTop: "var(--space-2)",
};

const INPUT_STYLE: CSSProperties = {
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-base)",
  letterSpacing: "0.06em",
  outline: "none",
};

const HINT_STYLE: CSSProperties = {
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
};

export interface AccountNumberEntryProps {
  /** Called with the raw (masked, display-form) account number once it
   *  validates locally. The caller carries it into password entry and then into
   *  sync — hashed at that boundary, never sent raw. */
  onValid: (accountNumber: string) => void;
  /**
   * Leave for the creation flow instead of signing in (`decisions.md`
   * 2026-08-15).
   *
   * Optional, and its absence is meaningful rather than a default: this screen
   * is also the entry for a client that cannot create an account, and offering
   * a door that leads nowhere is the greyed-control failure the capability
   * descriptor exists to prevent. The caller passes it only where
   * `vaultCreation` is present.
   */
  onCreateAccount?: () => void;
}

/**
 * The secondary "no account yet" door. Ghost-styled on purpose: signing in is
 * the primary action on this screen, and a second filled button would make the
 * two read as equal choices when one of them creates a permanent credential.
 */
const CREATE_LINK_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--fg-2)",
  cursor: "pointer",
  font: "inherit",
  fontSize: "var(--text-sm)",
  marginTop: "var(--space-3)",
  padding: 0,
  textDecoration: "underline",
};

export function AccountNumberEntry({ onValid, onCreateAccount }: AccountNumberEntryProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // Enabled on length alone. The check character is not consulted here — that is
  // the backend's single bit — so the button does not become a per-keystroke
  // validity oracle rendered in the UI.
  const submittable = value.length === DISPLAY_FORM_LENGTH && !checking;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!submittable) return;
    setChecking(true);
    setError(null);
    try {
      const valid = await invoke<boolean>("plugin:vault-unlock|account_number_check", {
        accountNumber: value,
      });
      if (valid) {
        onValid(value);
        return;
      }
      setError(t("accountEntry.invalid"));
    } catch {
      // The check itself failed to run — a dead Worker, a refused command. That
      // is NOT "your account number is wrong", and saying so would send the user
      // to re-read a number that is fine.
      setError(t("accountEntry.checkFailed"));
    } finally {
      setChecking(false);
    }
  }

  return (
    <CenteredCard>
      <h1 style={{ fontFamily: "var(--font-sans)", fontSize: "var(--text-xl)" }}>
        {t("accountEntry.title")}
      </h1>
      <p style={HINT_STYLE}>{t("accountEntry.hint")}</p>
      <form style={FORM_STYLE} onSubmit={(e) => void handleSubmit(e)}>
        <input
          data-testid="account-entry.input"
          style={INPUT_STYLE}
          value={value}
          onChange={(e) => {
            setValue(formatAccountNumberInput(e.target.value));
            // Clearing on edit rather than leaving the banner up: the message is
            // about the value that was submitted, and it stops describing the
            // field the moment the field changes.
            setError(null);
          }}
          placeholder="MY-XXXX-XXXX-XXXX-XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={t("accountEntry.title")}
        />
        {error !== null && (
          <DestructiveBanner testId="account-entry.error">{error}</DestructiveBanner>
        )}
        {/* No `<Spinner>` on the in-flight label, unlike the unlock surfaces:
            what this button waits for is a local Damm-32 parse, not Argon2id.
            It resolves in well under a frame, so a spinner would flicker rather
            than reassure. */}
        <button
          data-testid="account-entry.submit"
          type="submit"
          disabled={!submittable}
          style={ctaStyle(!submittable)}
          {...ctaInteraction(!submittable)}
        >
          <span>{checking ? t("accountEntry.checking") : t("accountEntry.continue")}</span>
        </button>
        {onCreateAccount && (
          <button
            data-testid="account-entry.create-account"
            type="button"
            style={CREATE_LINK_STYLE}
            onClick={onCreateAccount}
          >
            {t("accountEntry.createAccount")}
          </button>
        )}
      </form>
    </CenteredCard>
  );
}
