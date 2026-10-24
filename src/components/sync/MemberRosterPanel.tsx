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
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { useRoster, type RosterMember } from "../../hooks/useRoster";
import { startB2bMigration } from "../../lib/invite";
import { copyText } from "../../lib/clipboard";
import { writeText as clipboardWriteText } from "../../platform/clipboardManager";
import { usePrefs } from "../../hooks/usePrefs";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { VISUALLY_HIDDEN } from "../primitives/visuallyHidden";
import { EmptyState } from "../primitives/EmptyState";
import { Input } from "../primitives/Input";
import { HELPER_STYLE, MULTILINE_STYLE } from "../settings/panel-styles";
import { SettingsSection } from "../settings/SettingsSection";
import { toast } from "../toast/toastStore";
import { clearMyMemberName, memberNameErrorKey, setMyMemberName } from "../../lib/memberNames";
import {
  setPersonIdentityState,
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
  // The panel stacks several sentences; without this each `<p>` keeps the
  // WebView's default paragraph margin and the flex gap doubles on top of it,
  // which is what opened the dead gaps between the identity-status lines.
  margin: 0,
};

/** The panel's outer rhythm: each sub-section is one `SettingsSection`, so the
 *  gaps match every other settings panel instead of a private `--space-3`. */
const ROOT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-5)",
  alignSelf: "stretch",
  width: "100%",
};

const LIST_STYLE: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

/** A section's own vertical rhythm. The panel's two identity blocks are plain
 *  divs, so without this the primary button sits flush against the phrase grid's
 *  last row (myne-md/myne#764). */
const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  alignSelf: "stretch",
};

/** The `EndpointConfig` server-URL row, which the identity code deliberately
 *  matches: the field takes the flexible width and its actions sit BESIDE it as
 *  compact buttons, rather than a full-width copy button with a second one on a
 *  line of its own below (myne-md/myne#764). */
const FIELD_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
};

/** Actions in a `FIELD_ROW_STYLE` row keep their label on one line and never
 *  give ground to the field. */
const ROW_ACTION_STYLE: CSSProperties = {
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const ERROR_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

/** The unverified-name marker (`myne-md/myne#851` task 5). `--warning` rather
 *  than `--danger`: a name record whose signature does not check out is a fact to
 *  state plainly, not an alarm about a vault that is broken here and now, and the
 *  row keeps the fingerprint beside it as the identifier that IS trustworthy. */
const WARNING_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--warning)",
};

/** The identity marker beside a NAMED self row. The row renders its own display
 *  name like every other row (you see your own name where others see it), and
 *  this is what still says which row is yours. When the self row has no verified
 *  name the name slot itself carries the badge, so this does not double it. */
const YOU_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

/** The inline rename form on the caller's own row. It WRAPS rather than laying
 *  the buttons out on a second block, so the row keeps one line at the widths the
 *  members list is read at and the buttons drop below only when they must. */
const NAME_FORM_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
};

