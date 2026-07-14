// Outline (table-of-contents) tab body (right-panel tabs) — a NEW feature, but
// built entirely on existing infra: the canonical SYNC-1 heading surface
// (`headingSections`, shared with heading-folding MYND-300 + wikilink anchors
// MYND-305 — no second parser) for the data, and the `revealHeadingSignal` →
// PaneView `setScrollAnchor` bridge for click-to-scroll (the same machinery a
// `[[#heading]]` chip click uses).
//
// Heading source: read the focused note's body from disk via `noteRead`, exactly
// like `useVaultHeadings`. The list refreshes on the SYNC-5 index nonce and the
// open-note content-reload nonce, so an edit becomes visible once autosave
// flushes (a sub-second lag, the `useVaultHeadings` posture).
//
// Two interactions ride on the flat list (outline-scroll-tracking + collapsible
// nodes): the focused pane publishes its top visible heading via
// `activeHeadingSignal` — matched here by `from` — to highlight the current row
// and keep it in view; and each heading with deeper children gets a chevron that
// folds its subtree (pure shape math in `computeOutlineMeta`, ephemeral per-note
// collapse state).

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { headingSections } from "../../dialect";
import { useIndexNonce } from "../indexNonce";
import { noteRead } from "../readNote";
import { useSelectedNote } from "../sidebarState";
import { requestRevealHeading } from "../views/revealHeadingSignal";
import { useActiveHeading } from "../views/activeHeadingSignal";
import { computeOutlineMeta } from "../outlineTree";
import { SECTION_HEADING_STYLE } from "./sharedStyles";

interface OutlineEntry {
  level: number;
  text: string;
  /** UTF-16 offset of the heading line start — the join key with the active-
   *  heading signal, and a stable-ish row discriminator. */
  from: number;
}

/** Width (px) of one indentation step — also the width of each tree rail cell. */
const INDENT_WIDTH = 14;
/** Width (px) reserved for the disclosure chevron (or its spacer) so labels
 *  align whether or not a row can fold. */
const CHEVRON_WIDTH = 16;

/** Shallow equality on (level, text, from) so an unchanged re-read bails render. */
function outlineEqual(a: readonly OutlineEntry[], b: readonly OutlineEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.level !== y.level || x.text !== y.text || x.from !== y.from) return false;
  }
  return true;
}

// Right-pointing chevron that rotates to point down when expanded — the same
// disclosure motion as the sidebar folder tree (`FolderRow`). Rotation lives on
// the wrapper <span> so transform-origin is a reliable 50% 50% across engines.
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
      <svg
        width={12}
        height={12}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ color: "var(--fg-3)", display: "block" }}
      >
        <path d="m9 18 6-6-6-6" />
      </svg>
    </span>
  );
}

