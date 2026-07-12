// Device management panel (MYND-425 tasks 7 + 8) — the device list (friendly
// names + removal) + the approval gate entry (pending devices with approve).
// Penpot skipped per the owner directive; built against design tokens.
//
// Friendly names: v1 shows a default platform-agnostic short name derived from
// the device_id prefix; editable names stored in synced prefs are the prefs-field
// follow-up (MYND-425 spec-deltas).
//
// Approve-then-verify SAS (MYND-459 T14, SYNC-40): approving a pending device
// surfaces THIS device's adopted-head fingerprint (`sync_head_fingerprint` →
// the frozen 8-char Crockford `XXXX-XXXX`, protocol::head_fingerprint verbatim,
// ONE encoding — SYNC-17) for an out-of-band eye-compare against the newcomer's
// screen. A match confirms the newcomer is on the genuine account; a mismatch
// routes straight to Remove device. This is the desktop end of the same SAS the
// mobile SY-05 shows (SYNC-40 carries both ends in 459). Ship-gate: the SYNC-17
// primitive-level review of the fingerprint substrate is recorded, not passed.

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../i18n";
import { type DeviceEntry, type DevicesHook } from "../../hooks/useDevices";

const ROOT: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

const SECTION_LABEL: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
};

const BTN: CSSProperties = {
  padding: "var(--space-1) var(--space-2)",
  fontSize: "var(--text-sm)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
  color: "var(--fg-1)",
};

const BADGE: CSSProperties = {
  marginLeft: "var(--space-2)",
  padding: "0 var(--space-1)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--accent-fg, var(--fg-2))",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  whiteSpace: "nowrap",
};

/** A short, stable display name from the device_id (until editable names land). */
function shortName(d: DeviceEntry): string {
  return i18n.t("sync.devices.shortName", { hex: d.device_id_hex.slice(0, 6) });
}

// Takes the `useDevices` hook result as a prop (lifted to `SyncPanel`) so the
// roster poll runs once for both the device list AND the "Add a device" enroll
// gate above it — a single source of enrollment truth, no double-polling.
/** The device in the approve-then-verify SAS step (SYNC-40). */
interface SasState {
  deviceId: string;
  /** This device's adopted-head fingerprint (`XXXX-XXXX`), or null while loading. */
  fingerprint: string | null;
  loading: boolean;
}

