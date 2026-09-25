// SPDX-License-Identifier: AGPL-3.0
// The B2B member-roster panel (myne-md/myne#698, b2b-identity-substrate
// task 9). Three surfaces, in order: unlock the backend-held person
// identity once per process, invite a member, and list/remove members.
//
// The invite collects the invitee's three public hex values by paste. The
// automatic fetch of those values from the invitee's SCRAM account is the
// Grill 4 wire contract, so it is not here; the paste path is the complete
// flow until that lands, and the crypto behind it is identical either way.
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { useRoster, type RosterMember } from "../../hooks/useRoster";
import { startB2bMigration, inspectInviteCode } from "../../lib/invite";
import { copyText } from "../../lib/clipboard";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";

/** The `kind` of a serialized backend error, or `null` for anything else. */
function syncErrorKind(e: unknown): string | null {
  if (e && typeof e === "object" && "kind" in e) {
    const kind = (e as { kind: unknown }).kind;
    if (typeof kind === "string") return kind;
  }
  return null;
}
import { usePrefs } from "../../hooks/usePrefs";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Button } from "../primitives/Button";
import { Input } from "../primitives/Input";
import { EnrollPhraseCredential, PHRASE_CELL_COUNT } from "./EnrollPhraseCredential";
import { buildPhraseCredential } from "./phrase-credential";
import { toast } from "../toast/toastStore";
import {
  getPersonIdentityGeneration,
  setPersonIdentityState,
  setPersonIdentityStateForGeneration,
  usePersonIdentityState,
} from "./personIdentityState";

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) 0",
  borderBottom: "1px solid var(--line-1)",
};

const NAME_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  minWidth: 0,
};

const CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const STATUS_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const ERROR_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

const INPUT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  width: "100%",
};

