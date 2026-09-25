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
import {
  useEffect,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { Input } from "../components/primitives/Input";
import { MyneMark } from "../components/primitives/MyneMark";
import { stageRootStyle } from "../components/primitives/stageRoot";
import { personListInvites, personAcceptInvite, type InviteSummary } from "../lib/personAccount";
import { inspectInviteCode } from "../lib/invite";
import { copyText } from "../lib/clipboard";
import { writeText as clipboardWriteText } from "../platform/clipboardManager";
import { toast } from "../components/toast/toastStore";
import { EnrollPhraseCredential, PHRASE_CELL_COUNT } from "../components/sync/EnrollPhraseCredential";

interface IdentityHomeProps {
  personIdHex: string | null;
  /** The out-of-band invite code. Public material remains available while the
   *  private identity is locked. */
  identityCode: string | null;
  onCreateVault: () => void;
  /** Called after an invite is accepted and a shared vault is unlocked, so the
   *  app re-probes into the editor. */
  onAccepted: () => void;
}

export function IdentityHome({
  personIdHex,
  identityCode,
  onCreateVault,
  onAccepted,
}: IdentityHomeProps) {
  const { t } = useTranslation();
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [ownerCode, setOwnerCode] = useState("");
  const [ownerFingerprint, setOwnerFingerprint] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [acceptPhraseCells, setAcceptPhraseCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<"success" | "error" | null>(null);

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

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = await personListInvites();
        if (alive) setInvites(list);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const pending = (invites ?? []).filter((i) => !i.claimed);

  return (
    <div
      data-testid="identity-home.root"
      style={{
        ...stageRootStyle,
        background: "var(--bg-1)",
        padding: "var(--space-5)",
      }}
    >
      <div style={{ width: 460, display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <MyneMark size={36} />
          <div
            style={{
              fontSize: "var(--text-xl)",
              fontWeight: "var(--weight-semibold)",
              letterSpacing: "-0.02em",
              color: "var(--fg-display)",
            }}
          >
            {t("identityHome.title")}
          </div>
        </div>

        <div style={{ fontSize: "var(--text-base)", lineHeight: 1.6, color: "var(--fg-2)" }}>
          {t("identityHome.subtitle")}
        </div>

        {personIdHex ? (
          <div
            data-testid="identity-home.person-id"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              wordBreak: "break-all",
            }}
          >
            {personIdHex}
          </div>
        ) : null}

        {/* The invite code an owner pastes to invite this person. Public
            material only (person id + public halves). */}
        {identityCode ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <div
              style={{
                fontSize: "var(--text-sm)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--fg-1)",
              }}
            >
              {t("identityHome.shareCodeHeading")}
            </div>
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
                style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}
              >
                {t("personIdentityCode.copyFailed")}
              </p>
            ) : copyFeedback === "success" ? (
              <p
                data-testid="identity-home.copy-feedback"
                role="status"
                aria-live="polite"
                style={{ fontSize: "var(--text-xs)", color: "var(--fg-2)" }}
              >
                {t("personIdentityCode.copied")}
              </p>
            ) : null}
            <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
              {t("identityHome.shareCodeHint")}
            </div>
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <div
            style={{
              fontSize: "var(--text-sm)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--fg-1)",
            }}
          >
            {t("identityHome.invitesHeading")}
          </div>
          {failed ? (
            <div
              data-testid="identity-home.error"
              style={{ fontSize: "var(--text-sm)", color: "var(--danger)" }}
            >
              {t("identityHome.invitesError")}
            </div>
          ) : invites === null ? (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
              {t("identityHome.invitesLoading")}
            </div>
          ) : pending.length === 0 ? (
            <div
              data-testid="identity-home.empty-invites"
              style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}
            >
              {t("identityHome.noInvites")}
            </div>
          ) : (
            <div data-testid="identity-home.invites" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              {pending.map((inv) => (
                <div
                  key={inv.invite_id_hex}
                  data-testid="identity-home.invite-row"
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    color: "var(--fg-2)",
                    background: "var(--bg-2)",
                    border: "1px solid var(--line-1)",
                    borderRadius: "var(--radius-2)",
                    padding: "var(--space-2)",
                    wordBreak: "break-all",
                  }}
                >
                  <div>{inv.vault_account_hash_hex}</div>
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
                  {accepting === inv.invite_id_hex ? (
                    <div
                      data-testid="identity-home.accept-form"
                      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-2)" }}
                    >
                      <p style={{ fontFamily: "var(--font-sans)" }}>{t("identityHome.acceptHint")}</p>
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
                        <div data-testid="identity-home.accept-sas">
                          <p style={{ fontFamily: "var(--font-sans)" }}>
                            {t("identityHome.acceptSasHint")}
                          </p>
                          <code data-testid="identity-home.accept-owner-fingerprint">
                            {ownerFingerprint}
                          </code>
                          <label style={{ display: "block", fontFamily: "var(--font-sans)" }}>
                            <input
                              type="checkbox"
                              data-testid="identity-home.accept-confirm"
                              checked={confirmed}
                              onChange={(e) => setConfirmed(e.target.checked)}
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

                          <Button
                            type="button"
                            variant="primary"
                            data-testid="identity-home.accept-submit"
                             disabled={!confirmed || !acceptPhraseCells.every((cell) => cell.length > 0)}

                            onClick={async () => {
                              try {
                                await personAcceptInvite(
                                  inv.invite_id_hex,
                                  ownerCode.trim(),
                                   acceptPhraseCells.join(" "),

                                );
                                 setAcceptPhraseCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));

                                onAccepted();
                              } catch {
                                setAcceptError(t("identityHome.acceptError"));
                              }
                            }}
                          >
                            {t("identityHome.acceptSubmit")}
                          </Button>
                        </div>
                      )}
                      {acceptError ? (
                        <p data-testid="identity-home.accept-error" style={{ color: "var(--danger)", fontFamily: "var(--font-sans)" }}>
                          {acceptError}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
          <Button variant="primary" onClick={onCreateVault} data-testid="identity-home.create-vault-cta">
            {t("identityHome.createVaultCta")}
          </Button>
        </div>
      </div>
    </div>
  );
}
