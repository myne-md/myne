import { type CSSProperties, type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SidePanel } from "../../../../components";
import { computeOutlineMeta } from "../../../../lib/outlineTree";
import type { NoteEntry, OutlineItem } from "../types";

type ContextTab = "backlinks" | "unlinked" | "outline";

/** Width (px) of one indentation step — also the width of each tree-rail cell. */
const INDENT_WIDTH = 14;
/** Width (px) reserved for the disclosure chevron (or its spacer) so labels
 *  align whether or not a row can fold. */
const CHEVRON_WIDTH = 16;

/** Right-pointing chevron that rotates down when expanded — same disclosure
 *  motion as the sidebar folder tree (matches desktop `OutlineChevron`). */
function OutlineChevron({ collapsed }: { collapsed: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
        transformOrigin: "50% 50%",
        transition: "transform var(--duration-base) var(--ease-standard)",
      }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--fg-3)", display: "block" }}>
        <path d="m9 18 6-6-6-6" />
      </svg>
    </span>
  );
}

/** Right side panel — the note's CONTEXT, ported to the desktop tabbed
 *  convention: Backlinks (🔗) / Unlinked mentions (#) / Outline (☰), with a
 *  collapse button. No AI-chat tab; note actions live in the ⋯ menu instead. */
export function NoteContextPanel({
  backlinks,
  unlinked,
  outline,
  onOpen,
  onJump,
  onClose,
}: {
  backlinks: NoteEntry[];
  unlinked: NoteEntry[];
  outline: OutlineItem[];
  onOpen: (id: string) => void;
  onJump: (charIndex: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ContextTab>("backlinks");
  // Ephemeral outline fold state by row index; reset when the heading shape
  // changes (note switch or an edit that adds/removes headings) since indices
  // don't carry across snapshots — the desktop OutlineTab posture.
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const outlineSig = useMemo(() => outline.map((h) => `${h.level}:${h.text}`).join("|"), [outline]);
  useEffect(() => setCollapsed(new Set()), [outlineSig]);
  const outlineMeta = useMemo(() => computeOutlineMeta(outline.map((h) => h.level), collapsed), [outline, collapsed]);
  const toggleOutline = (i: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  // SECTION_HEADING_STYLE (desktop sharedStyles.ts) — "LINKED FROM 0" look.
  const heading: CSSProperties = { fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 8 };
  const linkRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", border: "none", background: "transparent", padding: "9px 4px", borderRadius: 8, cursor: "pointer", textAlign: "start", fontSize: 15, color: "var(--fg-1)", fontFamily: "var(--font-sans)" };
  const empty = (text: string): ReactNode => <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>{text}</div>;
  const noteRow = (n: NoteEntry): ReactNode => (
    <button key={n.id} onClick={() => onOpen(n.id)} style={linkRow}>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
    </button>
  );

  const tabBtn = (id: ContextTab, aria: string, icon: ReactNode): ReactNode => {
    const on = tab === id;
    return (
      <button
        onClick={() => setTab(id)}
        aria-label={aria}
        style={{ width: 40, height: 34, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", borderBottom: on ? "2px solid var(--accent)" : "2px solid transparent", marginBottom: -1, color: on ? "var(--fg-1)" : "var(--fg-3)", cursor: "pointer" }}
      >
        {icon}
      </button>
    );
  };

  const header = (close: () => void): ReactNode => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 10px", minHeight: 40, borderBottom: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", gap: 2 }}>
        {tabBtn("backlinks", t("editor.chrome.rightPanel.tabs.backlinks"), <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6L11 7" /><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6L13 17" /></svg>)}
        {tabBtn("unlinked", t("editor.chrome.rightPanel.tabs.unlinked"), <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M9 4L7 20M17 4l-2 16M5 9h15M4 15h15" /></svg>)}
        {tabBtn("outline", t("editor.chrome.rightPanel.tabs.outline"), <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>)}
      </div>
      <button onClick={close} aria-label={t("editor.noteContext.collapsePanel")} style={{ width: 32, height: 32, borderRadius: 8, border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="var(--fg-2)" strokeWidth="1.7" />
          <rect x="14.5" y="4.5" width="6" height="15" rx="2.5" fill="var(--fg-2)" opacity="0.85" />
        </svg>
      </button>
    </div>
  );

  return (
    <SidePanel header={header} onClose={onClose} padBody={false}>
      <div style={{ padding: "16px 18px" }}>
        {tab === "backlinks" && (
          <>
            <div style={heading}>{t("editor.chrome.backlinks.linkedFrom", { count: backlinks.length })}</div>
            {backlinks.length === 0 ? empty(t("editor.chrome.backlinks.empty")) : backlinks.map(noteRow)}
          </>
        )}
        {tab === "unlinked" && (
          <>
            <div style={heading}>{t("editor.noteContext.unlinkedCount", { count: unlinked.length })}</div>
            {unlinked.length === 0 ? empty(t("notes.unlinkedMentions.empty")) : unlinked.map(noteRow)}
          </>
        )}
        {tab === "outline" && (
          <>
            <div style={heading}>{t("editor.chrome.rightPanel.outline.heading")}</div>
            {outline.length === 0 ? (
              empty(t("editor.chrome.rightPanel.outline.empty"))
            ) : (
              // gap:0 so each row's indent rails touch the next and read as
              // continuous vertical tree lines (desktop OutlineTab parity).
              <div style={{ display: "flex", flexDirection: "column" }}>
                {outline.map((h, i) => {
                  const m = outlineMeta[i]!;
                  if (m.hidden) return null;
                  const isCollapsed = collapsed.has(i);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "stretch", width: "100%" }}>
                      {/* One full-height vertical guide per ancestor level. */}
                      {Array.from({ length: Math.max(0, h.level - 1) }, (_, d) => (
                        <span key={d} aria-hidden style={{ flexShrink: 0, width: INDENT_WIDTH, borderInlineStart: "1px solid var(--line-1)" }} />
                      ))}
                      {/* Disclosure chevron for foldable rows; spacer keeps leaf
                          labels aligned with foldable siblings. */}
                      {m.hasChildren ? (
                        <button
                          type="button"
                          data-testid="editor.outline-toggle"
                          aria-label={t(isCollapsed ? "editor.chrome.rightPanel.outline.expand" : "editor.chrome.rightPanel.outline.collapse")}
                          aria-expanded={!isCollapsed}
                          onClick={() => toggleOutline(i)}
                          style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: CHEVRON_WIDTH, background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
                        >
                          <OutlineChevron collapsed={isCollapsed} />
                        </button>
                      ) : (
                        <span aria-hidden style={{ flexShrink: 0, width: CHEVRON_WIDTH }} />
                      )}
                      {/* Label — tap scrolls the editor to the heading. */}
                      <button
                        type="button"
                        data-testid="editor.outline-row"
                        data-heading-level={h.level}
                        onClick={() => onJump(h.index)}
                        title={h.text}
                        style={{ flex: 1, minWidth: 0, textAlign: "start", background: "transparent", border: 0, padding: "8px 6px 8px 2px", fontSize: 15, lineHeight: 1.4, color: h.level === 1 ? "var(--fg-1)" : "var(--fg-2)", fontWeight: h.level === 1 ? 600 : 400, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: "var(--font-sans)" }}
                      >
                        {h.text}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </SidePanel>
  );
}