export function MemberRosterPanel({
  onDialogOpenChange,
}: {
  /** Raises the shell's child-dialog flag so one Escape closes THIS dialog
   *  rather than the whole Settings modal (SettingsModal's own gate comment). */
  onDialogOpenChange?: (open: boolean) => void;
} = {}) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  const { ready: personReady, ownerCode } = usePersonIdentityState();
  const {
    members,
    authority,
    groupKeyEpoch,
    loading,
    error,
    inviting,
    lastInvite,
    invite,
    vaultInvites,
    vaultInvitesFailed,
    removing,
    remove,
    unlockPerson,
    lockPerson,
  } = useRoster(personReady);
  const [personError, setPersonError] = useState(false);
  const [phraseCells, setPhraseCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RosterMember | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<"success" | "error" | null>(null);

  const copyOwnerCode = () => {
    if (!ownerCode) return;
    setCopyFeedback(null);
    void copyText(clipboardWriteText, ownerCode, {
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

  const setPhraseCell = (index: number, value: string) => {
    setPersonError(false);
    const cleaned = value.replace(/\s+/g, "");
    setPhraseCells((cells) => cells.map((cell, i) => (i === index ? cleaned : cell)));
  };

  const handlePhraseCellChange =
    (index: number) => (event: ChangeEvent<HTMLInputElement>) => {
      setPhraseCell(index, event.target.value);
    };

  const handlePhraseCellPaste =
    (index: number) => (event: ClipboardEvent<HTMLInputElement>) => {
      const tokens = event.clipboardData
        .getData("text")
        .split(/\s+/)
        .filter((token) => token.length > 0);
      if (tokens.length < 2) return;
      event.preventDefault();
      setPersonError(false);
      setPhraseCells((cells) => {
        const next = [...cells];
        for (let i = 0; i < tokens.length && index + i < PHRASE_CELL_COUNT; i += 1) {
          next[index + i] = tokens[i];
        }
        return next;
      });
    };

  // removal confirm are the two child dialogs.
  const childDialogOpen = inviteOpen || removeTarget !== null;
  useEffect(() => {
    onDialogOpenChange?.(childDialogOpen);
    return () => onDialogOpenChange?.(false);
  }, [childDialogOpen, onDialogOpenChange]);

  if (loading) {
    return (
      <p data-testid="member-roster.loading" style={STATUS_STYLE}>
        {t("sync.memberRoster.loading")}
      </p>
    );
  }

  if (error) {
    return (
      <p data-testid="member-roster.error" style={ERROR_STYLE}>
        {t("sync.memberRoster.error")}
      </p>
    );
  }

  return (
    <div data-testid="member-roster">
      {/* Step 1: the person identity. One unlock per process. */}
      {!personReady ? (
        <div data-testid="member-roster.person-unlock">
          <p style={STATUS_STYLE}>{t("sync.memberRoster.personHint")}</p>
          <EnrollPhraseCredential
            baseId="member-roster"
            label={t("sync.memberRoster.personHint")}
            cells={phraseCells}
            onCellChange={handlePhraseCellChange}
            onCellPaste={handlePhraseCellPaste}
            gridTestId="member-roster.phrase-grid"
            cellTestId={(index) =>
              index === 0 ? "member-roster.phrase-input" : `member-roster.phrase-cell-${index + 1}`
            }
          />

          <Button
            type="button"
            variant="primary"
            data-testid="member-roster.person-unlock-button"
            disabled={!phraseCells.every((cell) => cell.length > 0)}
            onClick={async () => {
              const unlockGeneration = getPersonIdentityGeneration();
              try {
                const view = await unlockPerson(buildPhraseCredential(phraseCells));
                if (!setPersonIdentityStateForGeneration(unlockGeneration, {
                  ready: true,
                  ownerCode: view.identity_code,
                })) {
                  return;
                }
                setPhraseCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
                setPersonError(false);
                setCopyFeedback(null);
              } catch {
                setPersonError(true);
              }
            }}
          >
            {t("sync.memberRoster.personUnlock")}
          </Button>
          {personError ? (
            <p data-testid="member-roster.person-error" style={ERROR_STYLE}>
              {t("sync.memberRoster.personError")}
            </p>
          ) : null}
        </div>
      ) : (
        <div data-testid="member-roster.person-ready">
          <p style={STATUS_STYLE}>{t("sync.memberRoster.personReady")}</p>
          {/* The owner's own out-of-band identity code: share it with an invitee
              so they can verify the group package the owner sends. Public
              material only. */}
          {authority === "owner" && ownerCode ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <p style={STATUS_STYLE}>{t("sync.memberRoster.ownerCodeHint")}</p>
              <Input
                data-testid="member-roster.owner-code"
                aria-label={t("sync.memberRoster.ownerCodeHint")}
                autoComplete="off"
                readOnly
                value={ownerCode}
                style={{ ...CODE_STYLE, width: "100%", userSelect: "all" }}
              />
              <Button
                type="button"
                variant="secondary"
                data-testid="member-roster.copy-owner-code"
                onClick={copyOwnerCode}
              >
                {t("personIdentityCode.copy")}
              </Button>
              {copyFeedback === "error" ? (
                <p
                  data-testid="member-roster.copy-feedback"
                  role="status"
                  aria-live="polite"
                  style={ERROR_STYLE}
                >
                  {t("personIdentityCode.copyFailed")}
                </p>
              ) : copyFeedback === "success" ? (
                <p
                  data-testid="member-roster.copy-feedback"
                  role="status"
                  aria-live="polite"
                  style={STATUS_STYLE}
                >
                  {t("personIdentityCode.copied")}
                </p>
              ) : null}
            </div>
          ) : null}
          <Button
            type="button"
            data-testid="member-roster.person-lock-button"
            onClick={async () => {
              await lockPerson();
              setCopyFeedback(null);
              setPersonIdentityState({ ready: false, ownerCode: null });
            }}
          >
            {t("sync.memberRoster.personLock")}
          </Button>
        </div>
      )}

      {/* Step 2: the roster. Removal is parked until the roster wire ships:
          no per-row Remove button renders, and the notice below states the
          disabled state instead of promising a flow that cannot run. */}
      {members.length === 0 ? (
        <p data-testid="member-roster.empty" style={STATUS_STYLE}>
          {t("sync.memberRoster.empty")}
        </p>
      ) : (
        <>
          {groupKeyEpoch !== null ? (
            <p data-testid="member-roster.epoch" style={STATUS_STYLE}>
              {t("sync.memberRoster.epoch", { epoch: groupKeyEpoch })}
            </p>
          ) : null}
          <ul data-testid="member-roster.list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {members.map((m) => (
              <li key={m.fingerprint_hex} data-testid="member-roster.row" data-fingerprint={m.fingerprint_hex} style={ROW_STYLE}>
                <span data-testid="member-roster.name" style={NAME_STYLE}>
                  {m.display_name}
                </span>
                <span data-testid="member-roster.role" style={CODE_STYLE}>
                  {m.role === "owner"
                    ? t("sync.memberRoster.ownerBadge")
                    : t("sync.memberRoster.memberBadge")}
                </span>
                <span data-testid="member-roster.fingerprint" style={CODE_STYLE}>
                  {m.fingerprint_hex.slice(0, 16)}
                </span>
                {/* A cryptographic key change and an owner-confirmed relink are
                    DIFFERENT states and must read differently: the first is a
                    new identity the owner has not vouched for, the second is the
                    owner re-confirming a transition. */}
                {m.continuity === "changed" ? (
                  <span data-testid="member-roster.key-changed" style={ERROR_STYLE}>
                    {t("sync.memberRoster.keyChanged")}
                  </span>
                ) : null}
                {m.continuity === "owner-confirmed" ? (
                  <span data-testid="member-roster.relink-confirmed" style={CODE_STYLE}>
                    {t("sync.memberRoster.relinkConfirmed")}
                  </span>
                ) : null}
                {/* A legacy roster row carries `continuity: null` while still
                    forwarding `previous_fingerprint_hex`; treat it as the
                    `current` arm so a rotated legacy row keeps its badge. */}
                {(m.continuity === "current" || m.continuity === null) &&
                m.previous_fingerprint_hex ? (
                  <span data-testid="member-roster.rotated" style={CODE_STYLE}>
                    {t("sync.memberRoster.rotated")}
                  </span>
                ) : null}
                {authority === "owner" && m.role === "member" ? (
                  <Button
                    type="button"
                    data-testid="member-roster.remove-button"
                    onClick={() => setRemoveTarget(m)}
                  >
                    {t("sync.memberRoster.remove")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <p data-testid="member-roster.removal-limits" style={STATUS_STYLE}>
            {t("sync.memberRoster.removalLimits")}
          </p>
        </>
      )}

      {/* Sent invitations, owner-only: claimed versus pending. The roster row
          exists from invite time, so this list is how the owner tells an
          accepted invite from one nobody has claimed yet. */}
      {authority === "owner" && vaultInvites.length > 0 ? (
        <div data-testid="member-roster.invitations">
          <p style={STATUS_STYLE}>{t("sync.memberRoster.invitationsHeading")}</p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {vaultInvites.map((inv) => (
              <li
                key={inv.invite_id_hex}
                data-testid="member-roster.invitation-row"
                style={ROW_STYLE}
              >
                <span data-testid="member-roster.invitation-recipient" style={CODE_STYLE}>
                  {inv.recipient_person_id_hex.slice(0, 16)}
                </span>
                <span
                  data-testid="member-roster.invitation-status"
                  data-claimed={inv.claimed ? "true" : "false"}
                  style={STATUS_STYLE}
                >
                  {inv.claimed
                    ? t("sync.memberRoster.invitationClaimed")
                    : t("sync.memberRoster.invitationPending")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {authority === "owner" && personReady && vaultInvitesFailed ? (
        <p data-testid="member-roster.invitations-error" role="alert" style={ERROR_STYLE}>
          {t("sync.memberRoster.invitationsFailed")}
        </p>
      ) : null}

      {/* Step 3: invite. Owner-only: a member is never shown an admin
          control they cannot use (the backend refuses with `NotOwner`). */}
      {authority === "owner" ? (
        <Button
          type="button"
          variant="primary"
          data-testid="member-roster.invite-button"
          disabled={!personReady || inviting}
          onClick={() => setInviteOpen(true)}
        >
          {t("sync.memberRoster.invite")}
        </Button>
      ) : null}

      {inviteOpen ? (
        <InviteMemberModal
          busy={inviting}
          onCancel={() => setInviteOpen(false)}
          onSubmit={async (input) => {
            const vaultLabel = prefs.label ?? t("sync.memberRoster.untitledVault");
            const args = {
              ...input,
              // The vault's own name (the sealed `vault.prefs.label`), not the
              // panel heading: the invited member is told what the shared vault
              // is called.
              vaultLabel,
              createdAtSecs: Math.floor(Date.now() / 1000),
            };
            try {
              await invite(args);
              setInviteOpen(false);
              return;
            } catch (e) {
              // The first B2B action on a pre-B2B vault migrates it to NTV6.
              // The backend refuses the invite with `MigrationRequired` until
              // that commit, so run the explicit migration and retry ONCE. Any
              // other failure is reported as-is.
              if (syncErrorKind(e) !== "MigrationRequired") {
                setActionError(t("sync.memberRoster.inviteFailed"));
                return;
              }
            }
            try {
              await startB2bMigration(vaultLabel);
              await invite(args);
              setInviteOpen(false);
            } catch {
              setActionError(t("sync.memberRoster.inviteFailed"));
            }
          }}
        />
      ) : null}

      {removeTarget ? (
        <RemoveConfirmDialog
          name={
            removeTarget.display_name ||
            removeTarget.fingerprint_hex.slice(0, 16)
          }
          busy={removing}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={async () => {
            try {
              await remove(removeTarget.fingerprint_hex);
              setRemoveTarget(null);
            } catch {
              setActionError(t("sync.memberRoster.removeFailed"));
            }
          }}
        />
      ) : null}

      {lastInvite ? (
        <p data-testid="member-roster.invite-result" style={CODE_STYLE}>
          {t("sync.memberRoster.inviteReady", {
            fingerprint: lastInvite.member_fingerprint_hex.slice(0, 16),
          })}
        </p>
      ) : null}

      {actionError ? (
        <p data-testid="member-roster.action-error" style={ERROR_STYLE}>
          {actionError}
        </p>
      ) : null}
    </div>
  );
}

/** Escape closes the topmost child dialog (the invite form, while removal
 *  is parked). */
function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
}

/** The removal confirm. A modal dialog with a focus trap and Escape-to-close,
 *  matching `InviteMemberModal`, so focus is moved in and `aria-modal="true"`
 *  is truthful. */
function RemoveConfirmDialog({
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { enabled: true });
  useEscapeToClose(onCancel);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={t("sync.memberRoster.remove")}
      data-testid="member-roster.remove-confirm"
      style={STATUS_STYLE}
    >
      <p>{t("sync.memberRoster.removeConfirm", { name })}</p>
      <Button
        type="button"
        data-testid="member-roster.remove-cancel"
        onClick={onCancel}
      >
        {t("common.cancel")}
      </Button>
      <Button
        type="button"
        variant="primary"
        data-testid="member-roster.remove-submit"
        disabled={busy}
        onClick={() => void onConfirm()}
      >
        {t("sync.memberRoster.remove")}
      </Button>
    </div>
  );
}

/** The invite form. The invitee's identity code is pasted; the SAS fingerprint
 *  it decodes to is shown and must be explicitly confirmed before the invite is
 *  sealed and relayed. The code carries public material only. */
function InviteMemberModal({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { recipientCode: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [inspectError, setInspectError] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { enabled: true });
  useEscapeToClose(onCancel);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={t("sync.memberRoster.invite")}
      data-testid="member-roster.invite-modal"
      style={STATUS_STYLE}
    >
      <p>{t("sync.memberRoster.inviteHint")}</p>
      <textarea
        data-testid="member-roster.invite-code"
        aria-label={t("sync.memberRoster.inviteCodeLabel")}
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          // A changed code invalidates a previous compare.
          setFingerprint(null);
          setConfirmed(false);
          setInspectError(false);
        }}
        rows={4}
        style={INPUT_STYLE}
      />
      {fingerprint === null ? (
        <Button
          type="button"
          data-testid="member-roster.inspect"
          disabled={code.trim() === ""}
          onClick={async () => {
            try {
              const view = await inspectInviteCode(code.trim());
              setFingerprint(view.fingerprint_hex);
              setInspectError(false);
            } catch {
              setInspectError(true);
            }
          }}
        >
          {t("sync.memberRoster.inspect")}
        </Button>
      ) : (
        <div data-testid="member-roster.sas">
          <p>{t("sync.memberRoster.sasHint")}</p>
          <code data-testid="member-roster.sas-fingerprint" style={CODE_STYLE}>
            {fingerprint}
          </code>
          <label style={{ display: "block" }}>
            <input
              type="checkbox"
              data-testid="member-roster.sas-confirm"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {t("sync.memberRoster.sasConfirm")}
          </label>
        </div>
      )}
      {inspectError ? (
        <p data-testid="member-roster.inspect-error" style={ERROR_STYLE}>
          {t("sync.memberRoster.inviteCodeInvalid")}
        </p>
      ) : null}
      <Button type="button" data-testid="member-roster.invite-cancel" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button
        type="button"
        variant="primary"
        data-testid="member-roster.invite-confirm"
        disabled={busy || fingerprint === null || !confirmed}
        onClick={() => onSubmit({ recipientCode: code.trim() })}
      >
        {t("sync.memberRoster.invite")}
      </Button>
    </div>
  );
}
