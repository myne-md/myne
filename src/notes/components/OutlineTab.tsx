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
// flushes (a sub-second lag, the `useVaultHeadings` posture). A live-keystroke
// outline would need a second signal carrying the editor's live buffer — out of
// scope for this baseline.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { headingSections } from "../../dialect";
import { useIndexNonce } from "../indexNonce";
import { noteRead } from "../readNote";
import { useSelectedNote } from "../sidebarState";
import { requestRevealHeading } from "../views/revealHeadingSignal";
import { SECTION_HEADING_STYLE } from "./sharedStyles";

interface OutlineEntry {
  level: number;
  text: string;
  /** Byte offset of the heading line start — a stable-ish row discriminator. */
  from: number;
}

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

export function OutlineTab() {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const indexNonce = useIndexNonce();
  const selectedId = ctx.selectedId;
  const contentReloadNonce = ctx.contentReloadNonce;
  const [entries, setEntries] = useState<OutlineEntry[]>([]);

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

  if (selectedId === null) return null;

  return (
    <>
      <div style={SECTION_HEADING_STYLE}>{t("editor.chrome.rightPanel.outline.heading")}</div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>
          {t("editor.chrome.rightPanel.outline.empty")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {entries.map((h, i) => (
            <button
              key={`${h.from}:${i}`}
              type="button"
              data-testid="editor.outline-row"
              data-heading-level={h.level}
              data-heading-from={h.from}
              onClick={() => requestRevealHeading(h.text)}
              title={h.text}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: 0,
                borderRadius: "var(--radius-1)",
                padding: "3px 6px",
                paddingLeft: 6 + (h.level - 1) * 12,
                fontSize: 13,
                color: h.level === 1 ? "var(--fg-1)" : "var(--fg-2)",
                fontWeight: h.level === 1 ? 600 : 400,
                cursor: "pointer",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {h.text}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
