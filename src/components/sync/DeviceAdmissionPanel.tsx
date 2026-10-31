// The two-sided device admission ceremony (myne-md/myne#938 task 11;
// `decisions/protocol/0735`). Built against design tokens, no Penpot pass.
//
// # The one rule this surface exists to enforce
//
// Each side gates its OWN action behind its OWN tap. The joining device writes
// nothing until its confirm button is pressed, and the admitting device installs
// no credential and writes no row until its own. Both buttons stay disabled until
// the human has said the two screens show the same string, and a mismatch is a
// STOP rather than a retry: the SAS is derived over the whole admission code, so
// a difference means the code changed in transit, and "try again" would train the
// user to press through the one signal that catches it.
//
// # Why the code is pasted and not scanned
//
// The admission code is several kilobytes of hex, larger than any QR symbol can
// hold and far past what a person would type, so it travels by whatever channel
// the user has (a shared clipboard, a message to themselves), and the SAS is what
// makes that channel safe: eight hex characters both screens derive
// independently, and a substituted code moves them. That is `0735` decision 2's
// whole point, and it is why this panel asks the user to compare a string instead
// of trusting a paste.
//
// The code is CREDENTIAL-EQUIVALENT and is copied through the SECRET path
// (`copySecretToClipboard`), not the plain one: it carries both SCRAM verifier
// halves, so whoever holds it can complete a handshake as that device, and the
// identifier table says so. Copying it as an ordinary string left it on the
// clipboard indefinitely, which is the exact failure `lib/clipboard.ts` documents
// (myne-md/myne#938 review). The header used to call the code "public halves",
// which is the reading that produced that call.
//
// # What it does not claim
//
// A client-behaviour guarantee, not a cryptographic mutuality proof: there is no
// signed confirmation token and no server-mediated phase. A peer that skips its
// own tap is not detected by the other side. The gate is that the honest client
// cannot complete the exchange without both humans.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import { Input } from "../primitives/Input";
import { copySecretToClipboard } from "../../lib/secret-export";
import type { CancelClear } from "../../lib/clipboard";
import { toast } from "../toast/toastStore";
import { VISUALLY_HIDDEN } from "../primitives/visuallyHidden";
import {
  acceptAdmittingDevice,
  cancelDeviceAdmission,
  confirmJoiningDevice,
  deviceAdmissionErrorKind,
  previewDeviceAdmission,
  startDeviceAdmission,
  type AdmissionConfirmedView,
  type AdmissionMintedView,
  type AdmissionPreviewView,
} from "../../lib/deviceAdmission";

const ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const ROW: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "center",
};

const LABEL: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
};

const HINT: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  margin: 0,
};

const SAS: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-2xl)",
  letterSpacing: "var(--tracking-wide)",
  color: "var(--fg-1)",
  userSelect: "all",
};

const STOP: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
  margin: 0,
};

/** The error line: the kind is the only part a message needs, and the two kinds
 *  this ceremony adds are worded rather than folded into a generic failure. */
function errorText(kind: string, t: (k: string) => string): string {
  switch (kind) {
    case "SasMismatch":
      return t("sync.deviceAdmission.error.sasMismatch");
    case "NoPendingAdmission":
      return t("sync.deviceAdmission.error.noPending");
    case "PersonSessionRequired":
    case "NotEnrolled":
      return t("sync.deviceAdmission.error.identityRequired");
    case "PersonMismatch":
      return t("sync.deviceAdmission.error.personMismatch");
    default:
      return t("sync.deviceAdmission.error.generic");
  }
}

export interface DeviceAdmissionPanelProps {
  /** The person id from the join QR this device scanned, when it is the joining
   *  side. `undefined` on a device with no identity session yet: the admitting
   *  arm does not need one, because the code carries it. */
  personIdHex?: string;
  /** Called after a successful accept/cancel so the parent can refresh the
   *  device roster. */
  onSettled?: () => void;
}

type Side = "join" | "admit";

