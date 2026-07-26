// Device management panel (MYND-425 tasks 7 + 8) — the device list (friendly
// names + removal) + the approval gate entry (pending devices with approve).
// Penpot skipped per the owner directive; built against design tokens.
//
// Friendly names (MYND-548, closing the MYND-425 spec-delta follow-up): an
// approved row leads with its synced `device_names` entry and demotes the short
// device code to a secondary line; a device nobody has named keeps the old
// id-derived label. Pending rows deliberately keep ONLY that id-derived label —
// see the SAS note below.
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
import { usePrefs } from "../../hooks/usePrefs";
import { setDeviceName } from "../../lib/prefs";
import { DEVICE_NAME_MAX_LEN } from "../../lib/device-name";

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

/** The short, id-derived label — the fallback for a device nobody has named, and
 *  the ONLY label a pending device ever gets (SYNC-40: a name chosen by an
 *  unverified newcomer would read as a trust signal next to the SAS). */
function shortName(d: DeviceEntry): string {
  return i18n.t("sync.devices.shortName", { hex: d.device_id_hex.slice(0, 6) });
}

/** The label an APPROVED row leads with: the synced `device_names` entry when the
 *  user has named this device, else {@link shortName}. A whitespace-only stored
 *  value is treated as absent — the Rust setter refuses to write one, so this is
 *  belt-and-braces against a hand-edited or foreign-client blob. */
function displayName(d: DeviceEntry, names: Record<string, string>): string {
  const stored = names[d.device_id_hex];
  return stored !== undefined && stored.trim() !== "" ? stored : shortName(d);
}

/** The demoted device code. Kept as a permanent secondary line rather than a
 *  hover affordance: mobile has no hover, and this is what disambiguates two
 *  devices that share a default name ("Mac" / "Mac"). */
const CODE_LINE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const NAME_LINE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  minWidth: 0,
};

const IDENTITY_COLUMN: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const ACTIONS: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexShrink: 0,
};

const RENAME_INPUT: CSSProperties = {
  font: "inherit",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  background: "var(--bg-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "2px var(--space-1)",
  minWidth: 0,
  width: "100%",
};

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
  // The synced `device_names` map (MYND-548). Read off the shared prefs hook like
  // every other prefs consumer — `setDeviceName` bumps the prefs nonce, so a local
  // rename and a peer's merged rename both land here the same way.
  const { prefs } = usePrefs();
  // `?? {}` is not defensive noise: a client can outrun its own backend (mobile
  // ships ahead of core), and a payload without the key must degrade to the
  // id-derived labels rather than take the panel down.
  const names = prefs.device_names ?? {};

  // The row currently being renamed, plus its in-flight input value. `null` = no
  // row is in rename mode. One at a time: the Rename buttons disable while any
  // row is open, so a stray click cannot strand a half-typed edit.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [renameFailed, setRenameFailed] = useState(false);

  // Enter and blur both land here. Closing the editor FIRST makes the two paths
  // idempotent — blur fires right after Enter, and the second call sees `null`
  // and returns. A blank value is a cancel (the backend refuses it too), so the
  // previous name survives; only a genuine write failure surfaces. Deliberately
  // NOT optimistic: the row renders straight off `names`, so a failed write simply
  // never changed it — which IS the revert, with no rollback path to desync.
  const commitRename = async () => {
    const target = renaming;
    if (target === null) return;
    setRenaming(null);
    if (target.value.trim() === "") return;
    try {
      await setDeviceName(target.id, target.value.trim());
      setRenameFailed(false);
    } catch {
      setRenameFailed(true);
    }
  };
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
        {renameFailed && (
          <div
            style={{ color: "var(--danger)", fontSize: "var(--text-sm)", paddingBottom: 4 }}
            data-testid="sync.rename-error"
          >
            {t("sync.devices.renameFailed")}
          </div>
        )}
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
              <span style={IDENTITY_COLUMN}>
                {renaming?.id === d.device_id_hex ? (
                  <input
                    // Focused on mount: the field replaces the line the user just
                    // activated, so focusing it IS the interaction.
                    autoFocus
                    value={renaming.value}
                    maxLength={DEVICE_NAME_MAX_LEN}
                    style={RENAME_INPUT}
                    aria-label={t("sync.devices.renameLabel")}
                    data-testid="sync.device-name-input"
                    onChange={(e) => setRenaming({ id: d.device_id_hex, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenaming(null);
                      }
                    }}
                    onBlur={() => void commitRename()}
                  />
                ) : (
                  <span style={NAME_LINE}>
                    <span data-testid="sync.device-name">{displayName(d, names)}</span>
                    {d.is_current && (
                      <span style={BADGE} data-testid="sync.this-device">
                        {t("sync.devices.thisDevice")}
                      </span>
                    )}
                  </span>
                )}
                <span style={CODE_LINE} data-testid="sync.device-code">
                  {d.device_id_hex.slice(0, 6)}
                </span>
              </span>
              <span style={ACTIONS}>
                {/* Rename is offered on EVERY approved row, not just this device:
                    devices enrolled before names existed are named from whatever
                    device the user happens to be holding. */}
                <button
                  type="button"
                  style={BTN}
                  disabled={busy || renaming !== null}
                  onClick={() =>
                    setRenaming({ id: d.device_id_hex, value: displayName(d, names) })
                  }
                  data-testid="sync.rename-device"
                >
                  {t("sync.devices.rename")}
                </button>
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
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
