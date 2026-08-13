import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll, FooterBar, Button } from "../../components";
import type { ScreenDef } from "../../gallery/types";
import { SYNC_INTEGRITY_ALERT } from "../../lib/load-bearing-copy";

// ── Shared local fragments ───────────────────────────────────────────────────

/** iOS-style nav header: a back chevron + accent text label, hairline underline. */
function NavHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        flex: "none",
        padding: "56px 12px 10px",
        display: "flex",
        alignItems: "center",
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
        {label}
      </button>
    </div>
  );
}

/** Uppercase tracked section label (12px, 0.08em, line-3). */
function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        padding: "0 4px 8px",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--line-3)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Form field label (12px, 0.06em, fg-3). */
function FieldLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        marginBottom: 8,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Bordered, rounded card container (r:10). */
function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--bg-1)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A 13×14 settings row, space-between, optional top hairline. */
function Row({ children, top = false }: { children: ReactNode; top?: boolean }) {
  return (
    <div
      style={{
        padding: "13px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderTop: top ? "1px solid var(--line-1)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

/** Tiny right-chevron used in list rows. */
function MiniChevron() {
  return (
    <svg width="8" height="13" viewBox="0 0 8 14">
      <path
        d="M1 1l6 6-6 6"
        stroke="var(--line-2)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Dashed status ring (TLS / synced indicator). */
function DashCircle({ color, size = 15 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6" stroke={color} strokeWidth="1.5" strokeDasharray="2.5 2" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 22 22" fill="none">
      <rect x="6" y="2" width="10" height="18" rx="2" stroke="var(--fg-2)" strokeWidth="1.5" />
      <path d="M9 18h4" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function LaptopIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 22 22" fill="none">
      <rect x="2" y="4" width="18" height="12" rx="2" stroke="var(--fg-2)" strokeWidth="1.5" />
      <path d="M8 19h6" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// SY-01 · Sync settings ───────────────────────────────────────────────────────
function SyncSettings() {
  return (
    <Screen>
      <NavHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <h1 style={{ margin: "4px 4px 0", fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Sync
        </h1>

        <SectionLabel style={{ marginTop: 18 }}>Server</SectionLabel>
        <Card>
          <Row>
            <span style={{ fontSize: 16 }}>Endpoint</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-3)" }}>sync.myne.md</span>
          </Row>
          <Row top>
            <span style={{ fontSize: 16 }}>Status</span>
            <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--fg-2)" }}>
              <DashCircle color="var(--success)" />
              <span style={{ fontSize: 15 }}>Connected · TLS</span>
            </div>
          </Row>
        </Card>

        <SectionLabel style={{ marginTop: 18 }}>Devices</SectionLabel>
        <Card>
          <Row>
            <span style={{ fontSize: 16 }}>Your devices</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-3)" }}>
              <span style={{ fontSize: 15 }}>3</span>
              <MiniChevron />
            </div>
          </Row>
          <Row top>
            <span style={{ fontSize: 16 }}>Add a device</span>
            <MiniChevron />
          </Row>
          <Row top>
            <span style={{ fontSize: 16 }}>Conflicts</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--danger-soft)",
                  color: "var(--danger)",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                2
              </span>
              <MiniChevron />
            </div>
          </Row>
        </Card>
      </ScreenScroll>
    </Screen>
  );
}

// SY-02 · Endpoint config ─────────────────────────────────────────────────────
function EndpointConfig() {
  return (
    <Screen>
      <NavHeader label="Sync" />
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <h1 style={{ margin: "4px 0 0", fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Sync server
        </h1>

        <FieldLabel style={{ marginTop: 18 }}>Server URL</FieldLabel>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 50,
            border: "1px solid var(--line-2)",
            borderRadius: 6,
            background: "var(--bg-1)",
            padding: "0 14px",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg-1)" }}>https://sync.myne.md</span>
        </div>

        <Button style={{ marginTop: 12, height: 48, fontSize: 15 }}>Connect</Button>

        <div style={{ marginTop: 22, padding: 14, border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-2)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: "var(--fg-2)" }}>
            <DashCircle color="var(--success)" />
            <span style={{ fontSize: 14, fontWeight: 600 }}>Connected over TLS</span>
          </div>
          <FieldLabel style={{ marginTop: 10, marginBottom: 0 }}>Certificate fingerprint</FieldLabel>
          <div
            style={{
              marginTop: 4,
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              lineHeight: 1.5,
              color: "var(--fg-1)",
              wordBreak: "break-all",
            }}
          >
            SHA‑256 9f2a:1c44:7e8b:
            <br />
            03dd:a591:6c20:4f7e:88b1
          </div>
        </div>
      </div>
    </Screen>
  );
}

// SY-03 · Enroll this device [keyboard] ───────────────────────────────────────
function EnrollDevice() {
  return (
    <Screen>
      <NavHeader label="Sync" />
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <h1 style={{ margin: "4px 0 0", fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Enroll device
        </h1>

        <FieldLabel style={{ marginTop: 18 }}>Account number</FieldLabel>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            height: 50,
            border: "1.5px solid var(--accent)",
            borderRadius: 6,
            background: "var(--bg-1)",
            padding: "0 14px",
            boxShadow: "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, color: "var(--fg-1)" }}>
            MY‑4F2A‑9C17‑8E2D‑1B5F‑K
          </span>
        </div>

        <FieldLabel style={{ marginTop: 18 }}>Sign in with</FieldLabel>
        <div style={{ display: "flex", gap: 4, background: "var(--bg-2)", border: "1px solid var(--line-1)", borderRadius: 8, padding: 3 }}>
          <div
            style={{
              flex: 1,
              textAlign: "center",
              padding: "8px 0",
              borderRadius: 6,
              background: "var(--bg-1)",
              border: "1px solid var(--line-1)",
              fontSize: 14,
              fontWeight: 600,
              color: "var(--fg-1)",
            }}
          >
            Password
          </div>
          <div style={{ flex: 1, textAlign: "center", padding: "8px 0", borderRadius: 6, fontSize: 14, color: "var(--fg-2)" }}>
            Recovery phrase
          </div>
        </div>

        <div
          style={{
            marginTop: 14,
            display: "flex",
            alignItems: "center",
            height: 50,
            border: "1px solid var(--line-2)",
            borderRadius: 6,
            background: "var(--bg-1)",
            padding: "0 14px",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, letterSpacing: "0.14em", color: "var(--fg-1)" }}>
            ••••••••
          </span>
        </div>

        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 6, color: "var(--danger)", fontSize: 13 }}>
          <svg width="14" height="14" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="6.5" stroke="var(--danger)" strokeWidth="1.4" />
            <path d="M8 5v4M8 11h.01" stroke="var(--danger)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Account number, password, or recovery phrase is incorrect. Please try again.
        </div>
      </div>
      <div style={{ flex: "none", padding: "14px 20px 14px" }}>
        <Button>Enroll</Button>
      </div>
    </Screen>
  );
}

// SY-04 · Pending approval ────────────────────────────────────────────────────
function PendingApproval() {
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
        }}
      >
        <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
          <circle cx="26" cy="26" r="21" stroke="var(--line-2)" strokeWidth="2" strokeDasharray="3 3" />
          <path d="M26 16v10l7 4" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h1 style={{ margin: "22px 0 0", fontSize: 24, lineHeight: 1.2, letterSpacing: "-0.02em", fontWeight: 600, color: "var(--fg-display)" }}>
          Waiting for approval
        </h1>
        <p style={{ margin: "12px 0 0", fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 300 }}>
          This device is waiting for approval. Approve it from a device that already has access to start syncing.
        </p>
      </div>
      <div style={{ flex: "none", paddingBottom: 52, width: "100%" }}>
        <Button variant="secondary" style={{ height: 48 }}>
          Cancel enrollment
        </Button>
      </div>
    </Screen>
  );
}

// SY-05 · Approve device + fingerprint ────────────────────────────────────────
function VWord({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 15,
        fontWeight: 600,
        color: "var(--fg-1)",
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: 6,
        padding: "6px 12px",
      }}
    >
      {children}
    </span>
  );
}

function ApproveDevice() {
  return (
    <Screen>
      <NavHeader label="Devices" />
      <ScreenScroll style={{ padding: "14px 20px 20px" }}>
        <h1 style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Approve “iPad”?
        </h1>
        <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          Check that the same words appear on both devices before you approve.
        </p>

        <div style={{ marginTop: 18, border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-2)", padding: 16 }}>
          <FieldLabel style={{ marginBottom: 10 }}>Verification words</FieldLabel>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <VWord>anchor</VWord>
            <VWord>violet</VWord>
            <VWord>harbor</VWord>
            <VWord>ember</VWord>
          </div>
          <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--line-3)" }}>
            code 4F‑2A‑9C
          </div>
        </div>
      </ScreenScroll>
      <FooterBar>
        <Button variant="secondary" full={false} style={{ fontSize: 14, padding: "0 18px" }}>
          They don't match
        </Button>
        <Button>Approve</Button>
      </FooterBar>
    </Screen>
  );
}

// SY-06 · Your devices ────────────────────────────────────────────────────────
function YourDevices() {
  return (
    <Screen>
      <NavHeader label="Sync" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <h1 style={{ margin: "4px 4px 0", fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Devices
        </h1>

        <SectionLabel style={{ marginTop: 16 }}>Awaiting approval</SectionLabel>
        <div
          style={{
            border: "1px solid var(--line-1)",
            borderRadius: 10,
            background: "var(--bg-1)",
            padding: "13px 14px",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <PhoneIcon />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>iPad</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>requested 3m ago</div>
          </div>
          <button
            style={{
              height: 36,
              padding: "0 14px",
              border: "none",
              borderRadius: 6,
              background: "var(--accent)",
              color: "var(--accent-on)",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Approve
          </button>
        </div>

        <SectionLabel style={{ marginTop: 18 }}>Your devices</SectionLabel>
        <Card>
          <div style={{ padding: "13px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <PhoneIcon />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>iPhone 15</div>
              <div style={{ fontSize: 12, color: "var(--fg-3)" }}>synced 2m ago</div>
            </div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--accent)",
                background: "var(--accent-soft)",
                padding: "3px 8px",
                borderRadius: 999,
              }}
            >
              This device
            </span>
          </div>
          <div style={{ padding: "13px 14px", borderTop: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 10 }}>
            <LaptopIcon />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Laptop</div>
              <div style={{ fontSize: 12, color: "var(--fg-3)" }}>synced 18m ago</div>
            </div>
            <button style={{ border: "none", background: "transparent", color: "var(--danger)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Remove
            </button>
          </div>
        </Card>
      </ScreenScroll>
    </Screen>
  );
}

// SY-07 · Remove device confirm ───────────────────────────────────────────────
function RemoveDevice() {
  return (
    <Screen>
      <div style={{ flex: 1, opacity: 0.4, padding: "56px 16px 0" }}>
        <h1 style={{ margin: "8px 4px", fontSize: 26, fontWeight: 700, color: "var(--fg-display)" }}>Devices</h1>
      </div>
      <div style={{ position: "absolute", inset: 0, background: "rgba(20,20,18,0.32)" }} />
      <div
        style={{
          position: "absolute",
          insetInlineStart: 0,
          insetInlineEnd: 0,
          bottom: 0,
          background: "var(--bg-1)",
          borderRadius: "16px 16px 0 0",
          padding: "10px 20px 30px",
          boxShadow: "0 -8px 30px rgba(20,24,40,0.18)",
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 999, background: "var(--line-2)", margin: "6px auto 16px" }} />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "var(--fg-1)" }}>Remove this device from sync?</h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          It will stop receiving updates. This does not wipe the device — any notes already on it stay there until that
          device is reset.
        </p>
        <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
          <Button variant="secondary" full={false} style={{ flex: 1, height: 50 }}>
            Cancel
          </Button>
          <Button variant="danger" full={false} style={{ flex: 1, height: 50, fontSize: 15 }}>
            Remove
          </Button>
        </div>
      </div>
    </Screen>
  );
}

// SY-08 · Sync status detail ──────────────────────────────────────────────────
function StatusCard({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: 10,
        background: "var(--bg-1)",
        padding: "13px 14px",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      {icon}
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 13, color: "var(--fg-3)" }}>{detail}</div>
      </div>
    </div>
  );
}

function SyncStatus() {
  return (
    <Screen>
      <NavHeader label="Sync" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <h1 style={{ margin: "4px 4px 0", fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Status
        </h1>
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <StatusCard
            icon={<DashCircle color="var(--success)" size={16} />}
            title="Synced"
            detail="up to change 1,284 · 2m ago"
          />
          <StatusCard
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="6" stroke="var(--fg-2)" strokeWidth="1.5" />
                <path d="M8 5v3l2 2" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            }
            title="Syncing…"
            detail="3 changes remaining"
          />
          <StatusCard
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16">
                <circle cx="8" cy="8" r="6" stroke="var(--fg-3)" strokeWidth="1.5" />
                <path d="M5 8h6" stroke="var(--fg-3)" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            }
            title="Offline"
            detail="changes will sync when you reconnect"
          />
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// SY-09 · Sync integrity alert ────────────────────────────────────────────────
function IntegrityAlert() {
  return (
    <Screen>
      <NavHeader label="Sync" />
      <div style={{ flex: 1, padding: "18px 20px 0" }}>
        <div
          style={{
            border: "1px solid color-mix(in srgb, var(--danger) 22%, transparent)",
            borderRadius: 12,
            background: "var(--danger-soft)",
            padding: 18,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              <path d="M11 3l9 16H2z" stroke="var(--danger)" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="M11 9v4M11 16h.01" stroke="var(--danger)" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--danger)" }}>Integrity problem</span>
          </div>
          {/* SYNC-48: render the pinned load-bearing literal VERBATIM (never a
              paraphrase) so the design mock cannot drift from the shipped copy. */}
          <p style={{ margin: "12px 0 0", fontSize: 14, lineHeight: 1.6, color: "var(--danger)" }}>
            {SYNC_INTEGRITY_ALERT}
          </p>
        </div>

        <Button style={{ marginTop: 16, height: 50, fontSize: 15 }}>Verify devices</Button>
        <Button variant="secondary" style={{ marginTop: 10, height: 46 }}>
          Pause sync
        </Button>
      </div>
    </Screen>
  );
}

// SY-10 · Attachment sync ─────────────────────────────────────────────────────
function AttachmentSync() {
  return (
    <Screen>
      <NavHeader label="Sync" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <h1 style={{ margin: "4px 4px 0", fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Attachments
        </h1>
        <Card style={{ marginTop: 16 }}>
          <div style={{ padding: "13px 14px", display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <rect x="3" y="3" width="14" height="14" rx="2" stroke="var(--fg-2)" strokeWidth="1.5" />
              <path d="M3 13l4-4 3 3 3-3 4 4" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span style={{ flex: 1, fontSize: 15 }}>diagram.png</span>
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M3 8.5l3 3 7-7.5" stroke="var(--success)" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div style={{ padding: "13px 14px", borderTop: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path d="M4 3h8l4 4v10H4z" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15 }}>spec.pdf</div>
              <div style={{ fontSize: 12, color: "var(--warning)" }}>failed · will retry</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M3 8a5 5 0 1 1 1.5 3.5M3 12V9h3" stroke="var(--warning)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div style={{ padding: "13px 14px", borderTop: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 10 }}>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <rect x="3" y="3" width="14" height="14" rx="2" stroke="var(--fg-2)" strokeWidth="1.5" />
            </svg>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15 }}>recording.m4a</div>
              <div style={{ fontSize: 12, color: "var(--fg-3)" }}>paused</div>
            </div>
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M5 4v8M11 4v8" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
        </Card>
      </ScreenScroll>
    </Screen>
  );
}

export const syncScreens: ScreenDef[] = [
  { id: "SY-01", label: "Sync settings", Component: SyncSettings },
  { id: "SY-02", label: "Endpoint config", Component: EndpointConfig },
  { id: "SY-03", label: "Enroll this device", Component: EnrollDevice, keyboard: true },
  { id: "SY-04", label: "Pending approval", Component: PendingApproval },
  { id: "SY-05", label: "Approve device + fingerprint", Component: ApproveDevice },
  { id: "SY-06", label: "Your devices", Component: YourDevices },
  { id: "SY-07", label: "Remove device confirm", Component: RemoveDevice },
  { id: "SY-08", label: "Sync status detail", Component: SyncStatus },
  { id: "SY-09", label: "Sync integrity alert", Component: IntegrityAlert },
  { id: "SY-10", label: "Attachment sync", Component: AttachmentSync },
];
