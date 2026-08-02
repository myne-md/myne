import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import type { ScreenDef } from "../gallery/types";

/**
 * iPad editor overlays (light) — surfaces that layer over the three-pane
 * workspace backdrop: ED-01 slash menu, ED-03 wikilink picker, ED-10 note
 * context menu, and ED-08 the full-bleed image/PDF lightbox. Built with tokens
 * (per WS-01 in ./index.tsx), so light / dark / amoled follow from CSS. The
 * lightbox is a deliberately theme-independent dark immersive viewer, so its
 * chrome uses fixed rgb/rgba tones rather than the paper/ink ramp.
 */

/** Blinking-caret marker sitting in the editor text (1.5×19px accent bar). */
function Caret() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 1.5,
        height: 19,
        background: "var(--accent)",
        verticalAlign: -3,
      }}
    />
  );
}

/** Breadcrumb in the detail-pane header. */
function Crumb({ children }: { children: ReactNode }) {
  return <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-3)" }}>{children}</div>;
}

/** A row inside the ED-10 note context menu. */
function MenuItem({
  icon,
  label,
  shortcut,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 6,
        color: danger ? "var(--danger)" : "var(--fg-1)",
      }}
    >
      {icon}
      <span style={{ fontSize: 14, flex: 1 }}>{label}</span>
      {shortcut && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: danger ? "color-mix(in srgb, var(--danger) 55%, var(--bg-1))" : "var(--line-3)",
          }}
        >
          {shortcut}
        </span>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   ED-01 · Slash menu
   ──────────────────────────────────────────────────────────────────────── */
