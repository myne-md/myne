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
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/primitives/Button";
import { MyneMark } from "../components/primitives/MyneMark";
import { stageRootStyle } from "../components/primitives/stageRoot";
import { personListInvites, personAcceptInvite, type InviteSummary } from "../lib/personAccount";
import { inspectInviteCode } from "../lib/invite";

interface IdentityHomeProps {
  personIdHex: string | null;
  /** The out-of-band invite code an owner pastes to invite this person. Public
   *  material only; `null` for a pre-task-11 credential. */
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
  const [acceptPhrase, setAcceptPhrase] = useState("");
  const [acceptError, setAcceptError] = useState<string | null>(null);

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
            <div
              data-testid="identity-home.identity-code"
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
              {identityCode}
            </div>
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
                          <textarea
                            data-testid="identity-home.accept-phrase"
                            aria-label={t("identityHome.acceptPhraseLabel")}
                            value={acceptPhrase}
                            onChange={(e) => {
                              setAcceptPhrase(e.target.value);
                              setAcceptError(null);
                            }}
                            rows={3}
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <Button
                            type="button"
                            variant="primary"
                            data-testid="identity-home.accept-submit"
                            disabled={!confirmed || acceptPhrase.trim() === ""}
                            onClick={async () => {
                              try {
                                await personAcceptInvite(
                                  inv.invite_id_hex,
                                  ownerCode.trim(),
                                  acceptPhrase,
                                );
                                setAcceptPhrase("");
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
