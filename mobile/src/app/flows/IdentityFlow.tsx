import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Screen,
  ScreenScroll,
  FlowHeader,
  Lead,
  Button,
  RecoveryGrid,
  Banner,
  Spinner,
} from "../../components";
import { HAS_TAURI } from "../../lib/app-window";
import {
  personSetup,
  personStatus,
  personListInvites,
  personLock,
  type PersonSetupView,
  type InviteSummary,
} from "../../lib/personAccount";
import { syncSetEndpoint } from "../../lib/sync";
import { HOSTED_SYNC_ORIGIN } from "@myne/client-core/hosted-sync";
import type { IdentityFlowProps } from "./types";

type Step = "gate" | "held" | "server" | "create" | "phrase" | "home";

/** A labelled monospace field, the same shape `JoinFlow` uses for server and
 *  account input. Local because `JoinFlow`'s copy is not exported. */
function MonoField({
  label,
  value,
  onChange,
  placeholder,
  testId,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId: string;
  inputMode?: "url";
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ marginTop: "var(--space-4)" }}>
      <div
        style={{
          fontSize: "var(--text-xs)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--fg-2)",
          marginBottom: "var(--space-2)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 52,
          border: `1.5px solid ${focused ? "var(--accent)" : "var(--line-2)"}`,
          borderRadius: "var(--radius-2)",
          background: "var(--bg-1)",
          padding: "0 14px",
        }}
      >
        <input
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          inputMode={inputMode}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          data-testid={testId}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-base)",
            color: "var(--fg-1)",
          }}
        />
      </div>
    </div>
  );
}

/**
 * The mobile identity-first flow (myne-md/myne#768).
 *
 * The phone-side counterpart of the desktop `IdentitySetupDialog` +
 * `IdentityHome`: create one identity, then create or join vaults under it. The
 * backend is the same `sync_person_*` plugin the desktop uses, so an identity
 * made here is addressable from a laptop.
 *
 * Deliberately its own flow rather than an import of the shared desktop dialog:
 * mobile composes its own UI from `mobile/src/components/` and imports no
 * desktop screen or component (that is the whole shape of the client), so
 * reaching into `src/components/IdentitySetupDialog` would be the first mobile
 * screen built from desktop JSX. The commands are shared; the presentation is
 * not.
 */
