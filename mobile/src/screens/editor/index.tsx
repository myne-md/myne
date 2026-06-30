import type { CSSProperties, ReactNode } from "react";
import { Screen } from "../../components";
import type { ScreenDef } from "../../gallery/types";

/**
 * Editor surfaces (prefix ED) — overlays, popovers and toolbars that sit over
 * an editor canvas. UI-only: every control is inert. Light variant only; the
 * dark / amoled frames are produced automatically by the CSS token flip.
 */

// ── Shared bits ──────────────────────────────────────────────────────────────

/** Inline transparent caption-bar button. */
const ghostBtn = (color: string, weight: number): CSSProperties => ({
  border: "none",
  background: "transparent",
  color,
  fontSize: 15,
  fontWeight: weight,
  cursor: "pointer",
  padding: 0,
});

/** The Cancel · title · Done caption bar most editor frames carry. */
function CaptionBar({
  title,
  padding = "56px 16px 10px",
}: {
  title: ReactNode;
  padding?: string;
}) {
  return (
    <div
      style={{
        flex: "none",
        padding,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <button style={ghostBtn("var(--fg-3)", 500)}>Cancel</button>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)" }}>{title}</div>
      <button style={ghostBtn("var(--accent)", 600)}>Done</button>
    </div>
  );
}

/** Blinking-caret block (accent bar). */
function Caret({
  height = 16,
  valign = -2,
  marginLeft = 0,
}: {
  height?: number;
  valign?: number;
  marginLeft?: number;
}) {
  return (
    <span
      style={{
        width: 2,
        height,
        background: "var(--accent)",
        display: "inline-block",
        verticalAlign: valign,
        marginLeft,
      }}
    />
  );
}

/** The rounded keyboard-anchored menu card (slash / wikilink / tag). */
function MenuCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        flex: "none",
        margin: "0 8px 4px",
        border: "1px solid var(--line-1)",
        borderRadius: 12,
        overflow: "hidden",
        background: "var(--bg-1)",
        boxShadow: "0 6px 18px rgba(20,24,40,0.12)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** A single menu row; `first` drops the top divider, `active` paints accent-soft. */
function MenuRow({
  children,
  active = false,
  first = false,
  style,
}: {
  children: ReactNode;
  active?: boolean;
  first?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        padding: "11px 14px",
        display: "flex",
        alignItems: "center",
        gap: 12,
        background: active ? "var(--accent-soft)" : undefined,
        borderTop: first ? undefined : "1px solid var(--line-1)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Waveform bars: [x, y, w, h] rects with a 1.5 radius. */
function Bars({ bars, fill }: { bars: [number, number, number, number][]; fill: string }) {
  return (
    <>
      {bars.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} rx={1.5} fill={fill} />
      ))}
    </>
  );
}

// ED-01 · Slash menu ──────────────────────────────────────────────────────────
function SlashMenu() {
  return (
    <Screen>
      <CaptionBar title="Inbox" />
      <div
        style={{
          flex: 1,
          padding: "18px 22px",
          fontFamily: "var(--font-mono)",
          fontSize: 15,
          lineHeight: 1.75,
          color: "var(--fg-1)",
        }}
      >
        <div>Capture quick idea</div>
        <div style={{ height: 8 }} />
        <div>
          <span style={{ color: "var(--accent)" }}>/</span>
          <Caret />
        </div>
      </div>
      <MenuCard style={{ maxHeight: 230 }}>
        <MenuRow first active>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, color: "var(--accent)", width: 24 }}>
            H1
          </span>
          <span style={{ fontSize: 15, color: "var(--fg-1)" }}>Heading 1</span>
        </MenuRow>
        <MenuRow>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg-3)", width: 24 }}>"</span>
          <span style={{ fontSize: 15 }}>Quote</span>
        </MenuRow>
        <MenuRow>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <rect x="3" y="4" width="14" height="12" rx="2" stroke="var(--fg-3)" strokeWidth="1.5" />
            <path d="M6 8h8" stroke="var(--fg-3)" strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: 15 }}>Callout</span>
        </MenuRow>
        <MenuRow>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M4 7h12M4 10h12M4 13h7" stroke="var(--fg-3)" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="2.5" cy="7" r="1" fill="var(--fg-3)" />
            <circle cx="2.5" cy="10" r="1" fill="var(--fg-3)" />
          </svg>
          <span style={{ fontSize: 15 }}>Bullet list</span>
        </MenuRow>
        <MenuRow>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <rect x="3" y="3" width="14" height="14" rx="3" stroke="var(--fg-3)" strokeWidth="1.5" />
            <path d="M7 10l2 2 4-4.5" stroke="var(--fg-3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{ fontSize: 15 }}>To-do</span>
        </MenuRow>
      </MenuCard>
    </Screen>
  );
}

