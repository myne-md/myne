// SPDX-License-Identifier: AGPL-3.0
// The invitations dialog, reachable from the vault picker and the in-editor
// vault switcher (myne-md/myne#911 follow-up).
//
// # Why it exists
//
// Accepting an invitation lived on `IdentityHome`, and `App.tsx` renders that
// screen only at ZERO vaults. A device that already held a vault therefore had
// no surface on which an invitation could be accepted, and a person invited to
// a shared vault had to create a vault of their own first. This dialog is the
// missing door: the same two wizards, mounted where the user already is.
//
// # What it deliberately does not do
//
// It does not list invitations nobody can act on. A `reserved` or `pending`
// identity has no invitations to miss (the relay addresses them to a REGISTERED
// person), so those two states explain themselves and point at Settings rather
// than showing an empty list that reads as "you were not invited".
//
// It also never renders the owner's code or the phrase: both stay inside the
// wizard that collects them, for the reason `InviteWizard.tsx` states.
import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../primitives/ModalShell";
import { Button } from "../primitives/Button";
import { Spinner } from "../Spinner";
import { DestructiveBanner } from "../DestructiveBanner";
import {
  AcceptInviteWizard,
  JoinVaultWizard,
} from "./InviteWizard";
import {
  personDeclineInvite,
  type InviteSummary,
} from "../../lib/personAccount";
import type { InvitesUnavailable } from "../../hooks/usePendingInvites";
import { unclaimedInvites } from "../../hooks/usePendingInvites";
import { PersonRegisterDialog } from "./PersonRegisterDialog";

interface InvitesDialogProps {
  open: boolean;
  /** The recipient-scoped list, claimed rows included. */
  invites: InviteSummary[];
  loading: boolean;
  unavailable: InvitesUnavailable | null;
  onClose: () => void;
  /** Retry the list after a failed read. */
  onRetry: () => void;
  /** An invitation was accepted or a shared vault was installed here. */
  /** `vaultId` is the vault the accept just installed, when the caller can use it. */
  onAccepted: (vaultId?: string) => void;
}

const BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const HINT_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: "var(--leading-normal)",
  color: "var(--fg-2)",
};

const SECTION_TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
};

const ID_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
  wordBreak: "break-all",
};

