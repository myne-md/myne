// Terminal post-vault-creation screen — empty shell.
//
// Mounted by App.tsx when stage transitions to "editor" from
// <CreateVault>'s onComplete callback (which fires from <ReadyStep>'s
// "Done" button).
//
// T-shape layout (per design session 2026-04-28-empty-editor-shell.md
// Q2 = A): outer flex column with a row of three panes on top
// (260 left + flex center + 280 right) and a 28 px full-width status
// bar on the bottom.
//
// All copy is intentionally honest: no "Encrypted" / "synced" claims
// (there is no sync server, no per-note encryption pipeline yet);
// the account-number chip is a static MY-XXXX-… placeholder
// (the real account number is owned by <CreateVault>'s reducer and
// not threaded through to App-level — it becomes a vault-unlock
// concern when that feature lands). The "0 words" indicator is
// static; live counters are explicitly out of scope per the PRD.
//
// References:
//   - PRD: myne-agents/features/empty-editor-shell/prd.md
//   - Design session: myne-agents/sessions/design/2026-04-28-empty-editor-shell.md
//   - Mockup (structural reference only, NOT copied):
//     docs/design/ui_kits/desktop/Editor.jsx

import { useState, type CSSProperties } from "react";

const SECTION_HEADING_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontWeight: 600,
};

const STATUS_TEXT_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
};

export function Editor() {
  const [content, setContent] = useState("");

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--bg-1)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          flex: 1,
          minHeight: 0,
        }}
      >
        <LeftSidebar />
        <CenterPane content={content} onChange={setContent} />
        <RightSidebar />
      </div>
      <BottomBar />
    </div>
  );
}

function LeftSidebar() {
  return (
    <aside
      style={{
        width: 260,
        background: "var(--paper-2)",
        borderRight: "1px solid var(--line-1)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "14px 14px 12px",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--fg-2)",
          }}
        >
          MY-XXXX-XXXX-XXXX-XXXX-X
        </span>
      </div>

      <div
        style={{
          padding: "14px 14px 6px",
          ...SECTION_HEADING_STYLE,
        }}
      >
        Notes
      </div>
      <div
        style={{
          padding: "4px 14px 14px",
          fontSize: 13,
          color: "var(--fg-3)",
        }}
      >
        No notes yet.
      </div>
    </aside>
  );
}

interface CenterPaneProps {
  content: string;
  onChange: (next: string) => void;
}

function CenterPane({ content, onChange }: CenterPaneProps) {
  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          height: 38,
          padding: "0 16px",
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid var(--line-1)",
          fontSize: 12,
          color: "var(--fg-2)",
        }}
      >
        Untitled
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: "32px 64px",
        }}
      >
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <textarea
            value={content}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Start typing…"
            spellCheck={false}
            style={{
              width: "100%",
              minHeight: 360,
              border: 0,
              outline: 0,
              resize: "none",
              background: "transparent",
              color: "var(--fg-1)",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              lineHeight: 1.7,
            }}
          />
        </div>
      </div>
    </main>
  );
}

function RightSidebar() {
  return (
    <aside
      style={{
        width: 280,
        background: "var(--paper-2)",
        borderLeft: "1px solid var(--line-1)",
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={SECTION_HEADING_STYLE}>Backlinks</div>
      <div style={{ fontSize: 12, color: "var(--fg-3)" }}>Linked from 0</div>
      <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>
        No backlinks yet.
      </div>
    </aside>
  );
}

function BottomBar() {
  return (
    <div
      style={{
        height: 28,
        width: "100%",
        background: "var(--paper-2)",
        borderTop: "1px solid var(--line-1)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
      }}
    >
      <span style={STATUS_TEXT_STYLE}>Local-only · not synced</span>
      <div style={{ flex: 1 }} />
      <span
        style={{
          ...STATUS_TEXT_STYLE,
          fontFamily: "var(--font-mono)",
        }}
      >
        0 words
      </span>
    </div>
  );
}
