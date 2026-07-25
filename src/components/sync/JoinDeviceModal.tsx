// "Add this device to an existing account" (MYND-424) — the fresh-device join
// flow. Server URL + account number + password → `sync_join_account` bootstraps
// the whole local vault from the server's meta (no 24-word recovery), unlocks
// it, and SCRAM-enrolls (password → pending until an existing device approves).
// On success the caller routes to the editor; sync starts once approved.
// Built against design tokens; Penpot skipped per the owner directive.

import { useEffect, useId, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Input } from "../primitives/Input";
import { PasswordInput } from "../PasswordInput";
import { DestructiveBanner } from "../DestructiveBanner";
import { formatAccountNumberInput } from "../../lib/account-number-format";
import { DEVICE_NAME_MAX_LEN, useDeviceNameField } from "../../lib/device-name";
import { ENROLL_PENDING_NOTICE } from "../../lib/load-bearing-copy";

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
  background: "rgba(0, 0, 0, 0.4)",
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
  fontWeight: 600,
};

const ROW: CSSProperties = {
  display: "flex",
  gap: "var(--space-2)",
  justifyContent: "flex-end",
};

function btn(primary: boolean, disabled: boolean): CSSProperties {
  return {
    padding: "8px 18px",
    fontSize: 13,
    fontWeight: 500,
    borderRadius: "var(--radius-2)",
    cursor: disabled ? "not-allowed" : "pointer",
    border: primary ? "none" : "1px solid var(--line-1)",
    background: primary ? "var(--accent)" : "var(--bg-2)",
    color: primary ? "var(--accent-on)" : "var(--fg-1)",
    opacity: disabled ? 0.6 : 1,
  };
}

interface JoinDeviceModalProps {
  /** Close the modal without joining. */
  onCancel: () => void;
  /** Join succeeded; the vault is unlocked — route to the editor. */
  onJoined: (vaultId: string) => void;
}

export function JoinDeviceModal({ onCancel, onJoined }: JoinDeviceModalProps) {
  const { t } = useTranslation();
  const baseId = useId();
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
  const [headFingerprint, setHeadFingerprint] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);

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
      deviceName: deviceNameField.resolved,
    })
      .then((res) => {
        if (!res.pending) {
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
      .catch(() => setError(t("sync.join.error")))
      .finally(() => setBusy(false));
  };

  // While PENDING, drive the claim + watch for the adopted-head fingerprint. The
  // foreground loop claims the token + pulls once an existing device approves; the
  // pulled head observation is surfaced as soon as it MAC-verifies (before note bodies
  // download), so `sync_head_fingerprint` returns non-null promptly → advance to the
  // mandatory verify step (SYNC-40). Self-scheduling ~1s poll (not setInterval) so a
  // slow claim RTT never overlaps ticks. This runs ONLY while step==='pending' — the
  // bounded, user-initiated enroll window, NOT the steady-state background sync cadence
  // (privacy-load-bearing, left untouched).
  useEffect(() => {
    if (step !== "pending") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await invoke("plugin:sync|sync_now");
        const fp = await invoke<string | null>("plugin:sync|sync_head_fingerprint");
        if (!cancelled && fp) {
          setHeadFingerprint(fp);
          setStep("verify");
          return; // adopted the head — stop polling
        }
      } catch {
        /* transient — retry next tick */
      }
      if (!cancelled) timer = setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [step]);

  // SAS mismatch → ABORT: un-enroll this device so it stops trusting the
  // (possibly forked) synced data, then close.
  const onMismatch = () => {
    setAborting(true);
    void invoke("plugin:sync|sync_reset_local")
      .catch(() => {})
      .finally(() => onCancel());
  };

  // Post-join: the fresh device pinned the server's cert (TOFU) — surface the
  // fingerprint for out-of-band cross-device eye-compare, then wait for approval.
  if (step === "pinned" && certFingerprint) {
    return (
      <div role="dialog" aria-modal="true" style={BACKDROP} data-testid="join.pinned">
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
      <div role="dialog" aria-modal="true" style={BACKDROP} data-testid="join.pending">
        <div style={CARD}>
          <h2 style={TITLE}>{t("sync.join.waitingTitle")}</h2>
          <p style={HELP}>{ENROLL_PENDING_NOTICE}</p>
          <p style={HELP}>{t("sync.join.waitingHint")}</p>
          <div style={ROW}>
            <button type="button" onClick={onCancel} style={btn(false, false)} data-testid="join.cancel">
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
      <div role="dialog" aria-modal="true" style={BACKDROP} data-testid="join.verify">
        <div style={CARD}>
          <h2 style={TITLE}>{t("sync.join.verifyTitle")}</h2>
          <p style={HELP}>{t("sync.join.verifyBody")}</p>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-2xl)",
              fontWeight: 700,
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
          <div style={{ ...ROW, justifyContent: "space-between" }}>
            <button
              type="button"
              onClick={onMismatch}
              disabled={aborting}
              style={{ ...btn(false, aborting), color: "var(--danger)" }}
              data-testid="join.sas-mismatch"
            >
              {t("sync.join.sasMismatch")}
            </button>
            <button
              type="button"
              onClick={() => joinedVaultId && onJoined(joinedVaultId)}
              disabled={aborting}
              style={btn(true, aborting)}
              data-testid="join.sas-match"
            >
              {t("sync.join.sasMatch")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
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
            form carries. The two doors must behave identically — a device that
            arrives through this one and lands nameless is a silent regression. */}
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

        <div style={ROW}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={btn(false, busy)}
            data-testid="join.cancel"
          >
            {t("sync.join.cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            style={btn(true, !canSubmit)}
            data-testid="join.submit"
          >
            {busy ? t("sync.join.submitting") : t("sync.join.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
