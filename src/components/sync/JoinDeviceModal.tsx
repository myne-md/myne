// "Add this device to an existing account" (MYND-424) — the fresh-device join
// flow. Server URL + account number + password → `sync_join_account` bootstraps
// the whole local vault from the server's meta (no 24-word recovery), unlocks
// it, and SCRAM-enrolls (password → pending until an existing device approves).
// On success the caller routes to the editor; sync starts once approved.
// Built against design tokens; Penpot skipped per the owner directive.
//
// myne-md/myne#468 changed three things, and none of them the security steps:
//
//  - **Full screen, not a modal** (task 10). Adding a device is as weighty as
//    creating a vault — the user is about to hand this machine a copy of every
//    note — and a card over a scrim read as a settings dialog. The states below
//    are unchanged: the TOFU pin, the Tor fingerprint confirmation, the SAS
//    compare and the SAS-mismatch abort all render and behave as before; only
//    the wrapper around each one moved into `AuthShell`.
//  - **A second way in** (task 7): "with my recovery phrase". The phrase is full
//    account takeover in the server's own assessment, so that path self-approves
//    — it is the door for a user who has lost every device and so has nobody to
//    approve a password join. It lands in the recovery flow's mandatory password
//    reset, because a user who needed the phrase may not know the password.
//  - **An escape from waiting** (task 8). "Waiting for approval" offered only
//    Cancel, so a user whose only other device is gone waited forever with
//    nothing saying another door existed.
//
// The phrase path is offered only where `phraseEnrolment` is present. The web
// client lacks it on purpose (a routine phrase prompt in a page is the A18
// training) and substitutes this whole module away in any case.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { AuthShell } from "../../screens/AuthShell";
import { Button } from "../primitives/Button";
import { Segmented } from "../primitives/Segmented";
import { PhraseEntryGrid } from "../PhraseEntryGrid";
import { buildPhraseCredential, PHRASE_CELL_COUNT } from "./phrase-credential";
import { useEnroll } from "../../hooks/useEnroll";
import { has } from "../../platform/capabilities";
import { BetaTermsConsent } from "./BetaTermsConsent";
import { useBetaTermsGate } from "../../hooks/useBetaTermsGate";
import { useHeadFingerprintCompare } from "../../hooks/useHeadFingerprintCompare";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import { useTranslation } from "react-i18next";
import { invoke } from "../../platform/core";
import { resetLocalOrReport } from "../../lib/reset-local";
import { Input } from "../primitives/Input";
import { PasswordInput } from "../PasswordInput";
import { DestructiveBanner } from "../DestructiveBanner";
import { formatAccountNumberInput } from "../../lib/account-number-format";
import { DEVICE_NAME_MAX_LEN, useDeviceNameField } from "../../lib/device-name";
// Aliased: the component already has a `setDeviceName` React state setter.
import { setDeviceName as persistDeviceName } from "../../lib/prefs";
import {
  ENROLL_NON_DISTINGUISHING_BANNER,
  ENROLL_PENDING_NOTICE,
} from "../../lib/load-bearing-copy";
import { refreshTorState } from "../../hooks/useTorState";
import { HOVER_TRANSITION } from "../primitives/hoverSurface";
import { interactiveSurface } from "../primitives/interactiveSurface";

interface JoinResult {
  /** The device_id this join registered (MYND-548) — used to name THIS device in
   *  its own local prefs; a pending device cannot read the roster to find itself. */
  device_id_hex: string;
  vault_id: string;
  pending: boolean;
  fingerprint: string | null;
  /** The join used the recovery phrase (myne-md/myne#468): the vault is
   *  `Recovering`, and the mandatory password reset comes next. */
  needs_password_reset: boolean;
}

/** The whole window, over whatever stage is showing. Still a modal layer —
 *  `App.tsx` mounts this over welcome, the picker and the unlock screen — but it
 *  owns the screen the way vault creation does rather than floating a card. */
const FULLSCREEN: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
};

/** The column every step lays out in. The card's gap and ink, without the card. */
const STACK: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  fontFamily: "var(--font-sans)",
  color: "var(--fg-1)",
};

/**
 * One wrapper for every step, so the move to full screen is ONE change rather
 * than five. The root keeps `role="dialog"` + `aria-modal` and the ref
 * `useOverlayInert` reads, because the layer is still modal over the stage
 * beneath it; the testid stays on the root so every scenario addressing a step
 * by it still finds it.
 */
