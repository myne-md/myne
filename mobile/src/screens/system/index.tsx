import type { CSSProperties, ReactNode } from "react";
import {
  Screen,
  ScreenScroll,
  Eyebrow,
  Button,
  MyneMark,
  BlockingOverlay,
} from "../../components";
import type { ScreenDef } from "../../gallery/types";

// Shared bits ─────────────────────────────────────────────────────────────────

/** The "Personal" + "Notes" home header (mark + vault name + big title). */
function NotesHeader({ children }: { children?: ReactNode }) {
  return (
    <div style={{ flex: "none", padding: "60px 20px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <MyneMark size={22} radius={4} />
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>Personal</span>
      </div>
      <h1
        style={{
          margin: "14px 0 0",
          fontSize: 32,
          fontWeight: 700,
          letterSpacing: "-0.025em",
          color: "var(--fg-display)",
        }}
      >
        Notes
      </h1>
      {children}
    </div>
  );
}

/** The bottom tab bar (Notes / Search / Graph / Settings). */
function TabBar() {
  const inactive = "var(--fg-3)";
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        padding: "8px 0 30px",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="3" width="14" height="18" rx="2.5" stroke="var(--accent)" strokeWidth="1.8" />
          <path d="M9 8h6M9 12h6M9 16h3" stroke="var(--accent)" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 600, color: "var(--accent)" }}>Notes</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke={inactive} strokeWidth="1.8" />
          <path d="M16 16l4 4" stroke={inactive} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, color: inactive }}>Search</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="17" r="2.6" stroke={inactive} strokeWidth="1.8" />
          <circle cx="18" cy="14" r="2.6" stroke={inactive} strokeWidth="1.8" />
          <circle cx="13" cy="6" r="2.6" stroke={inactive} strokeWidth="1.8" />
          <path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" stroke={inactive} strokeWidth="1.6" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, color: inactive }}>Graph</span>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M4 7h11M19 7h1M4 17h1M9 17h11" stroke={inactive} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="17" cy="7" r="2.4" stroke={inactive} strokeWidth="1.8" />
          <circle cx="7" cy="17" r="2.4" stroke={inactive} strokeWidth="1.8" />
        </svg>
        <span style={{ fontSize: 10, fontWeight: 500, color: inactive }}>Settings</span>
      </div>
    </div>
  );
}

/** Always-ink toast pill (radius 10) — surface flips, text stays paper. */
function ToastCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "var(--ink-1)",
        color: "var(--paper)",
        borderRadius: 10,
        padding: "13px 15px",
        boxShadow: "var(--shadow-3)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Uppercase tracked section label (SYS-07 — 12px / 0.08em / line-3). */
function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
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

/** A bordered inline status banner (SYS-07). */
function InlineBanner({
  color,
  soft,
  icon,
  children,
}: {
  color: string;
  soft: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        background: soft,
        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
        borderRadius: 8,
        padding: "12px 14px",
      }}
    >
      {icon}
      <span style={{ fontSize: 13, color }}>{children}</span>
    </div>
  );
}

