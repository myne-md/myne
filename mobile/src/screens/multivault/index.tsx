import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll, Title, FooterBar, Button, Sheet, MyneMark } from "../../components";
import type { ScreenDef } from "../../gallery/types";

// ── Shared bits ───────────────────────────────────────────────────────────────

/** Thin chevron-right used in the vault-picker rows (8×14, line-2 stroke). */
function RowChevron() {
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

/** A back link header with a hairline bottom border (MV-03, MV-05). */
function BackHeader({ label }: { label: string }) {
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
          fontFamily: "var(--font-sans)",
          fontSize: 15,
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        <svg width="9" height="16" viewBox="0 0 9 16">
          <path d="M7 1L1 8l6 7" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
      </button>
    </div>
  );
}

/** 12px uppercase tracked label (.06em) used above the join/confirm fields. */
function UpperLabel({
  children,
  color = "var(--fg-3)",
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color,
        marginBottom: 8,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── MV-01 · Vault picker ──────────────────────────────────────────────────────

function VaultRow({
  dot,
  name,
  when,
  italic = false,
}: {
  dot: string;
  name: string;
  when: string;
  italic?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        border: "1px solid var(--line-1)",
        borderRadius: 10,
        background: "var(--bg-1)",
        padding: "14px 14px",
      }}
    >
      <span
        style={{
          flex: "none",
          width: 30,
          height: 30,
          borderRadius: 7,
          background: "var(--ink-1)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 32 32" fill="none">
          <path d="M8 22 V10 L16 18 L24 10 V22" stroke="var(--paper)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: dot }} />
          <span
            style={{
              fontSize: 16,
              fontWeight: 600,
              color: italic ? "var(--fg-3)" : "var(--fg-1)",
              fontStyle: italic ? "italic" : undefined,
            }}
          >
            {name}
          </span>
        </div>
        <div style={{ marginTop: 2, fontSize: 13, color: "var(--fg-3)" }}>{when}</div>
      </div>
      <RowChevron />
    </div>
  );
}

function VaultPicker() {
  return (
    <Screen>
      <div style={{ flex: "none", padding: "80px 24px 0", display: "flex", alignItems: "center", gap: 10 }}>
        <MyneMark size={26} radius={6} />
        <span style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-1)" }}>myne</span>
      </div>
      <div style={{ flex: "none", padding: "22px 24px 6px" }}>
        <Title style={{ fontSize: 27 }}>Choose a vault</Title>
      </div>
      <ScreenScroll style={{ padding: "10px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <VaultRow dot="var(--label-slate)" name="Personal" when="opened 2 minutes ago" />
          <VaultRow dot="var(--label-moss)" name="Work" when="opened yesterday" />
          <VaultRow dot="var(--line-2)" name="Vault 3" when="opened last week" italic />
        </div>
      </ScreenScroll>
      <FooterBar style={{ flexDirection: "column", padding: "14px 20px 44px" }}>
        <Button variant="secondary" style={{ height: 48, color: "var(--fg-1)" }}>
          Create another vault
        </Button>
        <Button variant="ghost" style={{ height: 44, color: "var(--accent)", fontWeight: 600 }}>
          Restore from backup
        </Button>
      </FooterBar>
    </Screen>
  );
}

// ── MV-02 · In-app switcher (sheet) ───────────────────────────────────────────

function InAppSwitcher() {
  return (
    <Screen>
      <div style={{ padding: "60px 20px 0", opacity: 0.4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <MyneMark size={22} radius={6} />
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>Personal</span>
        </div>
        <h1 style={{ margin: "14px 0 0", fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>
          Notes
        </h1>
      </div>
      <Sheet style={{ padding: "10px 16px 40px", borderRadius: "16px 16px 0 0" }}>
        <div
          style={{
            padding: "0 4px 10px",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--line-3)",
          }}
        >
          Switch vault
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 12px", borderRadius: 10, background: "var(--accent-soft)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--label-slate)" }} />
          <span style={{ flex: 1, fontSize: 16, fontWeight: 600, color: "var(--accent)" }}>Personal</span>
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M3 8.5l3 3 7-7.5" stroke="var(--accent)" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 12px" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--label-moss)" }} />
          <span style={{ flex: 1, fontSize: 16, fontWeight: 600, color: "var(--fg-1)" }}>Work</span>
          <span style={{ fontSize: 13, color: "var(--fg-3)" }}>switching…</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 12px" }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--line-2)" }} />
          <span style={{ flex: 1, fontSize: 16, fontWeight: 600, fontStyle: "italic", color: "var(--fg-3)" }}>Vault 3</span>
        </div>
        <Button variant="secondary" style={{ marginTop: 8, height: 48, color: "var(--fg-1)" }}>
          Create another vault
        </Button>
      </Sheet>
    </Screen>
  );
}

// ── MV-03 · Vault management ──────────────────────────────────────────────────

function VaultManagement() {
  return (
    <Screen>
      <BackHeader label="Settings" />
      <ScreenScroll style={{ padding: "14px 16px 20px" }}>
        <h1 style={{ margin: "4px 4px 0", fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Vault
        </h1>
        <div
          style={{
            marginTop: 18,
            padding: "0 4px 8px",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--line-3)",
          }}
        >
          Label
        </div>
        <div style={{ display: "flex", alignItems: "center", height: 52, border: "1px solid var(--line-2)", borderRadius: 6, background: "var(--bg-1)", padding: "0 14px" }}>
          <span style={{ fontSize: 16, color: "var(--fg-1)" }}>Personal</span>
        </div>
        <Button full={false} style={{ marginTop: 10, height: 44, padding: "0 18px", fontSize: 14 }}>
          Save
        </Button>
        <div
          style={{
            marginTop: 26,
            padding: "0 4px 8px",
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--danger)",
          }}
        >
          Danger zone
        </div>
        <div
          style={{
            border: "1px solid color-mix(in srgb, var(--danger) 26%, transparent)",
            borderRadius: 10,
            background: "var(--danger-soft)",
            padding: 14,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>Delete this vault</div>
          <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)" }}>
            Removes the vault and its notes from this device. This cannot be undone.
          </div>
          <Button
            variant="secondary"
            full={false}
            style={{ marginTop: 12, height: 44, padding: "0 18px", fontSize: 14, border: "1px solid var(--danger)", color: "var(--danger)" }}
          >
            Delete vault
          </Button>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// ── MV-04 · Delete-vault confirm ──────────────────────────────────────────────

function DeleteVaultConfirm() {
  return (
    <Screen>
      <div style={{ flex: 1, opacity: 0.4, padding: "56px 16px 0" }}>
        <h1 style={{ margin: "8px 4px", fontSize: 26, fontWeight: 700, color: "var(--fg-display)" }}>Vault</h1>
      </div>
      <Sheet style={{ padding: "10px 20px 18px", borderRadius: "16px 16px 0 0" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "var(--fg-1)" }}>Delete “Personal”?</h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          This removes the vault and all its notes from this device. If it isn't backed up or synced elsewhere, it's gone for good.
        </p>
        <UpperLabel style={{ marginTop: 16 }}>Type DELETE to confirm</UpperLabel>
        <div style={{ display: "flex", alignItems: "center", height: 50, border: "1.5px solid var(--danger)", borderRadius: 6, background: "var(--bg-1)", padding: "0 14px" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 16, letterSpacing: "0.08em", color: "var(--fg-1)" }}>DELE</span>
          <span style={{ width: 2, height: 20, background: "var(--danger)", marginInlineStart: 1 }} />
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
          <Button variant="secondary" full={false} style={{ flex: 1, height: 50, fontSize: 15 }}>
            Cancel
          </Button>
          <Button variant="danger" full={false} disabled style={{ flex: 1, height: 50, fontSize: 15 }}>
            Delete
          </Button>
        </div>
      </Sheet>
    </Screen>
  );
}

// ── MV-05 · Join from another device ──────────────────────────────────────────

function JoinFromDevice() {
  return (
    <Screen>
      <BackHeader label="Back" />
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <h1 style={{ margin: "4px 0 0", fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Add this device
        </h1>
        <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)" }}>
          Connect to your sync server and sign in to an existing vault.
        </p>

        <UpperLabel style={{ marginTop: 18 }}>Server URL</UpperLabel>
        <div style={{ display: "flex", alignItems: "center", height: 50, border: "1px solid var(--line-2)", borderRadius: 6, background: "var(--bg-1)", padding: "0 14px" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg-1)" }}>sync.example</span>
        </div>

        <UpperLabel style={{ marginTop: 16 }}>Account number</UpperLabel>
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
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, color: "var(--line-3)" }}>MY‑XXXX‑XXXX‑XXXX‑XXXX‑X</span>
        </div>

        <UpperLabel style={{ marginTop: 16 }}>Password</UpperLabel>
        <div style={{ display: "flex", alignItems: "center", height: 50, border: "1px solid var(--line-2)", borderRadius: 6, background: "var(--bg-1)", padding: "0 14px" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, letterSpacing: "0.14em", color: "var(--fg-1)" }}>••••••••</span>
          <div style={{ flex: 1 }} />
          <svg width="20" height="20" viewBox="0 0 22 22" fill="none">
            <path d="M2 11s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" stroke="var(--fg-3)" strokeWidth="1.6" />
            <circle cx="11" cy="11" r="2.5" stroke="var(--fg-3)" strokeWidth="1.6" />
          </svg>
        </div>
      </div>
      <FooterBar style={{ padding: "14px 20px", borderTop: "none" }}>
        <Button variant="secondary" full={false} style={{ height: 52, padding: "0 22px" }}>
          Cancel
        </Button>
        <Button full={false} style={{ flex: 1, height: 52 }}>
          Submit
        </Button>
      </FooterBar>
    </Screen>
  );
}

export const multivaultScreens: ScreenDef[] = [
  { id: "MV-01", label: "Vault picker", Component: VaultPicker },
  { id: "MV-02", label: "In-app switcher (sheet)", Component: InAppSwitcher },
  { id: "MV-03", label: "Vault management", Component: VaultManagement },
  { id: "MV-04", label: "Delete-vault confirm", Component: DeleteVaultConfirm, keyboard: true },
  { id: "MV-05", label: "Join from another device", Component: JoinFromDevice, keyboard: true },
];
