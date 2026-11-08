import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll, Title, Button } from "../../components";
import type { ScreenDef } from "../../gallery/types";
import { SectionLabel } from "@myne/field-label";

// Shared bits ─────────────────────────────────────────────────────────────────

/** The thin iOS back chevron used in the nav bars (9×16). */
function BackChevron() {
  return (
    <svg width="9" height="16" viewBox="0 0 9 16">
      <path
        d="M7 1L1 8l6 7"
        stroke="var(--accent)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** iOS nav bar — back chevron + text label, optional right-side action. */
function NavBar({
  label,
  right,
  padding = "56px 12px 10px",
}: {
  label: string;
  right?: ReactNode;
  padding?: string;
}) {
  return (
    <div
      style={{
        flex: "none",
        padding,
        display: "flex",
        alignItems: "center",
        justifyContent: right ? "space-between" : "flex-start",
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <button
        style={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          border: "none",
          background: "transparent",
          color: "var(--accent)",
          fontSize: 15,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        <BackChevron />
        {label}
      </button>
      {right}
    </div>
  );
}

/** Thin progress bar (track + accent fill at `pct`). */
function ProgressBar({ pct, style }: { pct: number; style?: CSSProperties }) {
  return (
    <div
      style={{
        height: 6,
        borderRadius: 999,
        background: "var(--line-1)",
        overflow: "hidden",
        ...style,
      }}
    >
      <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)" }} />
    </div>
  );
}

// BK-01 · Restore from backup ─────────────────────────────────────────────────
function RestoreFromBackup() {
  return (
    <Screen>
      <NavBar label="Storage" />
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <Title style={{ fontSize: 24, margin: "4px 0 0" }}>Restore from backup</Title>
        <div
          style={{
            marginTop: 18,
            border: "1px solid var(--line-1)",
            borderRadius: 12,
            background: "var(--bg-1)",
            padding: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="20" height="20" viewBox="0 0 22 22" fill="none">
              <path
                d="M4 4h7l3 3h7v11H4z"
                stroke="var(--fg-2)"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>myne-personal-2026-06-20.backup</div>
              <div style={{ fontSize: 12, color: "var(--fg-3)" }}>14.2 MB</div>
            </div>
          </div>
          <ProgressBar pct={48} style={{ marginTop: 14 }} />
          <div style={{ marginTop: 8, fontSize: 13, color: "var(--fg-3)" }}>
            Verifying and restoring… 48%
          </div>
        </div>
        <Button variant="secondary" style={{ marginTop: 14, height: 46 }}>
          Cancel
        </Button>
      </div>
    </Screen>
  );
}

// BK-02 · Backup export ───────────────────────────────────────────────────────
function BackupExport() {
  return (
    <Screen>
      <NavBar label="Storage" />
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <Title style={{ fontSize: 24, margin: "4px 0 0" }}>Back up vault</Title>
        <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          An encrypted backup file you can restore on any device with your password and recovery
          phrase.
        </p>
        <div
          style={{
            marginTop: 18,
            border: "1px solid var(--line-1)",
            borderRadius: 12,
            background: "var(--bg-1)",
            padding: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--fg-2)" }}>
            <svg width="16" height="16" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6" stroke="var(--fg-2)" strokeWidth="1.5" />
              <path d="M8 5v3l2 2" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Copying… verifying integrity</span>
          </div>
          <ProgressBar pct={72} style={{ marginTop: 12 }} />
        </div>
        <SectionLabel style={{ marginTop: 18 }}>Destination</SectionLabel>
        <div style={{ display: "flex", gap: 10 }}>
          <div
            style={{
              flex: 1,
              border: "1px solid var(--accent)",
              borderRadius: 8,
              padding: 12,
              textAlign: "center",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--accent)",
              background: "var(--accent-soft)",
            }}
          >
            Share sheet
          </div>
          <div
            style={{
              flex: 1,
              border: "1px solid var(--line-2)",
              borderRadius: 8,
              padding: 12,
              textAlign: "center",
              fontSize: 14,
              color: "var(--fg-2)",
            }}
          >
            Files
          </div>
        </div>
      </div>
    </Screen>
  );
}

// BK-03 · Vault export (markdown) ─────────────────────────────────────────────
function VaultExport() {
  return (
    <Screen>
      <NavBar label="Storage" />
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <Title style={{ fontSize: 24, margin: "4px 0 0" }}>Export vault</Title>
        <div
          style={{
            marginTop: 12,
            background: "var(--warning-soft)",
            border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
            borderRadius: 8,
            padding: "12px 14px",
            fontSize: 13,
            lineHeight: 1.55,
            color: "var(--warning)",
          }}
        >
          This writes a plain, unencrypted folder of markdown files outside Myne. Keep it somewhere
          safe.
        </div>
        <SectionLabel style={{ marginTop: 18 }}>Scope</SectionLabel>
        <div
          style={{
            display: "flex",
            gap: 4,
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 8,
            padding: 3,
          }}
        >
          <div
            style={{
              flex: 1,
              textAlign: "center",
              padding: "8px 0",
              borderRadius: 6,
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Whole vault
          </div>
          <div
            style={{
              flex: 1,
              textAlign: "center",
              padding: "8px 0",
              borderRadius: 6,
              fontSize: 13,
              color: "var(--fg-2)",
            }}
          >
            A folder
          </div>
        </div>
        <div
          style={{
            marginTop: 16,
            border: "1px solid var(--line-1)",
            borderRadius: 10,
            background: "var(--bg-1)",
            padding: "13px 14px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 16 }}>Destination</span>
          <span style={{ fontSize: 15, color: "var(--fg-3)" }}>Files…</span>
        </div>
      </div>
      <div style={{ flex: "none", padding: "14px 20px 40px" }}>
        <Button>Export</Button>
      </div>
    </Screen>
  );
}

/** One snapshot row in the version-history list. */
function SnapshotRow({
  time,
  detail,
  current,
  restore,
}: {
  time: string;
  detail: ReactNode;
  current?: boolean;
  restore?: boolean;
}) {
  return (
    <div
      style={{
        padding: "13px 6px",
        borderTop: "1px solid var(--line-1)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: current ? "var(--accent-soft)" : undefined,
        borderRadius: current ? 8 : undefined,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{time}</div>
        {detail}
      </div>
      {restore && (
        <Button
          variant="secondary"
          full={false}
          style={{ height: 32, padding: "0 12px", fontSize: 13, color: "var(--fg-1)" }}
        >
          Restore
        </Button>
      )}
    </div>
  );
}

// BK-04 · Snapshots ───────────────────────────────────────────────────────────
function Snapshots() {
  return (
    <Screen>
      <NavBar label="Note" />
      <ScreenScroll style={{ padding: "14px 16px 0" }}>
        <Title style={{ fontSize: 24, fontWeight: 700, margin: "4px 4px 0" }}>Snapshots</Title>
        <p style={{ margin: "6px 4px 0", fontSize: 13, color: "var(--fg-3)" }}>Threat model v2</p>
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column" }}>
          <SnapshotRow
            time="2 minutes ago"
            current
            detail={<div style={{ fontSize: 12, color: "var(--fg-3)" }}>current</div>}
          />
          <SnapshotRow
            time="Today, 09:14"
            restore
            detail={
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>
                3.1 KB encrypted
              </div>
            }
          />
          <SnapshotRow
            time="Yesterday, 17:42"
            restore
            detail={
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>
                2.8 KB encrypted
              </div>
            }
          />
        </div>
        <div
          style={{
            marginTop: 14,
            border: "1px solid var(--line-1)",
            borderRadius: 10,
            background: "var(--bg-1)",
            padding: 14,
            fontSize: 14,
            lineHeight: 1.6,
            color: "var(--fg-2)",
          }}
        >
          <span style={{ background: "var(--success-soft)", color: "var(--success)" }}>
            + Added the relay-compromise section.
          </span>
          <br />
          <span
            style={{
              background: "var(--danger-soft)",
              color: "var(--danger)",
              textDecoration: "line-through",
            }}
          >
            − Removed the old quote.
          </span>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// BK-05 · Snapshot failed (quiet) ─────────────────────────────────────────────
function SnapshotFailed() {
  return (
    <Screen>
      <NavBar
        label="Notes"
        padding="56px 16px 10px"
        right={
          <button
            style={{
              border: "none",
              background: "transparent",
              color: "var(--accent)",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Edit
          </button>
        }
      />
      <div
        style={{
          margin: "12px 16px 0",
          background: "var(--warning-soft)",
          border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
          borderRadius: 8,
          padding: "10px 13px",
          display: "flex",
          alignItems: "center",
          gap: 9,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="7" stroke="var(--warning)" strokeWidth="1.4" />
          <path d="M9 5.5v4M9 12h.01" stroke="var(--warning)" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 13, color: "var(--warning)" }}>
          Couldn't save a snapshot. Your note is still saved.
        </span>
      </div>
      <div style={{ flex: 1, padding: "18px 24px", fontSize: 16, lineHeight: 1.65, color: "var(--fg-1)" }}>
        <Title style={{ fontSize: 26, margin: 0 }}>Threat model v2</Title>
        <p style={{ margin: "14px 0 0" }}>
          We assume a powerful network adversary that can observe all traffic.
        </p>
      </div>
    </Screen>
  );
}

export const backupScreens: ScreenDef[] = [
  { id: "BK-01", label: "Restore from backup", Component: RestoreFromBackup },
  { id: "BK-02", label: "Backup export", Component: BackupExport },
  { id: "BK-03", label: "Vault export (markdown)", Component: VaultExport },
  { id: "BK-04", label: "Snapshots", Component: Snapshots },
  { id: "BK-05", label: "Snapshot failed (quiet)", Component: SnapshotFailed },
];
