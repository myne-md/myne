import type { CSSProperties, ReactNode } from "react";
import { Screen, ScreenScroll } from "../../components";
import type { ScreenDef } from "../../gallery/types";

// ── Shared bits ──────────────────────────────────────────────────────────────

type Tab = "notes" | "search" | "graph" | "settings";

const tabCell: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 3,
};

/** Bottom tab bar (Notes / Search / Graph / Settings) used by Graph + Settings. */
function TabBar({ active }: { active: Tab }) {
  const tint = (k: Tab) => (active === k ? "var(--accent)" : "var(--fg-3)");
  const label = (k: Tab): CSSProperties => ({
    fontSize: 10,
    fontWeight: active === k ? 600 : 500,
    color: active === k ? "var(--accent)" : "var(--fg-3)",
  });
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
      <div style={tabCell}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="3" width="14" height="18" rx="2.5" stroke={tint("notes")} strokeWidth="1.8" />
          <path d="M9 8h6M9 12h6M9 16h3" stroke={tint("notes")} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={label("notes")}>Notes</span>
      </div>
      <div style={tabCell}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="7" stroke={tint("search")} strokeWidth="1.8" />
          <path d="M16 16l4 4" stroke={tint("search")} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={label("search")}>Search</span>
      </div>
      <div style={tabCell}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="17" r="2.6" stroke={tint("graph")} strokeWidth="1.8" />
          <circle cx="18" cy="14" r="2.6" stroke={tint("graph")} strokeWidth="1.8" />
          <circle cx="13" cy="6" r="2.6" stroke={tint("graph")} strokeWidth="1.8" />
          <path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" stroke={tint("graph")} strokeWidth="1.6" />
        </svg>
        <span style={label("graph")}>Graph</span>
      </div>
      <div style={tabCell}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M4 7h11M19 7h1M4 17h1M9 17h11" stroke={tint("settings")} strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="17" cy="7" r="2.4" stroke={tint("settings")} strokeWidth="1.8" />
          <circle cx="7" cy="17" r="2.4" stroke={tint("settings")} strokeWidth="1.8" />
        </svg>
        <span style={label("settings")}>Settings</span>
      </div>
    </div>
  );
}