function JoinScreen({
  rootRef,
  testId,
  labelledBy,
  children,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  testId: string;
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      style={FULLSCREEN}
      data-testid={testId}
    >
      <AuthShell align="upper">
        <div style={STACK}>{children}</div>
      </AuthShell>
    </div>
  );
}

const TITLE: CSSProperties = {
  fontSize: "var(--text-xl)",
  fontWeight: "var(--weight-semibold)" as CSSProperties["fontWeight"],
  margin: 0,
};

const HELP: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
  lineHeight: "var(--leading-normal)",
};

const FIELD: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
/** Sentence case, like every other first-run field label. */
const LABEL: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

/** The raised surface the form's fields sit on, the one every first-run step
 *  puts its working content on. */
const FIELDS_CARD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  padding: "var(--space-5)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-3)",
};

/** The waiting screen's second door, set apart by a rule so it reads as an
 *  alternative rather than as the next instruction. */
const ESCAPE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  borderTop: "1px solid var(--line-1)",
  paddingTop: "var(--space-3)",
};

const ROW: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  justifyContent: "flex-end",
};

function btn(primary: boolean, disabled: boolean): CSSProperties {
  return {
    padding: "8px 18px",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-medium)",
    borderRadius: "var(--radius-2)",
    cursor: disabled ? "not-allowed" : "pointer",
    border: primary ? "none" : "1px solid var(--line-1)",
    background: primary ? "var(--accent)" : "var(--bg-2)",
    color: primary ? "var(--accent-on)" : "var(--fg-1)",
    opacity: disabled ? 0.6 : 1,
    transition: HOVER_TRANSITION,
  };
}

/** Hover for a `btn()`-styled control: a primary deepens `--accent` → its hover
 *  accent; a secondary deepens `--bg-2` → `--paper-3`. Pass the same `disabled`
 *  the button carries so a dimmed control stays inert. */
function btnHover(primary: boolean, disabled: boolean) {
  return primary
    ? interactiveSurface({ restBg: "var(--accent)", hoverBg: "var(--accent-hover)", disabled })
    : interactiveSurface({ restBg: "var(--bg-2)", hoverBg: "var(--paper-3)", disabled });
}

interface JoinDeviceModalProps {
  /** Close the modal without joining. */
  onCancel: () => void;
  /** Join succeeded; the vault is unlocked — route to the editor. */
  onJoined: (vaultId: string) => void;
  /**
   * A recovery-phrase join succeeded (myne-md/myne#468): the vault is
   * `Recovering`, not unlocked, and the recovery flow's mandatory password reset
   * is owed. The caller reprobes, and boot routing already sends a `Recovering`
   * slot to that step — the same door a reload mid-recovery uses.
   */
  onRecovering: () => void;
}

