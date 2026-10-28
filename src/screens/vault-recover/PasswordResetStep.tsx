// Password-reset sub-step — non-dismissible chained step after a
// successful A8d. Per `recovery-flow.md` §4.1:
//
//   - **No skip, no later, no keep-current.** No Cancel button, no
//     Back arrow, no "use the same password" affordance. The only
//     bail mechanism is window close (process exit), which Rust
//     RAII handles by zeroizing `Slot::Recovering` on drop. Frontend
//     installs no `beforeunload` listener and dispatches no defensive
//     `vault_lock` (Q8 policy).
//   - **B3a-style form.** Mounts the shared `<PasswordCreateForm>`
//     (sibling of `PasswordChangeForm`; both compose the underlying
//     `PasswordInput` primitive) — same zxcvbn strength meter,
//     suggest-password helper, min-length + match + min-strength
//     gating as vault-creation's PasswordStep. The min-strength
//     constants (`MIN_PASSWORD_LEN = 12`, `MIN_ZXCVBN_SCORE = 3`)
//     live in `PasswordInput.tsx` so all three forms see the same
//     numbers and drift is structurally impossible.
//   - On submit, invoke A8f (`completeRecovery`); on Ok, call
//     `onCompleteSuccess` so App.tsx transitions Stage to `editor`.
//     On Err, map `VaultRecoveryError` → `PasswordOutcome` per Q7
//     A8f matrix and dispatch to the reducer.
//
// Penpot canon: `screen------recover--password-reset--{empty,filled,
// error-retry}`. Eyebrow `RECOVERY · NEW PASSWORD`, title "Set a new
// master password", info-box explains phrase preservation + old
// password death (`recovery-flow.md` §4.4).

import { useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { DestructiveBanner } from "../../components/DestructiveBanner";
import { PasswordCreateForm } from "../../components/PasswordCreateForm";
import { completeRecovery } from "../../lib/vault-recover";
import { listAccounts, accountIdForVault, accountCommandErrorKind } from "../../lib/account";
import type { AccountView } from "../../lib/account";
import { ioBanner } from "../../lib/io-banner";
import type { VaultRecoveryError } from "../../types/vault-recovery-error";
import type { Action, PasswordOutcome, VaultRecoverState } from "./reducer";
import { stageRootStyle } from "../../components/primitives/stageRoot";

interface PasswordResetStepProps {
  state: VaultRecoverState;
  dispatch: (action: Action) => void;
  onCompleteSuccess: () => void;
  /** Recover another vault: the sibling notice's action. The orchestrator
   *  routes back to the select step (or phrase-entry for a single vault). */
  onRecoverAnother: () => void;
}

/** Map a `VaultRecoveryError` from A8f to a `PasswordOutcome` per
 *  the Q7 A8f matrix. Banner copy is Turkish; `corrupted-vault` and
 *  `invalid-state` route through the fail-closed surface. */
function mapPasswordError(e: VaultRecoveryError): PasswordOutcome {
  switch (e.kind) {
    case "VaultRecoveryRequiresActiveSession":
      // Q4 silent recovery: slot is now Empty. Restart from
      // phrase-entry; no banner.
      return { kind: "needs-active-session" };
    case "RecoveryInProgress":
      // Semaphore busy — stay put, retry shortly.
      return {
        kind: "banner-retry",
        banner: i18n.t("vaultRecover.passwordReset.errors.operationInProgress"),
      };
    case "IoError":
      // Atomic write failed; slot is now Empty (recovering material
      // taken before spawn_blocking, dropped on failure). Sub-step
      // resets to phrase-entry; user must re-enter the phrase.
      return {
        kind: "io-failure",
        banner: ioBanner(e.detail.io_error_kind),
      };
    case "VaultNotFound":
      // Vault.meta vanished mid-recovery (exotic). Fail-closed.
      return { kind: "fail-closed", reason: "corrupted-vault" };
    case "InvalidVaultMeta":
      // Structural corruption surfaced during rewrite — fail-closed.
      return { kind: "fail-closed", reason: "corrupted-vault" };
    case "JoinFailure":
      // spawn_blocking panic — slot dropped recovering material on
      // failure (post-take_recovering closure). Sub-step resets to
      // phrase-entry.
      return {
        kind: "io-failure",
        banner: i18n.t("vaultRecover.passwordReset.errors.unexpected"),
      };
    case "VaultAlreadyUnlocked":
      // Defensive — A8f shouldn't see Unlocked slot, but the
      // exhaustiveness check forces a mapping. Stage-transition
      // bug-canary.
      return { kind: "fail-closed", reason: "invalid-state" };
    case "RecoveryAlreadyInProgress":
      // Defensive — A8f's slot peek expects `Recovering`, so this
      // would only fire on a race where slot transitioned between
      // peek and take. Generic banner.
      return {
        kind: "banner-retry",
        banner: i18n.t("vaultRecover.passwordReset.errors.unexpected"),
      };
    case "InvalidCredentialOrVault":
      // Defensive — A8f doesn't return this variant in practice
      // (recovery wrap-key already verified during A8d; A8f rewrites
      // the password side, no AEAD-tag credential check). Generic
      // banner if surfaces.
      return {
        kind: "banner-retry",
        banner: i18n.t("vaultRecover.passwordReset.errors.unexpected"),
      };
    case "RecoveryAbortedByLock":
      // vault_lock raced complete_recovery's Argon2id window — the
      // slot dropped Recovering→Empty and the recovery material was
      // zeroized; the rewrite never touched vault.meta. Restart from
      // phrase-entry (the io-failure outcome's reset shape) with an
      // informational banner mirroring the change-password lock-race
      // copy. Vacuous-by-affordance-absence today (§3.3: no Cancel
      // during decrypting) — pinned for any future Cancel.
      return {
        kind: "io-failure",
        banner: i18n.t("vaultRecover.passwordReset.errors.cancelledVaultLocked"),
      };
    case "WeakNewPassword":
      // Backend MIN_PASSWORD_LEN floor (belt+suspenders behind the
      // form's own gate). Stay on password-reset; same copy as the
      // change-password surface.
      return {
        kind: "banner-retry",
        banner: i18n.t("vaultRecover.passwordReset.errors.weakPassword"),
      };
    case "VaultOpenAsImportSource":
      // A8f cannot produce this in practice: reaching password-reset means the
      // slot for this vault was `Recovering`, and an import source slot is a
      // different variant on the same key, so the two cannot both hold it. The
      // exhaustiveness check still forces a mapping, and a stage-transition
      // bug-canary is the honest one rather than a banner claiming a state the
      // user can act on here.
      return { kind: "fail-closed", reason: "invalid-state" };
  }
}

const INFO_BOX_STYLE: CSSProperties = {
  padding: "var(--space-3)",
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  fontSize: "var(--text-sm)",
  lineHeight: 1.6,
  color: "var(--fg-2)",
};

const ROOT_STYLE: CSSProperties = {
  ...stageRootStyle,
  background: "var(--bg-1)",
  fontFamily: "var(--font-sans)",
  padding: "var(--space-5)",
};

const COLUMN_STYLE: CSSProperties = {
  width: 420,
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const EYEBROW_STYLE: CSSProperties = {
  fontSize: 12,
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-2xl)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "-0.015em",
  lineHeight: 1.2,
  color: "var(--fg-display)",
  margin: 0,
};

export function PasswordResetStep({
  state,
  dispatch,
  onCompleteSuccess,
  onRecoverAnother,
}: PasswordResetStepProps) {
  const { t } = useTranslation();
  const [inFlight, setInFlight] = useState(false);
  // The sibling count: how many OTHER vaults the recovered vault's account
  // holds. `null` while loading, `0` when there are none (or no account).
  const [siblingCount, setSiblingCount] = useState<number | null>(null);
  // A non-keychain grouping failure leaves the count unknown AND says so: the
  // notice hides (it must not claim siblings it never verified), but a
  // warning renders in its place so unknown never looks like zero.
  const [siblingsUnknown, setSiblingsUnknown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let accounts: AccountView[];
      try {
        accounts = await listAccounts();
      } catch (e) {
        if (cancelled) return;
        // Standalone by design (no keychain, no grouping) is the only silent
        // degrade: there are no siblings to miss. Any other failure warns.
        if (accountCommandErrorKind(e) === "KeychainUnavailable") {
          setSiblingCount(0);
        } else {
          setSiblingsUnknown(true);
        }
        return;
      }
      if (cancelled) return;
      const vaultId = state.vaultId;
      if (vaultId == null) {
        setSiblingCount(0);
        return;
      }
      const accountId = accountIdForVault(accounts, vaultId);
      if (accountId == null) {
        setSiblingCount(0);
        return;
      }
      const account = accounts.find((a) => a.id === accountId);
      const count = account ? account.vaults.length - 1 : 0;
      setSiblingCount(Math.max(0, count));
    })();
    return () => {
      cancelled = true;
    };
  }, [state.vaultId]);

  const handleSubmit = (newPassword: string) => {
    if (inFlight) return;
    setInFlight(true);
    void (async () => {
      try {
        // MYND-206: commit against the SAME vault A8d targeted (null →
        // sole-vault fallback) so the password reset rewrites exactly the
        // chosen vault's vault.meta (SYNC-6 targeting).
        await completeRecovery(newPassword, state.vaultId ?? undefined);
        // A8f Ok — slot is Unlocked server-side; App.tsx transitions
        // Stage to editor. Component unmounts shortly after; no
        // reducer dispatch needed.
        onCompleteSuccess();
      } catch (raw) {
        const outcome = mapPasswordError(raw as VaultRecoveryError);
        dispatch({ type: "password-result", outcome });
      } finally {
        setInFlight(false);
      }
    })();
  };

  return (
    <div style={ROOT_STYLE}>
      <div style={COLUMN_STYLE}>
        <div style={EYEBROW_STYLE}>{t("vaultRecover.passwordReset.eyebrow")}</div>
        <h1 style={TITLE_STYLE}>{t("vaultRecover.passwordReset.title")}</h1>

        <PasswordCreateForm
          submitLabel={t("vaultRecover.passwordReset.submit")}
          onSubmit={handleSubmit}
          disabled={inFlight}
          testIdPrefix="recover.reset"
          errorBanner={
            state.banner != null ? (
              <DestructiveBanner testId="recover.reset-banner">
                {state.banner}
              </DestructiveBanner>
            ) : undefined
          }
          helperCopy={
            <div style={INFO_BOX_STYLE}>
              {t("vaultRecover.passwordReset.helperBody")}{" "}
              <strong style={{ color: "var(--fg-1)" }}>
                {t("vaultRecover.passwordReset.helperEmphasis")}
              </strong>
            </div>
          }
        />

        {siblingsUnknown && (
          <p
            role="status"
            data-testid="recover.sibling-unknown"
            style={{
              margin: 0,
              fontSize: "var(--text-sm)",
              lineHeight: 1.6,
              color: "var(--ink-2)",
            }}
          >
            {t("vaultRecover.siblingNotice.unknown")}
          </p>
        )}
        {siblingCount != null && siblingCount > 0 && (
          <div            style={{
              padding: "var(--space-3)",
              background: "var(--paper-2)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-2)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            }}
            data-testid="recover.sibling-notice"
          >
            <span style={{ fontSize: "var(--text-sm)", lineHeight: 1.6, color: "var(--fg-2)" }}>
              {t("vaultRecover.siblingNotice.body", { count: siblingCount })}
            </span>
            <button
              type="button"
              onClick={onRecoverAnother}
              data-testid="recover.sibling-recover-another"
              style={{
                alignSelf: "flex-start",
                background: "transparent",
                border: 0,
                padding: "var(--space-2) var(--space-1)",
                borderRadius: "var(--radius-2)",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-base)",
                fontWeight: "var(--weight-medium)",
                color: "var(--accent)",
                cursor: "pointer",
              }}
            >
              {t("vaultRecover.siblingNotice.recoverAnother")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

