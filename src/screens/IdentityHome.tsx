// SPDX-License-Identifier: AGPL-3.0
// Identity-only home (myne-md/myne#711, b2b-member-sync).
//
// Shown at zero vaults when this device already holds a person account: the
// user has an identity (and can be invited) without owning a vault. Lists the
// invites addressed to the person from the sealed relay; the payload is not
// here, so a row only names the vault. Creating a vault is still one tap away.
//
// Desktop + mobile only: reached only when `sync_person_status` reports
// enrolled, which on web is impossible (`sync_person_setup` is Unsupported and
// the web client never renders `welcome` at zero vaults).
//
// Laid out on the shared `CenteredCard` envelope. It uses the same card as the
// other pre-unlock surfaces (`Unlock`, `AccountNumberEntry`, `FailClosedError`)
// rather than the bare column it shipped with, so the invite list scrolls
// inside a bounded card instead of pushing the create-vault and forget actions
// off the bottom of the window.
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { Input } from "../components/primitives/Input";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../components/primitives/CenteredCard";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { BetaTermsConsent } from "../components/sync/BetaTermsConsent";
import { useBetaTermsGate } from "../hooks/useBetaTermsGate";
import { MyneMark } from "../components/primitives/MyneMark";
import {
  personListInvites,
  personRegister,
  type InviteSummary,
  type PersonAccountState,
} from "../lib/personAccount";
import { acceptInviteErrorKey } from "@myne/client-core/accept-invite";
import { memberJoinVaultErrorKey } from "@myne/client-core/join-member-vault";
import { personLock } from "../lib/invite";
import { copyText } from "../lib/clipboard";
import { writeText as clipboardWriteText } from "../platform/clipboardManager";
import { toast } from "../components/toast/toastStore";
import { AcceptInviteWizard, JoinVaultWizard } from "../components/sync/InviteWizard";
import { MemberNameGate } from "../components/sync/MemberNameGate";

/** How often the pending-invite list re-polls while the identity home is
 *  mounted and visible. The relay has no push channel for a person account, so
 *  a list that is only fetched on mount never shows an invite that arrives while
 *  the screen is open (myne-md/myne#794). 5 s matches `useSyncStatus`'
 *  `STATUS_POLL_MS`; the request is one small relay GET. */
const INVITE_POLL_MS = 5000;

/** Whether a freshly fetched invite list differs from the one on screen. Used to
 *  skip the state update when nothing changed, so the 5 s poll does not re-render
 *  the list for no reason. */
function sameInvites(previous: InviteSummary[] | null, next: InviteSummary[]): boolean {
  if (previous === null || previous.length !== next.length) return false;
  return previous.every(
    (invite, index) =>
      invite.invite_id_hex === next[index].invite_id_hex && invite.claimed === next[index].claimed,
  );
}

/** Map a rejected `sync_person_accept_invite` to the message the user should
 *  see. Every failure used to collapse into one sentence, which is why a real
 *  failure on a member device was indistinguishable from a wrong owner code
 *  (myne-md/myne#794 manual-testing finding). The invoke rejects with the
 *  serialized `SyncDeviceError`, whose `kind` is a closed enum; anything else
 *  falls back to the generic message.
 *
 *  The mapping itself now lives in `@myne/client-core/accept-invite`, because the
 *  phone collects an accept too (myne-md/myne#851 task 14) and two copies of a
 *  six-arm switch over a closed enum is two places the distinction above can be
 *  lost, silently. Kept exported under this name so this screen's readers and
 *  its test are unchanged. */
export const acceptErrorKey = acceptInviteErrorKey;

/** The join-on-this-device sibling of the mapper above, and a SEPARATE mapping
 *  rather than the same one reused: the join never collects an owner code, so its
 *  `BadRequest` arm must not tell the user to paste one. Both live in
 *  `@myne/client-core` for the same reason. See
 *  `@myne/client-core/join-member-vault`. */
export const joinErrorKey = memberJoinVaultErrorKey;

const BLOCK_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const BRAND_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const WORDMARK_STYLE: CSSProperties = {
  fontSize: "var(--text-xl)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
};

// The canon's secondary/eyebrow heading (`VaultPicker`'s group header): small,
// secondary ink. It must not compete with the `--text-2xl` card title.
const SECTION_HEADING_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-3)",
};

const HINT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-3)",
};

const BODY_SMALL_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
};

const COPY_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs)",
  color: "var(--danger)",
};

