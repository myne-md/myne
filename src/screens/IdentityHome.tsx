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
// other pre-unlock surfaces (`Unlock`, `PendingApproval`, `FailClosedError`)
// rather than the bare column it shipped with, so the invite list scrolls
// inside a bounded card instead of pushing the create-vault and forget actions
// off the bottom of the window.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { IconButton } from "../components/primitives/IconButton";
import { Input } from "../components/primitives/Input";
import { ModalShell } from "../components/primitives/ModalShell";
import {
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../components/primitives/CenteredCard";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { MyneMark } from "../components/primitives/MyneMark";
import { VISUALLY_HIDDEN } from "../components/primitives/visuallyHidden";
import {
  personListInvites,
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
import { PersonRegisterDialog } from "../components/sync/PersonRegisterDialog";
import { PersonIdentityUnlock } from "../components/sync/PersonIdentityUnlock";
import { usePersonIdentityState } from "../components/sync/personIdentityState";

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

/** A field with its action BESIDE it, the `EndpointConfig` server-URL row's shape
 *  (`MemberRosterPanel`'s owner-code row is the same one): the value takes the
 *  flexible width and the control keeps its label on one line. It replaced the
 *  full-width field with a full-width button under it, which made two of those
 *  read as a pair of banners rather than as "this value, and what you can do with
 *  it" (2026-10-24). */
const FIELD_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
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

const FORGET_ERROR_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

/** The forget dialog's body. `ModalShell`'s `.myne-modal-body` carries no
 *  padding of its own, so the warning and the acknowledgement set their own
 *  rhythm here rather than inheriting the card's. */
const DIALOG_BODY_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  padding: "var(--space-4) var(--space-5)",
};

/** The dialog's footer: the destructive press right-most with the benign one
 *  beside it, in the order `DeleteAttachmentDialog` uses so every confirmation in
 *  the app is answered the same way. */
const DIALOG_FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  padding: "0 var(--space-5) var(--space-4)",
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
  /**
   * An invitation was accepted and a vault arrived on this device.
   *
   * `vaultId` is that vault. The caller holds the device on the approval wait
   * with it: a freshly accepted member vault is PENDING until an existing device
   * compares the head fingerprint (`sync-protocol.md` §6.3), and the vault is
   * empty until then.
   */
  onAccepted: (vaultId?: string) => void;
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

/** Whether a rejected `sync_person_list_invites` means "the server does not know
 *  this identity yet" rather than a real failure. `NotEnrolled` is the backend's
 *  answer for a person credential with no device token; the copy that follows it
 *  points at the register block below instead of at the connection. */
function invitesRefusal(error: unknown): boolean {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  return kind === "NotEnrolled";
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
  // Whether this SESSION holds the identity's private half. It decides the one
  // action this screen exists for: a vault born under an identity signs its first
  // member list with that key, so creating one while the identity is sealed needs
  // the phrase first (`vault_creation::commands` refuses with `PersonLocked`, and
  // `decisions/protocol/0717` is why it refuses rather than degrading to a
  // phrase-bearing vault).
  //
  // The door that satisfies it used to live only inside Settings, which a device
  // with zero vaults cannot open: this screen offered "Create a vault", the flow
  // answered "unlock your identity first", and there was nowhere to do that
  // (2026-10-25 owner report). Same shape as the register door `decisions/ui/0725`
  // item 2 added here for the same reason: a refusal must not name an act the
  // surface cannot perform.
  const { ready: identityReady } = usePersonIdentityState();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The identity the server does not know yet, as a state rather than an error
  // (2026-10-23). An invitation is addressed to a `person_id_hash` a server
  // holds, so a `reserved` identity (nothing sent) or a `pending` one (no token
  // yet) has none to miss, and asking the relay can only be refused. The same
  // rule is `usePendingInvites`' and its own comment states it; this screen is
  // the surface that was skipping it.
  const [notEnrolled, setNotEnrolled] = useState(false);
  const invitesReadable = accountState === "enrolled";
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
  // The vault the accept just installed, held across the name gate so the
  // landing can route it to the approval wait instead of the editor.
  const acceptedVaultId = useRef<string | null>(null);
  // Registration (myne-md/myne#911). The host owns one boolean; the dialog owns
  // the phrase, the address, the admission code and the beta-terms gate, so two
  // surfaces cannot drift about any of them (2026-10-23 review). It is a DIALOG
  // rather than a block that expands here (2026-10-24 owner report): the card
  // already carries the account number, the code and the invitation list, and the
  // 24-cell grid added to that same scroll region is what pushed it past the
  // window. A dialog says what it asks for, names the server, and offers Cancel.
  const [registerOpen, setRegisterOpen] = useState(false);
  // Forget-this-identity-on-this-device (myne-md/myne#782). Only whether the
  // confirmation is UP lives here: the acknowledgement, the in-flight state and
  // the failure are the dialog's own, so closing it discards all three with it
  // instead of leaving a ticked box behind for the next opening.
  const [forgetOpen, setForgetOpen] = useState(false);
  // Which copy just landed, for the tick on the button itself (2026-10-24). The
  // report lives on the control that was pressed rather than in a toast at the
  // corner of the screen, and the live region below it says the same thing out
  // loud, because a tick reaches nobody with a screen reader. A failure still
  // goes to the toast: a control cannot show "that did not work" by looking
  // happy, and a silent failure is the one report this app never makes
  // (`lib/clipboard.ts`).
  const [copied, setCopied] = useState<"code" | "account" | null>(null);
  const copyTimer = useRef<number | null>(null);
  const flashCopied = (kind: "code" | "account") => {
    setCopied(kind);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => {
      setCopied(null);
      copyTimer.current = null;
    }, 1600);
  };
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const copyIdentityCode = () => {
    if (!identityCode) return;
    void copyText(clipboardWriteText, identityCode, {
      onSuccess: {
        kind: "toast",
        run: () => flashCopied("code"),
      },
      onFailure: {
        kind: "toast",
        run: () => toast({ message: t("personIdentityCode.copyFailed"), variant: "error" }),
      },
    });
  };

  // The same number Settings shows, so it reports the same words:
  // `settings.account.numberCopied` / `numberCopyFailed` are reused rather than
  // copied, because one value described two different ways is the drift
  // `check-i18n-duplicates.mjs` exists to catch.
  const copyAccountNumber = () => {
    if (!accountNumber) return;
    void copyText(clipboardWriteText, accountNumber, {
      onSuccess: {
        kind: "toast",
        run: () => flashCopied("account"),
      },
      onFailure: {
        kind: "toast",
        run: () => toast({ message: t("settings.account.numberCopyFailed"), variant: "error" }),
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
      setNotEnrolled(false);
    } catch (e) {
      // A stale `accountState` (registered on another surface this session) can
      // still reach the relay through a prop that has not reprobed yet. The
      // refusal is the same fact as the prop's, so it lands in the same place
      // rather than in the error banner.
      if (invitesRefusal(e)) {
        setNotEnrolled(true);
        setFailed(false);
        return;
      }
      if (!silent) setFailed(true);
    }
  }, []);

  // Fetch on mount, then keep the list fresh while the screen is open: a poll
  // (the relay has no person-account push) plus an immediate refetch when the
  // window regains focus or the tab becomes visible. Without this, an invite
  // that arrives while the identity home is already mounted never appears until
  // the app is restarted (myne-md/myne#794).
  useEffect(() => {
    if (!invitesReadable) return;
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
  }, [loadInvites, invitesReadable]);

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
          // The gate sits between the accept and the landing, so the vault the
          // accept installed is carried across it rather than dropped here.
          onAccepted(acceptedVaultId.current ?? undefined);
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
        onAccepted={(vaultId) => {
          acceptedVaultId.current = vaultId ?? null;
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
        {/* The tick's screen-reader half. One region for both copy controls,
            because only one copy can be in flight at a time. */}
        <p role="status" aria-live="polite" data-testid="identity-home.copy-status" style={VISUALLY_HIDDEN}>
          {copied === "code"
            ? t("personIdentityCode.copied")
            : copied === "account"
              ? t("settings.account.numberCopied")
              : ""}
        </p>
        <div style={BRAND_ROW_STYLE}>
          <MyneMark size={36} />
          <span style={WORDMARK_STYLE}>Myne</span>
        </div>

        <h1 style={CARD_TITLE_STYLE}>{t("identityHome.title")}</h1>

        {/* The account number, where the identity is named: one value for
            support and for a self-host handoff, derived rather than generated so
            losing it costs nothing (myne-md/myne#911 review). */}
        {accountNumber ? (
          <div style={BLOCK_STYLE}>
            <h2 style={SECTION_HEADING_STYLE}>{t("identityHome.accountNumberHeading")}</h2>
            <div style={FIELD_ROW_STYLE}>
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
                  flex: 1,
                  minWidth: 0,
                  userSelect: "all",
                }}
              />
              <IconButton
                icon="copy"
                label={t("identityHome.copyAccountNumber")}
                bordered
                tooltip
                confirmed={copied === "account"}
                testId="identity-home.copy-account-number"
                onClick={copyAccountNumber}
              />
            </div>
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
            <div style={FIELD_ROW_STYLE}>
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
                  flex: 1,
                  minWidth: 0,
                  userSelect: "all",
                }}
              />
              <IconButton
                icon="copy"
                label={t("personIdentityCode.copy")}
                bordered
                tooltip
                confirmed={copied === "code"}
                testId="identity-home.copy-code"
                onClick={copyIdentityCode}
              />
            </div>
            {/* The copy reports on the BUTTON (2026-10-24): a tick and one pop,
                announced through the live region at the top of the card. Nothing
                is written under the field — that line repeated the toast's own
                sentence, and the toast repeated it again in the corner. */}
            <p style={HINT_STYLE}>{t("identityHome.shareCodeHint")}</p>
          </div>
        ) : null}

        <div style={BLOCK_STYLE}>
          <h2 style={SECTION_HEADING_STYLE}>{t("identityHome.invitesHeading")}</h2>
          {accountState === null ? (
            // The lifecycle probe has not answered (a failed status read falls
            // back to Welcome, so this is a transient). Claiming "not
            // registered" here would be a guess about the one fact the section
            // depends on, so the section stays empty until the answer exists.
            null
          ) : !invitesReadable || notEnrolled ? (
            // The state AND the action that ends it, once. This section used to say
            // "this identity is not registered, so no invitation can reach it" and
            // then explain the same state again in a block of its own below the
            // list, with the register control down there (2026-10-24 pass over the
            // panel: the same fact twice, five hundred pixels apart). The question
            // "why is there nothing here?" is asked HERE, so the answer belongs
            // here. `pending` states a wait and has no action.
            <div data-testid="identity-home.account-state" style={BLOCK_STYLE}>
              <p data-testid="identity-home.invites-unavailable" style={HINT_STYLE}>
                {t(
                  accountState === "pending"
                    ? "identityHome.invitesPending"
                    : "identityHome.invitesUnregistered",
                )}
              </p>
              {accountState === "pending" ? null : (
                <Button
                  onClick={() => setRegisterOpen(true)}
                  data-testid="identity-home.register-cta"
                >
                  {t("identityHome.registerCta")}
                </Button>
              )}
            </div>
          ) : failed ? (
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

        {/* The account lifecycle (myne-md/myne#911) lives with the invitation list
            above: its `reserved` arm IS the invitations empty state's explanation
            and carries the register control, and its `pending` arm is what
            `invitesPending` already says. No second block here. */}

        <div style={BLOCK_STYLE}>
          {/* **Absent, not disabled** (the rule `decisions/ui/0729` states for a
              control the state cannot honour). While the identity is locked the
              primary action is the UNLOCK, and the sentence above it says why:
              the alternative was a "Create a vault" button whose only outcome was
              a refusal that pointed at a door this screen did not have. */}
          {identityReady ? (
            <Button
              variant="primary"
              onClick={onCreateVault}
              data-testid="identity-home.create-vault-cta"
            >
              {t("identityHome.createVaultCta")}
            </Button>
          ) : (
            <div
              style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "var(--space-3)" }}
              data-testid="identity-home.create-vault-locked"
            >
              <p style={HINT_STYLE}>{t("identityHome.createVaultLocked")}</p>
              <PersonIdentityUnlock open={unlockOpen} onOpenChange={setUnlockOpen} />
            </div>
          )}
        </div>

        {/* Forget this identity on this device. Device-local only: the server
            account and any vault it owns or joined are untouched, and the
            phrase recovers the identity elsewhere. The confirmation is a DIALOG
            rather than a box that expands here (2026-10-24): a destructive action
            whose consequence needs this much stating deserves the chrome every
            other destructive confirmation in the app has (`ModalShell`: backdrop,
            Esc, focus trap, an inert page), and the card goes on saying what it
            said before the press. */}
        <div style={BLOCK_STYLE}>
          <Button
            variant="ghost"
            onClick={() => setForgetOpen(true)}
            data-testid="identity-home.forget-cta"
          >
            {t("identityHome.forgetCta")}
          </Button>
        </div>

        {/* PORTALLED out of the card for the same reason the forget dialog
            below is: `CenteredCard` masks its scroll region with `mask-image`
            once the content outgrows the window, and a mask clips its whole
            rendered subtree, a fixed-position backdrop included. */}
        {registerOpen
          ? createPortal(
              <PersonRegisterDialog
                open
                testIdPrefix="identity-home.register"
                onRegistered={() => {
                  // Closed before the reprobe: the probe re-renders this screen
                  // with the identity now `enrolled`, and a dialog left open over
                  // it would be asking for a phrase that has already been used.
                  setRegisterOpen(false);
                  onRegistered();
                }}
                onClose={() => setRegisterOpen(false)}
              />,
              document.body,
            )
          : null}

        {/* PORTALLED out of the card, not merely rendered at the end of it.
            `CenteredCard` masks its scroll region with `mask-image` once the
            content outgrows the window, and a mask clips its whole rendered
            subtree, a fixed-position backdrop included, so a dialog mounted in
            there is faded and cut at the edges exactly on the screens long enough
            to need scrolling (this one, with an invite list). The portal keeps the
            REACT tree and with it every provider and the translation context, and
            moves only the DOM. */}
        {forgetOpen
          ? createPortal(
              <ForgetIdentityDialog
                onCancel={() => setForgetOpen(false)}
                onForgotten={onForgotten}
              />,
              document.body,
            )
          : null}
      </div>
    </CenteredCard>
  );
}