function SlashMenu() {
  return (
    <div style={{ height: "100%", display: "flex", background: "var(--bg-1)", color: "var(--fg-1)" }}>
      <div style={{ width: 60, flex: "none", background: "var(--bg-2)", borderInlineEnd: "1px solid var(--line-1)" }} />
      <div style={{ width: 280, flex: "none", background: "var(--bg-1)", borderInlineEnd: "1px solid var(--line-1)" }} />
      <div style={{ flex: 1, position: "relative", background: "var(--bg-1)", minWidth: 0 }}>
        <div
          style={{
            height: 52,
            borderBottom: "1px solid var(--line-1)",
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
          }}
        >
          <Crumb>Specs / Threat model v2</Crumb>
        </div>
        <div style={{ padding: "34px 56px", fontSize: 16, lineHeight: 1.8 }}>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
            Threat model v2
          </div>
          <div style={{ marginTop: 20 }}>We assume a powerful network adversary.</div>
          <div style={{ marginTop: 8, color: "var(--accent)" }}>
            /<Caret />
          </div>
        </div>

        {/* slash popover */}
        <div
          style={{
            position: "absolute",
            insetInlineStart: 56,
            top: 200,
            width: 300,
            background: "var(--bg-1)",
            border: "1px solid var(--line-1)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(20,16,10,0.16)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              borderBottom: "1px solid var(--line-1)",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--fg-3)",
            }}
          >
            Insert
          </div>
          <div style={{ padding: 4 }}>
            {/* Heading 1 — active */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "9px 10px",
                borderRadius: 6,
                background: "var(--accent-soft)",
                color: "var(--accent)",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 600, width: 22 }}>H1</span>
              <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Heading 1</span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "color-mix(in srgb, var(--accent) 55%, var(--bg-1))",
                }}
              >
                #
              </span>
            </div>
            {/* Quote */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 10px", borderRadius: 6, color: "var(--fg-1)" }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, width: 22, color: "var(--fg-3)" }}>&quot;</span>
              <span style={{ fontSize: 14, flex: 1 }}>Quote</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>&gt;</span>
            </div>
            {/* Table */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 10px", borderRadius: 6, color: "var(--fg-1)" }}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <rect x="3" y="4" width="14" height="12" rx="2" stroke="var(--fg-3)" strokeWidth="1.6" />
                <path d="M3 9h14M9 9v7" stroke="var(--fg-3)" strokeWidth="1.6" />
              </svg>
              <span style={{ fontSize: 14, flex: 1 }}>Table</span>
            </div>
            {/* Bulleted list */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 10px", borderRadius: 6, color: "var(--fg-1)" }}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <path d="M3 6h14M3 10h14M3 14h9" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 14, flex: 1 }}>Bulleted list</span>
            </div>
            {/* To-do */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 10px", borderRadius: 6, color: "var(--fg-1)" }}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <rect x="3" y="3" width="14" height="14" rx="3" stroke="var(--fg-3)" strokeWidth="1.6" />
                <path d="M7 10l2 2 4-4" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span style={{ fontSize: 14, flex: 1 }}>To-do</span>
            </div>
            {/* Wiki link */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 10px", borderRadius: 6, color: "var(--fg-1)" }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--accent)", width: 22 }}>
                [[
              </span>
              <span style={{ fontSize: 14, flex: 1 }}>Wiki link</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   ED-03 · Wikilink picker
   ──────────────────────────────────────────────────────────────────────── */
function WikilinkPicker() {
  return (
    <div style={{ height: "100%", display: "flex", background: "var(--bg-1)", color: "var(--fg-1)" }}>
      <div style={{ width: 60, flex: "none", background: "var(--bg-2)", borderInlineEnd: "1px solid var(--line-1)" }} />
      <div style={{ width: 280, flex: "none", background: "var(--bg-1)", borderInlineEnd: "1px solid var(--line-1)" }} />
      <div style={{ flex: 1, position: "relative", background: "var(--bg-1)", minWidth: 0 }}>
        <div
          style={{
            height: 52,
            borderBottom: "1px solid var(--line-1)",
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
          }}
        >
          <Crumb>Specs / Threat model v2</Crumb>
        </div>
        <div style={{ padding: "34px 56px", fontSize: 16, lineHeight: 1.8 }}>
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--fg-display)" }}>
            Threat model v2
          </div>
          <div style={{ marginTop: 20 }}>
            See <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>[[</span>key
            <Caret /> for re-pair.
          </div>
        </div>

        {/* wikilink popover */}
        <div
          style={{
            position: "absolute",
            insetInlineStart: 96,
            top: 150,
            width: 320,
            background: "var(--bg-1)",
            border: "1px solid var(--line-1)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(20,16,10,0.16)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--line-1)", fontSize: 13, color: "var(--fg-3)" }}>
            Link to <span style={{ fontFamily: "var(--font-mono)", color: "var(--accent)" }}>key</span>
          </div>
          <div style={{ padding: 4 }}>
            {/* Key rotation — active */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 10px",
                borderRadius: 6,
                background: "var(--accent-soft)",
                color: "var(--accent)",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <rect x="4" y="3" width="12" height="14" rx="2" stroke="var(--accent)" strokeWidth="1.6" />
                <path d="M7 7h6M7 10h6M7 13h3" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Key rotation</span>
            </div>
            {/* Key derivation */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 6, color: "var(--fg-1)" }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--line-3)", width: 16 }}>#</span>
              <span style={{ fontSize: 14, flex: 1 }}>Key derivation</span>
              <span style={{ fontSize: 12, color: "var(--line-3)" }}>in Account</span>
            </div>
            {/* Keyboard shortcuts */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 6, color: "var(--fg-1)" }}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <rect x="4" y="3" width="12" height="14" rx="2" stroke="var(--fg-3)" strokeWidth="1.6" />
                <path d="M7 7h6M7 10h6" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 14, flex: 1 }}>Keyboard shortcuts</span>
            </div>
            {/* Create "key" */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 10px",
                borderRadius: 6,
                color: "var(--accent)",
                borderTop: "1px solid var(--line-1)",
                marginTop: 2,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <path d="M10 4v12M4 10h12" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>Create &ldquo;key&rdquo;</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   ED-10 · Note context menu
   ──────────────────────────────────────────────────────────────────────── */
function NoteContextMenu() {
  return (
    <div style={{ height: "100%", display: "flex", background: "var(--bg-1)", color: "var(--fg-1)" }}>
      <div style={{ width: 60, flex: "none", background: "var(--bg-2)", borderInlineEnd: "1px solid var(--line-1)" }} />
      <div style={{ width: 316, flex: "none", position: "relative", background: "var(--bg-1)", borderInlineEnd: "1px solid var(--line-1)" }}>
        <div style={{ padding: "18px 18px 12px" }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>All notes</h1>
        </div>
        <div style={{ padding: "0 12px" }}>
          <div style={{ padding: "13px 12px", borderRadius: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Weekly review — 06-15</div>
            <div style={{ marginTop: 3, fontSize: 13, color: "var(--fg-3)" }}>Shipped the sync conflict resolver…</div>
          </div>
          <div style={{ padding: "13px 12px", borderRadius: 8, border: "1px solid var(--accent)", background: "var(--accent-soft)" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Project Aurora — kickoff</div>
            <div style={{ marginTop: 3, fontSize: 13, color: "var(--fg-3)" }}>Scope, owners, and the first three milestones…</div>
          </div>
        </div>

        {/* context menu */}
        <div
          style={{
            position: "absolute",
            insetInlineStart: 120,
            top: 150,
            width: 236,
            background: "var(--bg-1)",
            border: "1px solid var(--line-1)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(20,16,10,0.18)",
            overflow: "hidden",
            padding: 4,
          }}
        >
          <MenuItem
            label="Open"
            icon={
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                <path d="M4 4h12v12H4z" stroke="var(--fg-3)" strokeWidth="1.5" />
              </svg>
            }
          />
          <MenuItem
            label="Open in new window"
            shortcut="⌘⏎"
            icon={
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                <path
                  d="M8 4H5a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-3M11 9l5-5M12 4h4v4"
                  stroke="var(--fg-3)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
          />
          <MenuItem
            label="Pin"
            shortcut="⌘P"
            icon={
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                <path d="M10 3v9M6 8l4 4 4-4" stroke="var(--fg-3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5 16h10" stroke="var(--fg-3)" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            }
          />
          <MenuItem
            label="Move to…"
            icon={
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                <path d="M3 7a2 2 0 012-2h3l2 2h4a2 2 0 012 2v4a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="var(--fg-3)" strokeWidth="1.5" />
              </svg>
            }
          />
          <MenuItem
            label="Snapshots"
            icon={
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                <path d="M4 14V6a2 2 0 012-2h8a2 2 0 012 2v8M3 14h14v2H3z" stroke="var(--fg-3)" strokeWidth="1.5" />
              </svg>
            }
          />
          <div style={{ height: 1, background: "var(--line-1)", margin: "4px 0" }} />
          <MenuItem
            danger
            label="Delete"
            shortcut="⌫"
            icon={
              <svg width="15" height="15" viewBox="0 0 20 20" fill="none">
                <path d="M5 6h10l-1 11H6L5 6z" stroke="var(--danger)" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M8 6V4h4v2" stroke="var(--danger)" strokeWidth="1.5" />
              </svg>
            }
          />
        </div>
      </div>
      <div style={{ flex: 1, background: "var(--bg-1)" }} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   ED-08 · Image / PDF lightbox — a theme-independent dark immersive viewer.
   Chrome tones are fixed rgb/rgba (a lightbox stays dark in every theme); the
   media card + diagram use the paper/ink ramp so they adapt with the canvas.
   ──────────────────────────────────────────────────────────────────────── */
function Lightbox() {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "rgb(12, 12, 11)",
        color: "rgb(247, 246, 238)",
      }}
    >
      {/* top bar */}
      <div
        style={{
          height: 54,
          flex: "none",
          display: "flex",
          alignItems: "center",
          padding: "0 20px",
          gap: 14,
          background: "rgba(12,12,11,0.6)",
        }}
      >
        <span style={{ color: "rgb(247, 246, 238)", fontSize: 14, fontWeight: 500 }}>architecture-diagram.png</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "rgb(141, 140, 133)" }}>1640 × 924 · 248 KB</span>
        <div style={{ flex: 1 }} />
        <Icon name="download" size={20} color="rgb(232, 231, 223)" strokeWidth={1.7} />
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 6,
            background: "rgba(255,255,255,0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="x" size={16} color="rgb(232, 231, 223)" strokeWidth={1.7} />
        </div>
      </div>

      {/* canvas */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 30 }}>
        <div
          style={{
            width: 560,
            height: 380,
            borderRadius: 8,
            background: "var(--bg-2)",
            border: "1px solid rgba(0,0,0,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <svg width="100%" height="100%" viewBox="0 0 560 380">
            <rect width="560" height="380" fill="var(--bg-2)" />
            <rect x="60" y="70" width="130" height="70" rx="6" fill="none" stroke="var(--label-slate)" strokeWidth="2" />
            <rect x="370" y="70" width="130" height="70" rx="6" fill="none" stroke="var(--label-slate)" strokeWidth="2" />
            <rect x="215" y="230" width="130" height="70" rx="6" fill="none" stroke="var(--label-clay)" strokeWidth="2" />
            <path d="M125 140 L280 230 M435 140 L280 230" stroke="var(--line-3)" strokeWidth="2" />
            <text x="125" y="110" textAnchor="middle" fontSize="13" fill="var(--fg-2)">
              Device A
            </text>
            <text x="435" y="110" textAnchor="middle" fontSize="13" fill="var(--fg-2)">
              Device B
            </text>
            <text x="280" y="270" textAnchor="middle" fontSize="13" fill="var(--fg-2)">
              Relay (blind)
            </text>
          </svg>
        </div>
      </div>

      {/* zoom bar */}
      <div style={{ height: 56, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", gap: 18 }}>
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
          <path d="M6 10h8" stroke="rgb(232, 231, 223)" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "rgb(194, 193, 185)" }}>100%</span>
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
          <path d="M10 6v8M6 10h8" stroke="rgb(232, 231, 223)" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}

export const ipadEditorScreens: ScreenDef[] = [
  { id: "ED-01", label: "Slash menu", Component: SlashMenu, platforms: ["ipad"], orientation: "landscape" },
  { id: "ED-03", label: "Wikilink picker", Component: WikilinkPicker, platforms: ["ipad"], orientation: "landscape" },
  { id: "ED-10", label: "Note context menu", Component: NoteContextMenu, platforms: ["ipad"], orientation: "landscape" },
  { id: "ED-08", label: "Image / PDF lightbox", Component: Lightbox, platforms: ["ipad"], orientation: "landscape" },
];