export function DeviceAdmissionPanel({
  personIdHex,
  onSettled,
}: DeviceAdmissionPanelProps) {
  const { t } = useTranslation();
  const [side, setSide] = useState<Side | null>(null);

  // Joining arm.
  const [minted, setMinted] = useState<AdmissionMintedView | null>(null);
  const [joinAck, setJoinAck] = useState(false);
  const [joinOutcome, setJoinOutcome] = useState<"pending" | "approved" | null>(
    null,
  );
  const [codeCopied, setCodeCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  // The pending clipboard clear, when the platform can perform one. Held so the
  // unmount path cancels it, which releases its reference to the code (see
  // `copySecret`'s note on why a held cancel must be invoked rather than dropped).
  const clearCancel = useRef<CancelClear | null>(null);

  // The confirmed tick is a timer this component owns, so it must clear it on the
  // way out: a `setState` on an unmounted panel is a warning today and a leak in
  // any world where the timer outlives the tree (myne-md/myne#938 review).
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      clearCancel.current?.();
      clearCancel.current = null;
    },
    [],
  );

  // Admitting arm.
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<AdmissionPreviewView | null>(null);
  const [admitAck, setAdmitAck] = useState(false);
  const [accepted, setAccepted] = useState<AdmissionConfirmedView | null>(null);

  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setMinted(null);
    setJoinAck(false);
    setJoinOutcome(null);
    setCode("");
    setPreview(null);
    setAdmitAck(false);
    setAccepted(null);
    setStopped(false);
    setError(null);
    setCodeCopied(false);
  }, []);

  const onCancel = useCallback(async () => {
    setBusy(true);
    try {
      await cancelDeviceAdmission();
    } catch (e) {
      // Reported rather than set as an error line: `reset()` below clears the
      // error state, so a `setError` here could never render. The code stays
      // CONFIRMABLE server-side until the cancel lands, so a silent failure would
      // leave the user believing it was revoked. Same toast as the mismatch arm,
      // and the same reason (myne-md/myne#938 review).
      void e;
      toast({
        message: t("sync.deviceAdmission.error.cancelFailed"),
        variant: "error",
      });
    } finally {
      setBusy(false);
      reset();
      setSide(null);
      onSettled?.();
    }
  }, [onSettled, reset, t]);

  const onStartJoining = useCallback(async () => {
    if (!personIdHex) return;
    setBusy(true);
    setError(null);
    try {
      setMinted(await startDeviceAdmission(personIdHex));
    } catch (e) {
      setError(errorText(deviceAdmissionErrorKind(e), t));
    } finally {
      setBusy(false);
    }
  }, [personIdHex, t]);

  const onConfirmJoining = useCallback(async () => {
    if (!minted) return;
    setBusy(true);
    setError(null);
    try {
      const approved = await confirmJoiningDevice(minted.sas);
      setJoinOutcome(approved ? "approved" : "pending");
      onSettled?.();
    } catch (e) {
      setError(errorText(deviceAdmissionErrorKind(e), t));
    } finally {
      setBusy(false);
    }
  }, [minted, onSettled, t]);

  const onPreview = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStopped(false);
    try {
      setPreview(await previewDeviceAdmission(code.trim()));
    } catch (e) {
      setError(errorText(deviceAdmissionErrorKind(e), t));
    } finally {
      setBusy(false);
    }
  }, [code, t]);

  const onAccept = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setAccepted(await acceptAdmittingDevice(code.trim(), preview.sas));
      onSettled?.();
    } catch (e) {
      setError(errorText(deviceAdmissionErrorKind(e), t));
    } finally {
      setBusy(false);
    }
  }, [code, onSettled, preview, t]);

  // The clipboard goes through the seam and through `lib/clipboard.ts`'s policy,
  // which is what makes the outcome visible: a copy that silently fails looks
  // exactly like one that worked, and the user then pastes the previous clipboard
  // contents into the other device believing it is the join code. Feedback names
  // the outcome and never the value.
  const copyCode = useCallback(() => {
    if (!minted) return;
    void copySecretToClipboard(minted.code, {
      onSuccess: {
        // `inline-icon`, not `toast`: this control shows its own confirmed tick,
        // and copy feedback lives on the control that was pressed. The toast stays
        // for failures, which is the one place it earns its interruption.
        kind: "inline-icon",
        run: () => {
          setCodeCopied(true);
          if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
          copyTimer.current = window.setTimeout(() => {
            setCodeCopied(false);
            copyTimer.current = null;
          }, 1600);
        },
      },
      onFailure: {
        kind: "toast",
        run: () =>
          toast({
            message: t("sync.deviceAdmission.join.copyFailed"),
            variant: "error",
          }),
      },
    }).then((cancel) => {
      clearCancel.current?.();
      clearCancel.current = cancel;
    });
  }, [minted, t]);

  // --- The stop arm: a mismatch is a visible stop, not a retry. ---
  //
  // Deliberately NOT `onCancel`: that is the user's dismiss path and its `finally`
  // runs `reset()`, which clears `stopped` and reopens the buttons that mint a new
  // code. The stop line then existed for one frame, which made "a mismatch stops
  // both sides" a claim nothing on screen held (myne-md/myne#938 review). The
  // backend still has to be cancelled, because a minted admission is live state on
  // the server; only the LOCAL fields are torn down, and `stopped` is left standing
  // until the user opens a new ceremony (every `setSide` arm calls `reset()`).
  const onMismatch = useCallback(async () => {
    setStopped(true);
    setBusy(true);
    try {
      await cancelDeviceAdmission();
    } catch {
      // Reported rather than swallowed (myne-md/myne#938 review). The cancel is
      // the call that revokes the minted admission, so a cancel that cannot reach
      // the backend leaves the code the user just rejected CONFIRMABLE by a peer
      // that kept its screen open. "Nothing was written" is true of this device
      // and not of the server, and a silent failure here would make the stop line
      // on screen claim a revocation that did not happen. The toast is the one
      // interruption that earns itself: the user's next action differs.
      toast({
        message: t("sync.deviceAdmission.error.cancelFailed"),
        variant: "error",
      });
    } finally {
      setBusy(false);
      setMinted(null);
      setJoinAck(false);
      setJoinOutcome(null);
      setCode("");
      setPreview(null);
      setAdmitAck(false);
      setAccepted(null);
      setCodeCopied(false);
      setSide(null);
      onSettled?.();
    }
  }, [onSettled]);

  return (
    <div style={ROOT} data-testid="sync.device-admission">
      {side === null ? (
        <div style={ROW}>
          <Button
            variant="secondary"
            onClick={() => {
              reset();
              setSide("join");
            }}
            data-testid="sync.device-admission.join-open"
          >
            {t("sync.deviceAdmission.join.cta")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              reset();
              setSide("admit");
            }}
            data-testid="sync.device-admission.admit-open"
          >
            {t("sync.deviceAdmission.admit.cta")}
          </Button>
        </div>
      ) : null}

      {/* ---------------- Joining side ---------------- */}
      {side === "join" ? (
        <div style={ROOT}>
          <p style={HINT}>{t("sync.deviceAdmission.join.intro")}</p>
          {minted === null ? (
            <div style={ROW}>
              {/* No identity, no code: an admission code names the person the
                  device is joining AS, so this device cannot produce one. The
                  control used to be rendered disabled, which is a door that
                  neither opens nor says why (PRD story 28, myne-md/myne#938
                  review): where the door does not exist, state the fact. */}
              {personIdHex ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={onStartJoining}
                  data-testid="sync.device-admission.join-start"
                >
                  {t("sync.deviceAdmission.join.start")}
                </Button>
              ) : (
                <p
                  role="status"
                  style={HINT}
                  data-testid="sync.device-admission.join-identity-required"
                >
                  {t("sync.deviceAdmission.error.identityRequired")}
                </p>
              )}
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void onCancel()}
                data-testid="sync.device-admission.join-cancel"
              >
                {t("sync.deviceAdmission.cancel")}
              </Button>
            </div>
          ) : (
            <>
              <span style={LABEL}>{t("sync.deviceAdmission.join.codeLabel")}</span>
              <div style={ROW}>
                <Input
                  readOnly
                  mono
                  aria-label={t("sync.deviceAdmission.join.codeLabel")}
                  value={minted.code}
                  data-testid="sync.device-admission.code"
                  style={{ flex: 1, minWidth: 0, userSelect: "all" }}
                  onFocus={(e) => e.target.select()}
                />
                <IconButton
                  icon="copy"
                  label={t("sync.deviceAdmission.join.copy")}
                  bordered
                  tooltip
                  confirmed={codeCopied}
                  onClick={copyCode}
                  testId="sync.device-admission.copy"
                />
                <p
                  role="status"
                  aria-live="polite"
                  data-testid="sync.device-admission.copy-status"
                  style={VISUALLY_HIDDEN}
                >
                  {codeCopied ? t("sync.deviceAdmission.join.copied") : ""}
                </p>
              </div>

              <span style={LABEL}>{t("sync.deviceAdmission.sasLabel")}</span>
              <div style={SAS} data-testid="sync.device-admission.sas">
                {minted.sas}
              </div>
              <p style={HINT}>{t("sync.deviceAdmission.sasHint")}</p>
              {!minted.has_device_key ? (
                <p style={HINT}>{t("sync.deviceAdmission.noDeviceKey")}</p>
              ) : null}

              <label style={ROW}>
                <input
                  type="checkbox"
                  checked={joinAck}
                  onChange={(e) => setJoinAck(e.target.checked)}
                  data-testid="sync.device-admission.join-ack"
                />
                <span style={LABEL}>{t("sync.deviceAdmission.matchAck")}</span>
              </label>

              <div style={ROW}>
                <Button
                  variant="primary"
                  disabled={busy || !joinAck}
                  onClick={onConfirmJoining}
                  data-testid="sync.device-admission.join-confirm"
                >
                  {t("sync.deviceAdmission.confirm")}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void onMismatch()}
                  data-testid="sync.device-admission.join-mismatch"
                >
                  {t("sync.deviceAdmission.mismatch")}
                </Button>
              </div>

              {joinOutcome === "pending" ? (
                <p style={HINT} data-testid="sync.device-admission.join-pending">
                  {t("sync.deviceAdmission.join.pending")}
                </p>
              ) : null}
              {joinOutcome === "approved" ? (
                <p style={HINT} data-testid="sync.device-admission.join-approved">
                  {t("sync.deviceAdmission.join.approved")}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* ---------------- Admitting side ---------------- */}
      {side === "admit" ? (
        <div style={ROOT}>
          <p style={HINT}>{t("sync.deviceAdmission.admit.intro")}</p>
          {accepted === null ? (
            <>
              <span style={LABEL}>{t("sync.deviceAdmission.admit.codeLabel")}</span>
              <Input
                mono
                aria-label={t("sync.deviceAdmission.admit.codeLabel")}
                value={code}
                placeholder={t("sync.deviceAdmission.admit.codePlaceholder")}
                onChange={(e) => {
                  setCode(e.target.value);
                  setPreview(null);
                  setAdmitAck(false);
                }}
                data-testid="sync.device-admission.admit-code"
              />
              {preview === null ? (
                <div style={ROW}>
                  <Button
                    variant="secondary"
                    disabled={busy || code.trim().length === 0}
                    onClick={onPreview}
                    data-testid="sync.device-admission.admit-preview"
                  >
                    {t("sync.deviceAdmission.admit.preview")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void onCancel()}
                    data-testid="sync.device-admission.admit-cancel"
                  >
                    {t("sync.deviceAdmission.cancel")}
                  </Button>
                </div>
              ) : (
                <>
                  <span style={LABEL}>{t("sync.deviceAdmission.sasLabel")}</span>
                  <div style={SAS} data-testid="sync.device-admission.admit-sas">
                    {preview.sas}
                  </div>
                  <p style={HINT}>{t("sync.deviceAdmission.sasHint")}</p>
                  <p style={HINT} data-testid="sync.device-admission.admit-device">
                    {t("sync.deviceAdmission.admit.deviceId", {
                      id: preview.device_id_hex,
                    })}
                  </p>
                  {!preview.has_device_key ? (
                    <p style={HINT}>{t("sync.deviceAdmission.noDeviceKey")}</p>
                  ) : null}

                  <label style={ROW}>
                    <input
                      type="checkbox"
                      checked={admitAck}
                      onChange={(e) => setAdmitAck(e.target.checked)}
                      data-testid="sync.device-admission.admit-ack"
                    />
                    <span style={LABEL}>{t("sync.deviceAdmission.matchAck")}</span>
                  </label>

                  <div style={ROW}>
                    <Button
                      variant="primary"
                      disabled={busy || !admitAck}
                      onClick={onAccept}
                      data-testid="sync.device-admission.admit-accept"
                    >
                      {t("sync.deviceAdmission.confirm")}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void onMismatch()}
                      data-testid="sync.device-admission.admit-mismatch"
                    >
                      {t("sync.deviceAdmission.mismatch")}
                    </Button>
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <p style={HINT} data-testid="sync.device-admission.admit-accepted">
                {accepted.binding_written
                  ? t("sync.deviceAdmission.admit.done")
                  : t("sync.deviceAdmission.admit.doneNoRow")}
              </p>
              <Button
                variant="secondary"
                onClick={() => {
                  reset();
                  setSide(null);
                }}
                data-testid="sync.device-admission.admit-close"
              >
                {t("sync.deviceAdmission.close")}
              </Button>
            </>
          )}
        </div>
      ) : null}

      {stopped ? (
        <p style={STOP} role="alert" data-testid="sync.device-admission.stopped">
          {t("sync.deviceAdmission.stopped")}
        </p>
      ) : null}
      {error !== null ? (
        <p style={STOP} role="alert" data-testid="sync.device-admission.error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