export function JoinDeviceModal({ onCancel, onJoined, onRecovering }: JoinDeviceModalProps) {
  const betaTerms = useBetaTermsGate();
  const { t } = useTranslation();
  const baseId = useId();
  // The rest of the page goes INERT while this is open (myne-md/myne#728,
  // review). This one is mounted globally by `App.tsx` over whatever screen
  // the user was on, and unlike its nine siblings it has no focus trap
  // either, so before this the background was reachable by Tab, by a screen
  // reader's virtual cursor AND by a click. `inert` closes all three at once,
  // which is why it is worth having even where a trap is still owed.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, true);
  const [url, setUrl] = useState("");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  // Which credential the join uses (task 7). Offered only where the capability
  // is present; everywhere else the choice does not render and this stays put.
  const phraseAvailable = has("phraseEnrolment");
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [cells, setCells] = useState<string[]>(() =>
    Array.from({ length: PHRASE_CELL_COUNT }, () => ""),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-join step machine: "pending" waits for an existing device to approve,
  // "verify" is the mandatory head-fingerprint SAS eye-compare (SYNC-40) before
  // routing into the editor. "pending-phrase" is the escape from "pending"
  // (task 8): the same device, already joined and unlocked with the password,
  // proves the account with the phrase instead of waiting for an approval
  // nobody is left to give. There is no certificate step: the server is
  // trusted through the platform's CA store (`docs/decisions/sync/0620`).
  const [step, setStep] = useState<"form" | "pending" | "pending-phrase" | "verify">("form");
  const [joinedVaultId, setJoinedVaultId] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  // MYND-548: the id this join minted, kept so the pending path can name the
  // device once its first pull lands.
  const [joinedDeviceId, setJoinedDeviceId] = useState<string | null>(null);

  // MYND-548: this device's own name — the same hook the Settings enrollment form
  // uses, so the two doors cannot drift.
  const deviceNameField = useDeviceNameField();

  const credentialFilled =
    mode === "password" ? password.length > 0 : cells.every((c) => c.length > 0);
  const canSubmit =
    url.trim().length > 0 && account.trim().length > 0 && credentialFilled && !busy;

  // The 24-cell grid's two handlers, the same shape `EnrollDeviceForm` uses:
  // whitespace never lands inside a cell, and a multi-word paste distributes.
  const handleCellChange = (index: number) => (e: ChangeEvent<HTMLInputElement>) => {
    const cleaned = e.target.value.replace(/\s+/g, "");
    setCells((prev) => prev.map((c, i) => (i === index ? cleaned : c)));
  };
  const handleCellPaste = (index: number) => (e: ClipboardEvent<HTMLInputElement>) => {
    const tokens = e.clipboardData
      .getData("text")
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (tokens.length < 2) return;
    e.preventDefault();
    setCells((prev) => {
      const next = [...prev];
      for (let i = 0; i < tokens.length && index + i < PHRASE_CELL_COUNT; i++) {
        next[index + i] = tokens[i];
      }
      return next;
    });
  };
  const clearCells = () => setCells(Array.from({ length: PHRASE_CELL_COUNT }, () => ""));

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const credential = mode === "password" ? password : buildPhraseCredential(cells);
    void invoke<JoinResult>("plugin:sync|sync_join_account", {
      serverUrl: url.trim(),
      accountNumber: account.trim(),
      password: credential,
      credentialKind: mode,
    })
      .then(async (res) => {
        // The phrase never outlives the call that used it.
        clearCells();
        // A phrase join (task 7) leaves the vault RECOVERING. Nothing here can
        // name the device or run a cycle — both need an unlocked vault — so it
        // hands straight to the password reset. The device keeps its id-derived
        // label until renamed, the same fallback a failed naming has always had.
        if (res.needs_password_reset) {
          onRecovering();
          return;
        }
        setJoinedDeviceId(res.device_id_hex);
        // A join writes the endpoint, and the Tor posture is endpoint-aware
        // (MYND-650 task 8): `exempt` polls slowly because only a deliberate
        // act can move it, so every path that writes an endpoint owes this
        // re-read. Otherwise the Network panel keeps describing whatever server
        // was configured before the join.
        refreshTorState();
        if (!res.pending) {
          // Self-approved (first device / recovery bootstrap): a cycle can run
          // now, so name after it — never before, or the §10.2.1 seed dies.
          try {
            await invoke("plugin:sync|sync_now");
            await persistDeviceName(res.device_id_hex, deviceNameField.resolved);
          } catch {
            // The row keeps its id-derived label; rename fixes it.
          }
          // Bootstrap/recovery self-approve (first device) — nothing to
          // eye-compare against, so route straight in.
          onJoined(res.vault_id);
          return;
        }
        setJoinedVaultId(res.vault_id);
        setStep("pending");
      })
      .catch((e: unknown) => {
        // A TLS failure names itself (the server's certificate did not chain to
        // a trusted CA). Every other failure keeps the single non-distinguishing
        // message, naming the credential the user actually typed: the password
        // sentence under a phrase attempt sent people to re-check a field they
        // had not used.
        if ((e as { kind?: string } | null)?.kind === "TlsFailure") {
          setError(t("sync.endpoint.tlsFailure"));
          return;
        }
        setError(mode === "password" ? t("sync.join.error") : t("sync.join.errorPhrase"));
      })
      .finally(() => setBusy(false));
  };

  // The adopted-head watch, and the SYNC-40 compare it feeds (myne#462).
  //
  // Armed from `pending` rather than from `verify`, which is load-bearing: the
  // device-name write below fires the instant a head is adopted, i.e. BEFORE the
  // verify screen exists. A hold armed on the compare screen would arrive one
  // vault write too late — and that write is the issue's own primary reproducer,
  // because `device_names` lives in `vault.prefs` and a prefs push authors a head.
  //
  // The hold suppresses the PUSH, not the write. `persistDeviceName` still lands
  // on disk immediately, so MYND-548 (the name that used to get lost) stays
  // fixed; only its trip to the server waits for the compare to close.
  const { fingerprint: headFingerprint, changed: sasChanged } = useHeadFingerprintCompare(
    step === "pending" || step === "verify",
    "joiner",
  );

  // The pending → verify edge. A non-null fingerprint means this device pulled
  // and MAC-verified a head, which is also the moment naming becomes safe (the
  // §10.2.1 prefs seed has had its turn). Both happen exactly once — `named`
  // guards the write against the poll that keeps running behind the compare.
  const named = useRef(false);
  useEffect(() => {
    if (step !== "pending" || headFingerprint === null) return;
    if (joinedDeviceId && !named.current) {
      named.current = true;
      void persistDeviceName(joinedDeviceId, deviceNameField.resolved).catch(() => {
        // The row keeps its id-derived label; rename from Settings fixes it.
      });
    }
    setStep("verify");
  }, [step, headFingerprint, joinedDeviceId, deviceNameField.resolved]);

  // The waiting screen's escape (task 8). The device is joined and UNLOCKED
  // (with the password) but pending; `sync_enroll` with the phrase re-proves the
  // account on the same vault and the server self-approves the recovery path.
  // No password reset: the user just typed the password, so they have it.
  const phraseEnroll = useEnroll();
  useEffect(() => {
    if (step !== "pending-phrase") return;
    if (phraseEnroll.outcome?.state === "approved" && joinedVaultId) {
      // Self-approved, so there is no second device to eye-compare against —
      // the same reason a first device routes straight in above.
      onJoined(joinedVaultId);
    }
  }, [step, phraseEnroll.outcome, joinedVaultId, onJoined]);

  const submitPendingPhrase = () => {
    if (!cells.every((c) => c.length > 0) || phraseEnroll.busy) return;
    const credential = buildPhraseCredential(cells);
    clearCells();
    void phraseEnroll.enroll(
      account.trim(),
      credential,
      "recovery",
      deviceNameField.resolved,
    );
  };

  // SAS mismatch → ABORT: un-enroll this device so it stops trusting the
  // (possibly forked) synced data, then close.
  //
  // A FAILED un-enrol must not close the modal. This used to be
  // `.catch(() => {}).finally(() => onCancel())`, which closed either way: a
  // user who compared fingerprints, saw a mismatch — the single signal that a
  // hostile server or a forked head is in play — and pressed abort got the same
  // outcome whether the device was actually disconnected or not. If the reset
  // failed, they were left enrolled against that endpoint, with a UI that had
  // just told them they backed out. Silence is indistinguishable from success
  // exactly where it must not be (test-audit #10/#65).
  //
  // The call is `lib/reset-local.ts`'s, which is the ONE implementation of it:
  // `AccountBootstrap` has two more doors onto the same command and they used to
  // disagree about what a refusal means.
  const onMismatch = () => {
    setAborting(true);
    setError(null);
    void resetLocalOrReport().then((reset) => {
      if (reset) {
        onCancel();
        return;
      }
      setAborting(false);
      setError(t("sync.join.sasAbortFailed"));
    });
  };

  // The beta-terms gate (myne-ops#15). This is the welcome-screen door onto
  // sync, and it stands FIRST — before the form, before the cert pin, before
  // anything that contacts a server. Placing it here rather than beside the
  // submit button is the same rule the screen itself states: there must be no
  // route to acceptance that skips the text, and no route past it either.
  //
  // Cancelling closes the modal, which is exactly what "not now" means at this
  // door — the user came from the welcome screen and can go back to it.
  if (!betaTerms.pending && betaTerms.needed) {
    // The consent carries its own dialog chrome, so this door hands it the
    // surface outright rather than wrapping it in a second one.
    return (
      <BetaTermsConsent
        open
        testId="join.beta-terms"
        onAccept={() => {
          void betaTerms.accept();
        }}
        onCancel={onCancel}
      />
    );
  }

  // Waiting for an existing device to approve — auto-polls, then advances to verify.
  if (step === "pending") {
    return (
      <JoinScreen rootRef={backdropRef} testId="join.pending">
          <h2 style={TITLE}>{t("sync.join.waitingTitle")}</h2>
          <p style={HELP}>{ENROLL_PENDING_NOTICE}</p>
          <p style={HELP}>{t("sync.join.waitingHint")}</p>
          {/* The escape (myne-md/myne#468, task 8). Before this the only control
              was Cancel, and a user whose other device is gone waited forever
              with nothing saying a second door existed. Offered only where the
              phrase is a device credential at all. */}
          {phraseAvailable && (
            <div style={ESCAPE_STYLE} data-testid="join.no-device">
              <p style={HELP}>{t("sync.join.noDeviceBody")}</p>
              <div>
                {/* The primitive, unlike this file's older hand-rolled buttons:
                    new controls do not add to `check-primitive-adoption.mjs`'s
                    count, and moving the existing ones is not this change. */}
                <Button
                  variant="secondary"
                  onClick={() => {
                    clearCells();
                    setStep("pending-phrase");
                  }}
                  data-testid="join.use-phrase"
                >
                  {t("sync.join.usePhrase")}
                </Button>
              </div>
            </div>
          )}
          <div style={ROW}>
            <button type="button" onClick={onCancel} style={btn(false, false)} {...btnHover(false, false)} data-testid="join.cancel">
              {t("sync.join.cancel")}
            </button>
          </div>
      </JoinScreen>
    );
  }

  // The phrase instead of an approval (task 8). Same device, same unlocked
  // vault; only the enrolment is re-run on the recovery path.
  if (step === "pending-phrase") {
    const filled = cells.every((c) => c.length > 0);
    return (
      <JoinScreen rootRef={backdropRef} testId="join.pending-phrase">
        <h2 style={TITLE}>{t("sync.join.phraseTitle")}</h2>
        {/* Not the join form's warning: that one promises a password reset,
            and here there is none — the vault is already open with the password
            the user just typed. */}
        <p style={HELP} data-testid="join.phrase-escape-warning">
          {t("sync.join.phraseEscapeBody")}
        </p>
        <PhraseEntryGrid
          baseId={`${baseId}-pending`}
          cells={cells}
          onCellChange={handleCellChange}
          onCellPaste={handleCellPaste}
          disabled={phraseEnroll.busy}
          gridTestId="join.phrase-grid"
          cellTestId={() => "join.phrase-cell"}
        />
        {phraseEnroll.outcome?.state === "error" && (
          <DestructiveBanner testId="join.error">{ENROLL_NON_DISTINGUISHING_BANNER}</DestructiveBanner>
        )}
        {/* A still-pending answer on the recovery path means the server did not
            self-approve it — say so rather than looping back to waiting. */}
        {phraseEnroll.outcome?.state === "pending" && (
          <p style={HELP} data-testid="join.phrase-still-pending">
            {ENROLL_PENDING_NOTICE}
          </p>
        )}
        <div style={ROW}>
          <Button
            variant="secondary"
            onClick={() => {
              clearCells();
              phraseEnroll.reset();
              setStep("pending");
            }}
            disabled={phraseEnroll.busy}
            data-testid="join.phrase-back"
          >
            {t("sync.join.backToWaiting")}
          </Button>
          <Button
            variant="primary"
            onClick={submitPendingPhrase}
            disabled={!filled || phraseEnroll.busy}
            data-testid="join.phrase-submit"
          >
            {phraseEnroll.busy ? t("sync.join.submitting") : t("sync.join.submit")}
          </Button>
        </div>
      </JoinScreen>
    );
  }

  // Mandatory head-fingerprint SAS eye-compare (SYNC-40).
  if (step === "verify") {
    return (
      <JoinScreen rootRef={backdropRef} testId="join.verify">
          <h2 style={TITLE}>{t("sync.join.verifyTitle")}</h2>
          <p style={HELP}>{t("sync.join.verifyBody")}</p>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xl)",
              fontWeight: "var(--weight-bold)",
              letterSpacing: "0.16em",
              textAlign: "center",
              padding: "var(--space-4)",
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-1)",
            }}
            data-testid="join.sas-fingerprint"
          >
            {headFingerprint}
          </div>
          {/* The head moved while the compare was open. Announced rather than
              swapped silently: a code that changes under the reader turns a
              comparison into a guess. */}
          {sasChanged && (
            <p style={HELP} data-testid="join.sas-changed">
              {t("sync.join.verifyChanged")}
            </p>
          )}
          <div style={{ ...ROW, justifyContent: "space-between" }}>
            <button
              type="button"
              onClick={onMismatch}
              disabled={aborting}
              style={{ ...btn(false, aborting), color: "var(--danger)" }}
              {...btnHover(false, aborting)}
              data-testid="join.sas-mismatch"
            >
              {t("sync.join.sasMismatch")}
            </button>
            <button
              type="button"
              onClick={() => joinedVaultId && onJoined(joinedVaultId)}
              disabled={aborting}
              style={btn(true, aborting)}
              {...btnHover(true, aborting)}
              data-testid="join.sas-match"
            >
              {t("sync.join.sasMatch")}
            </button>
          </div>
          {/* The abort's own failure surfaces HERE, in the step where the user
              pressed it — not as a closed modal that implies it worked. */}
          {error && <DestructiveBanner testId="join.error">{error}</DestructiveBanner>}
      </JoinScreen>
    );
  }

  return (
    <JoinScreen rootRef={backdropRef} testId="join.modal" labelledBy={`${baseId}-title`}>
        <h2 id={`${baseId}-title`} style={TITLE}>
          {t("sync.join.title")}
        </h2>
        <p style={HELP}>{t("sync.join.help")}</p>

        <div style={FIELDS_CARD}>
        <div style={FIELD}>
          <label style={LABEL} htmlFor={`${baseId}-url`}>
            {t("sync.join.serverLabel")}
          </label>
          <Input
            id={`${baseId}-url`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("sync.join.serverPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            data-testid="join.server-input"
          />
        </div>

        <div style={FIELD}>
          <label style={LABEL} htmlFor={`${baseId}-account`}>
            {t("sync.join.accountLabel")}
          </label>
          <Input
            id={`${baseId}-account`}
            value={account}
            onChange={(e) => setAccount(formatAccountNumberInput(e.target.value))}
            placeholder="MY-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            data-testid="join.account-input"
          />
        </div>

        {/* MYND-548: the same "Name this device" field the Settings enrollment
            form carries. The two doors must behave identically. The name is
            applied only once this device completes a pull — never at join time,
            which would disable the §10.2.1 seed. */}
        <div style={FIELD}>
          <label style={LABEL} htmlFor={`${baseId}-device-name`}>
            {t("sync.enroll.deviceNameLabel")}
          </label>
          <Input
            id={`${baseId}-device-name`}
            value={deviceNameField.value}
            onChange={(e) => deviceNameField.setValue(e.target.value)}
            maxLength={DEVICE_NAME_MAX_LEN}
            placeholder={deviceNameField.suggestion}
            autoComplete="off"
            spellCheck={false}
            data-testid="join.device-name-input"
          />
        </div>

        {/* The second way in (myne-md/myne#468, task 7). Absent — not hidden —
            where the phrase is not a device credential. */}
        {phraseAvailable && (
          <div style={FIELD}>
            <span style={LABEL}>{t("sync.enroll.signInWith")}</span>
            <Segmented
              options={[
                { value: "password", label: t("sync.join.modePassword") },
                { value: "recovery", label: t("sync.join.modePhrase") },
              ]}
              value={mode}
              onChange={(v) => {
                setError(null);
                setMode(v as "password" | "recovery");
              }}
              ariaLabel={t("sync.enroll.credentialTypeAria")}
              testId="join.mode"
            />
          </div>
        )}

        {mode === "password" ? (
          <PasswordInput
            label={t("sync.join.passwordLabel")}
            value={password}
            onChange={setPassword}
            show={showPassword}
            onToggleShow={() => setShowPassword((s) => !s)}
            testId="join.password-input"
          />
        ) : (
          <>
            {/* The warning carries the server's own assessment: the phrase is
                full account takeover, which is WHY this path needs no approval
                from another device. Stated before the grid, not after submit. */}
            <p style={HELP} data-testid="join.phrase-warning">
              {t("sync.join.phraseWarning")}
            </p>
            <PhraseEntryGrid
              baseId={baseId}
              cells={cells}
              onCellChange={handleCellChange}
              onCellPaste={handleCellPaste}
              disabled={busy}
              gridTestId="join.phrase-grid"
              cellTestId={() => "join.phrase-cell"}
            />
          </>
        )}
        </div>

        {error && <DestructiveBanner testId="join.error">{error}</DestructiveBanner>}

        <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="ghost"
              icon="arrow-left"
              onClick={onCancel}
              disabled={busy}
              data-testid="join.cancel"
            >
              {t("sync.join.back")}
            </Button>
            <div style={{ flex: 1 }} />
            <Button
              variant="primary"
              onClick={submit}
              disabled={!canSubmit}
              data-testid="join.submit"
            >
              {busy ? t("sync.join.submitting") : t("sync.join.submit")}
            </Button>
          </div>
    </JoinScreen>
  );
}
