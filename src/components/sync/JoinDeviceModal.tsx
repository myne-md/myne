// "Add this device to an existing account" (MYND-424) — the fresh-device join
// flow. Server URL + account number + password → `sync_join_account` bootstraps
// the whole local vault from the server's meta (no 24-word recovery), unlocks
// it, and SCRAM-enrolls (password → pending until an existing device approves).
// On success the caller routes to the editor; sync starts once approved.
// Built against design tokens; Penpot skipped per the owner directive.

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { BetaTermsConsent } from "./BetaTermsConsent";
import { useBetaTermsGate } from "../../hooks/useBetaTermsGate";
import { useHeadFingerprintCompare } from "../../hooks/useHeadFingerprintCompare";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import { useTranslation } from "react-i18next";
import { invoke } from "../../platform/core";
import { Input } from "../primitives/Input";
import { PasswordInput } from "../PasswordInput";
import { DestructiveBanner } from "../DestructiveBanner";
import { FingerprintConfirm, fingerprintGateRefusal } from "./FingerprintConfirm";
import { formatAccountNumberInput } from "../../lib/account-number-format";
import { DEVICE_NAME_MAX_LEN, useDeviceNameField } from "../../lib/device-name";
// Aliased: the component already has a `setDeviceName` React state setter.
import { setDeviceName as persistDeviceName } from "../../lib/prefs";
import { ENROLL_PENDING_NOTICE } from "../../lib/load-bearing-copy";
import { refreshTorState } from "../../hooks/useTorState";
import { hoverSurface, HOVER_TRANSITION } from "../primitives/hoverSurface";

interface JoinResult {
  /** The device_id this join registered (MYND-548) — used to name THIS device in
   *  its own local prefs; a pending device cannot read the roster to find itself. */
  device_id_hex: string;
  vault_id: string;
  pending: boolean;
  fingerprint: string | null;
}

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--scrim)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const CARD: CSSProperties = {
  width: 460,
  maxWidth: "calc(100vw - var(--space-7))",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-3)",
  padding: "var(--space-6)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  fontFamily: "var(--font-sans)",
  color: "var(--fg-1)",
};

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
const LABEL: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: "var(--weight-semibold)",
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
    ? hoverSurface({ restBg: "var(--accent)", hoverBg: "var(--accent-hover)", disabled })
    : hoverSurface({ restBg: "var(--bg-2)", hoverBg: "var(--paper-3)", disabled });
}

interface JoinDeviceModalProps {
  /** Close the modal without joining. */
  onCancel: () => void;
  /** Join succeeded; the vault is unlocked — route to the editor. */
  onJoined: (vaultId: string) => void;
}