// SYS-01 · Fail-closed error ──────────────────────────────────────────────────
function FailClosed() {
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
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <path d="M24 5l19 33H5z" stroke="var(--danger)" strokeWidth="2" strokeLinejoin="round" />
          <path d="M24 19v10M24 33h.02" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <h1
          style={{
            margin: "22px 0 0",
            fontSize: 24,
            lineHeight: 1.2,
            letterSpacing: "-0.02em",
            fontWeight: 600,
            color: "var(--fg-display)",
          }}
        >
          Vault couldn't be opened
        </h1>
        <p style={{ margin: "12px 0 0", fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 300 }}>
          The vault data on this device looks corrupted, so Myne stopped to avoid making it worse. Your
          other devices and backups are unaffected.
        </p>
      </div>
      <div style={{ flex: "none", paddingBottom: 52, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        <Button>Restore from backup</Button>
        <Button variant="secondary" style={{ height: 48 }}>
          Lock vault
        </Button>
      </div>
    </Screen>
  );
}

// SYS-02 · Permission denied ──────────────────────────────────────────────────
function PermissionDenied() {
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
        <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
          <path
            d="M23 9a6 6 0 0 1 6 6v6M17 15v6c0 4-2 6-4 8h20"
            stroke="var(--fg-3)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="23" cy="34" r="2" fill="var(--fg-3)" />
        </svg>
        <h1
          style={{
            margin: "22px 0 0",
            fontSize: 22,
            lineHeight: 1.2,
            letterSpacing: "-0.02em",
            fontWeight: 600,
            color: "var(--fg-display)",
          }}
        >
          Microphone access is off
        </h1>
        <p style={{ margin: "12px 0 0", fontSize: 15, lineHeight: 1.6, color: "var(--fg-2)", maxWidth: 290 }}>
          To record a voice note, allow microphone access for Myne in iOS Settings.
        </p>
      </div>
      <div style={{ flex: "none", paddingBottom: 52, width: "100%", display: "flex", flexDirection: "column", gap: 10 }}>
        <Button>Open Settings</Button>
        <Button variant="ghost" style={{ color: "var(--fg-3)", fontWeight: 600 }}>
          Not now
        </Button>
      </div>
    </Screen>
  );
}