export function IdentityFlow({ onCancel }: IdentityFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(HAS_TAURI ? "gate" : "gate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server step
  const [serverUrl, setServerUrl] = useState("");

  // Identity
  const [result, setResult] = useState<PersonSetupView | null>(null);
  const revealRef = useRef<PersonSetupView | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [ackSaved, setAckSaved] = useState(false);

  // Home
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [personIdHex, setPersonIdHex] = useState<string | null>(null);
  const [identityCode, setIdentityCode] = useState<string | null>(null);

  // Gate on boot: if an identity already exists, skip straight to the home.
  useEffect(() => {
    if (!HAS_TAURI) {
      setStep("gate");
      return;
    }
    let cancelled = false;
    void personStatus()
      .then((s) => {
        if (cancelled) return;
        if (s.enrolled) {
          setPersonIdHex(s.person_id_hex);
          setIdentityCode(s.identity_code);
          setStep("home");
        } else if (s.sealed_keypair_present) {
          // A sealed identity this device cannot open with a fresh phrase
          // (myne-md/myne#780): offer to forget it rather than loop through a
          // create that is guaranteed to fail.
          setStep("held");
        } else {
          setStep("gate");
        }
      })
      .catch(() => {
        if (!cancelled) setStep("gate");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load invites whenever the home step is shown.
  useEffect(() => {
    if (step !== "home" || !HAS_TAURI) return;
    let cancelled = false;
    void personListInvites()
      .then((list) => {
        if (!cancelled) setInvites(list);
      })
      .catch(() => {
        if (!cancelled) setInvites([]);
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const connectServer = useCallback(async () => {
    const trimmed = serverUrl.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await syncSetEndpoint(trimmed);
      setStep("create");
    } catch {
      setError(t("identityFlow.serverUnreachable"));
    } finally {
      setBusy(false);
    }
  }, [serverUrl, t]);

  // The hosted door: write the Myne server and let the first connection pin its
  // leaf (TOFU). No pre-vetted pin is claimed (myne-md/myne#781).
  const connectHosted = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await syncSetEndpoint(HOSTED_SYNC_ORIGIN);
      setStep("create");
    } catch {
      setError(t("identityFlow.serverUnreachable"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  // Forget a held identity this device cannot open with a fresh phrase, so a
  // create can proceed (myne-md/myne#780).
  const forgetHeld = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await personLock(true);
      setStep("gate");
    } catch {
      setError(t("identityFlow.createFailed"));
    } finally {
      setBusy(false);
    }
  }, [t]);

  const createIdentity = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const view = await personSetup();
      revealRef.current = view;
      setResult(view);
      setPersonIdHex(view.person_id_hex);
      setIdentityCode(view.identity_code);
      setStep("phrase");
    } catch {
      // The typed `NotConfigured` case means the endpoint did not take; send the
      // user back to the server step rather than showing a dead end.
      setError(t("identityFlow.createFailed"));
      setStep("server");
    } finally {
      setBusy(false);
    }
  }, [t]);

  const finishPhrase = useCallback(() => {
    revealRef.current = null;
    setResult(null);
    setRevealed(false);
    setAckSaved(false);
    setStep("home");
  }, []);

  const renderServer = () => (
    <ScreenScroll>
      <FlowHeader label={t("identityFlow.server.title")} onBack={onCancel} />
      <Lead>{t("identityFlow.server.lead")}</Lead>
      <Button
        onClick={() => void connectHosted()}
        disabled={busy}
        data-testid="identity-flow.server-myne-sync"
      >
        {t("identityFlow.server.useMyneSync")}
      </Button>
      <Lead>{t("identityFlow.server.selfHostedHint")}</Lead>
      <MonoField
        label={t("identityFlow.server.urlLabel")}
        value={serverUrl}
        onChange={setServerUrl}
        placeholder="https://sync.example"
        inputMode="url"
        testId="identity-flow.server-input"
      />
      {error ? <Banner kind="warning">{error}</Banner> : null}
      <Button onClick={() => void connectServer()} disabled={busy || !serverUrl.trim()} data-testid="identity-flow.server-connect">
        {busy ? t("identityFlow.server.connecting") : t("identityFlow.server.connect")}
      </Button>
      <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.server-back">
        {t("identityFlow.back")}
      </Button>
    </ScreenScroll>
  );

  const renderHeld = () => (
    <ScreenScroll>
      <FlowHeader label={t("identityFlow.held.title")} onBack={onCancel} />
      <Lead>{t("identityFlow.held.lead")}</Lead>
      {error ? <Banner kind="warning">{error}</Banner> : null}
      <Button
        onClick={() => void forgetHeld()}
        disabled={busy}
        data-testid="identity-flow.held-forget"
      >
        {t("identityFlow.held.forget")}
      </Button>
      <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.held-cancel">
        {t("identityFlow.back")}
      </Button>
    </ScreenScroll>
  );

  const renderGate = () => (
    <ScreenScroll>
      <FlowHeader label={t("identityFlow.title")} onBack={onCancel} />
      <Lead>{t("identityFlow.lead")}</Lead>
      <Button
        onClick={() => setStep("server")}
        data-testid="identity-flow.start"
      >
        {t("identityFlow.start")}
      </Button>
      <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.skip">
        {t("identityFlow.skip")}
      </Button>
    </ScreenScroll>
  );

  const renderCreate = () => (
    <ScreenScroll>
      <FlowHeader label={t("identityFlow.create.title")} onBack={() => setStep("server")} />
      <Lead>{t("identityFlow.create.lead")}</Lead>
      {error ? <Banner kind="warning">{error}</Banner> : null}
      <Button onClick={() => void createIdentity()} disabled={busy} data-testid="identity-flow.create">
        {busy ? t("identityFlow.create.working") : t("identityFlow.create.cta")}
      </Button>
    </ScreenScroll>
  );

  const renderPhrase = () => {
    const phrase = (result?.phrase ?? "").split(" ");
    return (
      <ScreenScroll>
        <FlowHeader label={t("identityFlow.phrase.title")} />
        <Lead>{t("identityFlow.phrase.warning")}</Lead>
        {revealed ? (
          <RecoveryGrid words={phrase} />
        ) : (
          <Button onClick={() => setRevealed(true)} data-testid="identity-flow.phrase-reveal">
            {t("identityFlow.phrase.reveal")}
          </Button>
        )}
        <label
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "flex-start",
            marginTop: "var(--space-3)",
          }}
        >
          <input
            type="checkbox"
            checked={ackSaved}
            onChange={(e) => setAckSaved(e.target.checked)}
            data-testid="identity-flow.phrase-ack"
            style={{
              marginTop: "var(--space-1)",
              width: 20,
              height: 20,
              accentColor: "var(--accent)",
            }}
          />
          <span
            style={{
              fontSize: "var(--text-sm)",
              lineHeight: "var(--leading-normal)",
              color: "var(--fg-1)",
            }}
          >
            {t("identityFlow.phrase.ack")}
          </span>
        </label>
        <Button
          onClick={finishPhrase}
          disabled={!ackSaved || !revealed}
          data-testid="identity-flow.phrase-continue"
        >
          {t("identityFlow.phrase.continue")}
        </Button>
      </ScreenScroll>
    );
  };

  const renderHome = () => {
    const pending = (invites ?? []).filter((i) => !i.claimed);
    return (
      <ScreenScroll>
        <FlowHeader label={t("identityFlow.home.title")} onBack={onCancel} />
        <Lead>{t("identityFlow.home.lead")}</Lead>
        {personIdHex ? (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              wordBreak: "break-all",
            }}
            data-testid="identity-flow.home-person-id"
          >
            {personIdHex}
          </div>
        ) : null}
        {identityCode ? (
          <div style={{ marginTop: "var(--space-3)" }}>
            <div
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--fg-2)",
                marginBottom: "var(--space-2)",
              }}
            >
              {t("identityFlow.home.codeLabel")}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--fg-2)",
                wordBreak: "break-all",
              }}
              data-testid="identity-flow.home-code"
            >
              {identityCode}
            </div>
          </div>
        ) : null}
        <Lead>{t("identityFlow.home.invitesHeading")}</Lead>
        {invites === null ? (
          <Spinner />
        ) : pending.length === 0 ? (
          <Lead data-testid="identity-flow.home-empty">{t("identityFlow.home.noInvites")}</Lead>
        ) : (
          pending.map((inv) => (
            <div key={inv.invite_id_hex} data-testid="identity-flow.invite-row">
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--fg-2)",
                  wordBreak: "break-all",
                }}
              >
                {inv.vault_account_hash_hex}
              </div>
              <Lead>{t("identityFlow.home.inviteHint")}</Lead>
            </div>
          ))
        )}
      </ScreenScroll>
    );
  };

  return (
    <Screen style={{ padding: 0 }}>
      {step === "gate" && renderGate()}
      {step === "held" && renderHeld()}
      {step === "server" && renderServer()}
      {step === "create" && renderCreate()}
      {step === "phrase" && renderPhrase()}
      {step === "home" && renderHome()}
    </Screen>
  );
}
