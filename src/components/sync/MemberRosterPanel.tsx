// SPDX-License-Identifier: AGPL-3.0
// The B2B member-roster panel (myne-md/myne#698, b2b-identity-substrate
// task 9). Three surfaces, in order: unlock the backend-held person
// identity once per process, invite a member, and list/remove members.
//
// The invite collects the invitee's three public hex values by paste. The
// automatic fetch of those values from the invitee's SCRAM account is the
// Grill 4 wire contract, so it is not here; the paste path is the complete
// flow until that lands, and the crypto behind it is identical either way.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useRoster } from "../../hooks/useRoster";
import { usePrefs } from "../../hooks/usePrefs";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Button } from "../primitives/Button";

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
  const {
    members,
    loading,
    error,
    inviting,
    lastInvite,
    invite,
    unlockPerson,
    lockPerson,
  } = useRoster();
  const [personReady, setPersonReady] = useState(false);
  const [personError, setPersonError] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Removal is parked until the roster wire ships, so there is no removal
  // dialog: the only child dialog is the invite form.
  const childDialogOpen = inviteOpen;
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
          <input
            data-testid="member-roster.phrase-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label={t("sync.memberRoster.personHint")}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            style={INPUT_STYLE}
          />
          <Button
            type="button"
            variant="primary"
            data-testid="member-roster.person-unlock-button"
            onClick={async () => {
              try {
                await unlockPerson(phrase);
                setPhrase("");
                setPersonError(false);
                setPersonReady(true);
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
          <Button
            type="button"
            data-testid="member-roster.person-lock-button"
            onClick={async () => {
              await lockPerson();
              setPersonReady(false);
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
          <ul data-testid="member-roster.list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {members.map((m) => (
              <li key={m.fingerprint_hex} data-testid="member-roster.row" data-fingerprint={m.fingerprint_hex} style={ROW_STYLE}>
                <span data-testid="member-roster.name" style={NAME_STYLE}>
                  {m.display_name}
                </span>
                <span data-testid="member-roster.fingerprint" style={CODE_STYLE}>
                  {m.fingerprint_hex.slice(0, 16)}
                </span>
                {m.previous_fingerprint_hex ? (
                  <span data-testid="member-roster.rotated" style={CODE_STYLE}>
                    {t("sync.memberRoster.rotated")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <p data-testid="member-roster.remove-disabled" style={STATUS_STYLE}>
            {t("sync.memberRoster.removeConfirm")}
          </p>
        </>
      )}

      {/* Step 3: invite. */}
      <Button
        type="button"
        variant="primary"
        data-testid="member-roster.invite-button"
        disabled={!personReady || inviting}
        onClick={() => setInviteOpen(true)}
      >
        {t("sync.memberRoster.invite")}
      </Button>

      {inviteOpen ? (
        <InviteMemberModal
          busy={inviting}
          onCancel={() => setInviteOpen(false)}
          onSubmit={async (input) => {
            try {
              await invite({
                ...input,
                // The vault's own name (the sealed `vault.prefs.label`), not
                // the panel heading: the invited member is told what the
                // shared vault is called.
                vaultLabel: prefs.label ?? t("sync.memberRoster.untitledVault"),
                createdAtSecs: Math.floor(Date.now() / 1000),
              });
              setInviteOpen(false);
            } catch {
              setActionError(t("sync.memberRoster.inviteFailed"));
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

/** The invite form. The invitee's public material is pasted; fetching it
 *  automatically is the Grill 4 wire contract. */
function InviteMemberModal({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: {
    memberKemEkHex: string;
    memberEdPkHex: string;
    memberMldsaVkHex: string;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [kem, setKem] = useState("");
  const [ed, setEd] = useState("");
  const [mldsa, setMldsa] = useState("");
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
      <label>
        {t("sync.memberRoster.kemLabel")}
        <input
          data-testid="member-roster.invite-kem"
          value={kem}
          onChange={(e) => setKem(e.target.value)}
          style={INPUT_STYLE}
        />
      </label>
      <label>
        {t("sync.memberRoster.edLabel")}
        <input
          data-testid="member-roster.invite-ed"
          value={ed}
          onChange={(e) => setEd(e.target.value)}
          style={INPUT_STYLE}
        />
      </label>
      <label>
        {t("sync.memberRoster.mldsaLabel")}
        <input
          data-testid="member-roster.invite-mldsa"
          value={mldsa}
          onChange={(e) => setMldsa(e.target.value)}
          style={INPUT_STYLE}
        />
      </label>
      <Button type="button" data-testid="member-roster.invite-cancel" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button
        type="button"
        variant="primary"
        data-testid="member-roster.invite-confirm"
        disabled={busy || kem === "" || ed === "" || mldsa === ""}
        onClick={() =>
          onSubmit({ memberKemEkHex: kem, memberEdPkHex: ed, memberMldsaVkHex: mldsa })
        }
      >
        {t("sync.memberRoster.invite")}
      </Button>
    </div>
  );
}