export function JoinDeviceModal({ onCancel, onJoined }: JoinDeviceModalProps) {
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Post-join step machine: "pinned" surfaces the TOFU cert fingerprint (SYNC-43),
  // "pending" waits for an existing device to approve, "verify" is the mandatory
  // head-fingerprint SAS eye-compare (SYNC-40) before routing into the editor.
  const [step, setStep] = useState<"form" | "pinned" | "pending" | "verify">("form");
  const [joinedVaultId, setJoinedVaultId] = useState<string | null>(null);
  const [certFingerprint, setCertFingerprint] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  // MYND-548: the id this join minted, kept so the pending path can name the
  // device once its first pull lands.
  const [joinedDeviceId, setJoinedDeviceId] = useState<string | null>(null);
  // MYND-650 task 5: the certificate fingerprint the user obtained OUT-OF-BAND
  // from their own server, plus whether the backend has asked for it. Required
  // only in Tor mode, where the enrollment handshake — the one handshake that
  // accepts any certificate — travels through an exit node that is in a
  // position to serve its own.
  //
  // It is typed in BEFORE the pin is accepted, and the captured value is never
  // shown alongside the question: "here is what we got, does it match yours?"
  // anchors the user on whatever the attacker served, and offering the captured
  // value on the failure path would let them paste it back. The compare below
  // (`step === "pinned"`) is a different thing — by then the pin is already
  // verified against this input, and that screen exists for cross-device
  // comparison.
  const [expectedFingerprint, setExpectedFingerprint] = useState("");
  const [confirmNeeded, setConfirmNeeded] = useState(false);

  // MYND-548: this device's own name — the same hook the Settings enrollment form
  // uses, so the two doors cannot drift.
  const deviceNameField = useDeviceNameField();

  const canSubmit =
    url.trim().length > 0 &&
    account.trim().length > 0 &&
    password.length > 0 &&
    !busy;

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    void invoke<JoinResult>("plugin:sync|sync_join_account", {
      serverUrl: url.trim(),
      accountNumber: account.trim(),
      password,
      confirmedFingerprint: expectedFingerprint.trim() || null,
    })
      .then(async (res) => {
        setConfirmNeeded(false);
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
        // Show the pinned cert fingerprint first (SYNC-43) when there is one (a
        // loopback http join has no TLS); either way we then wait for approval +
        // the head-fingerprint verify.
        if (res.fingerprint) {
          setCertFingerprint(res.fingerprint);
          setStep("pinned");
        } else {
          setStep("pending");
        }
      })
      .catch((e: unknown) => {
        // The two Tor-mode refusals aborted the join before anything was
        // written — no endpoint, no pin, no vault container — so the form stays
        // put with the fingerprint field revealed. Every other failure keeps the
        // single non-distinguishing message.
        const refusal = fingerprintGateRefusal(e);
        if (refusal !== null) {
          setConfirmNeeded(true);
          setError(
            refusal === "PinConfirmationRequired"
              ? t("sync.join.confirmFingerprintRequired")
              : t("sync.join.confirmFingerprintMismatch"),
          );
          return;
        }
        setError(t("sync.join.error"));
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
  const onMismatch = () => {
    setAborting(true);
    setError(null);
    void invoke("plugin:sync|sync_reset_local")
      .then(() => onCancel())
      .catch(() => {
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

  // Post-join: the fresh device pinned the server's cert (TOFU) — surface the
  // fingerprint for out-of-band cross-device eye-compare, then wait for approval.
  if (step === "pinned" && certFingerprint) {
    return (
      <div
        ref={backdropRef}
        role="dialog"
        aria-modal="true"
        style={BACKDROP}
        data-testid="join.pinned"
      >
        <div style={CARD}>
          <h2 style={TITLE}>{t("sync.join.pinnedTitle")}</h2>
          <p style={HELP}>{t("sync.join.pinnedCompare")}</p>
          <p style={HELP}>
            <span
              style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}
              data-testid="join.cert-fingerprint"
            >
              {certFingerprint}
            </span>
          </p>
          <div style={ROW}>
            <button
              type="button"
              onClick={() => setStep("pending")}
              style={btn(true, false)}
              {...btnHover(true, false)}
              data-testid="join.continue"
            >
              {t("sync.join.continue")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Waiting for an existing device to approve — auto-polls, then advances to verify.
  if (step === "pending") {
    return (
      <div
        ref={backdropRef}
        role="dialog"
        aria-modal="true"
        style={BACKDROP}
        data-testid="join.pending"
      >
        <div style={CARD}>
          <h2 style={TITLE}>{t("sync.join.waitingTitle")}</h2>
          <p style={HELP}>{ENROLL_PENDING_NOTICE}</p>
          <p style={HELP}>{t("sync.join.waitingHint")}</p>
          <div style={ROW}>
            <button type="button" onClick={onCancel} style={btn(false, false)} {...btnHover(false, false)} data-testid="join.cancel">
              {t("sync.join.cancel")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Mandatory head-fingerprint SAS eye-compare (SYNC-40).
  if (step === "verify") {
    return (
      <div
        ref={backdropRef}
        role="dialog"
        aria-modal="true"
        style={BACKDROP}
        data-testid="join.verify"
      >
        <div style={CARD}>
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
        </div>
      </div>
    );
  }

  return (
    <div
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${baseId}-title`}
      data-testid="join.modal"
      style={BACKDROP}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div style={CARD} onClick={(e) => e.stopPropagation()}>
        <h2 id={`${baseId}-title`} style={TITLE}>
          {t("sync.join.title")}
        </h2>
        <p style={HELP}>{t("sync.join.help")}</p>

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

        <PasswordInput
          label={t("sync.join.passwordLabel")}
          value={password}
          onChange={setPassword}
          show={showPassword}
          onToggleShow={() => setShowPassword((s) => !s)}
          testId="join.password-input"
        />

        {error && <DestructiveBanner testId="join.error">{error}</DestructiveBanner>}

        {/* Revealed only once the backend refuses for want of it — see the
            state declaration for why this is typed in rather than confirmed.
            While it is open it carries the retry AND the abort, so the footer
            below stands down: two "Add device" buttons on one card would be a
            choice between identical actions at the exact moment this screen is
            asking the user to slow down. Declining costs nothing to undo —
            the refused join wrote no endpoint, no pin and no vault container. */}
        {confirmNeeded ? (
          <FingerprintConfirm
            value={expectedFingerprint}
            onChange={setExpectedFingerprint}
            onConfirm={submit}
            onDecline={onCancel}
            confirmLabel={busy ? t("sync.join.submitting") : t("sync.join.submit")}
            confirmDisabled={!canSubmit}
            testIdPrefix="join"
          />
        ) : (
          <div style={ROW}>
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              style={btn(false, busy)}
              {...btnHover(false, busy)}
              data-testid="join.cancel"
            >
              {t("sync.join.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              style={btn(true, !canSubmit)}
              {...btnHover(true, !canSubmit)}
              data-testid="join.submit"
            >
              {busy ? t("sync.join.submitting") : t("sync.join.submit")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