export function InvitesDialog({
  open,
  invites,
  loading,
  unavailable,
  onClose,
  onRetry,
  onAccepted,
}: InvitesDialogProps) {
  const { t } = useTranslation();
  // Which wizard is on screen, if any. One invitation at a time: the wizards
  // hold a phrase and an owner code, and a second open row would invite the two
  // to be confused (the same reason `IdentityHome` holds one).
  const [accepting, setAccepting] = useState<InviteSummary | null>(null);
  const [joining, setJoining] = useState<InviteSummary | null>(null);
  // The refusal, and the two states around it (myne-md/myne#911 follow-up). It
  // asks first because it CANNOT be undone: the server drops the sealed payload,
  // so the only way back is a fresh invitation from the owner. `declineError`
  // stays in the confirm dialog rather than replacing the list, which would hide
  // the invitation the retry acts on.
  const [declining, setDeclining] = useState<InviteSummary | null>(null);
  const [declineError, setDeclineError] = useState(false);
  const [decliningBusy, setDecliningBusy] = useState(false);
  // The register door, for the two lifecycle states that cannot list invitations
  // at all (see the `not-enrolled` arm below).
  const [registerOpen, setRegisterOpen] = useState(false);

  const close = () => {
    setAccepting(null);
    setJoining(null);
    setDeclining(null);
    // The two states around the refusal are cleared with it. Leaving `busy` set
    // would re-open the dialog with its confirm button disabled forever, and a
    // stale error would greet the next decline before anything was pressed.
    setDeclineError(false);
    setDecliningBusy(false);
    onClose();
  };

  /** Closing the confirm on its own, which is the same reset one step narrower. */
  const closeDecline = () => {
    setDeclining(null);
    setDeclineError(false);
    setDecliningBusy(false);
  };

  const pending = unclaimedInvites(invites);
  const claimed = invites.filter((invite) => invite.claimed);

  const body = accepting ? (
    <AcceptInviteWizard
      invite={accepting}
      onCancel={() => setAccepting(null)}
      onAccepted={onAccepted}
    />
  ) : joining ? (
    <JoinVaultWizard
      invite={joining}
      onCancel={() => setJoining(null)}
      onAccepted={onAccepted}
    />
  ) : (
    <div style={BODY_STYLE}>
      {unavailable === "error" ? (
        <>
          <DestructiveBanner testId="invites.error">
            {t("invites.error")}
          </DestructiveBanner>
          <div>
            <Button variant="secondary" onClick={onRetry} data-testid="invites.retry">
              {t("common.tryagain")}
            </Button>
          </div>
        </>
      ) : unavailable === "no-identity" ? (
        <p style={HINT_STYLE} data-testid="invites.no-identity">
          {t("invites.noIdentity")}
        </p>
      ) : unavailable === "not-enrolled" ? (
        // The state AND the act that ends it, the shape `IdentityHome` already
        // uses for the same fact (`decisions/ui/0725`): an invitation is
        // addressed to a person account, so an identity this device has created
        // but never registered cannot list what was sent to it. The register form
        // is mounted here rather than pointing at Settings, because this is where
        // the question is asked.
        <div
          style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "var(--space-3)" }}
          data-testid="invites.not-enrolled"
        >
          <p style={HINT_STYLE}>{t("invites.notEnrolled")}</p>
          <Button onClick={() => setRegisterOpen(true)} data-testid="invites.register-cta">
            {t("common.registerthisidentity")}
          </Button>
        </div>
      ) : unavailable === "pending" ? (
        // Registered and waiting for approval: it HAS an account, so the sentence
        // is a wait rather than a remedy, and no register control appears: the
        // fix is on the account's other device, not here.
        <p style={HINT_STYLE} data-testid="invites.pending-identity">
          {t("identityHome.invitesPending")}
        </p>
      ) : loading && invites.length === 0 ? (
        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
          data-testid="invites.loading"
        >
          <Spinner size={14} />
          <span style={HINT_STYLE}>{t("invites.loading")}</span>
        </div>
      ) : pending.length === 0 && claimed.length === 0 ? (
        <p style={HINT_STYLE} data-testid="invites.empty">
          {t("common.noinvitationsyet")}
        </p>
      ) : (
        <>
          {pending.length > 0 ? (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
              data-testid="invites.pending"
            >
              <h3 style={SECTION_TITLE_STYLE}>{t("invites.pendingHeading")}</h3>
              <p style={HINT_STYLE}>{t("invites.pendingHint")}</p>
              {pending.map((invite) => (
                <div
                  key={invite.invite_id_hex}
                  style={ROW_STYLE}
                  data-testid="invites.row"
                >
                  <span style={ID_STYLE}>{invite.vault_account_hash_hex}</span>
                  <div style={{ display: "flex", gap: "var(--space-2)" }}>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setDeclineError(false);
                        setDeclining(invite);
                      }}
                      data-testid="invites.decline"
                    >
                      {t("invites.decline")}
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => setAccepting(invite)}
                      data-testid="invites.accept"
                    >
                      {t("identityHome.accept")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {claimed.length > 0 ? (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
              data-testid="invites.claimed"
            >
              <h3 style={SECTION_TITLE_STYLE}>{t("identityHome.claimedHeading")}</h3>
              <p style={HINT_STYLE}>{t("identityHome.claimedHint")}</p>
              {claimed.map((invite) => (
                <div
                  key={invite.invite_id_hex}
                  style={ROW_STYLE}
                  data-testid="invites.claimed-row"
                >
                  <span style={ID_STYLE}>{invite.vault_account_hash_hex}</span>
                  <Button
                    variant="secondary"
                    onClick={() => setJoining(invite)}
                    data-testid="invites.join"
                  >
                    {t("identityHome.join")}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );

  return (
    <ModalShell
      open={open}
      title={t("invites.title")}
      onClose={close}
      labelId="invites-dialog-title"
      testId="invites.dialog"
    >
      {body}
      {declining !== null ? (
        <ModalShell
          open
          title={t("invites.declineTitle")}
          labelId="invites-decline-title"
          testId="invites.decline-confirm"
          onClose={closeDecline}
          width={440}
        >
          <p style={HINT_STYLE} data-testid="invites.decline-body">
            {t("invites.declineBody")}
          </p>
          {declineError ? (
            <p role="alert" style={{ ...HINT_STYLE, color: "var(--danger)" }} data-testid="invites.decline-error">
              {t("invites.declineFailed")}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="ghost"
              disabled={decliningBusy}
              onClick={closeDecline}
              data-testid="invites.decline-cancel"
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={decliningBusy}
              onClick={async () => {
                setDecliningBusy(true);
                setDeclineError(false);
                try {
                  await personDeclineInvite(declining.invite_id_hex);
                  setDeclining(null);
                  setDeclineError(false);
                  onRetry();
                } catch {
                  setDeclineError(true);
                } finally {
                  setDecliningBusy(false);
                }
              }}
              data-testid="invites.decline-confirm-cta"
            >
              {t("invites.declineCta")}
            </Button>
          </div>
        </ModalShell>
      ) : null}
      <PersonRegisterDialog
        open={registerOpen}
        testIdPrefix="invites.register"
        onRegistered={() => {
          setRegisterOpen(false);
          onRetry();
        }}
        onClose={() => setRegisterOpen(false)}
      />
    </ModalShell>
  );
}
