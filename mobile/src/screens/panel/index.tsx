import type { ReactNode } from "react";
import { Screen } from "../../components";
import type { ScreenDef } from "../../gallery/types";

/**
 * Right-panel surface (prefix RP). A note page sits dimmed behind a scrim while
 * a bottom panel slides up carrying a tabbed header — Backlinks / Unlinked /
 * Outline. UI-only: tabs and buttons are inert. Light variant only; the dark +
 * amoled themes are produced automatically by the CSS tokens.
 *
 * The scrim is a literal dark rgba (matching the Sheet primitive convention) so
 * it stays a dimming wash in every theme rather than flipping with --fg-1.
 */

const TABS = ["Backlinks", "Unlinked", "Outline"] as const;

// Tabbed header shared by every panel screen.
function TabHeader({ active }: { active: number }) {
  return (
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
      {TABS.map((t, i) =>
        i === active ? (
          <div
            key={t}
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
            {t}
          </div>
        ) : (
          <div
            key={t}
            style={{
              flex: 1,
              textAlign: "center",
              padding: "8px 0",
              borderRadius: 6,
              fontSize: 13,
              color: "var(--fg-2)",
            }}
          >
            {t}
          </div>
        ),
      )}
    </div>
  );
}

// Dimmed note page + scrim + slide-up panel with grabber and tab header.
function PanelHost({
  noteTitle,
  active,
  panelHeight = "74%",
  children,
}: {
  noteTitle: string;
  active: number;
  panelHeight?: string;
  children: ReactNode;
}) {
  return (
    <Screen>
      <div style={{ flex: 1, opacity: 0.4, padding: "56px 22px 0" }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: "var(--fg-display)" }}>
          {noteTitle}
        </h1>
      </div>
      <div style={{ position: "absolute", inset: 0, background: "rgba(20,20,18,0.28)" }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: panelHeight,
          background: "var(--bg-1)",
          borderRadius: "16px 16px 0 0",
          padding: "10px 16px 30px",
          boxShadow: "0 -8px 30px rgba(20,24,40,0.18)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            width: 36,
            height: 4,
            borderRadius: 999,
            background: "var(--line-2)",
            margin: "6px auto 14px",
          }}
        />
        <TabHeader active={active} />
        {children}
      </div>
    </Screen>
  );
}

// Uppercase reference / mention count label.
function CountLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--line-3)",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

// RP-01 · Backlinks (panel) ───────────────────────────────────────────────────
function Backlinks() {
  return (
    <PanelHost noteTitle="Threat model v2" active={0}>
      <div style={{ marginTop: 14, flex: 1, overflow: "auto" }}>
        <CountLabel>2 references</CountLabel>
        <div style={{ border: "1px solid var(--line-1)", borderRadius: 8, padding: "12px 14px" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Key rotation</div>
          <div style={{ marginTop: 4, fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)" }}>
            …see <span style={{ color: "var(--accent)" }}>[[Threat model v2]]</span> for the
            adversary set.
          </div>
        </div>
        <div
          style={{
            marginTop: 8,
            border: "1px solid var(--line-1)",
            borderRadius: 8,
            padding: "12px 14px",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>Project Aurora — kickoff</div>
          <div style={{ marginTop: 4, fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)" }}>
            Security review blocked on{" "}
            <span style={{ color: "var(--accent)" }}>[[Threat model v2]]</span> sign-off.
          </div>
        </div>
      </div>
    </PanelHost>
  );
}

// A single unlinked-mention row with its inline highlight + Link action.
function MentionRow({
  title,
  before,
  highlight,
  after,
  first,
}: {
  title: string;
  before: string;
  highlight: string;
  after: string;
  first?: boolean;
}) {
  return (
    <div
      style={{
        marginTop: first ? 0 : 8,
        border: "1px solid var(--line-1)",
        borderRadius: 8,
        padding: "12px 14px",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div style={{ marginTop: 4, fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)" }}>
          {before}
          <span style={{ background: "var(--warning-soft)" }}>{highlight}</span>
          {after}
        </div>
      </div>
      <button
        style={{
          flex: "none",
          height: 32,
          padding: "0 12px",
          border: "1px solid var(--line-2)",
          borderRadius: 6,
          background: "transparent",
          color: "var(--accent)",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        Link
      </button>
    </div>
  );
}

// RP-02 · Unlinked mentions ───────────────────────────────────────────────────
function Unlinked() {
  return (
    <PanelHost noteTitle="Threat model v2" active={1}>
      <div style={{ marginTop: 14, flex: 1, overflow: "auto" }}>
        <CountLabel>3 mentions</CountLabel>
        <MentionRow
          title="Roadmap Q3"
          before="…blocked on the "
          highlight="threat model v2"
          after=" review."
          first
        />
        <MentionRow
          title="Sync protocol notes"
          before="…assumptions match the "
          highlight="threat model v2"
          after="."
        />
      </div>
    </PanelHost>
  );
}

// One outline row at a given indent level.
function OutlineRow({
  children,
  size,
  color,
  indent,
  accentRule,
}: {
  children: ReactNode;
  size: number;
  color: string;
  indent: number;
  accentRule?: boolean;
}) {
  return (
    <div
      style={{
        padding: `9px 4px 9px ${indent}px`,
        fontSize: size,
        color,
        borderLeft: accentRule ? "2px solid var(--accent-soft)" : undefined,
      }}
    >
      {children}
    </div>
  );
}

// RP-03 · Outline ─────────────────────────────────────────────────────────────
function Outline() {
  return (
    <PanelHost noteTitle="Threat model v2" active={2}>
      <div style={{ marginTop: 14, flex: 1, overflow: "auto" }}>
        <div style={{ padding: "10px 4px", fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>
          Threat model v2
        </div>
        <OutlineRow size={15} color="var(--accent)" indent={18} accentRule>
          Adversaries
        </OutlineRow>
        <OutlineRow size={14} color="var(--fg-2)" indent={34}>
          Network observer
        </OutlineRow>
        <OutlineRow size={14} color="var(--fg-2)" indent={34}>
          Malicious relay
        </OutlineRow>
        <OutlineRow size={15} color="var(--fg-2)" indent={18}>
          Key handling
        </OutlineRow>
        <OutlineRow size={15} color="var(--fg-2)" indent={18}>
          Open questions
        </OutlineRow>
      </div>
    </PanelHost>
  );
}

// RP-04 · Panel host (all hidden) ─────────────────────────────────────────────
function PanelEmpty() {
  return (
    <PanelHost noteTitle="Sourdough — working notes" active={0} panelHeight="60%">
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          color: "var(--line-3)",
        }}
      >
        <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
          <path
            d="M7 11h12M7 17h20M7 23h9"
            stroke="var(--line-2)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
        <div style={{ marginTop: 12, fontSize: 15, fontWeight: 600, color: "var(--fg-3)" }}>
          No links yet
        </div>
        <div style={{ marginTop: 4, fontSize: 13, color: "var(--line-3)", maxWidth: 240 }}>
          Mention this note elsewhere with{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>[[ ]]</span> and it'll show up here.
        </div>
      </div>
    </PanelHost>
  );
}

export const panelScreens: ScreenDef[] = [
  { id: "RP-01", label: "Backlinks (panel)", Component: Backlinks },
  { id: "RP-02", label: "Unlinked mentions", Component: Unlinked },
  { id: "RP-03", label: "Outline", Component: Outline },
  { id: "RP-04", label: "Panel host (all hidden)", Component: PanelEmpty },
];
