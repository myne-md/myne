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
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ClipboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { Input } from "../components/primitives/Input";
import {
  CARD_BODY_STYLE,
  CARD_TITLE_STYLE,
  CenteredCard,
} from "../components/primitives/CenteredCard";
import { DestructiveBanner } from "../components/DestructiveBanner";
import { PasswordCreateForm } from "../components/PasswordCreateForm";
import { MULTILINE_STYLE } from "../components/settings/panel-styles";
import { MyneMark } from "../components/primitives/MyneMark";
import {
  personListInvites,
  personAcceptInvite,
  personJoinVault,
  type InviteSummary,
} from "../lib/personAccount";
import { acceptInviteErrorKey } from "@myne/client-core/accept-invite";
import { memberJoinVaultErrorKey } from "@myne/client-core/join-member-vault";
import { inspectInviteCode, personLock } from "../lib/invite";
import { copyText } from "../lib/clipboard";
import { writeText as clipboardWriteText } from "../platform/clipboardManager";
import { toast } from "../components/toast/toastStore";
import { EnrollPhraseCredential, PHRASE_CELL_COUNT } from "../components/sync/EnrollPhraseCredential";
import { MemberNameGate } from "../components/sync/MemberNameGate";

/** How often the pending-invite list re-polls while the identity home is
 *  mounted and visible. The relay has no push channel for a person account, so
 *  a list that is only fetched on mount never shows an invite that arrives while
 *  the screen is open (myne-md/myne#794). 5 s matches `useSyncStatus`'
 *  `STATUS_POLL_MS`; the request is one small relay GET. */
const INVITE_POLL_MS = 5000;

/** Whether a freshly fetched invite list differs from the one on screen. Used to
 *  skip the state update when nothing changed, so a 5 s poll does not re-render
 *  the list (and disturb an open Accept form) for no reason. */
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

const PERSON_ID_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  wordBreak: "break-all",
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

const ACCEPT_FORM_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  paddingTop: "var(--space-2)",
  borderTop: "1px solid var(--line-1)",
};

const FINGERPRINT_STYLE: CSSProperties = {
  display: "block",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-2) var(--space-3)",
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
  personIdHex: string | null;
  /** The out-of-band invite code. Public material remains available while the
   *  private identity is locked. */
  identityCode: string | null;
  onCreateVault: () => void;
  /** Called after an invite is accepted and a shared vault is unlocked, so the
   *  app re-probes into the editor. */
  onAccepted: () => void;
  /** Called after this device's identity is forgotten, so the app re-probes to
   *  the Welcome screen (myne-md/myne#782). */
  onForgotten: () => void;
}