const COPY_SUCCESS_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
};

const INVITES_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const INVITE_ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3)",
};

const INVITE_HASH_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  wordBreak: "break-all",
  userSelect: "all",
};

const CHECKBOX_LABEL_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  cursor: "pointer",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

const CHECKBOX_STYLE: CSSProperties = {
  width: 16,
  height: 16,
  accentColor: "var(--accent)",
  flexShrink: 0,
};

const FORGET_BOX_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  border: "1px solid var(--danger)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3)",
};

const FORGET_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

const ACTIONS_ROW_STYLE: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
};

interface IdentityHomeProps {
  /** The out-of-band invite code. Public material remains available while the
   *  private identity is locked. */
  identityCode: string | null;
  /** The person account number in DISPLAY form, or `null` when this device holds
   *  no identity (myne-md/myne#911 review). It is derived from the phrase, so it
   *  is not a secret and does not need saving: the story it answers is "one
   *  number names my account", and a number nobody can see answers nothing. */
  accountNumber: string | null;
  onCreateVault: () => void;
  /** Called after an invite is accepted and a shared vault is unlocked, so the
   *  app re-probes into the editor. */
  onAccepted: () => void;
  /** Called after this device's identity is forgotten, so the app re-probes to
   *  the Welcome screen (myne-md/myne#782). */
  onForgotten: () => void;
  /** The account lifecycle (myne-md/myne#911). `reserved` offers registration;
   *  `pending` explains the wait; `enrolled` needs neither. */
  accountState: PersonAccountState | null;
  /** Called after registration succeeds, so the app re-probes into the new
   *  state rather than trusting a local copy of it. */
  onRegistered: () => void;
}