export function OutlineTab() {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const indexNonce = useIndexNonce();
  const selectedId = ctx.selectedId;
  const contentReloadNonce = ctx.contentReloadNonce;
  const [entries, setEntries] = useState<OutlineEntry[]>([]);
  // Collapsed rows by index — ephemeral, reset on note switch (a fresh note has
  // its own heading structure, and offsets/indices don't carry across notes).
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());

  // Generation guard: a read that resolves after a newer activation is dropped.
  const seqRef = useRef(0);
  useEffect(() => {
    if (selectedId === null) {
      setEntries((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const seq = ++seqRef.current;
    void noteRead(selectedId).then(
      (body) => {
        if (seq !== seqRef.current) return;
        const next: OutlineEntry[] = headingSections(body).map((s) => ({
          level: s.level,
          text: s.text,
          from: s.from,
        }));
        setEntries((prev) => (outlineEqual(prev, next) ? prev : next));
      },
      () => {
        // Best-effort — an unreadable body shows the empty state.
        if (seq === seqRef.current) setEntries((prev) => (prev.length === 0 ? prev : []));
      },
    );
    // `indexNonce` + `contentReloadNonce` refresh after a rename / edit flush.
  }, [selectedId, indexNonce, contentReloadNonce]);

  // A new note is a clean slate — never carry another note's fold state over.
  useEffect(() => {
    setCollapsed(new Set());
  }, [selectedId]);

  const meta = useMemo(
    () => computeOutlineMeta(entries.map((e) => e.level), collapsed),
    [entries, collapsed],
  );

  // The focused pane's top visible heading (outline-scroll-tracking). Ignore a
  // value belonging to another note. When the active heading is folded away,
  // redirect the highlight onto its visible collapsed ancestor.
  const active = useActiveHeading();
  const activeFrom = active !== null && active.noteId === selectedId ? active.from : null;
  const activeIndex = activeFrom === null ? -1 : entries.findIndex((e) => e.from === activeFrom);
  const activeVisibleIndex =
    activeIndex < 0 ? -1 : meta[activeIndex]!.hidden ? meta[activeIndex]!.collapsedUnder : activeIndex;

  // Keep the highlighted row in view as the editor scrolls (no-op when already
  // visible, so a manual outline scroll isn't yanked unless the section changes).
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeVisibleIndex >= 0) activeRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeVisibleIndex]);

  const toggle = (i: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  if (selectedId === null) return null;

  return (
    <>
      <div style={SECTION_HEADING_STYLE}>{t("editor.chrome.rightPanel.outline.heading")}</div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>
          {t("editor.chrome.rightPanel.outline.empty")}
        </div>
      ) : (
        // gap:0 so each row's indent rails touch the next and read as continuous
        // vertical tree lines.
        <div style={{ display: "flex", flexDirection: "column" }}>
          {entries.map((h, i) => {
            const m = meta[i]!;
            if (m.hidden) return null;
            const isActive = i === activeVisibleIndex;
            const isCollapsed = collapsed.has(i);
            return (
              <div
                key={`${h.from}:${i}`}
                ref={isActive ? activeRowRef : undefined}
                style={{
                  display: "flex",
                  alignItems: "stretch",
                  width: "100%",
                  // Active row: the left tree-line + label turn accent, no row
                  // fill (label colour is set on the button below).
                  boxShadow: isActive ? "inset 2px 0 0 0 var(--accent)" : "none",
                }}
              >
                {/* Indent rails — one full-height vertical guide per ancestor
                    level. With no row gap they connect into continuous tree
                    lines down each sibling group. */}
                {Array.from({ length: Math.max(0, h.level - 1) }, (_, d) => (
                  <span
                    key={d}
                    aria-hidden
                    style={{
                      flexShrink: 0,
                      width: INDENT_WIDTH,
                      borderLeft: "1px solid var(--line-1)",
                    }}
                  />
                ))}
                {/* Disclosure chevron for foldable rows; a matching spacer keeps
                    leaf-row labels aligned with foldable siblings. */}
                {m.hasChildren ? (
                  <button
                    type="button"
                    data-testid="editor.outline-toggle"
                    aria-label={t(
                      isCollapsed
                        ? "editor.chrome.rightPanel.outline.expand"
                        : "editor.chrome.rightPanel.outline.collapse",
                    )}
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(i)}
                    style={{
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: CHEVRON_WIDTH,
                      background: "transparent",
                      border: 0,
                      padding: 0,
                      cursor: "pointer",
                    }}
                  >
                    <OutlineChevron collapsed={isCollapsed} />
                  </button>
                ) : (
                  <span aria-hidden style={{ flexShrink: 0, width: CHEVRON_WIDTH }} />
                )}
                {/* Label — clicking scrolls the editor to the heading. */}
                <button
                  type="button"
                  data-testid="editor.outline-row"
                  data-heading-level={h.level}
                  data-heading-from={h.from}
                  data-active={isActive ? "true" : undefined}
                  onClick={() => requestRevealHeading(h.text)}
                  title={h.text}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    textAlign: "left",
                    background: "transparent",
                    border: 0,
                    padding: "4px 6px 4px 0",
                    fontSize: 13,
                    lineHeight: 1.4,
                    color: isActive
                      ? "var(--accent)"
                      : h.level === 1
                        ? "var(--fg-1)"
                        : "var(--fg-2)",
                    fontWeight: h.level === 1 ? 600 : 400,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {h.text}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