// SYS-03 · Offline (not an error) ─────────────────────────────────────────────
function OfflineRow({ title, snippet, last }: { title: string; snippet: string; last?: boolean }) {
  return (
    <div
      style={{
        padding: "14px 20px",
        borderTop: "1px solid var(--line-1)",
        borderBottom: last ? "1px solid var(--line-1)" : undefined,
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)" }}>{title}</div>
      <div
        style={{
          marginTop: 3,
          fontSize: 14,
          color: "var(--fg-3)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {snippet}
      </div>
    </div>
  );
}

function Offline() {
  return (
    <Screen>
      <NotesHeader>
        <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 7 }}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="var(--fg-3)" strokeWidth="1.4" />
            <path d="M5 8h6" stroke="var(--fg-3)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span style={{ fontSize: 13, color: "var(--fg-3)" }}>Offline · changes will sync later</span>
        </div>
      </NotesHeader>
      <ScreenScroll style={{ marginTop: 14 }}>
        <OfflineRow title="Threat model v2" snippet="We assume a powerful network adversary…" />
        <OfflineRow title="Weekly review — 06-15" snippet="Shipped the sync conflict resolver…" />
        <OfflineRow title="Project Aurora — kickoff" snippet="Scope, owners, and milestones…" last />
      </ScreenScroll>
      <TabBar />
    </Screen>
  );
}

// SYS-04 · App-switcher privacy cover ─────────────────────────────────────────
function PrivacyCover() {
  return (
    <Screen style={{ background: "var(--bg-2)", alignItems: "center", justifyContent: "center" }}>
      <MyneMark size={56} radius={12} />
      <div style={{ marginTop: 16, fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>
        myne
      </div>
    </Screen>
  );
}

// SYS-05 · Resume → unlock ────────────────────────────────────────────────────
function ResumeUnlock() {
  return (
    <Screen style={{ alignItems: "center", padding: "0 32px" }}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Eyebrow>Locked vault</Eyebrow>
        <div style={{ marginTop: 8, fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Personal
        </div>
        <div style={{ marginTop: 44, width: 64, height: 64, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="64" height="64" viewBox="0 0 72 72" fill="none">
            <path d="M4 22 V14 a10 10 0 0 1 10 -10 H22" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
            <path d="M50 4 H58 a10 10 0 0 1 10 10 V22" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
            <path d="M68 50 V58 a10 10 0 0 1 -10 10 H50" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
            <path d="M22 68 H14 a10 10 0 0 1 -10 -10 V50" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
            <path d="M27 30 V34 M45 30 V34" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
            <path d="M36 31 V40 M32 44 h8" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M29 50 q7 5 14 0" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" fill="none" />
          </svg>
        </div>
        <div style={{ marginTop: 20, fontSize: 16, fontWeight: 500, color: "var(--fg-1)" }}>
          Locked while you were away
        </div>
        <div style={{ marginTop: 4, fontSize: 13, color: "var(--fg-3)" }}>Look to unlock</div>
      </div>
      <div style={{ flex: "none", paddingBottom: 48 }}>
        <Button variant="ghost" style={{ height: 44, color: "var(--accent)", fontWeight: 600 }}>
          Enter passphrase instead
        </Button>
      </div>
    </Screen>
  );
}

// SYS-06 · Empty — Notes ──────────────────────────────────────────────────────
function EmptyNotes() {
  return (
    <Screen>
      <NotesHeader />
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "0 40px",
        }}
      >
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="3" width="14" height="18" rx="2.5" stroke="var(--line-2)" strokeWidth="1.6" />
          <path d="M9 9h6M9 13h4" stroke="var(--line-2)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <div style={{ marginTop: 14, fontSize: 17, fontWeight: 600, color: "var(--fg-2)" }}>No notes yet</div>
        <div style={{ marginTop: 6, fontSize: 14, color: "var(--fg-3)", lineHeight: 1.5 }}>
          Your first note is one tap away. Everything you write stays encrypted on this device.
        </div>
        <Button full={false} style={{ marginTop: 18, height: 48, fontSize: 15 }}>
          New note
        </Button>
      </div>
      <TabBar />
    </Screen>
  );
}

// SYS-07 · Toast & banner primitives ──────────────────────────────────────────
function ToastBannerPrimitives() {
  return (
    <Screen style={{ background: "var(--bg-2)", padding: "64px 20px", gap: 14 }}>
      <SectionLabel>Toast</SectionLabel>
      <ToastCard>
        <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
          <path d="M3 9.5l4 4 8-9" stroke="var(--_success-dark)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ flex: 1, fontSize: 14 }}>Note archived</span>
      </ToastCard>
      <ToastCard>
        <span style={{ flex: 1, fontSize: 14 }}>Note deleted</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--_accent-dark)" }}>Undo</span>
      </ToastCard>

      <SectionLabel style={{ marginTop: 8 }}>Inline banners</SectionLabel>
      <InlineBanner
        color="var(--danger)"
        soft="var(--danger-soft)"
        icon={
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
            <path d="M9 2l7 13H2z" stroke="var(--danger)" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M9 7v3M9 12.5h.01" stroke="var(--danger)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        }
      >
        Couldn't reach the sync server.
      </InlineBanner>
      <InlineBanner
        color="var(--warning)"
        soft="var(--warning-soft)"
        icon={
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="7" stroke="var(--warning)" strokeWidth="1.4" />
            <path d="M9 5.5v4M9 12h.01" stroke="var(--warning)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        }
      >
        Some attachments are still downloading.
      </InlineBanner>
      <InlineBanner
        color="var(--success)"
        soft="var(--success-soft)"
        icon={
          <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="7" stroke="var(--success)" strokeWidth="1.4" />
            <path d="M9 8v5M9 5.5h.01" stroke="var(--success)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        }
      >
        All changes are synced.
      </InlineBanner>
    </Screen>
  );
}

// SYS-08 · Blocking progress ──────────────────────────────────────────────────
function BlockingProgress() {
  return (
    <Screen>
      <BlockingOverlay title="Restoring…" subtitle="This can take a moment and can't be interrupted." />
    </Screen>
  );
}

// SYS-09 · Repair-residue (Welcome) ───────────────────────────────────────────
function RepairResidue() {
  return (
    <Screen style={{ padding: "0 30px" }}>
      <div style={{ paddingTop: 80, display: "flex", alignItems: "center", gap: 10 }}>
        <MyneMark size={26} radius={5} />
        <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>myne</span>
      </div>
      <div
        style={{
          marginTop: 24,
          background: "var(--warning-soft)",
          border: "1px solid color-mix(in srgb, var(--warning) 25%, transparent)",
          borderRadius: 10,
          padding: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="7" stroke="var(--warning)" strokeWidth="1.4" />
            <path d="M9 5.5v4M9 12h.01" stroke="var(--warning)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--warning)" }}>Leftover data found</span>
        </div>
        <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.55, color: "var(--warning)" }}>
          A vault that was being deleted didn't finish cleaning up. You can safely remove what's left.
        </p>
        <button
          style={{
            marginTop: 12,
            height: 40,
            padding: "0 16px",
            border: "1px solid color-mix(in srgb, var(--warning) 45%, transparent)",
            borderRadius: 6,
            background: "transparent",
            color: "var(--warning)",
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Clean up
        </button>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{ paddingBottom: 52, display: "flex", flexDirection: "column", gap: 10 }}>
        <Button>Create a vault</Button>
        <Button variant="ghost">Connect to my account</Button>
      </div>
    </Screen>
  );
}

// SYS-10 · Clipper pairing ────────────────────────────────────────────────────
function ClipperPairing() {
  return (
    <Screen>
      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.32)" }} />
      <div
        style={{
          position: "absolute",
          insetInlineStart: 20,
          insetInlineEnd: 20,
          top: "50%",
          transform: "translateY(-50%)",
          background: "var(--bg-1)",
          borderRadius: 14,
          padding: 22,
          boxShadow: "var(--shadow-3)",
          textAlign: "center",
        }}
      >
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 600, color: "var(--fg-1)" }}>Pair web clipper?</h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          Confirm this code matches the one shown in your browser extension.
        </p>
        <div
          style={{
            marginTop: 16,
            fontFamily: "var(--font-mono)",
            fontSize: 30,
            fontWeight: 600,
            letterSpacing: "0.12em",
            color: "var(--fg-1)",
          }}
        >
          4F‑2A‑9C
        </div>
        <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
          <Button variant="secondary" full={false} style={{ flex: 1, height: 48, fontSize: 15 }}>
            Reject
          </Button>
          <Button full={false} style={{ flex: 1, height: 48, fontSize: 15 }}>
            Approve
          </Button>
        </div>
      </div>
    </Screen>
  );
}

// SYS-11 · Clip-saved toast ───────────────────────────────────────────────────
function ClipSaved() {
  return (
    <Screen>
      <NotesHeader />
      <div style={{ flex: 1 }} />
      <ToastCard style={{ position: "absolute", insetInlineStart: 16, insetInlineEnd: 16, bottom: 40, padding: "14px 16px" }}>
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
          <path d="M3 10.5l4 4 10-10" stroke="var(--_success-dark)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ flex: 1, fontSize: 14 }}>Clip saved</span>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--_accent-dark)" }}>View note</span>
      </ToastCard>
    </Screen>
  );
}

export const systemScreens: ScreenDef[] = [
  { id: "SYS-01", label: "Fail-closed error", Component: FailClosed },
  { id: "SYS-02", label: "Permission denied", Component: PermissionDenied },
  { id: "SYS-03", label: "Offline (not an error)", Component: Offline },
  { id: "SYS-04", label: "App-switcher privacy cover", Component: PrivacyCover },
  { id: "SYS-05", label: "Resume → unlock", Component: ResumeUnlock },
  { id: "SYS-06", label: "Empty — Notes", Component: EmptyNotes },
  { id: "SYS-07", label: "Toast & banner primitives", Component: ToastBannerPrimitives },
  { id: "SYS-08", label: "Blocking progress", Component: BlockingProgress },
  { id: "SYS-09", label: "Repair-residue (Welcome)", Component: RepairResidue },
  { id: "SYS-10", label: "Clipper pairing", Component: ClipperPairing },
  { id: "SYS-11", label: "Clip-saved toast", Component: ClipSaved },
];