// ED-02 · Find & replace ──────────────────────────────────────────────────────
function FindReplace() {
  return (
    <Screen>
      <div
        style={{
          flex: "none",
          padding: "54px 12px 12px",
          borderBottom: "1px solid var(--line-1)",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <circle cx="9" cy="9" r="6.5" stroke="var(--fg-3)" strokeWidth="1.7" />
              <path d="M14 14l3.5 3.5" stroke="var(--fg-3)" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
            <span style={{ fontSize: 15, color: "var(--fg-1)" }}>relay</span>
          </div>
          <span style={{ fontSize: 13, color: "var(--fg-3)", whiteSpace: "nowrap" }}>2 of 4</span>
          <button style={{ width: 34, height: 34, border: "none", background: "transparent", cursor: "pointer" }}>
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path d="M3 9l4-4 4 4" stroke="var(--fg-2)" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button style={{ width: 34, height: 34, border: "none", background: "transparent", cursor: "pointer" }}>
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path d="M3 5l4 4 4-4" stroke="var(--fg-2)" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 40,
              background: "var(--bg-1)",
              border: "1px solid var(--line-2)",
              borderRadius: 8,
              padding: "0 12px",
            }}
          >
            <span style={{ fontSize: 15, color: "var(--fg-1)" }}>server</span>
          </div>
          <button
            style={{
              height: 40,
              padding: "0 14px",
              border: "1px solid var(--line-2)",
              borderRadius: 8,
              background: "transparent",
              color: "var(--fg-1)",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Replace
          </button>
          <button
            style={{
              height: 40,
              padding: "0 12px",
              border: "none",
              borderRadius: 8,
              background: "var(--accent)",
              color: "var(--accent-on)",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            All
          </button>
        </div>
      </div>
      <div style={{ flex: 1, padding: "18px 22px", fontSize: 16, lineHeight: 1.75, color: "var(--fg-1)" }}>
        Ciphertext is opaque to the{" "}
        <span style={{ background: "var(--accent)", color: "var(--accent-on)", borderRadius: 2, padding: "0 2px" }}>relay</span>. A
        malicious <span style={{ background: "var(--warning-soft)", borderRadius: 2, padding: "0 2px" }}>relay</span> only stores
        opaque blobs.
      </div>
    </Screen>
  );
}

// ED-03 · Wikilink picker ─────────────────────────────────────────────────────
function WikilinkPicker() {
  return (
    <Screen>
      <CaptionBar title="Threat model v2" />
      <div
        style={{
          flex: 1,
          padding: "18px 22px",
          fontFamily: "var(--font-mono)",
          fontSize: 15,
          lineHeight: 1.75,
          color: "var(--fg-1)",
        }}
      >
        <div>
          See <span style={{ color: "var(--fg-3)" }}>[[</span>
          <span style={{ color: "var(--accent)" }}>key</span>
          <Caret />
        </div>
      </div>
      <MenuCard>
        <MenuRow first active style={{ gap: 10 }}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <rect x="4" y="3" width="12" height="14" rx="2" stroke="var(--accent)" strokeWidth="1.5" />
            <path d="M7 7h6M7 10h6" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span style={{ flex: 1, fontSize: 15, color: "var(--fg-1)" }}>
            <span style={{ background: "var(--warning-soft)" }}>Key</span> rotation
          </span>
        </MenuRow>
        <MenuRow style={{ gap: 10 }}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M5 10h10M11 6l4 4-4 4" stroke="var(--fg-3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{ flex: 1, fontSize: 15 }}>Key handling ▸ heading</span>
        </MenuRow>
        <MenuRow style={{ gap: 10, color: "var(--accent)" }}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <path d="M10 4v12M4 10h12" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span style={{ flex: 1, fontSize: 15 }}>Create “key…”</span>
        </MenuRow>
      </MenuCard>
    </Screen>
  );
}

// ED-04 · Tag autocomplete ────────────────────────────────────────────────────
function TagAutocomplete() {
  return (
    <Screen>
      <CaptionBar title="Inbox" />
      <div
        style={{
          flex: 1,
          padding: "18px 22px",
          fontFamily: "var(--font-mono)",
          fontSize: 15,
          lineHeight: 1.75,
          color: "var(--fg-1)",
        }}
      >
        <div>
          Tagging this <span style={{ color: "var(--accent)" }}>#sec</span>
          <Caret />
        </div>
      </div>
      <MenuCard>
        <MenuRow first active style={{ gap: 8 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, color: "var(--accent)" }}>#security</span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--fg-3)" }}>14</span>
        </MenuRow>
        <MenuRow style={{ gap: 8 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, color: "var(--fg-2)" }}>#secrets</span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--line-3)" }}>3</span>
        </MenuRow>
        <MenuRow style={{ gap: 8 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, color: "var(--fg-2)" }}>#section</span>
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--line-3)" }}>1</span>
        </MenuRow>
      </MenuCard>
    </Screen>
  );
}

// ED-05 · Voice recording ─────────────────────────────────────────────────────
const PLAY_BARS_1: [number, number, number, number][] = [
  [0, 11, 3, 6],
  [6, 7, 3, 14],
  [12, 3, 3, 22],
  [18, 9, 3, 10],
  [24, 5, 3, 18],
  [30, 11, 3, 6],
];
const PLAY_BARS_2: [number, number, number, number][] = [
  [36, 8, 3, 12],
  [42, 12, 3, 4],
  [48, 6, 3, 16],
  [54, 10, 3, 8],
  [60, 4, 3, 20],
  [66, 9, 3, 10],
  [72, 11, 3, 6],
  [78, 7, 3, 14],
  [84, 10, 3, 8],
  [90, 5, 3, 18],
  [96, 11, 3, 6],
  [102, 8, 3, 12],
  [108, 12, 3, 4],
  [114, 9, 3, 10],
  [120, 6, 3, 16],
  [126, 11, 3, 6],
  [132, 10, 3, 8],
  [138, 8, 3, 12],
  [144, 11, 3, 6],
];
const REC_BARS: [number, number, number, number][] = [
  [0, 9, 3, 6],
  [6, 5, 3, 14],
  [12, 2, 3, 20],
  [18, 8, 3, 8],
  [24, 4, 3, 16],
  [30, 10, 3, 4],
  [36, 6, 3, 12],
  [42, 3, 3, 18],
];

function VoiceRecording() {
  return (
    <Screen>
      <CaptionBar title="Inbox" />
      <div style={{ flex: 1, padding: "18px 22px", fontSize: 16, lineHeight: 1.7, color: "var(--fg-1)" }}>
        <div style={{ marginBottom: 16 }}>Voice memo for the review:</div>
        <div
          style={{
            border: "1px solid var(--line-1)",
            borderRadius: 12,
            background: "var(--bg-1)",
            padding: 14,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <button
            style={{
              flex: "none",
              width: 40,
              height: 40,
              borderRadius: "50%",
              border: "none",
              background: "var(--accent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16">
              <path d="M5 3l8 5-8 5z" fill="var(--accent-on)" />
            </svg>
          </button>
          <svg width="150" height="28" viewBox="0 0 150 28">
            <Bars bars={PLAY_BARS_1} fill="var(--line-2)" />
            <Bars bars={PLAY_BARS_2} fill="var(--line-3)" />
          </svg>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-3)" }}>0:12 / 0:34</span>
        </div>
      </div>
      <div
        style={{
          flex: "none",
          padding: "14px 16px 30px",
          background: "var(--bg-2)",
          borderTop: "1px solid var(--line-1)",
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--danger)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, color: "var(--fg-1)" }}>0:12</span>
        <svg width="120" height="24" viewBox="0 0 120 24">
          <Bars bars={REC_BARS} fill="var(--danger)" />
        </svg>
        <div style={{ flex: 1 }} />
        <button
          style={{
            height: 38,
            padding: "0 16px",
            border: "none",
            borderRadius: 8,
            background: "var(--ink-1)",
            color: "var(--paper)",
            fontFamily: "var(--font-sans)",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Stop
        </button>
      </div>
    </Screen>
  );
}

// ED-06 · Attachment insert ───────────────────────────────────────────────────
function AttachmentInsert() {
  return (
    <Screen>
      <CaptionBar title="Threat model v2" />
      <div style={{ flex: 1, padding: "18px 22px", fontSize: 16, lineHeight: 1.7, color: "var(--fg-1)" }}>
        <div style={{ marginBottom: 14 }}>Architecture sketch:</div>
        <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
          <div
            style={{
              height: 150,
              background: "var(--bg-2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="4" width="18" height="16" rx="2" stroke="var(--line-2)" strokeWidth="1.5" />
              <circle cx="8.5" cy="9.5" r="1.8" stroke="var(--line-2)" strokeWidth="1.5" />
              <path d="M4 17l5-5 4 4 3-3 4 4" stroke="var(--line-2)" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <div
              style={{
                position: "absolute",
                left: 12,
                right: 12,
                bottom: 12,
                height: 5,
                borderRadius: 999,
                background: "var(--line-1)",
                overflow: "hidden",
              }}
            >
              <div style={{ width: "64%", height: "100%", background: "var(--accent)" }} />
            </div>
          </div>
          <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: "var(--fg-3)" }}>diagram.png · importing 64%</span>
          </div>
        </div>
        <div
          style={{
            marginTop: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            border: "1px solid var(--line-1)",
            borderRadius: 8,
            background: "var(--bg-1)",
          }}
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
            <path d="M4 3h8l4 4v10H4z" stroke="var(--fg-2)" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <span style={{ fontSize: 14 }}>spec.pdf</span>
          <span style={{ fontSize: 12, color: "var(--line-3)" }}>240 KB</span>
        </div>
      </div>
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 18,
          padding: "14px 16px 30px",
          background: "var(--bg-2)",
          borderTop: "1px solid var(--line-1)",
        }}
      >
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect x="3" y="4" width="16" height="13" rx="2" stroke="var(--fg-2)" strokeWidth="1.6" />
          <circle cx="8" cy="9" r="1.6" stroke="var(--fg-2)" strokeWidth="1.6" />
          <path d="M3 14l4-4 3 3 3-3 5 5" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path d="M5 3h8l4 4v12H5z" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path d="M11 4v9M7 9l4 4 4-4" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 17h12" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </div>
    </Screen>
  );
}

// ED-07 · Image lightbox ──────────────────────────────────────────────────────
function ImageLightbox() {
  return (
    <Screen>
      <div
        style={{
          flex: "none",
          padding: "54px 16px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--line-1)",
        }}
      >
        <button style={ghostBtn("var(--accent)", 500)}>Close</button>
        <span style={{ fontSize: 14, color: "var(--fg-3)" }}>diagram.png</span>
        <button style={ghostBtn("var(--accent)", 600)}>Export</button>
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 20px",
          background: "var(--bg-2)",
        }}
      >
        <div
          style={{
            width: "100%",
            aspectRatio: "4 / 3",
            borderRadius: 10,
            background: "var(--bg-1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--line-1)",
          }}
        >
          <svg width="60" height="60" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="4" width="18" height="16" rx="2" stroke="var(--line-2)" strokeWidth="1.3" />
            <circle cx="8.5" cy="9.5" r="1.8" stroke="var(--line-2)" strokeWidth="1.3" />
            <path d="M4 17l5-5 4 4 3-3 4 4" stroke="var(--line-2)" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
      <div
        style={{
          flex: "none",
          padding: "18px 0 40px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          background: "var(--bg-2)",
        }}
      >
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <circle cx="10" cy="10" r="6.5" stroke="var(--fg-3)" strokeWidth="1.6" />
          <path d="M15 15l4 4M8 10h4M10 8v4" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span style={{ fontSize: 13, color: "var(--fg-3)" }}>pinch to zoom</span>
      </div>
    </Screen>
  );
}

// ED-08 · Spell correction ────────────────────────────────────────────────────
function SpellCorrection() {
  return (
    <Screen>
      <CaptionBar title="Inbox" />
      <div style={{ flex: 1, padding: "18px 22px", fontSize: 16, lineHeight: 1.8, color: "var(--fg-1)" }}>
        The relay stores <span style={{ borderBottom: "2px dotted var(--danger)" }}>cyphertext</span> only.
      </div>
      <div
        style={{
          position: "absolute",
          left: 18,
          bottom: 120,
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 8px 24px rgba(20,24,40,0.16)",
          minWidth: 200,
        }}
      >
        <div style={{ padding: "11px 14px", fontSize: 15, fontWeight: 600, color: "var(--accent)" }}>ciphertext</div>
        <div style={{ padding: "11px 14px", fontSize: 15, borderTop: "1px solid var(--line-1)" }}>cipher text</div>
        <div style={{ padding: "11px 14px", fontSize: 14, color: "var(--fg-2)", borderTop: "1px solid var(--line-1)" }}>
          Add to dictionary
        </div>
        <div style={{ padding: "11px 14px", fontSize: 14, color: "var(--fg-2)", borderTop: "1px solid var(--line-1)" }}>
          Ignore in this vault
        </div>
      </div>
    </Screen>
  );
}

// ED-09 · Decoration popover ──────────────────────────────────────────────────
const SWATCHES: { color: string; selected?: boolean }[] = [
  { color: "var(--label-clay)" },
  { color: "var(--label-ochre)" },
  { color: "var(--label-moss)" },
  { color: "var(--label-slate)", selected: true },
  { color: "var(--label-plum)" },
  { color: "var(--label-stone)" },
];

function PopoverLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--fg-3)",
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function DecorationPopover() {
  return (
    <Screen>
      <CaptionBar title="Folder" />
      <div style={{ flex: 1, padding: "18px 22px", fontSize: 16, color: "var(--fg-1)" }}>
        Choose a colour and icon for <span style={{ fontWeight: 600 }}>Reading</span>.
      </div>
      <div
        style={{
          position: "absolute",
          left: 18,
          right: 18,
          bottom: 40,
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: 14,
          padding: 16,
          boxShadow: "0 8px 24px rgba(20,24,40,0.16)",
        }}
      >
        <PopoverLabel>Label colour</PopoverLabel>
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          {SWATCHES.map((s, i) => (
            <span
              key={i}
              style={{
                width: 30,
                height: 30,
                borderRadius: "50%",
                background: s.color,
                outline: s.selected ? `2px solid ${s.color}` : undefined,
                outlineOffset: s.selected ? 2 : undefined,
              }}
            />
          ))}
        </div>
        <PopoverLabel>Icon</PopoverLabel>
        <div style={{ display: "flex", gap: 14 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M5 4h11l3 3v13H5z" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="4" width="16" height="16" rx="2" stroke="var(--accent)" strokeWidth="1.6" />
            <path d="M8 9h8M8 13h5" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 4l2.4 5 5.6.6-4 3.9 1 5.5-5-2.8-5 2.8 1-5.5-4-3.9 5.6-.6z"
              stroke="var(--fg-2)"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="8" stroke="var(--fg-2)" strokeWidth="1.6" />
          </svg>
        </div>
      </div>
    </Screen>
  );
}

// ED-10 · View-mode switch ────────────────────────────────────────────────────
function ViewModeSwitch() {
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
            padding: 0,
          }}
        >
          <svg width="9" height="16" viewBox="0 0 9 16">
            <path d="M7 1L1 8l6 7" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Notes
        </button>
        <button style={ghostBtn("var(--accent)", 600)}>Edit</button>
      </div>
      <div style={{ flex: "none", padding: "14px 16px" }}>
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
            Live
          </div>
          <div style={{ flex: 1, textAlign: "center", padding: "8px 0", borderRadius: 6, fontSize: 13, color: "var(--fg-2)" }}>
            Reading
          </div>
          <div style={{ flex: 1, textAlign: "center", padding: "8px 0", borderRadius: 6, fontSize: 13, color: "var(--fg-2)" }}>
            Source
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "6px 24px 30px" }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
          Threat model v2
        </h1>
        <h2 style={{ margin: "22px 0 0", fontSize: 19, fontWeight: 600 }}>Adversaries</h2>
        <p style={{ margin: "10px 0 0", fontSize: 16, lineHeight: 1.65 }}>
          We assume a powerful network adversary that can{" "}
          <span style={{ background: "var(--warning-soft)", borderRadius: 2, padding: "0 2px" }}>observe all traffic</span> and
          compromise the relay.
        </p>
        <p style={{ margin: "12px 0 0", fontSize: 16, lineHeight: 1.65 }}>
          See{" "}
          <span style={{ color: "var(--accent)", borderBottom: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)" }}>
            [[Key rotation]]
          </span>{" "}
          for re-pair.
        </p>
      </div>
    </Screen>
  );
}

// ED-11 · Focus mode ──────────────────────────────────────────────────────────
function FocusMode() {
  return (
    <Screen>
      <div
        style={{
          flex: 1,
          padding: "80px 26px 0",
          fontFamily: "var(--font-mono)",
          fontSize: 16,
          lineHeight: 1.85,
        }}
      >
        <div style={{ color: "var(--line-2)" }}>## Adversaries</div>
        <div style={{ color: "var(--line-2)", marginTop: 8 }}>We assume a powerful network adversary.</div>
        <div style={{ color: "var(--fg-1)", marginTop: 8 }}>
          The vault key is derived from the passphrase and never leaves the device.
          <Caret height={18} valign={-3} marginLeft={1} />
        </div>
        <div style={{ color: "var(--line-2)", marginTop: 8 }}>Ciphertext is opaque to the relay.</div>
      </div>
      <div style={{ flex: "none", paddingBottom: 8, display: "flex", justifyContent: "center" }}>
        <span style={{ fontSize: 12, color: "var(--line-3)" }}>Tap anywhere to exit focus</span>
      </div>
    </Screen>
  );
}

export const editorScreens: ScreenDef[] = [
  { id: "ED-01", label: "Slash menu", Component: SlashMenu, keyboard: true },
  { id: "ED-02", label: "Find & replace", Component: FindReplace, keyboard: true },
  { id: "ED-03", label: "Wikilink picker", Component: WikilinkPicker, keyboard: true },
  { id: "ED-04", label: "Tag autocomplete", Component: TagAutocomplete, keyboard: true },
  { id: "ED-05", label: "Voice recording", Component: VoiceRecording },
  { id: "ED-06", label: "Attachment insert", Component: AttachmentInsert },
  { id: "ED-07", label: "Image lightbox", Component: ImageLightbox },
  { id: "ED-08", label: "Spell correction", Component: SpellCorrection },
  { id: "ED-09", label: "Decoration popover", Component: DecorationPopover },
  { id: "ED-10", label: "View-mode switch", Component: ViewModeSwitch },
  { id: "ED-11", label: "Focus mode", Component: FocusMode, keyboard: true },
];
