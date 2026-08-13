import type { ReactNode } from "react";
import type { ScreenDef } from "../gallery/types";

/**
 * iPad command + search surfaces (SC-01 / SC-02 / SC-04). Light variant only —
 * dark / amoled fall out of the CSS tokens for free. Each screen reproduces the
 * full 1194×834 landscape board: SC-01 and SC-04 layer a scrim + centered card
 * over a dimmed three-pane backdrop; SC-02 is the full-width results pane.
 * Geometry copied verbatim from the design board.
 */

/** The offset magnifier glyph the board draws for search affordances. */
function SearchGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <circle cx="9" cy="9" r="6.5" stroke="var(--fg-3)" strokeWidth="1.7" />
      <path d="M14 14l3.5 3.5" stroke="var(--fg-3)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** Highlighted query-match run. */
function HL({ children }: { children: ReactNode }) {
  return <span style={{ background: "var(--highlight)", borderRadius: 2 }}>{children}</span>;
}

function PaletteGroup({ children, top = false }: { children: ReactNode; top?: boolean }) {
  return (
    <div
      style={{
        padding: "5px 10px",
        marginTop: top ? 4 : 0,
        fontSize: 11,
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

/* ── SC-01 · Command palette ─────────────────────────────────────────────── */

function CommandPalette() {
  return (
    <div style={{ height: "100%", position: "relative", background: "var(--bg-1)", color: "var(--fg-1)" }}>
      {/* dimmed three-pane backdrop */}
      <div style={{ height: "100%", display: "flex", filter: "brightness(0.96)" }}>
        <div style={{ width: 60, background: "var(--bg-2)", borderInlineEnd: "1px solid var(--line-1)" }} />
        <div style={{ width: 300, background: "var(--bg-1)", borderInlineEnd: "1px solid var(--line-1)" }} />
        <div style={{ flex: 1, background: "var(--bg-1)" }} />
      </div>

      {/* scrim + centered palette card */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(20,16,10,0.18)",
          display: "flex",
          justifyContent: "center",
          paddingTop: 120,
        }}
      >
        <div
          style={{
            width: 600,
            height: "max-content",
            background: "var(--bg-1)",
            border: "1px solid var(--line-1)",
            borderRadius: 12,
            boxShadow: "0 24px 60px rgba(20,16,10,0.28)",
            overflow: "hidden",
          }}
        >
          {/* query row */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "16px 18px",
              borderBottom: "1px solid var(--line-1)",
            }}
          >
            <SearchGlyph size={20} />
            <span style={{ fontSize: 18, color: "var(--fg-1)" }}>thr</span>
            <span style={{ width: 2, height: 20, background: "var(--accent)" }} />
            <div style={{ flex: 1 }} />
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--line-3)",
                border: "1px solid var(--line-1)",
                borderRadius: 4,
                padding: "2px 6px",
              }}
            >
              esc
            </span>
          </div>

          {/* results */}
          <div style={{ padding: 8 }}>
            <PaletteGroup>Notes</PaletteGroup>

            {/* active: note match */}
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
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <rect x="4" y="3" width="12" height="14" rx="2" stroke="var(--accent)" strokeWidth="1.6" />
                <path d="M7 7h6M7 10h6" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>
                <HL>Thr</HL>eat model v2
              </span>
            </div>

            {/* heading match */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "9px 10px",
                borderRadius: 6,
                color: "var(--fg-1)",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--line-3)", width: 16 }}>#</span>
              <span style={{ fontSize: 15, flex: 1 }}>Adversaries</span>
              <span style={{ fontSize: 12, color: "var(--line-3)" }}>Threat model v2</span>
            </div>

            <PaletteGroup top>Commands</PaletteGroup>

            {/* command: new note */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "9px 10px",
                borderRadius: 6,
                color: "var(--fg-1)",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <path d="M10 4v12M4 10h12" stroke="var(--fg-3)" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <span style={{ fontSize: 15, flex: 1 }}>New note</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>⌘N</span>
            </div>

            {/* command: toggle theme */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                padding: "9px 10px",
                borderRadius: 6,
                color: "var(--fg-1)",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                <circle cx="10" cy="10" r="6.5" stroke="var(--fg-3)" strokeWidth="1.6" />
                <path d="M10 3.5v13" stroke="var(--fg-3)" strokeWidth="1.6" />
              </svg>
              <span style={{ fontSize: 15, flex: 1 }}>Toggle theme</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── SC-02 · Search results ──────────────────────────────────────────────── */

function ResultCard({
  dotColor,
  title,
  snippet,
  meta,
  last = false,
}: {
  dotColor?: string;
  title: ReactNode;
  snippet: ReactNode;
  meta: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        padding: 16,
        border: "1px solid var(--line-1)",
        borderRadius: 8,
        marginBottom: last ? 0 : 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {dotColor && <span style={{ width: 8, height: 8, borderRadius: 2, background: dotColor }} />}
        <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
      </div>
      <div style={{ marginTop: 6, fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>{snippet}</div>
      <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--line-3)" }}>{meta}</div>
    </div>
  );
}

function SearchResults() {
  return (
    <div style={{ height: "100%", display: "flex", background: "var(--bg-1)", color: "var(--fg-1)" }}>
      {/* collapsed rail */}
      <div style={{ width: 60, flex: "none", background: "var(--bg-2)", borderInlineEnd: "1px solid var(--line-1)" }} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--bg-1)", minWidth: 0 }}>
        {/* search field + scope pills */}
        <div style={{ padding: "24px 40px 16px", borderBottom: "1px solid var(--line-1)" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              height: 44,
              border: "1px solid var(--accent)",
              borderRadius: 8,
              background: "var(--bg-1)",
              padding: "0 14px",
              boxShadow: "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)",
              maxWidth: 560,
            }}
          >
            <SearchGlyph size={18} />
            <span style={{ fontSize: 16 }}>threat</span>
            <span style={{ width: 2, height: 20, background: "var(--accent)" }} />
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <span
              style={{
                padding: "5px 11px",
                borderRadius: 999,
                background: "var(--accent)",
                color: "var(--accent-on)",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              All · 6
            </span>
            <span
              style={{
                padding: "5px 11px",
                borderRadius: 999,
                background: "var(--bg-2)",
                border: "1px solid var(--line-1)",
                color: "var(--fg-2)",
                fontSize: 12,
              }}
            >
              Title
            </span>
            <span
              style={{
                padding: "5px 11px",
                borderRadius: 999,
                background: "var(--bg-2)",
                border: "1px solid var(--line-1)",
                color: "var(--fg-2)",
                fontSize: 12,
              }}
            >
              Body
            </span>
          </div>
        </div>

        {/* result cards */}
        <div style={{ flex: 1, overflow: "auto", padding: "12px 28px" }}>
          <ResultCard
            dotColor="var(--label-slate)"
            title={
              <>
                <HL>Threat</HL> model v2
              </>
            }
            snippet={
              <>
                We assume a powerful network adversary… the <HL>threat</HL> surface is timing and size.
              </>
            }
            meta="Specs · 2 matches"
          />
          <ResultCard
            title="Key rotation"
            snippet={
              <>
                …in the <HL>threat</HL> model the device key never leaves the enclave.
              </>
            }
            meta="Specs · 1 match"
          />
          <ResultCard
            last
            title="Project Aurora — kickoff"
            snippet={
              <>
                Security review covers the <HL>threat</HL> model sign-off.
              </>
            }
            meta="Work · 1 match"
          />
        </div>
      </div>
    </div>
  );
}

/* ── SC-04 · Key-command cheat sheet ─────────────────────────────────────── */

function ShortcutRow({ label, keys }: { label: string; keys: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "6px 0",
        fontSize: 13,
      }}
    >
      <span style={{ color: "var(--fg-2)" }}>{label}</span>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-3)" }}>{keys}</span>
    </div>
  );
}

function ShortcutColumn({ title, rows }: { title: string; rows: { label: string; keys: string }[] }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--fg-3)",
          marginBottom: 10,
        }}
      >
        {title}
      </div>
      {rows.map((r) => (
        <ShortcutRow key={r.label} label={r.label} keys={r.keys} />
      ))}
    </div>
  );
}