/** The forget confirmation (myne-md/myne#782), on the shared `ModalShell` instead
 *  of the bordered box that used to expand inside the card.
 *
 *  **The acknowledgement still gates the destructive button.** The warning above
 *  it is the only place the consequence is stated, and it states three things at
 *  once: what survives (the server account and any vault it owns or joined), what
 *  does not (this device's sealed keypair and its token), and the way back (the
 *  24-word phrase, on another device). The tick is what separates "a button I
 *  might hit" from "a consequence I read".
 *
 *  **It owns its own in-flight and failure state**, so the dialog and the erase
 *  live in one place: closing it discards the acknowledgement, the error and any
 *  half-run attempt with it, and the screen above decides only whether it is up.
 *
 *  **`canDismiss` closes the three ways out while the erase is in flight.** Esc, a
 *  backdrop click and the × would each report "cancelled" for an erase the backend
 *  has already committed, which is the one report this surface must never make. */
function ForgetIdentityDialog({
  onCancel,
  onForgotten,
}: {
  onCancel: () => void;
  /** Called once the erase succeeds, so the app re-probes to the Welcome screen
   *  rather than trusting a local copy of the identity's state. */
  onForgotten: () => void;
}) {
  const { t } = useTranslation();
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const confirm = async () => {
    setBusy(true);
    setError(false);
    try {
      // Erases the sealed keypair and the device token; the server account
      // survives and is recoverable with the phrase on another device.
      await personLock(true);
      onForgotten();
    } catch {
      setError(true);
      setBusy(false);
    }
  };

  return (
    <ModalShell
      open
      title={t("identityHome.forgetCta")}
      labelId="identity-home-forget-title"
      closeLabel={t("identityHome.forgetCancel")}
      canDismiss={() => !busy}
      onClose={onCancel}
      testId="identity-home.forget-confirm"
    >
      <div style={DIALOG_BODY_STYLE}>
        <p data-testid="identity-home.forget-warning" style={BODY_SMALL_STYLE}>
          {t("identityHome.forgetWarning")}
        </p>
        <label style={CHECKBOX_LABEL_STYLE}>
          <input
            type="checkbox"
            data-testid="identity-home.forget-ack"
            checked={ack}
            disabled={busy}
            onChange={(e) => setAck(e.target.checked)}
            style={CHECKBOX_STYLE}
          />
          {t("identityHome.forgetCheckbox")}
        </label>
        {error ? (
          <p data-testid="identity-home.forget-error" role="alert" style={FORGET_ERROR_STYLE}>
            {t("identityHome.forgetError")}
          </p>
        ) : null}
      </div>
      <div style={DIALOG_FOOTER_STYLE}>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
          data-testid="identity-home.forget-cancel"
        >
          {t("identityHome.forgetCancel")}
        </Button>
        <Button
          variant="danger"
          disabled={!ack || busy}
          onClick={() => void confirm()}
          data-testid="identity-home.forget-confirm-cta"
        >
          {t("identityHome.forgetConfirm")}
        </Button>
      </div>
    </ModalShell>
  );
}
