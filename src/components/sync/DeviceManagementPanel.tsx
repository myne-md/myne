// Device management panel (MYND-425 tasks 7 + 8) — the device list (friendly
// names + removal) + the approval gate entry (pending devices with approve).
// Penpot skipped per the owner directive; built against design tokens.
//
// Friendly names: v1 shows a default platform-agnostic short name derived from
// the device_id prefix; editable names stored in synced prefs are the prefs-field
// follow-up (MYND-425 spec-deltas). The enroll-time fingerprint eye-compare reuses
// protocol::head_fingerprint and is wired when the head_fingerprint command lands.

import type { CSSProperties } from "react";
import { useDevices, type DeviceEntry } from "../../hooks/useDevices";

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

/** A short, stable display name from the device_id (until editable names land). */
function shortName(d: DeviceEntry): string {
  return `Device ${d.device_id_hex.slice(0, 6)}`;
}

export function DeviceManagementPanel() {
  const { devices, pending, error, busy, approve, remove } = useDevices();
  const approved = (devices ?? []).filter((d) => d.approved && !d.retired);

  return (
    <div style={ROOT} data-testid="sync.device-management">
      {error && (
        <div data-testid="sync.device-error" style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}>
          Couldn’t reach sync ({error}).
        </div>
      )}

      {pending.length > 0 && (
        <div data-testid="sync.pending-devices">
          <div style={SECTION_LABEL}>
            {pending.length === 1
              ? "1 device awaiting approval"
              : `${pending.length} devices awaiting approval`}
          </div>
          {pending.map((d) => (
            <div key={d.device_id_hex} style={ROW} data-testid="sync.pending-row" data-device-id={d.device_id_hex}>
              <span>{shortName(d)}</span>
              <button
                type="button"
                style={BTN}
                disabled={busy}
                onClick={() => void approve(d.device_id_hex)}
                data-testid="sync.approve-device"
              >
                Approve
              </button>
            </div>
          ))}
        </div>
      )}

      <div>
        <div style={SECTION_LABEL}>Your devices</div>
        {devices === null ? (
          <div style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>Loading…</div>
        ) : approved.length === 0 ? (
          <div style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>No devices synced yet.</div>
        ) : (
          approved.map((d) => (
            <div key={d.device_id_hex} style={ROW} data-testid="sync.device-row" data-device-id={d.device_id_hex}>
              <span>{shortName(d)}</span>
              <button
                type="button"
                style={BTN}
                disabled={busy}
                onClick={() => void remove(d.device_id_hex)}
                data-testid="sync.remove-device"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
