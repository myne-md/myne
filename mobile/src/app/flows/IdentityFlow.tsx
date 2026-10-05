import { useCallback, useEffect, useId, useState, type ChangeEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Screen,
  ScreenScroll,
  FlowHeader,
  Title,
  Lead,
  FooterBar,
  Button,
  RecoveryGrid,
  Checkbox,
  Banner,
  Spinner,
  BlockingOverlay,
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

/**
 * Map a failed `sync_set_endpoint` invoke to user copy. The gated-server
 * refusals (`InviteCodeRequired` / `InviteCodeInvalid`, myne-md/myne#800) are
 * not reachability failures: the server answered, and the remedy is the
 * operator's invite code, so "couldn't reach the server" would send the user to
 * fix the wrong thing. Same mapping the sync settings panel uses.
 */
function serverConnectError(
  error: unknown,
  t: (key: string) => string,
): string {
  const kind =
    typeof error === "object" && error !== null && "kind" in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  if (kind === "InviteCodeRequired") return t("sync.enroll.error.inviteCodeRequired");
  if (kind === "InviteCodeInvalid") return t("sync.enroll.error.inviteCodeInvalid");
  if (kind === "TlsFailure") return t("sync.endpoint.tlsFailure");
  return t("identityFlow.serverUnreachable");
}

/** Small uppercase field label, the shape every wired flow uses (`JoinFlow`,
 *  `RecoverFlow`, `CreateVaultFlow` each keep a local copy). */
function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: "var(--text-xs)",
        fontWeight: "var(--weight-semibold)",
        letterSpacing: "var(--tracking-caps)",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        marginBottom: "var(--space-2)",
      }}
    >
      {children}
    </div>
  );
}

/** A labelled monospace field, the same shape `JoinFlow` uses for server and
 *  account input. Local because `JoinFlow`'s copy is not exported. */
function MonoField({
  value,
  onChange,
  placeholder,
  testId,
  inputMode,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  testId: string;
  inputMode?: "url";
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 52,
        border: `1.5px solid ${focused ? "var(--accent)" : "var(--line-2)"}`,
        borderRadius: "var(--radius-2)",
        background: "var(--bg-1)",
        padding: "0 14px",
        boxShadow: focused ? "0 0 0 3px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
      }}
    >
      {/* A raw `<input>`: mobile has no real text-input primitive yet
          (`components/inputs.tsx`'s `Field` is a presentational mock that
          renders a div, not a field), so the real control lives here and is
          recorded in `scripts/primitive-adoption.json` (myne-md/myne#788). */}
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
          minWidth: 0,
          border: "none",
          outline: "none",
          background: "transparent",
          padding: 0,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-md)",
          letterSpacing: "var(--tracking-wide)",
          color: "var(--fg-1)",
        }}
      />
    </div>
  );
}

/** A read-only monospace value in a field (the identity code on the home step).
 *  The code is a few kilobytes of hex (`MYNE-PERSON-1:` + the public halves), so
 *  it renders in a single-line read-only input that scrolls, exactly as the
 *  desktop `IdentityHome` shows it. A wrapping box turns it into an unreadable
 *  wall and pushes everything below it off screen. */
function MonoBox({ value, testId }: { value: string; testId: string }) {
  return (
    // Read-only monospace display; same missing-primitive reason as `RawField`
    // above. Recorded in `scripts/primitive-adoption.json`.
    <input
      readOnly
      value={value}
      data-testid={testId}
      aria-label={testId}
      style={{
        display: "block",
        width: "100%",
        height: 52,
        border: "1.5px solid var(--line-2)",
        borderRadius: "var(--radius-2)",
        background: "var(--bg-1)",
        padding: "0 14px",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--fg-2)",
      }}
    />
  );
}

/** The canonical acknowledgement row (myne#728): a checkbox glyph inside a
 *  named toggle button, with the sentence beside it as the accessible name.
 *  Copying `CreateVaultFlow`'s `AckRow` keeps the two identical by shape. */