export function IdentityHome({
  identityCode,
  accountNumber,
  onCreateVault,
  onAccepted,
  onForgotten,
  accountState,
  onRegistered,
}: IdentityHomeProps) {
  const { t } = useTranslation();
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Which invite each wizard is open for (myne-md/myne#871), or null for none.
  // The screen owns only that choice: the wizard owns its own step, its own
  // fields and its own secrets, so unmounting it (Cancel, or the accept
  // succeeding) discards all of them with no cleanup to forget.
  const [acceptingInvite, setAcceptingInvite] = useState<InviteSummary | null>(null);
  // The join-on-this-device path (myne-md/myne#852 task 7) is deliberately its
  // own wizard rather than a mode on the accept: the two differ in what they
  // collect (the join collects no owner code) and in what follows them (the
  // accept owes the name gate, the join must not touch a name at all).
  const [joiningInvite, setJoiningInvite] = useState<InviteSummary | null>(null);
  // The required name step (myne-md/myne#851 task 8, stories 5 to 7). The accept
  // is COMMITTED by the time this opens, and `onAccepted` (which reprobes and lands
  // the member in the editor) is withheld until the gate completes: an accepted
  // vault cannot reach the editor unnamed. Quitting here leaves the vault exactly as
  // the accept left it, openable and unnamed, which is story 7's "not a lockout".
  const [nameGateOpen, setNameGateOpen] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<"success" | "error" | null>(null);
  // Registration (myne-md/myne#911). The phrase is the proof of possession, so
  // it lives in this screen's state only until the call returns and is never
  // persisted here: the backend derives the SCRAM secret and forgets the phrase.
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerPhrase, setRegisterPhrase] = useState("");
  const [registerBusy, setRegisterBusy] = useState(false);
  const [registerError, setRegisterError] = useState(false);
  // Forget-this-identity-on-this-device (myne-md/myne#782). A short
  // acknowledgement gates the destructive button; the warning above it is the
  // only place the consequence is stated.
  const [forgetOpen, setForgetOpen] = useState(false);
  const [forgetAck, setForgetAck] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [forgetError, setForgetError] = useState(false);

  const betaTerms = useBetaTermsGate();
  const [termsOpen, setTermsOpen] = useState(false);

  /**
   * The beta-terms gate (myne-ops#15, myne-md/myne#911 review).
   *
   * Registration is a server-facing act: it creates the account the phrase derives
   * and enrols this device on it. `useBetaTermsGate` stands in front of the three
   * other doors that turn sync on, and `SyncPanel` states the rule this closes: a
   * consent screen at one door is not a consent screen. The identity screen was the
   * fourth door and had none.
   */
  const doRegister = async () => {
    setRegisterBusy(true);
    setRegisterError(false);
    try {
      await personRegister(registerPhrase);
      setRegisterOpen(false);
      setRegisterPhrase("");
      onRegistered();
    } catch {
      // The phrase is not kept across a failure: the user retypes it on the
      // retry, which the copy already asks for, and a mounted component holding
      // it is one devtools panel away from exposure (myne-md/myne#911 review).
      setRegisterPhrase("");
      setRegisterError(true);
    } finally {
      setRegisterBusy(false);
    }
  };

  const register = async () => {
    if (betaTerms.needed) {
      setTermsOpen(true);
      return;
    }
    await doRegister();
  };

  const forgetIdentity = async () => {
    setForgetBusy(true);
    setForgetError(false);
    try {
      // Erases the sealed keypair and the device token; the server account
      // survives and is recoverable with the phrase on another device.
      await personLock(true);
      onForgotten();
    } catch {
      setForgetError(true);
      setForgetBusy(false);
    }
  };

  const copyIdentityCode = () => {
    if (!identityCode) return;
    setCopyFeedback(null);
    void copyText(clipboardWriteText, identityCode, {
      onSuccess: {
        kind: "toast",
        run: () => {
          setCopyFeedback("success");
          toast({ message: t("personIdentityCode.copied"), variant: "info" });
        },
      },
      onFailure: {
        kind: "toast",
        run: () => {
          setCopyFeedback("error");
          toast({ message: t("personIdentityCode.copyFailed"), variant: "error" });
        },
      },
    });
  };

  // A silent fetch keeps the last good list on a transient failure; only the
  // FIRST load (silent=false) may surface the "Could not load invites" banner,
  // so a poll failing every 5 s cannot flicker the screen into an error.
  const loadInvites = useCallback(async (silent: boolean) => {
    try {
      const list = await personListInvites();
      setInvites((previous) => (sameInvites(previous, list) ? previous : list));
      setFailed(false);
    } catch {
      if (!silent) setFailed(true);
    }
  }, []);

  // Fetch on mount, then keep the list fresh while the screen is open: a poll
  // (the relay has no person-account push) plus an immediate refetch when the
  // window regains focus or the tab becomes visible. Without this, an invite
  // that arrives while the identity home is already mounted never appears until
  // the app is restarted (myne-md/myne#794).
  useEffect(() => {
    let alive = true;
    const run = (silent: boolean) => {
      if (alive) void loadInvites(silent);
    };
    run(false);
    const timer = setInterval(() => run(true), INVITE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") run(true);
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadInvites]);

  // Unclaimed and claimed are two different offers, not one list with a filter. An
  // unclaimed invite is an identity that is not a member yet and is accepted with the
  // owner's out-of-band code; a CLAIMED one is a vault this identity already belongs
  // to, which a second device joins without any out-of-band material at all. Hiding
  // the claimed rows (the pre-#852 behaviour) is what made the second-device path
  // unreachable from the identity home.
  const pending = (invites ?? []).filter((i) => !i.claimed);
  const claimed = (invites ?? []).filter((i) => i.claimed);

  if (nameGateOpen) {
    return (
      <MemberNameGate
        onDone={() => {
          setNameGateOpen(false);
          onAccepted();
        }}
      />
    );
  }

  // Both wizards replace the whole card rather than expanding inside it, the way
  // the vault-creation steps own their screen. `key` on the invite id means
  // switching invites (or reopening the same one after a Cancel) starts a fresh
  // wizard rather than resuming one whose fields the previous invite's flow
  // filled.
  if (acceptingInvite) {
    return (
      <AcceptInviteWizard
        key={acceptingInvite.invite_id_hex}
        invite={acceptingInvite}
        onCancel={() => setAcceptingInvite(null)}
        onAccepted={() => {
          setAcceptingInvite(null);
          setNameGateOpen(true);
        }}
      />
    );
  }

  if (joiningInvite) {
    return (
      <JoinVaultWizard
        key={joiningInvite.invite_id_hex}
        invite={joiningInvite}
        onCancel={() => setJoiningInvite(null)}
        onAccepted={onAccepted}
      />
    );
  }

  return (
    <CenteredCard>
      <div data-testid="identity-home.root" style={{ display: "contents" }}>
        <div style={BRAND_ROW_STYLE}>
          <MyneMark size={36} />
          <span style={WORDMARK_STYLE}>Myne</span>
        </div>

        <h1 style={CARD_TITLE_STYLE}>{t("identityHome.title")}</h1>

        <p style={CARD_BODY_STYLE}>{t("identityHome.subtitle")}</p>

        {/* The account number, where the identity is named: one value for
            support and for a self-host handoff, derived rather than generated so
            losing it costs nothing (myne-md/myne#911 review). */}
        {accountNumber ? (
          <div style={BLOCK_STYLE}>
            <h2 style={SECTION_HEADING_STYLE}>{t("identityHome.accountNumberHeading")}</h2>
            <Input
              data-testid="identity-home.account-number"
              aria-label={t("identityHome.accountNumberHeading")}
              autoComplete="off"
              readOnly
              value={accountNumber}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-base)",
                color: "var(--fg-1)",
                width: "100%",
                userSelect: "all",
              }}
            />
            <p style={BODY_SMALL_STYLE}>{t("identityHome.accountNumberHint")}</p>
          </div>
        ) : null}

        {/* The person-id hex line that used to sit here is gone (myne-md/myne#869):
            an unlabeled 32-byte blob that no one can read or compare, directly
            between the subtitle and the one piece of public material the user is
            meant to hand out. The invite code below is that material, and it is
            labelled. */}

        {/* The invite code an owner pastes to invite this person. Public
            material only (person id + public halves). */}
        {identityCode ? (
          <div style={BLOCK_STYLE}>
            <h2 style={SECTION_HEADING_STYLE}>{t("identityHome.shareCodeHeading")}</h2>
            <Input
              data-testid="identity-home.identity-code"
              aria-label={t("identityHome.shareCodeHeading")}
              autoComplete="off"
              readOnly
              value={identityCode}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-2)",
                width: "100%",
                userSelect: "all",
              }}
            />
            <Button
              type="button"
              variant="secondary"
              data-testid="identity-home.copy-code"
              onClick={copyIdentityCode}
            >
              {t("personIdentityCode.copy")}
            </Button>
            {copyFeedback === "error" ? (
              <p
                data-testid="identity-home.copy-feedback"
                role="status"
                aria-live="polite"
                style={COPY_ERROR_STYLE}
              >
                {t("personIdentityCode.copyFailed")}
              </p>
            ) : copyFeedback === "success" ? (
              <p
                data-testid="identity-home.copy-feedback"
                role="status"
                aria-live="polite"
                style={COPY_SUCCESS_STYLE}
              >
                {t("personIdentityCode.copied")}
              </p>
            ) : null}
            <p style={HINT_STYLE}>{t("identityHome.shareCodeHint")}</p>
          </div>
        ) : null}

        <div style={BLOCK_STYLE}>
          <h2 style={SECTION_HEADING_STYLE}>{t("identityHome.invitesHeading")}</h2>
          {failed ? (
            <DestructiveBanner testId="identity-home.error">
              {t("identityHome.invitesError")}
            </DestructiveBanner>
          ) : invites === null ? (
            <p style={HINT_STYLE}>{t("identityHome.invitesLoading")}</p>
          ) : pending.length === 0 && claimed.length === 0 ? (
            <p data-testid="identity-home.empty-invites" style={HINT_STYLE}>
              {t("identityHome.noInvites")}
            </p>
          ) : (
            <div data-testid="identity-home.invites" style={INVITES_STYLE}>
              {pending.map((inv) => (
                <div
                  key={inv.invite_id_hex}
                  data-testid="identity-home.invite-row"
                  style={INVITE_ROW_STYLE}
                >
                  <span style={INVITE_HASH_STYLE}>{inv.vault_account_hash_hex}</span>
                  <div>
                    <Button
                      type="button"
                      data-testid="identity-home.accept-open"
                      onClick={() => setAcceptingInvite(inv)}
                    >
                      {t("identityHome.accept")}
                    </Button>
                  </div>
                </div>
              ))}
              {claimed.length > 0 ? (
                <div data-testid="identity-home.claimed-invites" style={BLOCK_STYLE}>
                  <h3 style={SECTION_HEADING_STYLE}>{t("identityHome.claimedHeading")}</h3>
                  <p style={HINT_STYLE}>{t("identityHome.claimedHint")}</p>
                  {claimed.map((inv) => (
                    <div
                      key={inv.invite_id_hex}
                      data-testid="identity-home.claimed-row"
                      style={INVITE_ROW_STYLE}
                    >
                      <span style={INVITE_HASH_STYLE}>{inv.vault_account_hash_hex}</span>
                      <div>
                        <Button
                          type="button"
                          data-testid="identity-home.join-open"
                          onClick={() => setJoiningInvite(inv)}
                        >
                          {t("identityHome.join")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* The account lifecycle (myne-md/myne#911). A `reserved` identity is
            complete and offline; registering is an explicit act that asks for
            the phrase, so "I exist locally" and "a server knows me" cannot be
            confused. `pending` needs no action, only an explanation. */}
        {accountState === "reserved" ? (
          <div style={BLOCK_STYLE} data-testid="identity-home.account-state">
            <p style={BODY_SMALL_STYLE}>{t("identityHome.accountStateReserved")}</p>
            <BetaTermsConsent
              open={termsOpen}
              testId="identity.register.beta-terms"
              onAccept={() => {
                setTermsOpen(false);
                // `accept()` then the body directly, because `needed` is still
                // true for this render and `register()` would reopen the dialog.
                void betaTerms.accept().then(() => doRegister());
              }}
              // Declining closes the dialog and leaves the gate standing: nothing
              // was sent, so there is nothing to take back.
              onCancel={() => setTermsOpen(false)}
            />
            {registerOpen ? (
              <div data-testid="identity-home.register-form">
                <p style={BODY_SMALL_STYLE}>{t("identityHome.registerPrompt")}</p>
                <Input
                  type="password"
                  value={registerPhrase}
                  onChange={(e) => setRegisterPhrase(e.target.value)}
                  aria-label={t("identityHome.registerPhraseLabel")}
                  data-testid="identity-home.register-phrase"
                  autoComplete="off"
                  spellCheck={false}
                />
                {registerError ? (
                  <p role="alert" data-testid="identity-home.register-error">
                    {t("identityHome.registerError")}
                  </p>
                ) : null}
                <Button
                  variant="primary"
                  onClick={() => void register()}
                  disabled={registerBusy || registerPhrase.trim() === ""}
                  data-testid="identity-home.register-submit"
                >
                  {t("identityHome.registerSubmit")}
                </Button>
              </div>
            ) : (
              <Button
                onClick={() => setRegisterOpen(true)}
                data-testid="identity-home.register-cta"
              >
                {t("identityHome.registerCta")}
              </Button>
            )}
          </div>
        ) : null}
        {accountState === "pending" ? (
          <p style={BODY_SMALL_STYLE} data-testid="identity-home.account-state">
            {t("identityHome.accountStatePending")}
          </p>
        ) : null}

        <div style={BLOCK_STYLE}>
          <Button variant="primary" onClick={onCreateVault} data-testid="identity-home.create-vault-cta">
            {t("identityHome.createVaultCta")}
          </Button>
        </div>

        {/* Forget this identity on this device. Device-local only: the server
            account and any vault it owns or joined are untouched, and the
            phrase recovers the identity elsewhere. */}
        {forgetOpen ? (
          <div data-testid="identity-home.forget-confirm" style={FORGET_BOX_STYLE}>
            <p style={BODY_SMALL_STYLE}>{t("identityHome.forgetWarning")}</p>
            <label style={CHECKBOX_LABEL_STYLE}>
              <input
                type="checkbox"
                data-testid="identity-home.forget-ack"
                checked={forgetAck}
                onChange={(e) => setForgetAck(e.target.checked)}
                style={CHECKBOX_STYLE}
              />
              {t("identityHome.forgetCheckbox")}
            </label>
            {forgetError ? (
              <p data-testid="identity-home.forget-error" role="alert" style={FORGET_ERROR_STYLE}>
                {t("identityHome.forgetError")}
              </p>
            ) : null}
            <div style={ACTIONS_ROW_STYLE}>
              <Button
                variant="ghost"
                disabled={forgetBusy}
                onClick={() => {
                  setForgetOpen(false);
                  setForgetAck(false);
                }}
                data-testid="identity-home.forget-cancel"
              >
                {t("identityHome.forgetCancel")}
              </Button>
              <div style={{ flex: 1 }} />
              <Button
                variant="danger"
                disabled={!forgetAck || forgetBusy}
                onClick={() => void forgetIdentity()}
                data-testid="identity-home.forget-confirm-cta"
              >
                {t("identityHome.forgetConfirm")}
              </Button>
            </div>
          </div>
        ) : (
          <div style={BLOCK_STYLE}>
            <Button
              variant="ghost"
              onClick={() => setForgetOpen(true)}
              data-testid="identity-home.forget-cta"
            >
              {t("identityHome.forgetCta")}
            </Button>
          </div>
        )}
      </div>
    </CenteredCard>
  );
}