/** A writer failure under the field, on its own line of that wrapped form. */
const NAME_ERROR_STYLE: CSSProperties = {
  ...ERROR_STYLE,
  flexBasis: "100%",
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
    loading,
    error,
    inviting,
    lastInvite,
    invite,
    vaultInvites,
    vaultInvitesFailed,
    shared,
    removing,
    remove,
    lockPerson,
    reload,
  } = useRoster(personReady);
  const [inviteOpen, setInviteOpen] = useState(false);
  // The NTV5→NTV6 confirmation, shown before the invite form on an unshared
  // vault (myne-md/myne#783). The migration is permanent, so it is an explicit
  // step rather than a hidden retry.
  const [shareConfirmOpen, setShareConfirmOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RosterMember | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The copy reports on the BUTTON (2026-10-24): a tick and one pop, said out
  // loud in the live region below. A failure still goes to the toast, because a
  // control cannot report "that did not work" by looking happy.
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );
  // Forget this device's person identity (myne-md/myne#782). `lockPerson` is a
  // session lock; the `true` argument is the off-boarding erase.
  const [forgetOpen, setForgetOpen] = useState(false);
  const [forgetAck, setForgetAck] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [forgetError, setForgetError] = useState(false);
  // The inline name editor (myne-md/myne#851 task 6). Only ever open on the
  // caller's OWN row: the backend keys a name row by the session's own person id
  // and signs it with the session's own key, so there is no other row it could
  // write. Held by FINGERPRINT rather than by the row object, so a reload that
  // replaces the row array does not silently close the editor mid-typing.
  const [nameEdit, setNameEdit] = useState<{
    fingerprint: string;
    draft: string;
  } | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const openNameEditor = (m: RosterMember) => {
    setNameError(null);
    setNameEdit({ fingerprint: m.fingerprint_hex, draft: m.display_name });
  };
  const closeNameEditor = () => {
    setNameEdit(null);
    setNameError(null);
  };
  const saveName = async () => {
    if (!nameEdit) return;
    setNameBusy(true);
    setNameError(null);
    try {
      await setMyMemberName(nameEdit.draft.trim());
      closeNameEditor();
      reload();
    } catch (e) {
      setNameError(memberNameErrorKey(e));
    } finally {
      setNameBusy(false);
    }
  };
  const clearName = async () => {
    setNameBusy(true);
    setNameError(null);
    try {
      await clearMyMemberName();
      closeNameEditor();
      reload();
    } catch (e) {
      setNameError(memberNameErrorKey(e));
    } finally {
      setNameBusy(false);
    }
  };

  const forgetIdentity = async () => {
    setForgetBusy(true);
    setForgetError(false);
    try {
      await lockPerson(true);
      setPersonIdentityState({ ready: false, ownerCode: null });
      setForgetOpen(false);
      setForgetAck(false);
    } catch {
      setForgetError(true);
    } finally {
      setForgetBusy(false);
    }
  };

  const copyOwnerCode = () => {
    if (!ownerCode) return;
    void copyText(clipboardWriteText, ownerCode, {
      onSuccess: {
        kind: "toast",
        run: () => {
          setCopied(true);
          if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
          copyTimer.current = window.setTimeout(() => {
            setCopied(false);
            copyTimer.current = null;
          }, 1600);
        },
      },
      onFailure: {
        kind: "toast",
        run: () => {
          toast({ message: t("personIdentityCode.copyFailed"), variant: "error" });
        },
      },
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

  // The one lock control, rendered either inside the identity-code row (owner,
  // beside Copy) or on its own line (a member has no code to show). Declared
  // once so the two arms cannot drift apart.
  const lockButton = (
    <Button
      type="button"
      data-testid="member-roster.person-lock-button"
      style={ROW_ACTION_STYLE}
      onClick={async () => {
        await lockPerson();
          setPersonIdentityState({ ready: false, ownerCode: null });
      }}
    >
      {t("sync.memberRoster.personLock")}
    </Button>
  );


  // The invite action, built once and placed in ONE of two spots: inside the
  // members zero state while the list is empty, centred under its sentence, and
  // below the list once it has rows (myne-md/myne#867, on the user's read: "put
  // the invite button under the zero state's description, centred"). The zero
  // state already says "invite someone", so the button belongs with that
  // sentence rather than floating under the box.
  const inviteButton = (
    <Button
      type="button"
      variant="primary"
      data-testid="member-roster.invite-button"
      disabled={!personReady || inviting}
      onClick={() => {
        // An `NTV5` vault gains the group tier on its first invite, which
        // is PERMANENT. Say so BEFORE the form, rather than letting the
        // user submit and infer it from a hidden retry (myne-md/myne#783).
        if (!shared) {
          setShareConfirmOpen(true);
          return;
        }
        setInviteOpen(true);
      }}
    >
      {t("sync.memberRoster.invite")}
    </Button>
  );

  return (
    <div data-testid="member-roster" style={ROOT_STYLE}>
      {/* The inviting identity: the person this device invites as, shown once
          it is unlocked (the Sync panel's Identity block is the one place it is
          unlocked, myne-md/myne#831). Grouped under its own heading so it reads
          apart from the member list and the invitations below. */}
      {personReady ? (
      <SettingsSection
        title={t("sync.memberRoster.identityHeading")}
        testId="member-roster.identity-section"
      >
        <div data-testid="member-roster.person-ready" style={SECTION_STYLE}>
          <p style={STATUS_STYLE}>{t("sync.memberRoster.personReady")}</p>
          {/* The owner's own out-of-band identity code: share it with an invitee
              so they can verify the group package the owner sends. Public
              material only. */}
          {authority === "owner" && ownerCode ? (
            <>
              <p style={STATUS_STYLE}>{t("sync.memberRoster.ownerCodeHint")}</p>
              {/* The `EndpointConfig` server-URL row's shape: the code takes the
                  flexible width and both actions sit beside it, so a 180-hex
                  code and two controls share one line instead of three
                  (myne-md/myne#764). */}
              <div style={FIELD_ROW_STYLE}>
                <Input
                  data-testid="member-roster.owner-code"
                  aria-label={t("sync.memberRoster.ownerCodeHint")}
                  autoComplete="off"
                  readOnly
                  value={ownerCode}
                  style={{ ...CODE_STYLE, flex: 1, minWidth: 0, userSelect: "all" }}
                />
                <IconButton
                  icon="copy"
                  label={t("personIdentityCode.copy")}
                  bordered
                  tooltip
                  confirmed={copied}
                  testId="member-roster.copy-owner-code"
                  onClick={copyOwnerCode}
                />
                {lockButton}
              </div>
              {/* The tick's screen-reader half. Nothing is drawn: the button IS
                  the report (2026-10-24), and the line that used to sit here
                  repeated the toast's own sentence under the field. */}
              <p
                role="status"
                aria-live="polite"
                data-testid="member-roster.copy-status"
                style={VISUALLY_HIDDEN}
              >
                {copied ? t("personIdentityCode.copied") : ""}
              </p>
            </>
          ) : (
            lockButton
          )}

          {/* Forget this device's identity entirely (myne-md/myne#782): erases
              the sealed keypair and the device token. Device-local; the server
              account and any vault it owns or joined are untouched. */}
          {forgetOpen ? (
            <div
              data-testid="member-roster.forget-confirm"
              style={{
                marginTop: "var(--space-2)",
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
                border: "1px solid var(--danger)",
                borderRadius: "var(--radius-2)",
                padding: "var(--space-3)",
              }}
            >
              <p data-testid="member-roster.forget-warning" style={{ ...STATUS_STYLE, margin: 0 }}>
                {t("sync.memberRoster.identityForgetWarning")}
              </p>
              <label
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  alignItems: "center",
                  fontSize: "var(--text-sm)",
                  color: "var(--fg-1)",
                }}
              >
                <input
                  type="checkbox"
                  data-testid="member-roster.forget-ack"
                  checked={forgetAck}
                  onChange={(e) => setForgetAck(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: "var(--accent)" }}
                />
                {t("sync.memberRoster.identityForgetCheckbox")}
              </label>
              {forgetError ? (
                <p data-testid="member-roster.forget-error" style={{ ...ERROR_STYLE, margin: 0 }}>
                  {t("sync.memberRoster.identityForgetError")}
                </p>
              ) : null}
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={forgetBusy}
                  onClick={() => {
                    setForgetOpen(false);
                    setForgetAck(false);
                    setForgetError(false);
                  }}
                  data-testid="member-roster.forget-cancel"
                >
                  {t("sync.memberRoster.identityForgetCancel")}
                </Button>
                <div style={{ flex: 1 }} />
                <Button
                  type="button"
                  variant="danger"
                  disabled={!forgetAck || forgetBusy}
                  onClick={() => void forgetIdentity()}
                  data-testid="member-roster.forget-confirm-cta"
                >
                  {t("sync.memberRoster.identityForgetConfirm")}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="ghost"
              style={{ ...ROW_ACTION_STYLE, marginTop: "var(--space-2)", alignSelf: "flex-start" }}
              onClick={() => {
                setForgetOpen(true);
                setForgetError(false);
              }}
              data-testid="member-roster.forget-cta"
            >
              {t("sync.memberRoster.identityForgetCta")}
            </Button>
          )}
        </div>
      </SettingsSection>
      ) : null}

      {/* The members list and the invite action that adds to it. */}
      <SettingsSection
        title={t("sync.memberRoster.membersHeading")}
        testId="member-roster.members-section"
      >
      {members.length === 0 ? (
        <EmptyState
          variant="firstRun"
          icon="user"
          size="sm"
          title={t("sync.memberRoster.emptyTitle")}
          body={t("sync.memberRoster.empty")}
          {...(authority === "owner" ? { action: inviteButton } : {})}
          testId="member-roster.empty"
        />
      ) : (
        <>
          <ul data-testid="member-roster.list" style={LIST_STYLE}>
            {members.map((m) => (
              /* The row's `data-fingerprint` discriminator carries the SAME
                 16-char prefix the row renders, never the raw 32-hex value: a
                 DOM that holds more than the user can see is a DOM that leaks
                 whatever the extra characters are, and `key` already carries the
                 full value without writing it to the document. */
              <li key={m.fingerprint_hex} data-testid="member-roster.row" data-fingerprint={m.fingerprint_hex.slice(0, 16)} style={ROW_STYLE}>
                {/* ONE RULE FOR EVERY ROW (myne-md/myne#851 task 5): the
                    VERIFIED name where there is one, the short fingerprint where
                    there is not, and a marker when a record exists that nobody's
                    signature backs. Nothing here keys on `role`: the owner's row
                    follows the same rule as every other, which is what retires the
                    migration-captured vault label the hand-written role guard used
                    to suppress (myne#795 UI pass). A tampered record is never
                    rendered as a name; it is absent from the payload entirely,
                    since `partition_verified` drops it, so the marker says the
                    record failed rather than showing what it claimed. The caller's
                    OWN row is the one addition, and only in that it also carries a
                    "You" marker: `is_self` decides it by identity, never by role
                    (myne#859), and its name renders like anyone else's so its
                    owner can see what the others see. */}
                {nameEdit?.fingerprint === m.fingerprint_hex ? (
                  <NameEditor
                    draft={nameEdit.draft}
                    busy={nameBusy}
                    errorKey={nameError}
                    onChange={(draft) => setNameEdit({ fingerprint: m.fingerprint_hex, draft })}
                    onSave={() => void saveName()}
                    onClear={() => void clearName()}
                    onCancel={closeNameEditor}
                  />
                ) : m.is_self ? (
                  /* The caller's OWN row follows the same name rule as every other
                     (a verified name is rendered where there is one), and keeps a
                     "You" marker beside it so identity survives. Only an UNNAMED
                     self row still shows the badge in the name slot, because there
                     is no name to show. */
                  <>
                    <span data-testid="member-roster.name" style={NAME_STYLE}>
                      {m.name_state === "verified"
                        ? m.display_name
                        : t("sync.memberRoster.youBadge")}
                    </span>
                    {m.name_state === "verified" ? (
                      <span data-testid="member-roster.you" style={YOU_STYLE}>
                        {t("sync.memberRoster.youBadge")}
                      </span>
                    ) : null}
                  </>
                ) : m.name_state === "verified" ? (
                  <span data-testid="member-roster.name" style={NAME_STYLE}>
                    {m.display_name}
                  </span>
                ) : (
                  <>
                    <span data-testid="member-roster.fingerprint" style={CODE_STYLE}>
                      {m.fingerprint_hex.slice(0, 16)}
                    </span>
                    {m.name_state === "unverified" ? (
                      <span data-testid="member-roster.name-unverified" style={WARNING_STYLE}>
                        {t("sync.memberRoster.nameUnverified")}
                      </span>
                    ) : null}
                  </>
                )}
                <span data-testid="member-roster.role" style={CODE_STYLE}>
                  {m.role === "owner"
                    ? t("sync.memberRoster.ownerBadge")
                    : t("sync.memberRoster.memberBadge")}
                </span>
                {/* The rename affordance, on the caller's own row only, the
                    owner's included: `is_self` is the identity-based test the
                    backend enforces in the key, and `shared` is here because the
                    family is `NTV6`-only, so on a birth-format vault the control
                    would only ever answer `NotASharedVault`. Omitted rather than
                    shown broken, per the platform-seam rule. */}
                {m.is_self && shared && nameEdit === null ? (
                  <Button
                    type="button"
                    variant={m.name_state === "verified" ? "ghost" : "secondary"}
                    data-testid="member-roster.name-edit"
                    onClick={() => openNameEditor(m)}
                  >
                    {m.name_state === "verified"
                      ? t("sync.memberRoster.nameEdit")
                      : t("sync.memberRoster.nameInviteCta")}
                  </Button>
                ) : null}
                {/* The invitation used to be a sentence plus a `Not now` link
                    (myne-md/myne#851 task 9). Both are gone: the dismissal was
                    session-scoped, so it promised a silence it could not keep
                    and the prompt returned on the next launch, and the sentence
                    restated what the button beside it already says. What
                    remains is the one control that acts: `Set a name` on the
                    caller's own unverified row. */}
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

      {/* An unshared vault says so once, plainly, instead of leaving the reader
          to infer it from an error line. `shared` is the roster view's
          `group_key_epoch`, so this is a state and not a guess. */}
      {authority === "owner" && personReady && !shared ? (
        <p data-testid="member-roster.unshared" style={HELPER_STYLE}>
          {t("sync.memberRoster.unsharedNotice")}
        </p>
      ) : null}

      {/* Invite: owner-only. A member is never shown an admin control they
          cannot use (the backend refuses with `NotOwner`). Left-aligned at its
          natural width rather than stretched across the panel. With no members
          the button lives inside the zero state instead (`inviteButton`), so
          only the invite result line can render here. */}
      {authority === "owner" ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: "var(--space-2)",
          }}
        >
          {members.length > 0 ? inviteButton : null}
          {lastInvite ? (
            <p data-testid="member-roster.invite-result" style={CODE_STYLE}>
              {t("sync.memberRoster.inviteReady", {
                fingerprint: lastInvite.member_fingerprint_hex.slice(0, 16),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
      </SettingsSection>

      {/* Sent invitations, owner-only: its own section so an accepted invite
          reads apart from the live member list above. The roster row exists
          from invite time, so this is how the owner tells an accepted invite
          from one nobody has claimed yet. */}
      {authority === "owner" ? (
        <SettingsSection
          title={t("sync.memberRoster.invitationsHeading")}
          testId="member-roster.invitations-section"
        >
          {vaultInvites.length === 0 ? (
            // The app's one zero state, like the members list above it
            // (myne-md/myne#885 visual pass): the two sections are one story, and
            // a bare line under a section whose sibling draws `EmptyState` read as
            // an unstyled leftover.
            <EmptyState
              variant="firstRun"
              icon="share-2"
              size="sm"
              title={t("sync.memberRoster.noInvitations")}
              testId="member-roster.invitations-empty"
            />
          ) : (
            <ul data-testid="member-roster.invitations" style={LIST_STYLE}>
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
          )}

          {vaultInvitesFailed ? (
            <p data-testid="member-roster.invitations-error" role="alert" style={ERROR_STYLE}>
              {t("sync.memberRoster.invitationsFailed")}
            </p>
          ) : null}
        </SettingsSection>
      ) : null}

      {shareConfirmOpen ? (
        <div
          data-testid="member-roster.share-confirm"
          role="dialog"
          aria-modal="true"
          aria-label={t("sync.memberRoster.shareConfirmTitle")}
          style={SECTION_STYLE}
        >
          <p style={STATUS_STYLE}>{t("sync.memberRoster.shareConfirmTitle")}</p>
          <p data-testid="sync.memberRoster.shareConfirmBody" style={STATUS_STYLE}>
            {t("sync.memberRoster.shareConfirmBody")}
          </p>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              type="button"
              data-testid="member-roster.share-cancel"
              disabled={inviting}
              onClick={() => setShareConfirmOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              data-testid="member-roster.share-confirm-cta"
              disabled={inviting}
              onClick={async () => {
                const vaultLabel = prefs.label ?? t("sync.memberRoster.untitledVault");
                try {
                  await startB2bMigration(vaultLabel);
                } catch {
                  setActionError(t("sync.memberRoster.shareFailed"));
                  return;
                }
                reload();
                setShareConfirmOpen(false);
                setInviteOpen(true);
              }}
            >
              {t("sync.memberRoster.shareConfirmCta")}
            </Button>
          </div>
        </div>
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
            // The vault is shared by now (the migration ran in the confirmation
            // step), so this is a plain invite. Any failure is reported as-is:
            // the retired hidden retry turned a real error into a second
            // attempt the user could not see or reason about.
            try {
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

      {actionError ? (
        <p data-testid="member-roster.action-error" style={ERROR_STYLE}>
          {actionError}
        </p>
      ) : null}
    </div>
  );
}

/** The inline rename editor, rendered on the caller's OWN row and nowhere else
 *  (myne-md/myne#851 task 6). A `<form>` rather than a click handler, so Enter
 *  saves; Escape cancels rather than silently discarding, which matters because
 *  the row would otherwise keep a half-typed name with no way back. `Clear` is a
 *  distinct action from saving an empty name, because the backend refuses the
 *  latter by design: a tombstone is what makes a cleared name win a merge. */
function NameEditor({
  draft,
  busy,
  errorKey,
  onChange,
  onSave,
  onClear,
  onCancel,
}: {
  draft: string;
  busy: boolean;
  errorKey: string | null;
  onChange: (next: string) => void;
  onSave: () => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <form
      style={NAME_FORM_STYLE}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <Input
        data-testid="member-roster.name-input"
        aria-label={t("sync.memberRoster.nameLabel")}
        value={draft}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      />
      <Button type="submit" data-testid="member-roster.name-save" disabled={busy}>
        {t("sync.memberRoster.nameSave")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        data-testid="member-roster.name-clear"
        disabled={busy}
        onClick={onClear}
      >
        {t("sync.memberRoster.nameClear")}
      </Button>
      <Button
        type="button"
        variant="ghost"
        data-testid="member-roster.name-cancel"
        disabled={busy}
        onClick={onCancel}
      >
        {t("sync.memberRoster.nameCancel")}
      </Button>
      {errorKey ? (
        <span data-testid="member-roster.name-error" role="alert" style={NAME_ERROR_STYLE}>
          {t(errorKey)}
        </span>
      ) : null}
    </form>
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

/** The invite form. The invitee's identity code is pasted and the invite is
 *  sealed and relayed from it. The code carries public material only. */
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
        }}
        rows={4}
        style={MULTILINE_STYLE}
      />
      <Button type="button" data-testid="member-roster.invite-cancel" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
      <Button
        type="button"
        variant="primary"
        data-testid="member-roster.invite-confirm"
        disabled={busy || code.trim() === ""}
        onClick={() => onSubmit({ recipientCode: code.trim() })}
      >
        {t("sync.memberRoster.invite")}
      </Button>
    </div>
  );
}