/** The thin 8×14 disclosure chevron used inside Settings list rows. */
function RowChevron() {
  return (
    <svg width="8" height="13" viewBox="0 0 8 14" fill="none">
      <path d="M1 1l6 6-6 6" stroke="var(--line-2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Uppercase tracked group label (Settings + Search section headers). */
function GroupLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
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

/** Inset settings card. */
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

/** A single settings row (label left, value/control right). */
function GroupRow({
  left,
  right,
  first = false,
  pad = "13px 14px",
}: {
  left: ReactNode;
  right: ReactNode;
  first?: boolean;
  pad?: string;
}) {
  return (
    <div
      style={{
        padding: pad,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        borderTop: first ? undefined : "1px solid var(--line-1)",
      }}
    >
      {left}
      {right}
    </div>
  );
}

// 08 · Editor + markdown toolbar ──────────────────────────────────────────────

const tbCell: CSSProperties = {
  flex: "none",
  width: 42,
  height: 38,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: "var(--font-mono)",
  color: "var(--fg-2)",
};

function Editor() {
  return (
    <Screen>
      <div
        style={{
          flex: "none",
          padding: "56px 16px 10px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <button style={{ border: "none", background: "transparent", color: "var(--fg-3)", fontSize: 15, fontWeight: 500, cursor: "pointer" }}>
          Cancel
        </button>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>Threat model v2</div>
        <button style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
          Done
        </button>
      </div>

      <ScreenScroll style={{ padding: "18px 22px", fontSize: 16, lineHeight: 1.7 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 15, lineHeight: 1.75, color: "var(--fg-1)" }}>
          <div>
            <span style={{ color: "var(--accent)" }}># </span>
            <span style={{ fontWeight: 600 }}>Threat model v2</span>
          </div>
          <div style={{ height: 14 }} />
          <div>
            <span style={{ color: "var(--accent)" }}>## </span>Adversaries
          </div>
          <div style={{ height: 10 }} />
          <div>
            We assume a <span style={{ color: "var(--fg-3)" }}>**</span>powerful
            <span style={{ color: "var(--fg-3)" }}>**</span> network adversary that can{" "}
            <span style={{ color: "var(--fg-3)" }}>==</span>
            <span style={{ background: "var(--warning-soft)" }}>observe all traffic</span>
            <span style={{ color: "var(--fg-3)" }}>==</span> and compromise the relay.
          </div>
          <div style={{ height: 10 }} />
          <div>
            Ciphertext stays opaque to the server — see <span style={{ color: "var(--fg-3)" }}>[[</span>
            <span style={{ color: "var(--accent)" }}>Key rotation</span>
            <span style={{ color: "var(--fg-3)" }}>]]</span> for re-pair.
            <span
              style={{ display: "inline-block", width: 2, height: 18, background: "var(--accent)", verticalAlign: -3, marginInlineStart: 1 }}
            />
          </div>
          <div style={{ height: 10 }} />
          <div>
            <span style={{ color: "var(--fg-3)" }}>- </span>Network observer
          </div>
          <div>
            <span style={{ color: "var(--fg-3)" }}>- </span>Malicious relay
          </div>
        </div>
      </ScreenScroll>

      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: 46,
          padding: "0 6px",
          background: "var(--bg-2)",
          borderTop: "1px solid var(--line-1)",
          overflow: "hidden",
        }}
      >
        <div style={{ ...tbCell, fontSize: 16, fontWeight: 600 }}>H1</div>
        <div style={{ ...tbCell, fontSize: 16, fontWeight: 700 }}>B</div>
        <div style={{ ...tbCell, fontSize: 16, fontStyle: "italic" }}>I</div>
        <div style={tbCell}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M7 5l-4 5 4 5M13 5l4 5-4 5" stroke="var(--fg-2)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div style={tbCell}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M7 6h10M7 10h10M7 14h10" stroke="var(--fg-2)" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="3" cy="6" r="1.3" fill="var(--fg-2)" />
            <circle cx="3" cy="10" r="1.3" fill="var(--fg-2)" />
            <circle cx="3" cy="14" r="1.3" fill="var(--fg-2)" />
          </svg>
        </div>
        <div style={tbCell}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <rect x="3" y="3" width="14" height="14" rx="3" stroke="var(--fg-2)" strokeWidth="1.8" />
            <path d="M7 10l2.2 2.2L13.5 8" stroke="var(--fg-2)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div style={{ ...tbCell, width: 46, fontSize: 15, fontWeight: 600, color: "var(--accent)" }}>[[ ]]</div>
        <div style={{ ...tbCell, fontSize: 18 }}>"</div>
        <div style={{ ...tbCell, fontSize: 16 }}>{"{ }"}</div>
      </div>
    </Screen>
  );
}

// 09 · Search & commands ──────────────────────────────────────────────────────

function Search() {
  return (
    <Screen>
      <div style={{ flex: "none", padding: "56px 16px 12px", display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 40,
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: 8,
            padding: "0 12px",
          }}
        >
          <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
            <circle cx="9" cy="9" r="6.5" stroke="var(--fg-3)" strokeWidth="1.7" />
            <path d="M14 14l3.5 3.5" stroke="var(--fg-3)" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <span style={{ fontFamily: "var(--font-sans)", fontSize: 16, color: "var(--fg-1)" }}>threat</span>
          <span style={{ width: 2, height: 18, background: "var(--accent)" }} />
        </div>
        <button style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 500, cursor: "pointer" }}>
          Cancel
        </button>
      </div>

      <ScreenScroll>
        <GroupLabel style={{ padding: "6px 20px 8px" }}>Notes</GroupLabel>
        <div style={{ padding: "11px 20px", borderTop: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--label-slate)", flex: "none" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              <span style={{ background: "var(--warning-soft)" }}>Threat</span> model v2
            </div>
            <div style={{ fontSize: 13, color: "var(--fg-3)" }}>…powerful network adversary…</div>
          </div>
        </div>
        <div style={{ padding: "11px 20px", borderTop: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "transparent", border: "1px solid var(--line-2)", flex: "none" }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Key rotation</div>
            <div style={{ fontSize: 13, color: "var(--fg-3)" }}>
              …in the <span style={{ background: "var(--warning-soft)" }}>threat</span> model the device key…
            </div>
          </div>
        </div>

        <GroupLabel style={{ padding: "14px 20px 8px" }}>Headings</GroupLabel>
        <div style={{ padding: "11px 20px", borderTop: "1px solid var(--line-1)" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--accent)" }}>## Adversaries</div>
          <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 2 }}>in Threat model v2</div>
        </div>

        <GroupLabel style={{ padding: "14px 20px 8px" }}>Commands</GroupLabel>
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 12 }}>
          <svg width="19" height="19" viewBox="0 0 20 20" fill="none">
            <path d="M10 3v14M3 10h14" stroke="var(--fg-2)" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span style={{ fontSize: 16 }}>New note</span>
        </div>
        <div style={{ padding: "12px 20px", borderTop: "1px solid var(--line-1)", display: "flex", alignItems: "center", gap: 12 }}>
          <svg width="19" height="19" viewBox="0 0 20 20" fill="none">
            <rect x="3" y="3" width="14" height="14" rx="3" stroke="var(--fg-2)" strokeWidth="1.7" />
            <path d="M10 3v14" stroke="var(--fg-2)" strokeWidth="1.7" />
          </svg>
          <span style={{ fontSize: 16 }}>Switch vault</span>
        </div>
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--line-1)",
            borderBottom: "1px solid var(--line-1)",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <svg width="19" height="19" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="6.5" stroke="var(--fg-2)" strokeWidth="1.7" />
            <path d="M10 3.5v13" stroke="var(--fg-2)" strokeWidth="1.7" />
          </svg>
          <span style={{ fontSize: 16 }}>Toggle theme</span>
        </div>
      </ScreenScroll>
    </Screen>
  );
}

