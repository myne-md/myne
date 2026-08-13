import type { ReactNode } from "react";
import { Screen, Sheet, Banner, Button } from "../../components";
import type { ScreenDef } from "../../gallery/types";

/**
 * Share & export (SX) — note-level action sheet, export-format chooser, the
 * PDF-flattening notice, and the system share sheet. UI-only: every sheet is
 * presentational; buttons are inert. Light variant only — dark/amoled flip via
 * tokens.
 */

// Small uppercase field label (matches the design's 12px / 0.06em caps).
function SheetLabel({ children }: { children: ReactNode }) {
  return (
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
      {children}
    </div>
  );
}

// 20px sheet heading.
function SheetTitle({ children }: { children: ReactNode }) {
  return (
    <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: "var(--fg-1)" }}>{children}</h2>
  );
}

// Two-button sheet footer (Cancel + confirming action), 50px tall.
function SheetActions({ confirm }: { confirm: string }) {
  return (
    <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
      <Button variant="secondary" full={false} style={{ flex: 1, height: 50 }}>
        Cancel
      </Button>
      <Button full={false} style={{ flex: 1, height: 50, fontSize: 15 }}>
        {confirm}
      </Button>
    </div>
  );
}

// Faint note title peeking behind a sheet's scrim.
function GhostNote({ title }: { title: string }) {
  return (
    <div style={{ flex: 1, opacity: 0.4, padding: "56px 22px 0" }}>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: "var(--fg-display)" }}>{title}</h1>
    </div>
  );
}

// SX-01 · Note actions (…) ────────────────────────────────────────────────────
const NOTE_ACTIONS: { label: string; glyph: ReactNode }[] = [
  { label: "Edit", glyph: <path d="M3 15l9-9 2 2-9 9H3z" /> },
  {
    label: "Share / export",
    glyph: (
      <>
        <circle cx={6} cy={10} r={2} />
        <circle cx={14} cy={5} r={2} />
        <circle cx={14} cy={15} r={2} />
        <path d="M8 9l4-2.5M8 11l4 2.5" />
      </>
    ),
  },
  {
    label: "Snapshots",
    glyph: (
      <>
        <path d="M10 3v7M7 7l3 3 3-3" />
        <circle cx={10} cy={10} r={7.5} />
      </>
    ),
  },
  { label: "Move", glyph: <path d="M3 6h6l2 2h6v8H3z" /> },
  {
    label: "Archive",
    glyph: (
      <>
        <path d="M4 7h12v9H4z" />
        <path d="M3 4h14v3H3z" />
      </>
    ),
  },
  {
    label: "Copy link",
    glyph: (
      <>
        <path d="M5 7h2l3 3 3-3h2" />
        <rect x={3} y={4} width={14} height={12} rx={2} />
      </>
    ),
  },
];

function NoteActions() {
  return (
    <Screen>
      <GhostNote title="Threat model v2" />
      <Sheet style={{ padding: "10px 12px 34px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {NOTE_ACTIONS.map((a) => (
            <div
              key={a.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "13px 12px",
                border: "1px solid var(--line-1)",
                borderRadius: 10,
              }}
            >
              <svg
                width={19}
                height={19}
                viewBox="0 0 20 20"
                fill="none"
                stroke="var(--fg-2)"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {a.glyph}
              </svg>
              <span style={{ fontSize: 15, color: "var(--fg-1)" }}>{a.label}</span>
            </div>
          ))}
        </div>
        <button
          style={{
            marginTop: 10,
            width: "100%",
            height: 48,
            border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
            borderRadius: 10,
            background: "var(--danger-soft)",
            color: "var(--danger)",
            fontFamily: "var(--font-sans)",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Delete note
        </button>
      </Sheet>
    </Screen>
  );
}