function CheatSheet() {
  return (
    <div style={{ height: "100%", position: "relative", background: "var(--bg-1)", color: "var(--fg-1)" }}>
      {/* dimmed paper backdrop */}
      <div style={{ height: "100%", filter: "brightness(0.96)" }} />

      {/* scrim + centered cheat-sheet card */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(20,16,10,0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            width: 840,
            background: "var(--bg-1)",
            border: "1px solid var(--line-1)",
            borderRadius: 12,
            boxShadow: "0 24px 60px rgba(20,16,10,0.28)",
            padding: "28px 32px",
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em" }}>Keyboard shortcuts</div>
          <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 28 }}>
            <ShortcutColumn
              title="File"
              rows={[
                { label: "New note", keys: "⌘N" },
                { label: "New folder", keys: "⇧⌘N" },
                { label: "Export…", keys: "⌘E" },
                { label: "Lock vault", keys: "⌃⌘L" },
              ]}
            />
            <ShortcutColumn
              title="Format"
              rows={[
                { label: "Bold", keys: "⌘B" },
                { label: "Italic", keys: "⌘I" },
                { label: "Wiki link", keys: "⌘K" },
                { label: "Highlight", keys: "⌘⇧H" },
              ]}
            />
            <ShortcutColumn
              title="Navigate"
              rows={[
                { label: "Command palette", keys: "⌘K" },
                { label: "Quick switch", keys: "⌘O" },
                { label: "Toggle inspector", keys: "⌥⌘I" },
                { label: "Graph", keys: "⌘G" },
              ]}
            />
          </div>
          <div style={{ marginTop: 22, textAlign: "center", fontSize: 12, color: "var(--line-3)" }}>
            Hold <span style={{ fontFamily: "var(--font-mono)" }}>⌘</span> to show · release to dismiss
          </div>
        </div>
      </div>
    </div>
  );
}

export const ipadCommandScreens: ScreenDef[] = [
  { id: "SC-01", label: "Command palette", Component: CommandPalette, platforms: ["ipad"], orientation: "landscape" },
  { id: "SC-02", label: "Search results", Component: SearchResults, platforms: ["ipad"], orientation: "landscape" },
  { id: "SC-04", label: "Key-command cheat sheet", Component: CheatSheet, platforms: ["ipad"], orientation: "landscape" },
];