// 10 · Graph ──────────────────────────────────────────────────────────────────

function Graph() {
  return (
    <Screen>
      <div style={{ flex: "none", padding: "60px 20px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>Graph</h1>
          <div
            style={{
              padding: "7px 13px",
              borderRadius: 999,
              border: "1px solid var(--line-2)",
              color: "var(--fg-2)",
              fontSize: 13,
              fontWeight: 500,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            Personal
            <svg width="10" height="10" viewBox="0 0 12 12">
              <path d="M2 4l4 4 4-4" stroke="var(--fg-3)" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 402 560"
          preserveAspectRatio="xMidYMid meet"
          style={{ position: "absolute", inset: 0 }}
        >
          <line x1="201" y1="270" x2="110" y2="150" stroke="var(--line-1)" strokeWidth="1.5" />
          <line x1="201" y1="270" x2="300" y2="160" stroke="var(--line-1)" strokeWidth="1.5" />
          <line x1="201" y1="270" x2="120" y2="380" stroke="var(--line-1)" strokeWidth="1.5" />
          <line x1="201" y1="270" x2="300" y2="400" stroke="var(--line-1)" strokeWidth="1.5" />
          <line x1="201" y1="270" x2="210" y2="430" stroke="var(--line-1)" strokeWidth="1.5" />
          <line x1="110" y1="150" x2="60" y2="250" stroke="var(--line-1)" strokeWidth="1.5" />
          <line x1="300" y1="160" x2="350" y2="270" stroke="var(--line-1)" strokeWidth="1.5" />
          <line x1="300" y1="400" x2="210" y2="430" stroke="var(--line-1)" strokeWidth="1.5" />
          <circle cx="110" cy="150" r="7" fill="var(--bg-1)" stroke="var(--label-slate)" strokeWidth="2" />
          <circle cx="300" cy="160" r="6" fill="var(--bg-1)" stroke="var(--label-clay)" strokeWidth="2" />
          <circle cx="60" cy="250" r="5" fill="var(--bg-1)" stroke="var(--line-2)" strokeWidth="2" />
          <circle cx="350" cy="270" r="5" fill="var(--bg-1)" stroke="var(--line-2)" strokeWidth="2" />
          <circle cx="120" cy="380" r="6" fill="var(--bg-1)" stroke="var(--label-moss)" strokeWidth="2" />
          <circle cx="300" cy="400" r="6" fill="var(--bg-1)" stroke="var(--label-ochre)" strokeWidth="2" />
          <circle cx="210" cy="430" r="5" fill="var(--bg-1)" stroke="var(--line-2)" strokeWidth="2" />
          <circle cx="201" cy="270" r="11" fill="var(--accent)" />
          <text x="201" y="298" textAnchor="middle" fontFamily="var(--font-sans)" fontSize="13" fontWeight="600" fill="var(--fg-1)">
            Threat model v2
          </text>
          <text x="110" y="135" textAnchor="middle" fontFamily="var(--font-sans)" fontSize="12" fill="var(--fg-2)">
            Key rotation
          </text>
          <text x="300" y="145" textAnchor="middle" fontFamily="var(--font-sans)" fontSize="12" fill="var(--fg-2)">
            Project Aurora
          </text>
          <text x="120" y="400" textAnchor="middle" fontFamily="var(--font-sans)" fontSize="12" fill="var(--fg-2)">
            Weekly review
          </text>
          <text x="300" y="420" textAnchor="middle" fontFamily="var(--font-sans)" fontSize="12" fill="var(--fg-2)">
            Inbox
          </text>
        </svg>
        <div style={{ position: "absolute", insetInlineStart: 20, bottom: 14, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>
          48 notes · 112 links
        </div>
      </div>

      <TabBar active="graph" />
    </Screen>
  );
}

// 11 · Settings ───────────────────────────────────────────────────────────────

const rowLabel: CSSProperties = { fontSize: 16 };

function Settings() {
  return (
    <Screen>
      <div style={{ flex: "none", padding: "60px 20px 0" }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>Settings</h1>
      </div>

      <ScreenScroll style={{ padding: "18px 16px 20px" }}>
        <GroupLabel style={{ padding: "0 4px 8px" }}>Account</GroupLabel>
        <Card>
          <GroupRow first left={<span style={rowLabel}>Vault</span>} right={<span style={{ fontSize: 16, color: "var(--fg-3)" }}>Personal</span>} />
          <GroupRow
            left={<span style={rowLabel}>Account no.</span>}
            right={
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, letterSpacing: "0.02em", color: "var(--fg-2)" }}>
                MY‑4F2A‑9C17‑8E2D‑1B5F‑K
              </span>
            }
          />
        </Card>

        <GroupLabel style={{ padding: "18px 4px 8px" }}>Security</GroupLabel>
        <Card>
          <GroupRow
            first
            pad="11px 14px"
            left={<span style={rowLabel}>Unlock with Face ID</span>}
            right={
              <div style={{ width: 48, height: 28, borderRadius: 999, background: "var(--accent)", position: "relative" }}>
                <span style={{ position: "absolute", top: 3, insetInlineEnd: 3, width: 22, height: 22, borderRadius: "50%", background: "var(--accent-on)" }} />
              </div>
            }
          />
          <GroupRow
            left={<span style={rowLabel}>Auto-lock</span>}
            right={
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--fg-3)" }}>
                <span style={{ fontSize: 16 }}>After 2 minutes</span>
                <RowChevron />
              </div>
            }
          />
          <GroupRow left={<span style={rowLabel}>Change passphrase</span>} right={<RowChevron />} />
        </Card>

        <GroupLabel style={{ padding: "18px 4px 8px" }}>Sync</GroupLabel>
        <Card>
          <GroupRow
            first
            left={<span style={rowLabel}>Status</span>}
            right={
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />
                <span style={{ fontSize: 15, color: "var(--fg-3)" }}>Synced · 2m ago</span>
              </div>
            }
          />
          <GroupRow left={<span style={rowLabel}>Relay</span>} right={<span style={{ fontSize: 16, color: "var(--fg-3)" }}>sync.example</span>} />
        </Card>

        <GroupLabel style={{ padding: "18px 4px 8px" }}>Appearance</GroupLabel>
        <Card style={{ overflow: "visible", padding: "12px 14px" }}>
          <div style={{ fontSize: 16, marginBottom: 10 }}>Theme</div>
          <div style={{ display: "flex", gap: 4, background: "var(--bg-2)", border: "1px solid var(--line-1)", borderRadius: 8, padding: 3 }}>
            <div style={{ flex: 1, textAlign: "center", padding: "7px 0", borderRadius: 6, fontSize: 14, color: "var(--fg-2)" }}>System</div>
            <div
              style={{
                flex: 1,
                textAlign: "center",
                padding: "7px 0",
                borderRadius: 6,
                background: "var(--bg-1)",
                border: "1px solid var(--line-1)",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--fg-1)",
              }}
            >
              Light
            </div>
            <div style={{ flex: 1, textAlign: "center", padding: "7px 0", borderRadius: 6, fontSize: 14, color: "var(--fg-2)" }}>Dark</div>
          </div>
        </Card>

        <GroupLabel style={{ padding: "18px 4px 8px" }}>Import</GroupLabel>
        <Card>
          <GroupRow first left={<span style={rowLabel}>Import from Obsidian</span>} right={<RowChevron />} />
          <GroupRow left={<span style={rowLabel}>Import Markdown files</span>} right={<RowChevron />} />
        </Card>

        <button
          style={{
            marginTop: 20,
            width: "100%",
            height: 48,
            border: "1px solid var(--line-1)",
            borderRadius: 10,
            background: "var(--bg-1)",
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 16,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Lock vault
        </button>
        <div style={{ marginTop: 14, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>
          myne 0.4.1 · open source
        </div>
      </ScreenScroll>

      <TabBar active="settings" />
    </Screen>
  );
}

export const workspaceScreens: ScreenDef[] = [
  { id: "08", label: "Editor + markdown toolbar", Component: Editor, keyboard: true },
  { id: "09", label: "Search & commands", Component: Search, keyboard: true },
  { id: "10", label: "Graph", Component: Graph },
  { id: "11", label: "Settings", Component: Settings },
];