function AckRow({
  checked,
  onToggle,
  children,
  testId,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
  testId: string;
}) {
  const labelId = useId();
  return (
    <div
      style={{
        display: "flex",
        gap: "var(--space-3)",
        padding: "14px 0",
        marginTop: "var(--space-4)",
        borderTop: "1px solid var(--line-1)",
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <Button
        variant="ghost"
        full={false}
        onClick={onToggle}
        aria-pressed={checked}
        aria-labelledby={labelId}
        data-testid={testId}
        style={{ border: "none", background: "transparent", padding: 0, height: "auto", width: "auto", display: "flex", flex: "none" }}
      >
        <Checkbox checked={checked} />
      </Button>
      <div
        id={labelId}
        onClick={onToggle}
        style={{ flex: 1, fontSize: "var(--text-md)", lineHeight: "var(--leading-normal)", color: "var(--fg-1)", cursor: "pointer" }}
      >
        {children}
      </div>
    </div>
  );
}

/** Secondary ink for a hint line under a field or section. */
const HINT_STYLE = { fontSize: "var(--text-sm)", lineHeight: "var(--leading-normal)", color: "var(--fg-3)" } as const;

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
 * not. The presentation nonetheless follows the same envelope as every other
 * mobile flow: `Screen` → `FlowHeader` → padded `ScreenScroll` carrying a
 * `Title`/`Lead`, and a `FooterBar` for the step's actions.
 */
export function IdentityFlow({ onCancel }: IdentityFlowProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>("gate");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server step
  const [serverUrl, setServerUrl] = useState("");
  // The shared invite code for a gated server (myne-md/myne#800); empty for an
  // open one. Identity creation registers a new account, so a gated server
  // refuses it without the code.
  const [inviteCode, setInviteCode] = useState("");

  // Identity
  const [result, setResult] = useState<PersonSetupView | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [ackSaved, setAckSaved] = useState(false);

  // Home
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [identityCode, setIdentityCode] = useState<string | null>(null);
  // Forget-this-identity acknowledgement (myne-md/myne#782).
  const [forgetAck, setForgetAck] = useState(false);

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
      await syncSetEndpoint(trimmed, inviteCode.trim());
      setStep("create");
    } catch (e) {
      setError(serverConnectError(e, t));
    } finally {
      setBusy(false);
    }
  }, [serverUrl, inviteCode, t]);

  // The hosted door uses the same public-CA and hostname verification.
  const connectHosted = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await syncSetEndpoint(HOSTED_SYNC_ORIGIN, inviteCode.trim());
      setStep("create");
    } catch (e) {
      setError(serverConnectError(e, t));
    } finally {
      setBusy(false);
    }
  }, [inviteCode, t]);

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
      setResult(view);
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
    setResult(null);
    setRevealed(false);
    setAckSaved(false);
    setStep("home");
  }, []);

  const renderServer = () => (
    <Screen>
      <FlowHeader label={t("identityFlow.server.title")} onBack={() => setStep("gate")} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.server.title")}</Title>
        <Lead>{t("identityFlow.server.lead")}</Lead>
        <div style={{ marginTop: "var(--space-5)" }}>
          <Button
            variant="secondary"
            onClick={() => void connectHosted()}
            disabled={busy}
            data-testid="identity-flow.server-myne-sync"
          >
            {t("identityFlow.server.useMyneSync")}
          </Button>
        </div>
        <div style={{ ...HINT_STYLE, marginTop: "var(--space-4)" }}>{t("identityFlow.server.selfHostedHint")}</div>
        <div style={{ marginTop: "var(--space-4)" }}>
          <FieldLabel>{t("identityFlow.server.urlLabel")}</FieldLabel>
          <MonoField
            value={serverUrl}
            onChange={setServerUrl}
            placeholder="https://sync.example"
            inputMode="url"
            testId="identity-flow.server-input"
          />
        </div>
        <div style={{ marginTop: "var(--space-4)" }}>
          <FieldLabel>{t("sync.endpoint.inviteLabel")}</FieldLabel>
          <MonoField
            value={inviteCode}
            onChange={setInviteCode}
            placeholder={t("sync.endpoint.invitePlaceholder")}
            testId="identity-flow.server-invite"
          />
        </div>
        {error ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar>
        <Button variant="secondary" full={false} onClick={() => setStep("gate")} data-testid="identity-flow.server-back">
          {t("identityFlow.back")}
        </Button>
        <Button
          onClick={() => void connectServer()}
          disabled={busy || !serverUrl.trim()}
          data-testid="identity-flow.server-connect"
        >
          {busy ? t("identityFlow.server.connecting") : t("identityFlow.server.connect")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("identityFlow.server.connecting")} />}
    </Screen>
  );

  const renderHeld = () => (
    <Screen>
      <FlowHeader label={t("identityFlow.held.title")} onBack={onCancel} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.held.title")}</Title>
        <Lead>{t("identityFlow.held.lead")}</Lead>
        {error ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", gap: "var(--space-3)" }}>
        <Button variant="danger" onClick={() => void forgetHeld()} disabled={busy} data-testid="identity-flow.held-forget">
          {t("identityFlow.held.forget")}
        </Button>
        <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.held-cancel">
          {t("identityFlow.back")}
        </Button>
      </FooterBar>
    </Screen>
  );

  const renderGate = () => (
    <Screen>
      <FlowHeader label={t("identityFlow.title")} onBack={onCancel} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.title")}</Title>
        <Lead>{t("identityFlow.lead")}</Lead>
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", gap: "var(--space-3)" }}>
        <Button onClick={() => setStep("server")} data-testid="identity-flow.start">
          {t("identityFlow.start")}
        </Button>
        <Button variant="ghost" onClick={onCancel} data-testid="identity-flow.skip">
          {t("identityFlow.skip")}
        </Button>
      </FooterBar>
    </Screen>
  );

  const renderCreate = () => (
    <Screen>
      <FlowHeader label={t("identityFlow.create.title")} onBack={() => setStep("server")} />
      <ScreenScroll style={{ padding: "18px 22px 0" }}>
        <Title>{t("identityFlow.create.title")}</Title>
        <Lead>{t("identityFlow.create.lead")}</Lead>
        {error ? (
          <Banner kind="warning" style={{ marginTop: "var(--space-4)" }}>
            {error}
          </Banner>
        ) : null}
      </ScreenScroll>
      <FooterBar>
        <Button variant="secondary" full={false} onClick={() => setStep("server")}>
          {t("identityFlow.back")}
        </Button>
        <Button onClick={() => void createIdentity()} disabled={busy} data-testid="identity-flow.create">
          {busy ? t("identityFlow.create.working") : t("identityFlow.create.cta")}
        </Button>
      </FooterBar>
      {busy && <BlockingOverlay title={t("identityFlow.create.working")} />}
    </Screen>
  );

  const renderPhrase = () => {
    const phrase = (result?.phrase ?? "").split(" ");
    return (
      <Screen>
        <FlowHeader label={t("identityFlow.phrase.title")} />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          <Title>{t("identityFlow.phrase.title")}</Title>
          <Lead>{t("identityFlow.phrase.warning")}</Lead>
          <div style={{ marginTop: "var(--space-5)" }}>
            {revealed ? (
              <RecoveryGrid words={phrase} />
            ) : (
              <Button onClick={() => setRevealed(true)} data-testid="identity-flow.phrase-reveal">
                {t("identityFlow.phrase.reveal")}
              </Button>
            )}
          </div>
          <AckRow
            checked={ackSaved}
            onToggle={() => setAckSaved((v) => !v)}
            testId="identity-flow.phrase-ack"
          >
            {t("identityFlow.phrase.ack")}
          </AckRow>
        </ScreenScroll>
        <FooterBar>
          <Button
            onClick={finishPhrase}
            disabled={!ackSaved || !revealed}
            data-testid="identity-flow.phrase-continue"
          >
            {t("identityFlow.phrase.continue")}
          </Button>
        </FooterBar>
      </Screen>
    );
  };

  const renderHome = () => {
    const pending = (invites ?? []).filter((i) => !i.claimed);
    return (
      <Screen>
        <FlowHeader label={t("identityFlow.home.title")} onBack={onCancel} />
        <ScreenScroll style={{ padding: "18px 22px 0" }}>
          <Title>{t("identityFlow.home.title")}</Title>
          <Lead>{t("identityFlow.home.lead")}</Lead>

          {identityCode ? (
            <div style={{ marginTop: "var(--space-5)" }}>
              <FieldLabel>{t("identityFlow.home.codeLabel")}</FieldLabel>
              <MonoBox value={identityCode} testId="identity-flow.home-code" />
            </div>
          ) : null}

          <div style={{ marginTop: "var(--space-5)" }}>
            <FieldLabel>{t("identityFlow.home.invitesHeading")}</FieldLabel>
            {invites === null ? (
              <Spinner />
            ) : pending.length === 0 ? (
              <div style={HINT_STYLE} data-testid="identity-flow.home-empty">
                {t("identityFlow.home.noInvites")}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                {pending.map((inv) => (
                  <div
                    key={inv.invite_id_hex}
                    data-testid="identity-flow.invite-row"
                    style={{
                      background: "var(--bg-1)",
                      border: "1px solid var(--line-1)",
                      borderRadius: "var(--radius-2)",
                      padding: "var(--space-3)",
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                        color: "var(--fg-3)",
                        wordBreak: "break-all",
                        userSelect: "all",
                      }}
                    >
                      {inv.vault_account_hash_hex}
                    </div>
                    <div style={{ ...HINT_STYLE, marginTop: "var(--space-2)" }}>{t("identityFlow.home.inviteHint")}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Forget this identity on this device (myne-md/myne#782). Device-local:
              the server account survives and is recoverable with the phrase. */}
          <div style={{ marginTop: "var(--space-5)", paddingTop: "var(--space-4)", borderTop: "1px solid var(--line-1)" }}>
            <FieldLabel>{t("identityFlow.home.forgetHeading")}</FieldLabel>
            {error ? (
              <Banner kind="warning" style={{ marginBottom: "var(--space-3)" }}>
                {error}
              </Banner>
            ) : null}
            <AckRow
              checked={forgetAck}
              onToggle={() => setForgetAck((v) => !v)}
              testId="identity-flow.home-forget-ack"
            >
              {t("identityFlow.home.forgetCheckbox")}
            </AckRow>
            <Button
              variant="ghost"
              disabled={!forgetAck || busy}
              onClick={() => void forgetHeld()}
              style={{ color: "var(--danger)", marginTop: "var(--space-3)" }}
              data-testid="identity-flow.home-forget"
            >
              {t("identityFlow.home.forget")}
            </Button>
          </div>
        </ScreenScroll>
      </Screen>
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
