// SPDX-License-Identifier: AGPL-3.0
// Identity-only setup dialog (myne-md/myne#711, b2b-member-sync).
//
// A vault-less person can create an identity here: a 24-word phrase is
// generated and shown ONCE, the keypair is derived and sealed backend-side, and
// a person-level server account is registered. Recovering an existing identity
// takes its phrase instead. No vault is created either way; the `approved:
// false` case is a second password-path device awaiting approval.
//
// Desktop + mobile only: on web `plugin:sync|sync_person_setup` is
// `Class::Unsupported`, and Welcome is not reached at zero vaults there
// (`vaultCreation` absent routes to `account-entry`).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "./primitives/ModalShell";
import { Button } from "./primitives/Button";
import { personSetup, type PersonSetupView } from "../lib/personAccount";

interface IdentitySetupDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful setup/recover so the host can re-probe and land
   *  the user on the identity home. */
  onCreated?: () => void;
}

export function IdentitySetupDialog({ open, onClose, onCreated }: IdentitySetupDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [recovery, setRecovery] = useState("");
  const [result, setResult] = useState<PersonSetupView | null>(null);

  async function run(phrase?: string) {
    setBusy(true);
    setError(false);
    try {
      setResult(await personSetup(phrase));
      setRecovery("");
    } catch {
      // Never surface the raw backend error: it can carry a stage tag but no
      // secret, and the UI cannot act differently on the variant anyway.
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    // The re-probe is deferred to the Done CTA (not fired from `run`), because
    // the generated recovery phrase is shown ONCE and must stay on screen until
    // the user dismisses it: firing `onCreated` from `run` lets the host re-route
    // and unmount this dialog before `result.phrase` ever renders.
    const created = result !== null;
    setResult(null);
    setError(false);
    setRecovery("");
    onClose();
    if (created) onCreated?.();
  }

  return (
    <ModalShell
      open={open}
      title={t("identitySetup.title")}
      onClose={close}
      labelId="identity-setup-title"
      testId="identity-setup.root"
    >
      {result ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {result.phrase ? (
            <>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", lineHeight: 1.6 }}>
                {t("identitySetup.phraseWarning")}
              </div>
              <div
                data-testid="identity-setup.phrase"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-sm)",
                  lineHeight: 1.8,
                  color: "var(--fg-1)",
                  background: "var(--bg-2)",
                  border: "1px solid var(--line-1)",
                  borderRadius: "var(--radius-2)",
                  padding: "var(--space-3)",
                  userSelect: "all",
                }}
              >
                {result.phrase}
              </div>
            </>
          ) : (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {t("identitySetup.recovered")}
            </div>
          )}

          <div
            data-testid="identity-setup.fingerprint"
            style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--fg-3)", wordBreak: "break-all" }}
          >
            {result.fingerprint_hex}
          </div>

          {!result.approved ? (
            <div data-testid="identity-setup.pending" style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
              {t("identitySetup.pending")}
            </div>
          ) : null}

          <Button variant="primary" onClick={close} data-testid="identity-setup.close-cta">
            {t("identitySetup.doneCta")}
          </Button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", lineHeight: 1.6 }}>
            {t("identitySetup.intro")}
          </div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void run()}
            data-testid="identity-setup.create-cta"
          >
            {t("identitySetup.createCta")}
          </Button>

          <div style={{ height: 1, background: "var(--line-1)", margin: "var(--space-1) 0" }} />

          <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
            {t("identitySetup.recoverIntro")}
          </div>
          <textarea
            data-testid="identity-setup.phrase-input"
            value={recovery}
            onChange={(e) => setRecovery(e.target.value)}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
              color: "var(--fg-1)",
              background: "var(--bg-2)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-2)",
              padding: "var(--space-2)",
              resize: "none",
            }}
          />
          <Button
            variant="secondary"
            disabled={busy || recovery.trim() === ""}
            onClick={() => void run(recovery)}
            data-testid="identity-setup.recover-cta"
          >
            {t("identitySetup.recoverCta")}
          </Button>
        </div>
      )}

      {error ? (
        <div
          data-testid="identity-setup.error"
          role="alert"
          style={{ marginTop: "var(--space-3)", fontSize: "var(--text-sm)", color: "var(--danger)" }}
        >
          {t("identitySetup.error")}
        </div>
      ) : null}
    </ModalShell>
  );
}
