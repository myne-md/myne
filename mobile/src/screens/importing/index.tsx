import {
  Screen,
  Title,
  Button,
  MyneMark,
} from "../../components";
import type { ScreenDef } from "../../gallery/types";

// iOS-style nav bar with a labelled back button (chevron + word).
function NavBack({ label, padding }: { label: string; padding: string }) {
  return (
    <div
      style={{
        flex: "none",
        padding,
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid var(--line-1)",
        background: "var(--bg-1)",
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
        <svg width="9" height="16" viewBox="0 0 9 16" fill="none">
          <path d="M7 1L1 8l6 7" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {label}
      </button>
    </div>
  );
}

// IM-01 · Obsidian import (in progress) ───────────────────────────────────────
function ObsidianImport() {
  return (
    <Screen>
      <NavBack label="Storage" padding="56px 12px 10px" />
      <div style={{ flex: 1, padding: "14px 22px 0" }}>
        <Title style={{ fontSize: 24, margin: "4px 0 0" }}>Import from Obsidian</Title>

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
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="var(--fg-2)" strokeWidth="1.5" />
              <path d="M8 5v3l2 2" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Importing 128 / 412</span>
          </div>
          <div style={{ marginTop: 12, height: 6, borderRadius: 999, background: "var(--line-1)", overflow: "hidden" }}>
            <div style={{ width: "31%", height: "100%", background: "var(--accent)" }} />
          </div>
          <div style={{ marginTop: 8, fontSize: 13, color: "var(--fg-3)" }}>Adversaries.md</div>
        </div>

        <div
          style={{
            marginTop: 16,
            marginBottom: 8,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--fg-3)",
          }}
        >
          If a note exists
        </div>
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
              color: "var(--fg-1)",
            }}
          >
            Skip
          </div>
          <div style={{ flex: 1, textAlign: "center", padding: "8px 0", borderRadius: 6, fontSize: 13, color: "var(--fg-2)" }}>
            Keep both
          </div>
        </div>

        <Button variant="secondary" style={{ marginTop: 16, height: 46 }}>
          Cancel (keep imported)
        </Button>
      </div>
    </Screen>
  );
}

// IM-02 · Import offer (sheet over dimmed Notes) ──────────────────────────────
function ImportOffer() {
  return (
    <Screen>
      <div style={{ flex: 1, opacity: 0.4, padding: "60px 16px 0" }}>
        <h1 style={{ margin: "8px 4px", fontSize: 30, fontWeight: 700, color: "var(--fg-display)" }}>Notes</h1>
      </div>

      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.32)" }} />

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          background: "var(--bg-1)",
          borderRadius: "16px 16px 0 0",
          padding: "10px 22px 34px",
          boxShadow: "var(--shadow-3)",
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 999, background: "var(--line-2)", margin: "6px auto 16px" }} />
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <path d="M6 3h8l4 4v14H6z" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M9 12h6M9 15h6" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, textAlign: "center", color: "var(--fg-1)" }}>
          Bring your notes with you
        </h2>
        <p style={{ margin: "8px 0 0", fontSize: 14, lineHeight: 1.55, color: "var(--fg-2)", textAlign: "center" }}>
          Import an existing Obsidian vault or a folder of markdown files. Everything is encrypted as it comes in.
        </p>
        <Button style={{ marginTop: 18 }}>Choose folder</Button>
        <Button variant="ghost" style={{ marginTop: 10, height: 46, color: "var(--fg-3)", fontWeight: 600 }}>
          Not now
        </Button>
      </div>
    </Screen>
  );
}

// IM-03 · Saved-view import (toast) ───────────────────────────────────────────
function SavedViewImport() {
  return (
    <Screen>
      <div style={{ padding: "60px 20px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <MyneMark size={22} radius={4} />
          <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>Personal</span>
        </div>
        <h1 style={{ margin: "14px 0 0", fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>
          Views
        </h1>
      </div>

      <div style={{ flex: 1 }} />

      <div
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: 40,
          background: "var(--ink-1)",
          color: "var(--paper)",
          borderRadius: 10,
          padding: "14px 16px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          boxShadow: "var(--shadow-3)",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
          <path
            d="M3 10.5l4 4 10-10"
            stroke="var(--_success-dark)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span style={{ flex: 1, fontSize: 14, color: "var(--paper)" }}>Imported view “Reading list” · 1 view added</span>
      </div>
    </Screen>
  );
}

export const importScreens: ScreenDef[] = [
  { id: "IM-01", label: "Obsidian import (in progress)", Component: ObsidianImport },
  { id: "IM-02", label: "Import offer", Component: ImportOffer },
  { id: "IM-03", label: "Saved-view import (toast)", Component: SavedViewImport },
];
