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
import type { InviteSummary } from "../../lib/personAccount";
import type { InvitesUnavailable } from "../../hooks/usePendingInvites";
import { unclaimedInvites } from "../../hooks/usePendingInvites";

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
  onAccepted: () => void;
}

const BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-5)",
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

  const close = () => {
    setAccepting(null);
    setJoining(null);
    onClose();
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
              {t("invites.retry")}
            </Button>
          </div>
        </>
      ) : unavailable === "no-identity" ? (
        <p style={HINT_STYLE} data-testid="invites.no-identity">
          {t("invites.noIdentity")}
        </p>
      ) : unavailable === "not-enrolled" ? (
        <p style={HINT_STYLE} data-testid="invites.not-enrolled">
          {t("invites.notEnrolled")}
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
          {t("invites.empty")}
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
                  <Button
                    variant="primary"
                    onClick={() => setAccepting(invite)}
                    data-testid="invites.accept"
                  >
                    {t("identityHome.accept")}
                  </Button>
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
    </ModalShell>
  );
}