export function DeviceManagementPanel({ hook }: { hook: DevicesHook }) {
  const { t } = useTranslation();
  const { devices, pending, error, busy, approve, remove, resetLocal } = hook;
  const approved = (devices ?? []).filter((d) => d.approved && !d.retired);
  // This device, if the roster came back marking it retired — it was removed from
  // another device. It is filtered out of `approved`/`pending`, so without this it
  // would vanish silently; surface it with the reset+re-add recovery instead.
  const retiredSelf = (devices ?? []).find((d) => d.is_current && d.retired);

  const [sas, setSas] = useState<SasState | null>(null);

  // Approve-then-verify (SYNC-40): approve FIRST, then fetch this device's
  // adopted-head fingerprint for the out-of-band eye-compare against the newcomer.
  const approveAndVerify = async (deviceId: string) => {
    // Only surface the SAS eye-compare once approval actually succeeded. If the
    // backend `sync_approve_device` failed, `approve` returns false (and set the
    // error banner) — stay on the device list rather than showing a verify
    // screen for a device that was never approved.
    if (!(await approve(deviceId))) return;
    setSas({ deviceId, fingerprint: null, loading: true });
    try {
      const fp = await invoke<string | null>("plugin:sync|sync_head_fingerprint");
      setSas((s) => (s?.deviceId === deviceId ? { ...s, fingerprint: fp, loading: false } : s));
    } catch {
      setSas((s) => (s?.deviceId === deviceId ? { ...s, fingerprint: null, loading: false } : s));
    }
  };

  // SY-05 desktop end: the SAS eye-compare, shown right after an approve. Renders
  // the frozen Crockford `XXXX-XXXX` (SYNC-17: one encoding, no word-list) for the
  // user to compare against the new device; a mismatch routes to Remove device.
  if (sas) {
    return (
      <div style={ROOT} data-testid="sync.approve-verify">
        <div style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"], color: "var(--fg-1)" }}>
          {t("sync.devices.verifyTitle")}
        </div>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)", margin: 0, lineHeight: "var(--leading-normal)" }}>
          {t("sync.devices.verifyBody")}
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "var(--space-4)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-1)",
            background: "var(--bg-2)",
          }}
        >
          {sas.loading ? (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>{t("sync.devices.verifySyncing")}</span>
          ) : sas.fingerprint ? (
            <span
              style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xl)", fontWeight: 700, letterSpacing: "0.14em", color: "var(--fg-1)" }}
              data-testid="sync.sas-fingerprint"
            >
              {sas.fingerprint}
            </span>
          ) : (
            <span style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)", textAlign: "center" }} data-testid="sync.sas-pending">
              {t("sync.devices.verifyPending")}
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button type="button" style={BTN} onClick={() => setSas(null)} data-testid="sync.sas-match">
            {t("sync.devices.verifyMatch")}
          </button>
          <button
            type="button"
            style={{ ...BTN, color: "var(--danger)" }}
            disabled={busy}
            onClick={() => {
              const id = sas.deviceId;
              setSas(null);
              void remove(id);
            }}
            data-testid="sync.sas-mismatch"
          >
            {t("sync.devices.verifyMismatch")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={ROOT} data-testid="sync.device-management">
      {error === "NotEnrolled" ? (
        <div
          data-testid="sync.device-not-enrolled"
          style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}
        >
          {t("sync.devices.notEnrolled")}
        </div>
      ) : error ? (
        <div
          data-testid="sync.device-error"
          style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--danger)", fontSize: "var(--text-sm)" }}
        >
          <span>{t("sync.devices.unreachable", { error })}</span>
          {error === "Unauthenticated" ? (
            // A rejected credential (e.g. this device was removed elsewhere) — a local
            // reset is the actual remedy.
            <button
              type="button"
              style={BTN}
              disabled={busy}
              onClick={() => void resetLocal()}
              data-testid="sync.reset-local"
            >
              {t("sync.devices.resetSyncOnThisDevice")}
            </button>
          ) : (
            // A transport failure — NOT a reason to wipe the baseline. The likely cause
            // (server moved / certificate changed) is fixed by re-pinning the endpoint.
            <span style={{ color: "var(--fg-3)" }} data-testid="sync.transport-hint">
              {t("sync.devices.transportHint")}
            </span>
          )}
        </div>
      ) : retiredSelf ? (
        <div
          data-testid="sync.device-retired-self"
          style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--danger)", fontSize: "var(--text-sm)" }}
        >
          <span>{t("sync.devices.removedElsewhere")}</span>
          <button
            type="button"
            style={BTN}
            disabled={busy}
            onClick={() => void resetLocal()}
            data-testid="sync.reset-local"
          >
            {t("sync.devices.resetAndReAdd")}
          </button>
        </div>
      ) : null}

      {pending.length > 0 && (
        <div data-testid="sync.pending-devices">
          <div style={SECTION_LABEL}>
            {t("sync.devices.awaitingApproval", { count: pending.length })}
          </div>
          {pending.map((d) => (
            <div key={d.device_id_hex} style={ROW} data-testid="sync.pending-row" data-device-id={d.device_id_hex}>
              <span>{shortName(d)}</span>
              <button
                type="button"
                style={BTN}
                disabled={busy}
                onClick={() => void approveAndVerify(d.device_id_hex)}
                data-testid="sync.approve-device"
              >
                {t("sync.devices.approve")}
              </button>
            </div>
          ))}
        </div>
      )}

      <div>
        <div style={SECTION_LABEL}>{t("sync.devices.yourDevices")}</div>
        {devices === null ? (
          // Only "Loading…" while genuinely loading. When the roster failed (e.g. this
          // device is not enrolled) `devices` stays null with an error set above — show
          // nothing here rather than spinning on "Loading…" forever.
          error ? null : (
            <div style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>{t("sync.devices.loading")}</div>
          )
        ) : approved.length === 0 ? (
          <div style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>{t("sync.devices.noDevices")}</div>
        ) : (
          approved.map((d) => (
            <div key={d.device_id_hex} style={ROW} data-testid="sync.device-row" data-device-id={d.device_id_hex} data-current={d.is_current ? "true" : "false"}>
              <span>
                {shortName(d)}
                {d.is_current && (
                  <span style={BADGE} data-testid="sync.this-device">
                    {t("sync.devices.thisDevice")}
                  </span>
                )}
              </span>
              {d.is_current ? (
                <span style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)" }}>
                  {t("sync.devices.syncedHere")}
                </span>
              ) : (
                <button
                  type="button"
                  style={BTN}
                  disabled={busy}
                  onClick={() => void remove(d.device_id_hex)}
                  data-testid="sync.remove-device"
                >
                  {t("sync.devices.remove")}
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