// SX-02 · Export note ─────────────────────────────────────────────────────────
function ExportNote() {
  const formats = ["Markdown", "PDF", "HTML", "txt"];
  return (
    <Screen>
      <Sheet style={{ padding: "10px 20px 34px" }}>
        <SheetTitle>Export note</SheetTitle>
        <SheetLabel>Format</SheetLabel>
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
          {formats.map((o, i) => (
            <div
              key={o}
              style={{
                flex: 1,
                textAlign: "center",
                padding: "8px 0",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: i === 0 ? 600 : 400,
                background: i === 0 ? "var(--bg-1)" : "transparent",
                border: i === 0 ? "1px solid var(--line-1)" : "1px solid transparent",
                color: i === 0 ? "var(--fg-1)" : "var(--fg-2)",
              }}
            >
              {o}
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 14px",
            border: "1px solid var(--line-1)",
            borderRadius: 10,
          }}
        >
          <span style={{ fontSize: 15, color: "var(--fg-1)" }}>Include 2 attachments</span>
          <div
            style={{
              width: 48,
              height: 28,
              borderRadius: 999,
              background: "var(--accent)",
              position: "relative",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 3,
                insetInlineEnd: 3,
                width: 22,
                height: 22,
                borderRadius: "50%",
                background: "var(--accent-on)",
              }}
            />
          </div>
        </div>
        <SheetActions confirm="Export" />
      </Sheet>
    </Screen>
  );
}

// SX-03 · PDF export notice ───────────────────────────────────────────────────
function PdfExportNotice() {
  return (
    <Screen>
      <Sheet style={{ padding: "10px 20px 34px" }}>
        <SheetTitle>Export as PDF</SheetTitle>
        <Banner
          kind="warning"
          icon={false}
          style={{
            marginTop: 12,
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)",
            lineHeight: 1.55,
          }}
        >
          A PDF is a flat copy. Audio and file attachments won't be embedded — only images and text
          are included.
        </Banner>
        <SheetActions confirm="Continue" />
      </Sheet>
    </Screen>
  );
}

// SX-04 · Share to system ─────────────────────────────────────────────────────
const SHARE_TARGETS: { label: string; bg: string; stroke: string; glyph: ReactNode }[] = [
  {
    label: "Files",
    bg: "var(--accent-soft)",
    stroke: "var(--accent)",
    glyph: <path d="M6 12h12M12 6v12" strokeWidth={1.8} strokeLinecap="round" />,
  },
  {
    label: "Notes",
    bg: "var(--success-soft)",
    stroke: "var(--success)",
    glyph: <path d="M5 5h14v14H5z" strokeWidth={1.6} />,
  },
  {
    label: "Mail",
    bg: "var(--warning-soft)",
    stroke: "var(--label-clay)",
    glyph: <path d="M5 12a7 7 0 0 1 14 0v3H5z" strokeWidth={1.6} />,
  },
  {
    label: "More",
    bg: "color-mix(in srgb, var(--label-plum) 14%, transparent)",
    stroke: "var(--label-plum)",
    glyph: <circle cx={12} cy={12} r={7} strokeWidth={1.6} />,
  },
];

function ShareToSystem() {
  return (
    <Screen>
      <Sheet style={{ padding: "10px 16px 34px" }}>
        <Banner
          kind="warning"
          icon={false}
          style={{
            marginBottom: 14,
            padding: "11px 13px",
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--warning) 35%, transparent)",
          }}
        >
          Sharing exports a plain, unencrypted copy out of Myne. Only share with apps you trust.
        </Banner>
        <div style={{ display: "flex", gap: 16, overflow: "hidden", padding: "4px 4px 10px" }}>
          {SHARE_TARGETS.map((t) => (
            <div
              key={t.label}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}
            >
              <div
                style={{
                  width: 54,
                  height: 54,
                  borderRadius: 14,
                  background: t.bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={t.stroke}>
                  {t.glyph}
                </svg>
              </div>
              <span style={{ fontSize: 11, color: "var(--fg-2)" }}>{t.label}</span>
            </div>
          ))}
        </div>
        <button
          style={{
            marginTop: 8,
            width: "100%",
            height: 50,
            border: "1px solid var(--line-2)",
            borderRadius: 10,
            background: "var(--bg-1)",
            color: "var(--fg-1)",
            fontFamily: "var(--font-sans)",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </Sheet>
    </Screen>
  );
}

export const shareScreens: ScreenDef[] = [
  { id: "SX-01", label: "Note actions (…)", Component: NoteActions },
  { id: "SX-02", label: "Export note", Component: ExportNote },
  { id: "SX-03", label: "PDF export notice", Component: PdfExportNotice },
  { id: "SX-04", label: "Share to system", Component: ShareToSystem },
];