export function IdentityHome({
  personIdHex,
  identityCode,
  onCreateVault,
  onAccepted,
  onForgotten,
}: IdentityHomeProps) {
  const { t } = useTranslation();
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  // The join-on-this-device path (myne-md/myne#852 task 7). Deliberately a SECOND
  // set of state rather than a mode flag on the accept above: the two forms differ
  // in what they collect (the join collects no owner code) and in what follows them
  // (the accept owes the name gate, the join must not touch a name at all).
  const [joining, setJoining] = useState<string | null>(null);
  const [joinPhraseCells, setJoinPhraseCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [joinError, setJoinError] = useState<string | null>(null);
  const [ownerCode, setOwnerCode] = useState("");
  const [ownerFingerprint, setOwnerFingerprint] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  // The required name step (myne-md/myne#851 task 8, stories 5 to 7). The accept
  // is COMMITTED by the time this opens, and `onAccepted` (which reprobes and lands
  // the member in the editor) is withheld until the gate completes: an accepted
  // vault cannot reach the editor unnamed. Quitting here leaves the vault exactly as
  // the accept left it, openable and unnamed, which is story 7's "not a lockout".
  const [nameGateOpen, setNameGateOpen] = useState(false);
  const [acceptPhraseCells, setAcceptPhraseCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<"success" | "error" | null>(null);
  // Forget-this-identity-on-this-device (myne-md/myne#782). A short
  // acknowledgement gates the destructive button; the warning above it is the
  // only place the consequence is stated.
  const [forgetOpen, setForgetOpen] = useState(false);
  const [forgetAck, setForgetAck] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [forgetError, setForgetError] = useState(false);

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

  return (
    <CenteredCard>
      <div data-testid="identity-home.root" style={{ display: "contents" }}>
        <div style={BRAND_ROW_STYLE}>
          <MyneMark size={36} />
          <span style={WORDMARK_STYLE}>Myne</span>
        </div>

        <h1 style={CARD_TITLE_STYLE}>{t("identityHome.title")}</h1>

        <p style={CARD_BODY_STYLE}>{t("identityHome.subtitle")}</p>

        {personIdHex ? (
          <div data-testid="identity-home.person-id" style={PERSON_ID_STYLE}>
            {personIdHex}
          </div>
        ) : null}

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
                      onClick={() => {
                        setAccepting(inv.invite_id_hex);
                        setOwnerCode("");
                        setOwnerFingerprint(null);
                        setConfirmed(false);
                        setAcceptPhraseCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
                        setAcceptError(null);
                      }}
                    >
                      {t("identityHome.accept")}
                    </Button>
                  </div>
                  {accepting === inv.invite_id_hex ? (
                    <div data-testid="identity-home.accept-form" style={ACCEPT_FORM_STYLE}>
                      <p style={BODY_SMALL_STYLE}>{t("identityHome.acceptHint")}</p>
                      <textarea
                        data-testid="identity-home.accept-owner-code"
                        aria-label={t("identityHome.acceptOwnerCodeLabel")}
                        value={ownerCode}
                        onChange={(e) => {
                          setOwnerCode(e.target.value);
                          setOwnerFingerprint(null);
                          setConfirmed(false);
                          setAcceptError(null);
                        }}
                        rows={3}
                        style={MULTILINE_STYLE}
                      />
                      {ownerFingerprint === null ? (
                        <Button
                          type="button"
                          data-testid="identity-home.accept-inspect"
                          disabled={ownerCode.trim() === ""}
                          onClick={async () => {
                            try {
                              const view = await inspectInviteCode(ownerCode.trim());
                              setOwnerFingerprint(view.fingerprint_hex);
                            } catch {
                              setAcceptError(t("identityHome.acceptInvalid"));
                            }
                          }}
                        >
                          {t("identityHome.acceptInspect")}
                        </Button>
                      ) : (
                        <div data-testid="identity-home.accept-sas" style={BLOCK_STYLE}>
                          <p style={BODY_SMALL_STYLE}>{t("identityHome.acceptSasHint")}</p>
                          <code
                            data-testid="identity-home.accept-owner-fingerprint"
                            style={FINGERPRINT_STYLE}
                          >
                            {ownerFingerprint}
                          </code>
                          <label style={CHECKBOX_LABEL_STYLE}>
                            <input
                              type="checkbox"
                              data-testid="identity-home.accept-confirm"
                              checked={confirmed}
                              onChange={(e) => setConfirmed(e.target.checked)}
                              style={CHECKBOX_STYLE}
                            />
                            {t("identityHome.acceptConfirm")}
                          </label>
                          <EnrollPhraseCredential
                            baseId="identity-home-accept"
                            label={t("identityHome.acceptPhraseLabel")}
                            cells={acceptPhraseCells}
                            onCellChange={(index) => (event: ChangeEvent<HTMLInputElement>) => {
                              setAcceptError(null);
                              setAcceptPhraseCells((cells) =>
                                cells.map((cell, cellIndex) =>
                                  cellIndex === index
                                    ? event.target.value.replace(/\s+/g, "")
                                    : cell,
                                ),
                              );
                            }}
                            onCellPaste={(index) => (event: ClipboardEvent<HTMLInputElement>) => {
                              const tokens = event.clipboardData
                                .getData("text")
                                .split(/\s+/)
                                .filter((token) => token.length > 0);
                              if (tokens.length < 2) return;
                              event.preventDefault();
                              setAcceptError(null);
                              setAcceptPhraseCells((cells) => {
                                const next = [...cells];
                                for (
                                  let i = 0;
                                  i < tokens.length && index + i < PHRASE_CELL_COUNT;
                                  i += 1
                                ) {
                                  next[index + i] = tokens[i];
                                }
                                return next;
                              });
                            }}
                            gridTestId="identity-home.accept-phrase-grid"
                            cellTestId={(index) =>
                              index === 0
                                ? "identity-home.accept-phrase"
                                : `identity-home.accept-phrase-cell-${index + 1}`
                            }
                          />
                          {/* The REQUIRED device-local credential (myne-md/myne#851
                              task 7). This form's own submit IS the accept button,
                              so the phrase, the out-of-band confirmation and a
                              password meeting the project floor are all satisfied in
                              one gesture, and an accepted vault always carries a
                              credential this device can open it with. The copy says
                              plainly that this is not the owner's password. */}
                          <PasswordCreateForm
                            testIdPrefix="identity-home.accept"
                            submitLabel={t("identityHome.acceptSubmit")}
                            disabled={
                              !confirmed || !acceptPhraseCells.every((cell) => cell.length > 0)
                            }
                            autoFocus={false}
                            helperCopy={
                              <p
                                data-testid="identity-home.accept-password-note"
                                style={BODY_SMALL_STYLE}
                              >
                                {t("identityHome.acceptPasswordNote")}
                              </p>
                            }
                            onSubmit={async (password) => {
                              try {
                                await personAcceptInvite(
                                  inv.invite_id_hex,
                                  ownerCode.trim(),
                                  acceptPhraseCells.join(" "),
                                  password,
                                );
                                setAcceptPhraseCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));
                                setNameGateOpen(true);
                              } catch (error) {
                                // Surface WHICH failure it was, not only "could
                                // not be accepted": the kinds are a closed enum
                                // and carry no secret (myne-md/myne#794).
                                setAcceptError(t(acceptErrorKey(error)));
                              }
                            }}
                          />
                        </div>
                      )}
                      {acceptError ? (
                        <DestructiveBanner testId="identity-home.accept-error">
                          {acceptError}
                        </DestructiveBanner>
                      ) : null}
                    </div>
                  ) : null}
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
                          onClick={() => {
                            setJoining(inv.invite_id_hex);
                            setJoinPhraseCells(
                              Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
                            );
                            setJoinError(null);
                          }}
                        >
                          {t("identityHome.join")}
                        </Button>
                      </div>
                      {joining === inv.invite_id_hex ? (
                        <div data-testid="identity-home.join-form" style={ACCEPT_FORM_STYLE}>
                          <p style={BODY_SMALL_STYLE}>{t("identityHome.joinHint")}</p>
                          {/* There is deliberately NO owner-code field here, and the
                              absence is load-bearing rather than a simplification: the
                              owner this device verifies the group package against is the
                              one its own per-(person, vault) profile already pins
                              (`decisions/protocol/0675`). A field would let whatever is
                              pasted into it become the trust anchor, which is the one
                              thing the pin exists to prevent. */}
                          <EnrollPhraseCredential
                            baseId="identity-home-join"
                            label={t("identityHome.joinPhraseLabel")}
                            cells={joinPhraseCells}
                            onCellChange={(index) => (event: ChangeEvent<HTMLInputElement>) => {
                              setJoinError(null);
                              setJoinPhraseCells((cells) =>
                                cells.map((cell, cellIndex) =>
                                  cellIndex === index
                                    ? event.target.value.replace(/\s+/g, "")
                                    : cell,
                                ),
                              );
                            }}
                            onCellPaste={(index) => (event: ClipboardEvent<HTMLInputElement>) => {
                              const tokens = event.clipboardData
                                .getData("text")
                                .split(/\s+/)
                                .filter((token) => token.length > 0);
                              if (tokens.length < 2) return;
                              event.preventDefault();
                              setJoinError(null);
                              setJoinPhraseCells((cells) => {
                                const next = [...cells];
                                for (
                                  let i = 0;
                                  i < tokens.length && index + i < PHRASE_CELL_COUNT;
                                  i += 1
                                ) {
                                  next[index + i] = tokens[i];
                                }
                                return next;
                              });
                            }}
                            gridTestId="identity-home.join-phrase-grid"
                            cellTestId={(index) =>
                              index === 0
                                ? "identity-home.join-phrase"
                                : `identity-home.join-phrase-cell-${index + 1}`
                            }
                          />
                          <PasswordCreateForm
                            testIdPrefix="identity-home.join"
                            submitLabel={t("identityHome.joinSubmit")}
                            disabled={!joinPhraseCells.every((cell) => cell.length > 0)}
                            autoFocus={false}
                            helperCopy={
                              <p
                                data-testid="identity-home.join-password-note"
                                style={BODY_SMALL_STYLE}
                              >
                                {t("identityHome.joinPasswordNote")}
                              </p>
                            }
                            onSubmit={async (password) => {
                              try {
                                await personJoinVault(
                                  inv.invite_id_hex,
                                  inv.vault_account_hash_hex,
                                  joinPhraseCells.join(" "),
                                  password,
                                );
                                setJoinPhraseCells(
                                  Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
                                );
                                // Straight to the editor: a join installs a vault this
                                // identity is ALREADY a member of, so there is no name to
                                // set and no gate to pass. The accept above owes one
                                // because it is what creates a member; this path must not
                                // write a name, or a second device would silently re-name
                                // a person its first device had already named
                                // (myne-md/myne#852 task 7).
                                onAccepted();
                              } catch (error) {
                                setJoinError(t(joinErrorKey(error)));
                              }
                            }}
                          />
                          {joinError ? (
                            <DestructiveBanner testId="identity-home.join-error">
                              {joinError}
                            </DestructiveBanner>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

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
